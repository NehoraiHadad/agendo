/**
 * Tests for structured synthesis — parsing, task creation, and prompt generation.
 *
 * Covers:
 * - parseTaskItems(): extracting action items from any contract-defined section
 * - createTasksFromSynthesis(): auto-creating tasks respecting per-deliverable policy
 * - buildSynthesisPrompt(): contract-driven prompt generation for all deliverable types
 * - Metadata preservation (Owner, Due, Depends on)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: task-service (must be before import)
// ---------------------------------------------------------------------------

const mockCreateTask = vi.fn().mockResolvedValue({
  id: 'task-new-1',
  title: 'Test task',
  status: 'todo',
  parentTaskId: null,
  projectId: null,
});

vi.mock('@/lib/services/task-service', () => ({
  createTask: mockCreateTask,
}));

// ---------------------------------------------------------------------------
// Mock: agent-service
// ---------------------------------------------------------------------------

const mockGetAgentBySlug = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/services/agent-service', () => ({
  getAgentBySlug: mockGetAgentBySlug,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const {
  parseTaskItems,
  createTasksFromSynthesis,
  buildSynthesisPrompt,
  STRUCTURED_SYNTHESIS_PROMPT_SUFFIX,
} = await import('../synthesis-decision-log');

// Also import contracts for reference
const { SYNTHESIS_CONTRACTS } = await import('../../brainstorm/synthesis-contract');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({
    id: 'task-new-1',
    title: 'Test task',
    status: 'todo',
    parentTaskId: null,
    projectId: null,
  });
});

// ---------------------------------------------------------------------------
// parseTaskItems — decision (## Next Steps, checklist format)
// ---------------------------------------------------------------------------

describe('parseTaskItems', () => {
  describe('decision deliverable', () => {
    it('extracts checklist items from ## Next Steps', () => {
      const synthesis = `## Decision
We should use PostgreSQL for the database.

## Rationale
It has great JSON support.

## Next Steps
- [ ] Set up PostgreSQL schema \u2014 Owner: claude-code-1 \u2014 Due: 2026-03-18
- [ ] Write migration scripts \u2014 Owner: codex-cli-1 \u2014 Due: 2026-03-20
`;

      const items = parseTaskItems(synthesis, 'decision');

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        action: 'Set up PostgreSQL schema',
        owner: 'claude-code-1',
        due: '2026-03-18',
        dependsOn: null,
      });
      expect(items[1]).toEqual({
        action: 'Write migration scripts',
        owner: 'codex-cli-1',
        due: '2026-03-20',
        dependsOn: null,
      });
    });

    it('returns empty when no Next Steps section exists', () => {
      const synthesis = `## Decision
We decided something.

## Rationale
For good reasons.`;

      expect(parseTaskItems(synthesis, 'decision')).toEqual([]);
    });

    it('stops parsing at the next heading', () => {
      const synthesis = `## Next Steps
- [ ] Action item 1 \u2014 Owner: claude-code-1

## Other Section
- [ ] This should NOT be parsed
`;

      const items = parseTaskItems(synthesis, 'decision');
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe('Action item 1');
    });
  });

  describe('action_plan deliverable', () => {
    it('extracts numbered items from ## Action Items', () => {
      const synthesis = `## Objective
Build the thing.

## Action Items
1. [ ] Design the API \u2014 Owner: claude-code-1 \u2014 Depends on: nothing
2. [ ] Implement endpoints \u2014 Owner: codex-cli-1 \u2014 Depends on: item 1
3. [ ] Write tests \u2014 Owner: gemini-cli-1 \u2014 Due: 2026-04-01

## Timeline
Phase 1: March
`;

      const items = parseTaskItems(synthesis, 'action_plan');

      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({
        action: 'Design the API',
        owner: 'claude-code-1',
        due: null,
        dependsOn: 'nothing',
      });
      expect(items[1]).toEqual({
        action: 'Implement endpoints',
        owner: 'codex-cli-1',
        due: null,
        dependsOn: 'item 1',
      });
      expect(items[2]).toEqual({
        action: 'Write tests',
        owner: 'gemini-cli-1',
        due: '2026-04-01',
        dependsOn: null,
      });
    });

    it('supports checklist format in Action Items', () => {
      const synthesis = `## Action Items
- [ ] Single checklist item \u2014 Owner: claude-code-1
`;

      const items = parseTaskItems(synthesis, 'action_plan');
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe('Single checklist item');
    });
  });

  describe('risk_assessment deliverable', () => {
    it('extracts items from ## Recommended Actions', () => {
      const synthesis = `## Risks Identified
| Risk | Impact |
|------|--------|
| Data loss | High |

## Recommended Actions
- [ ] Set up automated backups \u2014 Owner: claude-code-1
- [ ] Add monitoring alerts \u2014 Due: 2026-03-25

## Key Discussion Points
Agents agreed on backup priority.
`;

      const items = parseTaskItems(synthesis, 'risk_assessment');

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        action: 'Set up automated backups',
        owner: 'claude-code-1',
        due: null,
        dependsOn: null,
      });
      expect(items[1]).toEqual({
        action: 'Add monitoring alerts',
        owner: null,
        due: '2026-03-25',
        dependsOn: null,
      });
    });

    it('supports bullet format without checkboxes', () => {
      const synthesis = `## Recommended Actions
- Implement rate limiting
- Add circuit breakers \u2014 Owner: claude-code-1
`;

      const items = parseTaskItems(synthesis, 'risk_assessment');
      expect(items).toHaveLength(2);
      expect(items[0].action).toBe('Implement rate limiting');
      expect(items[1].action).toBe('Add circuit breakers');
    });
  });

  describe('options_list deliverable (no task creation)', () => {
    it('returns empty array \u2014 options_list does not allow task creation', () => {
      const synthesis = `## Options Evaluated
### Option 1: PostgreSQL
**Pros:** Great JSON support
### Option 2: MySQL
**Pros:** Widely used

## Recommendation
Go with PostgreSQL.
`;

      const items = parseTaskItems(synthesis, 'options_list');
      expect(items).toEqual([]);
    });
  });

  describe('exploration deliverable (no task creation)', () => {
    it('returns empty array \u2014 exploration does not allow task creation', () => {
      const synthesis = `## Key Findings
- Finding 1: something important

## Open Questions
- How to scale?

## Potential Next Steps
- Consider implementing caching
`;

      const items = parseTaskItems(synthesis, 'exploration');
      expect(items).toEqual([]);
    });
  });

  describe('metadata preservation', () => {
    it('extracts Owner, Due, and Depends on from a single line', () => {
      const synthesis = `## Next Steps
- [ ] Build feature \u2014 Owner: claude-code-1 \u2014 Due: 2026-04-01 \u2014 Depends on: design review
`;

      const items = parseTaskItems(synthesis, 'decision');
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        action: 'Build feature',
        owner: 'claude-code-1',
        due: '2026-04-01',
        dependsOn: 'design review',
      });
    });

    it('handles items with no metadata', () => {
      const synthesis = `## Next Steps
- [ ] Do something simple
`;

      const items = parseTaskItems(synthesis, 'decision');
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        action: 'Do something simple',
        owner: null,
        due: null,
        dependsOn: null,
      });
    });

    it('handles case-insensitive metadata keys', () => {
      const synthesis = `## Next Steps
- [ ] Task A \u2014 owner: Claude \u2014 due: next week \u2014 depends on: task B
`;

      const items = parseTaskItems(synthesis, 'decision');
      expect(items[0]).toEqual({
        action: 'Task A',
        owner: 'Claude',
        due: 'next week',
        dependsOn: 'task B',
      });
    });

    it('trims whitespace from all fields', () => {
      const synthesis = `## Next Steps
- [ ]   Set up database   \u2014 Owner:   claude-code-1   \u2014 Due:   2026-03-18
`;

      const items = parseTaskItems(synthesis, 'decision');
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        action: 'Set up database',
        owner: 'claude-code-1',
        due: '2026-03-18',
        dependsOn: null,
      });
    });
  });

  describe('fallback to decision when no deliverable type', () => {
    it('defaults to decision contract when deliverableType is undefined', () => {
      const synthesis = `## Next Steps
- [ ] Action item \u2014 Owner: claude-code-1
`;

      const items = parseTaskItems(synthesis, undefined);
      expect(items).toHaveLength(1);
      expect(items[0].action).toBe('Action item');
    });
  });
});

// ---------------------------------------------------------------------------
// createTasksFromSynthesis \u2014 per-deliverable task creation policy
// ---------------------------------------------------------------------------

describe('createTasksFromSynthesis', () => {
  it('creates tasks for decision deliverable', async () => {
    const synthesis = `## Next Steps
- [ ] Implement feature A \u2014 Owner: claude-code-1 \u2014 Due: 2026-03-20
- [ ] Write tests \u2014 Owner: codex-cli-1
`;

    let callCount = 0;
    mockCreateTask.mockImplementation(async () => ({
      id: `task-${++callCount}`,
      title: 'mock',
      status: 'todo',
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
    }));

    mockGetAgentBySlug.mockImplementation(async (slug: string) => {
      if (slug === 'claude-code-1') return { id: 'agent-claude' };
      if (slug === 'codex-cli-1') return { id: 'agent-codex' };
      return null;
    });

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
      deliverableType: 'decision',
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Implement feature A',
        parentTaskId: 'parent-task-id',
        projectId: 'project-123',
        assigneeAgentId: 'agent-claude',
      }),
    );
    expect(taskIds).toHaveLength(2);
  });

  it('creates tasks from action_plan Action Items section', async () => {
    const synthesis = `## Objective
Build the thing.

## Action Items
1. [ ] Design the API \u2014 Owner: claude-code-1
2. [ ] Implement endpoints \u2014 Owner: codex-cli-1

## Timeline
Phase 1: March
`;

    let callCount = 0;
    mockCreateTask.mockImplementation(async () => ({
      id: `task-${++callCount}`,
      title: 'mock',
      status: 'todo',
    }));

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'action_plan',
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(taskIds).toHaveLength(2);
  });

  it('creates tasks from risk_assessment Recommended Actions section', async () => {
    const synthesis = `## Risks Identified
| Risk | Impact |
|------|--------|

## Recommended Actions
- [ ] Set up backups \u2014 Owner: claude-code-1
`;

    mockCreateTask.mockResolvedValue({ id: 'task-1', title: 'mock', status: 'todo' });

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'risk_assessment',
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(taskIds).toHaveLength(1);
  });

  it('does NOT create tasks for options_list deliverable', async () => {
    const synthesis = `## Options Evaluated
### Option 1: PostgreSQL

## Recommendation
Go with PostgreSQL.

## Open Questions
- [ ] Should we also evaluate DynamoDB?
`;

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'options_list',
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(taskIds).toEqual([]);
  });

  it('does NOT create tasks for exploration deliverable', async () => {
    const synthesis = `## Key Findings
- Finding 1

## Open Questions
- Question 1

## Potential Next Steps
- [ ] Consider implementing caching
`;

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'exploration',
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(taskIds).toEqual([]);
  });

  it('includes dependsOn in task description when present', async () => {
    const synthesis = `## Action Items
1. [ ] Design the API
2. [ ] Implement endpoints \u2014 Depends on: item 1
`;

    let callCount = 0;
    mockCreateTask.mockImplementation(async () => ({
      id: `task-${++callCount}`,
      title: 'mock',
      status: 'todo',
    }));

    await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'action_plan',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Implement endpoints',
        description: expect.stringContaining('Depends on: item 1'),
      }),
    );
  });

  it('defaults to decision when deliverableType is omitted', async () => {
    const synthesis = `## Next Steps
- [ ] Do something
`;

    mockCreateTask.mockResolvedValue({ id: 'task-1', title: 'mock', status: 'todo' });

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(taskIds).toHaveLength(1);
  });

  it('parses ISO date strings into Date objects for dueAt', async () => {
    const synthesis = `## Next Steps
- [ ] Deploy feature \u2014 Due: 2026-03-25
`;

    mockCreateTask.mockResolvedValue({ id: 'task-1', title: 'mock', status: 'todo' });

    await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'decision',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Deploy feature',
        dueAt: new Date('2026-03-25'),
      }),
    );
  });

  it('continues creating remaining tasks if one fails', async () => {
    const synthesis = `## Next Steps
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;

    let callCount = 0;
    mockCreateTask.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('DB error');
      return { id: `task-${callCount}`, title: 'mock', status: 'todo' };
    });

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      deliverableType: 'decision',
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(3);
    expect(taskIds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildSynthesisPrompt \u2014 contract-driven prompt generation
// ---------------------------------------------------------------------------

describe('buildSynthesisPrompt', () => {
  it('generates prompt with all required sections for decision', () => {
    const prompt = buildSynthesisPrompt('decision');
    const contract = SYNTHESIS_CONTRACTS['decision'];

    for (const section of contract.requiredSections) {
      expect(prompt).toContain(`## ${section}`);
    }
    for (const section of contract.optionalSections) {
      expect(prompt).toContain(`## ${section}`);
    }
  });

  it('generates prompt with all required sections for action_plan', () => {
    const prompt = buildSynthesisPrompt('action_plan');
    const contract = SYNTHESIS_CONTRACTS['action_plan'];

    for (const section of contract.requiredSections) {
      expect(prompt).toContain(`## ${section}`);
    }
  });

  it('generates prompt with all required sections for risk_assessment', () => {
    const prompt = buildSynthesisPrompt('risk_assessment');
    const contract = SYNTHESIS_CONTRACTS['risk_assessment'];

    for (const section of contract.requiredSections) {
      expect(prompt).toContain(`## ${section}`);
    }
  });

  it('generates prompt with all required sections for options_list', () => {
    const prompt = buildSynthesisPrompt('options_list');
    const contract = SYNTHESIS_CONTRACTS['options_list'];

    for (const section of contract.requiredSections) {
      expect(prompt).toContain(`## ${section}`);
    }
    // Should NOT mention task creation metadata
    expect(prompt).not.toMatch(/Owner:|Due:|Depends on:/);
  });

  it('generates prompt with all required sections for exploration', () => {
    const prompt = buildSynthesisPrompt('exploration');
    const contract = SYNTHESIS_CONTRACTS['exploration'];

    for (const section of contract.requiredSections) {
      expect(prompt).toContain(`## ${section}`);
    }
    // Should NOT mention task creation metadata
    expect(prompt).not.toMatch(/Owner:|Due:|Depends on:/);
  });

  it('includes checklist format instruction for decision', () => {
    const prompt = buildSynthesisPrompt('decision');
    expect(prompt).toContain('- [ ]');
  });

  it('includes numbered format instruction for action_plan', () => {
    const prompt = buildSynthesisPrompt('action_plan');
    expect(prompt).toMatch(/\d+\.\s*\[/);
  });

  it('defaults to decision when deliverableType is undefined', () => {
    const prompt = buildSynthesisPrompt(undefined);
    expect(prompt).toContain('## Decision');
    expect(prompt).toContain('## Rationale');
    expect(prompt).toContain('## Next Steps');
  });
});

// ---------------------------------------------------------------------------
// STRUCTURED_SYNTHESIS_PROMPT_SUFFIX (cross-cutting formatting)
// ---------------------------------------------------------------------------

describe('STRUCTURED_SYNTHESIS_PROMPT_SUFFIX', () => {
  it('contains formatting guidance', () => {
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('formatting rules');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('## (h2)');
  });
});
