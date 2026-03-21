/**
 * Structured synthesis — parsing, prompt generation, and task creation.
 *
 * Uses synthesis contracts to drive section-aware parsing and per-deliverable
 * task creation policy.
 */

import { createTask } from '@/lib/services/task-service';
import { getAgentBySlug } from '@/lib/services/agent-service';
import { createLogger } from '@/lib/logger';
import {
  SYNTHESIS_CONTRACTS,
  type DeliverableType,
  type SynthesisContract,
} from '@/lib/brainstorm/synthesis-contract';

const log = createLogger('synthesis-decision-log');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NextStep {
  action: string;
  owner: string | null;
  due: string | null;
}

export interface TaskItem {
  action: string;
  owner: string | null;
  due: string | null;
  dependsOn: string | null;
}

// ---------------------------------------------------------------------------
// Prompt generation (contract-driven)
// ---------------------------------------------------------------------------

/**
 * Build a synthesis prompt template from the contract for a given deliverable type.
 *
 * Replaces the old hardcoded SYNTHESIS_TEMPLATES — now driven entirely by
 * SYNTHESIS_CONTRACTS, so the prompt always matches what parsing expects.
 */
export function buildSynthesisPrompt(deliverableType: DeliverableType | undefined): string {
  const contract = SYNTHESIS_CONTRACTS[deliverableType ?? 'decision'];
  const allSections = [...contract.requiredSections, ...contract.optionalSections];

  const lines: string[] = ['Structure your synthesis as:'];

  for (const section of allSections) {
    lines.push(`## ${section}`);
    lines.push(getSectionGuidance(section, contract));
    lines.push('');
  }

  return lines.join('\n');
}

/** Per-section content guidance, including format examples for task-extraction sections. */
function getSectionGuidance(section: string, contract: SynthesisContract): string {
  const isTaskSection = contract.taskExtractionSection === section;

  if (isTaskSection) {
    return getTaskSectionGuidance(contract);
  }

  switch (section) {
    case 'Decision':
      return '[What was decided — one clear sentence]';
    case 'Rationale':
      return '[Key arguments from the discussion that support this decision]';
    case 'Objections Addressed':
      return '[Key disagreements and how they were resolved or overruled]';
    case 'Options Evaluated':
      return `### Option 1: [Name]\n**Pros:** ...\n**Cons:** ...\n**Advocates:** [who argued for this]\n### Option 2: [Name]\n...`;
    case 'Recommendation':
      return '[Which option to pursue and why, citing specific discussion arguments]';
    case 'Open Questions':
      return '[What remains unresolved]';
    case 'Objective':
      return '[What we are trying to achieve]';
    case 'Risks & Mitigations':
      return '- Risk: [X] → Mitigation: [Y]';
    case 'Timeline':
      return '[Rough phases or milestones if discussed]';
    case 'Risks Identified':
      return '| Risk | Impact | Likelihood | Severity | Mitigation |\n|------|--------|-----------|----------|------------|\n| ...  | High/Med/Low | High/Med/Low | Critical/High/Med/Low | ... |';
    case 'Key Discussion Points':
      return '[How agents evaluated each risk — major agreements/disagreements]';
    case 'Topics Explored':
      return '[What ground the discussion covered]';
    case 'Key Findings':
      return '- [Finding 1]: [supporting evidence from discussion]\n- [Finding 2]: ...';
    case 'Potential Next Steps':
      return '[Ideas for follow-up — not commitments]';
    default:
      return '[Details from the discussion]';
  }
}

/** Build format-specific examples for task extraction sections. */
function getTaskSectionGuidance(contract: SynthesisContract): string {
  const formats = contract.allowedFormats;

  if (formats.includes('numbered')) {
    return `1. [ ] [Action] — Owner: [agent/person] — Depends on: [nothing or item N]\n2. [ ] [Action] — Owner: [agent/person] — Depends on: [item 1]\n...`;
  }

  if (formats.includes('checklist')) {
    return `- [ ] [Action] — Owner: [agent/person/team] — Due: [ISO date or timeframe]`;
  }

  return `- [Action] — Owner: [agent/person]`;
}

// ---------------------------------------------------------------------------
// Legacy exports (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Deliverable-type-specific synthesis templates.
 * @deprecated Use buildSynthesisPrompt() instead — driven by SYNTHESIS_CONTRACTS.
 */
export const SYNTHESIS_TEMPLATES: Record<string, string> = Object.fromEntries(
  (Object.keys(SYNTHESIS_CONTRACTS) as DeliverableType[]).map((dt) => [
    dt,
    buildSynthesisPrompt(dt),
  ]),
);

/** Fall-back template used when no deliverableType is set */
export const DEFAULT_SYNTHESIS_TEMPLATE = buildSynthesisPrompt('decision');

/**
 * Universal formatting guidance appended to ALL synthesis prompts.
 *
 * Must NOT contain deliverable-specific sections — those come from
 * buildSynthesisPrompt(). This suffix only provides cross-cutting formatting rules.
 */
export const STRUCTURED_SYNTHESIS_PROMPT_SUFFIX = `
IMPORTANT formatting rules:
- Use ## (h2) for all section headings — match the template above exactly.
- For action items or checklists, use this format per line:
  - [ ] [Action description] — Owner: [agent-slug or person] — Due: [ISO date or timeframe]
  Omit Owner/Due fields if they were not discussed.
- Be concise but comprehensive. Cite specific arguments from the discussion.
- Do not invent sections beyond what the template specifies.
`;

