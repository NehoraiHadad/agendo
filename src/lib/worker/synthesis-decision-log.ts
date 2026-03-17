/**
 * Structured Decision Log — synthesis parsing and task creation.
 *
 * Parses the structured synthesis output from brainstorm sessions and
 * auto-creates tasks for each "Next Steps" action item.
 */

import { createTask } from '@/lib/services/task-service';
import { getAgentBySlug } from '@/lib/services/agent-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('synthesis-decision-log');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NextStep {
  action: string;
  owner: string | null;
  due: string | null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Append this to the synthesis prompt to request structured output.
 * The synthesis agent should produce markdown with these exact section headers.
 */
export const STRUCTURED_SYNTHESIS_PROMPT_SUFFIX = `

Structure your response using EXACTLY these markdown sections:

## Decision
[What was decided — the core conclusion or direction agreed upon]

## Rationale
[Why this was decided — key arguments and evidence that support the decision]

## Objections Addressed
[Key disagreements raised during discussion and how they were resolved or acknowledged]

## Next Steps
List concrete action items as a checklist. For each item, include an owner (agent slug or person) and a due date if discussed:
- [ ] [Action description] — Owner: [agent-slug or person] — Due: [ISO date or timeframe]
- [ ] [Action description] — Owner: [agent-slug or person] — Due: [ISO date or timeframe]

If no specific owner or due date was discussed for an item, omit those fields:
- [ ] [Action description]
`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extract action items from the "## Next Steps" section of a structured synthesis.
 *
 * Looks for lines matching: `- [ ] Action — Owner: slug — Due: date`
 * Owner and Due are optional. Parsing stops at the next `## ` heading or end of string.
 */
export function parseNextSteps(synthesis: string): NextStep[] {
  // Find the "## Next Steps" section
  const nextStepsMatch = synthesis.match(/^## Next Steps\s*$/m);
  if (!nextStepsMatch || nextStepsMatch.index === undefined) {
    return [];
  }

  // Extract the section content (from header to next ## heading or end)
  const sectionStart = nextStepsMatch.index + nextStepsMatch[0].length;
  const nextHeadingMatch = synthesis.slice(sectionStart).match(/^## /m);
  const sectionEnd = nextHeadingMatch?.index
    ? sectionStart + nextHeadingMatch.index
    : synthesis.length;
  const sectionContent = synthesis.slice(sectionStart, sectionEnd);

  // Match checklist items: `- [ ] ...`
  const itemRegex = /^- \[ \] (.+)$/gm;
  const steps: NextStep[] = [];

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(sectionContent)) !== null) {
    const raw = match[1].trim();
    steps.push(parseNextStepLine(raw));
  }

  return steps;
}

/**
 * Parse a single next-step line into structured fields.
 *
 * Supports:
 * - `Action — Owner: slug — Due: date`
 * - `Action — Owner: slug`
 * - `Action — Due: date`
 * - `Action`
 */
function parseNextStepLine(raw: string): NextStep {
  let action = raw;
  let owner: string | null = null;
  let due: string | null = null;

  // Extract Owner (case-insensitive)
  const ownerMatch = raw.match(/\s*—\s*[Oo]wner:\s*([^—]+)/);
  if (ownerMatch) {
    owner = ownerMatch[1].trim();
  }

  // Extract Due (case-insensitive)
  const dueMatch = raw.match(/\s*—\s*[Dd]ue:\s*(.+?)(?:\s*—|$)/);
  if (dueMatch) {
    due = dueMatch[1].trim();
  }

  // Strip Owner/Due metadata from the action text
  // Remove everything from the first em-dash separator onwards
  const dashIdx = raw.indexOf(' \u2014 ');
  if (dashIdx >= 0) {
    action = raw.slice(0, dashIdx).trim();
  }

  return { action, owner, due };
}

// ---------------------------------------------------------------------------
// Task creation
// ---------------------------------------------------------------------------

interface CreateTasksOptions {
  parentTaskId: string;
  projectId?: string;
}

/**
 * Parse synthesis markdown and create tasks for each next step.
 *
 * Returns the IDs of successfully created tasks.
 * Continues past individual failures so one bad item doesn't block the rest.
 */
export async function createTasksFromSynthesis(
  synthesis: string,
  options: CreateTasksOptions,
): Promise<string[]> {
  const steps = parseNextSteps(synthesis);
  if (steps.length === 0) return [];

  const taskIds: string[] = [];

  for (const step of steps) {
    try {
      // Resolve owner slug to agent ID (if it looks like an agent slug)
      let assigneeAgentId: string | undefined;
      if (step.owner) {
        const agent = await getAgentBySlug(step.owner);
        if (agent) {
          assigneeAgentId = agent.id;
        }
      }

      // Parse due date — only set if it's a valid ISO date
      let dueAt: Date | undefined;
      if (step.due) {
        const parsed = new Date(step.due);
        if (!isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(step.due)) {
          dueAt = parsed;
        }
      }

      const task = await createTask({
        title: step.action,
        parentTaskId: options.parentTaskId,
        projectId: options.projectId,
        assigneeAgentId,
        dueAt,
        description: step.owner ? `Owner: ${step.owner}` : undefined,
      });

      taskIds.push(task.id);
    } catch (err) {
      log.error({ err, action: step.action }, 'Failed to create task from synthesis next step');
    }
  }

  return taskIds;
}
