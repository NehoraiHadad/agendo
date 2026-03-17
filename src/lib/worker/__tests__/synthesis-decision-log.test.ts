/**
 * Tests for structured Decision Log synthesis — subtask #6
 *
 * Covers:
 * - parseNextSteps(): extracting action items from synthesis markdown
 * - createTasksFromSynthesis(): auto-creating tasks from parsed next steps
 * - STRUCTURED_SYNTHESIS_PROMPT: prompt format validation
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

const { parseNextSteps, createTasksFromSynthesis, STRUCTURED_SYNTHESIS_PROMPT_SUFFIX } =
  await import('../synthesis-decision-log');

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
// parseNextSteps
// ---------------------------------------------------------------------------

describe('parseNextSteps', () => {
  it('extracts action items from well-formed Next Steps section', () => {
    const synthesis = `## Decision
We should use PostgreSQL for the database.

## Rationale
It has great JSON support.

## Objections Addressed
None significant.

## Next Steps
- [ ] Set up PostgreSQL schema — Owner: claude-code-1 — Due: 2026-03-18
- [ ] Write migration scripts — Owner: codex-cli-1 — Due: 2026-03-20
- [ ] Add integration tests — Owner: gemini-cli-1 — Due: 2026-03-25
`;

    const steps = parseNextSteps(synthesis);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      action: 'Set up PostgreSQL schema',
      owner: 'claude-code-1',
      due: '2026-03-18',
    });
    expect(steps[1]).toEqual({
      action: 'Write migration scripts',
      owner: 'codex-cli-1',
      due: '2026-03-20',
    });
    expect(steps[2]).toEqual({
      action: 'Add integration tests',
      owner: 'gemini-cli-1',
      due: '2026-03-25',
    });
  });

  it('handles action items without owner or due date', () => {
    const synthesis = `## Next Steps
- [ ] Do something simple
- [ ] Another thing — Owner: claude-code-1
- [ ] Third thing — Due: 2026-04-01
`;

    const steps = parseNextSteps(synthesis);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      action: 'Do something simple',
      owner: null,
      due: null,
    });
    expect(steps[1]).toEqual({
      action: 'Another thing',
      owner: 'claude-code-1',
      due: null,
    });
    expect(steps[2]).toEqual({
      action: 'Third thing',
      owner: null,
      due: '2026-04-01',
    });
  });

  it('returns empty array when no Next Steps section exists', () => {
    const synthesis = `## Decision
We decided something.

## Rationale
For good reasons.`;

    const steps = parseNextSteps(synthesis);
    expect(steps).toEqual([]);
  });

  it('returns empty array when Next Steps section has no checklist items', () => {
    const synthesis = `## Next Steps
No action items needed at this time.`;

    const steps = parseNextSteps(synthesis);
    expect(steps).toEqual([]);
  });

  it('stops parsing at the next heading', () => {
    const synthesis = `## Next Steps
- [ ] Action item 1 — Owner: claude-code-1

## Other Section
- [ ] This should NOT be parsed
`;

    const steps = parseNextSteps(synthesis);
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe('Action item 1');
  });

  it('handles variations in Owner/Due formatting', () => {
    const synthesis = `## Next Steps
- [ ] Task A — owner: Claude — due: next week
- [ ] Task B — Owner: team — Due: ASAP
`;

    const steps = parseNextSteps(synthesis);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({
      action: 'Task A',
      owner: 'Claude',
      due: 'next week',
    });
    expect(steps[1]).toEqual({
      action: 'Task B',
      owner: 'team',
      due: 'ASAP',
    });
  });

  it('trims whitespace from action, owner, and due fields', () => {
    const synthesis = `## Next Steps
- [ ]   Set up database   — Owner:   claude-code-1   — Due:   2026-03-18
`;

    const steps = parseNextSteps(synthesis);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      action: 'Set up database',
      owner: 'claude-code-1',
      due: '2026-03-18',
    });
  });
});

// ---------------------------------------------------------------------------
// createTasksFromSynthesis
// ---------------------------------------------------------------------------

describe('createTasksFromSynthesis', () => {
  it('creates tasks for each next step under the parent task', async () => {
    const synthesis = `## Next Steps
- [ ] Implement feature A — Owner: claude-code-1 — Due: 2026-03-20
- [ ] Write tests — Owner: codex-cli-1
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
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Write tests',
        parentTaskId: 'parent-task-id',
        projectId: 'project-123',
        assigneeAgentId: 'agent-codex',
      }),
    );

    expect(taskIds).toHaveLength(2);
  });

  it('skips task creation when there are no next steps', async () => {
    const synthesis = `## Decision
Something was decided.`;

    const taskIds = await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(taskIds).toEqual([]);
  });

  it('handles unknown agent slugs gracefully (no assignee)', async () => {
    const synthesis = `## Next Steps
- [ ] Do something — Owner: unknown-agent
`;

    mockGetAgentBySlug.mockResolvedValue(null);

    await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Do something',
        assigneeAgentId: undefined,
      }),
    );
  });

  it('parses ISO date strings into Date objects for dueAt', async () => {
    const synthesis = `## Next Steps
- [ ] Deploy feature — Due: 2026-03-25
`;

    await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Deploy feature',
        dueAt: new Date('2026-03-25'),
      }),
    );
  });

  it('ignores non-ISO due dates (does not set dueAt)', async () => {
    const synthesis = `## Next Steps
- [ ] Review PR — Due: next week
`;

    await createTasksFromSynthesis(synthesis, {
      parentTaskId: 'parent-task-id',
      projectId: 'project-123',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review PR',
        dueAt: undefined,
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
      projectId: 'project-123',
    });

    // Should have attempted all 3
    expect(mockCreateTask).toHaveBeenCalledTimes(3);
    // Should return 2 successful task IDs (task 2 failed)
    expect(taskIds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// STRUCTURED_SYNTHESIS_PROMPT_SUFFIX
// ---------------------------------------------------------------------------

describe('STRUCTURED_SYNTHESIS_PROMPT_SUFFIX', () => {
  it('contains the required section headers', () => {
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('## Decision');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('## Rationale');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('## Objections Addressed');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('## Next Steps');
  });

  it('contains the checklist format instruction', () => {
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('- [ ]');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('Owner:');
    expect(STRUCTURED_SYNTHESIS_PROMPT_SUFFIX).toContain('Due:');
  });
});