// ---------------------------------------------------------------------------
// Parsing (contract-driven)
// ---------------------------------------------------------------------------

/**
 * Extract task items from the contract-defined extraction section.
 *
 * Uses the contract's taskExtractionSection to know which section to parse.
 * Returns empty if the contract disallows task creation.
 *
 * Supports checklist, numbered, and bullet formats.
 */
export function parseTaskItems(
  synthesis: string,
  deliverableType: DeliverableType | undefined,
): TaskItem[] {
  const contract = SYNTHESIS_CONTRACTS[deliverableType ?? 'decision'];

  if (!contract.allowsTaskCreation || !contract.taskExtractionSection) {
    return [];
  }

  return extractItemsFromSection(synthesis, contract.taskExtractionSection);
}

/**
 * Legacy function — extract action items from "## Next Steps" (decision format).
 * @deprecated Use parseTaskItems() for contract-aware parsing.
 */
export function parseNextSteps(synthesis: string): NextStep[] {
  const items = parseTaskItems(synthesis, 'decision');
  return items.map(({ action, owner, due }) => ({ action, owner, due }));
}

/**
 * Extract items from a named ## section in markdown.
 * Supports checklist, numbered, and bullet formats.
 */
function extractItemsFromSection(synthesis: string, sectionName: string): TaskItem[] {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionMatch = synthesis.match(new RegExp(`^## ${escaped}\\s*$`, 'm'));
  if (!sectionMatch || sectionMatch.index === undefined) {
    return [];
  }

  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const nextHeadingMatch = synthesis.slice(sectionStart).match(/^## /m);
  const sectionEnd = nextHeadingMatch?.index
    ? sectionStart + nextHeadingMatch.index
    : synthesis.length;
  const sectionContent = synthesis.slice(sectionStart, sectionEnd);

  const items: TaskItem[] = [];

  // Match all supported item formats:
  // - [ ] checklist item
  // 1. [ ] numbered checklist item
  // 1. numbered item (without checkbox)
  // - bullet item (without checkbox)
  const itemRegex = /^(?:- \[ \] |(\d+)\.\s*\[ \] |(\d+)\.\s+|- )(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(sectionContent)) !== null) {
    const raw = match[3].trim();
    items.push(parseItemLine(raw));
  }

  return items;
}

/**
 * Parse a single task item line into structured fields.
 *
 * Supports Owner, Due, and Depends on metadata in any order.
 */
function parseItemLine(raw: string): TaskItem {
  let action = raw;
  let owner: string | null = null;
  let due: string | null = null;
  let dependsOn: string | null = null;

  const ownerMatch = raw.match(/\s*—\s*[Oo]wner:\s*([^—]+)/);
  if (ownerMatch) {
    owner = ownerMatch[1].trim();
  }

  const dueMatch = raw.match(/\s*—\s*[Dd]ue:\s*(.+?)(?:\s*—|$)/);
  if (dueMatch) {
    due = dueMatch[1].trim();
  }

  const dependsMatch = raw.match(/\s*—\s*[Dd]epends on:\s*(.+?)(?:\s*—|$)/);
  if (dependsMatch) {
    dependsOn = dependsMatch[1].trim();
  }

  // Strip metadata from the action text (everything after first em-dash)
  const dashIdx = raw.indexOf(' \u2014 ');
  if (dashIdx >= 0) {
    action = raw.slice(0, dashIdx).trim();
  }

  return { action, owner, due, dependsOn };
}

// ---------------------------------------------------------------------------
// Task creation
// ---------------------------------------------------------------------------

interface CreateTasksOptions {
  parentTaskId: string;
  projectId?: string;
  deliverableType?: DeliverableType;
}

/**
 * Parse synthesis markdown and create tasks based on the deliverable contract.
 *
 * Returns the IDs of successfully created tasks.
 * Continues past individual failures so one bad item doesn't block the rest.
 */
export async function createTasksFromSynthesis(
  synthesis: string,
  options: CreateTasksOptions,
): Promise<string[]> {
  const items = parseTaskItems(synthesis, options.deliverableType);
  if (items.length === 0) return [];

  const taskIds: string[] = [];

  for (const item of items) {
    try {
      let assigneeAgentId: string | undefined;
      if (item.owner) {
        const agent = await getAgentBySlug(item.owner);
        if (agent) {
          assigneeAgentId = agent.id;
        }
      }

      let dueAt: Date | undefined;
      if (item.due) {
        const parsed = new Date(item.due);
        if (!isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(item.due)) {
          dueAt = parsed;
        }
      }

      const descParts: string[] = [];
      if (item.owner) descParts.push(`Owner: ${item.owner}`);
      if (item.dependsOn) descParts.push(`Depends on: ${item.dependsOn}`);

      const task = await createTask({
        title: item.action,
        parentTaskId: options.parentTaskId,
        projectId: options.projectId,
        assigneeAgentId,
        dueAt,
        description: descParts.length > 0 ? descParts.join('\n') : undefined,
      });

      taskIds.push(task.id);
    } catch (err) {
      log.error({ err, action: item.action }, 'Failed to create task from synthesis item');
    }
  }

  return taskIds;
}
