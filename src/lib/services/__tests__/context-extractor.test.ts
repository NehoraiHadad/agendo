import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgendoEvent, AgendoEventPayload } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const { mockState } = vi.hoisted(() => ({
  mockState: {
    sessionResult: null as unknown,
    readFileResult: null as string | null,
    readFileError: null as Error | null,
    geminiResult: null as string | null,
    geminiError: null as Error | null,
  },
}));

// ---------------------------------------------------------------------------
// Mock @/lib/db (not used directly by context-extractor, but imported
// transitively via session-service — we mock session-service instead)
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const createFromResult = () => {
    const whereResult = () =>
      Object.assign(Promise.resolve([]), {
        limit: vi.fn().mockImplementation(() => Promise.resolve([])),
      });
    return Object.assign(Promise.resolve([]), {
      where: vi.fn().mockImplementation(whereResult),
      limit: vi.fn().mockImplementation(() => Promise.resolve([])),
    });
  };
  const mockFrom = vi.fn().mockImplementation(createFromResult);
  return {
    db: {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
      execute: vi.fn().mockResolvedValue([]),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock session-service
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/session-service', () => ({
  getSessionWithDetails: vi.fn().mockImplementation(async () => {
    if (!mockState.sessionResult) {
      throw new Error('Session not found');
    }
    return mockState.sessionResult;
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockImplementation(async () => {
    if (mockState.readFileError) throw mockState.readFileError;
    if (mockState.readFileResult === null) throw new Error('File not found');
    return mockState.readFileResult;
  }),
}));

// ---------------------------------------------------------------------------
// Mock @/lib/services/summarization-providers
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/summarization-providers', () => ({
  callSummarizationProvider: vi.fn().mockImplementation(async () => {
    if (mockState.geminiError) throw mockState.geminiError;
    if (mockState.geminiResult === null) return null;
    return { text: mockState.geminiResult, provider: 'gemini-cli' };
  }),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks
// ---------------------------------------------------------------------------
import { extractSessionContext, clearSummaryCache } from '../context-extractor';

// ---------------------------------------------------------------------------
// Helpers to build AgendoEvent log lines
// ---------------------------------------------------------------------------
let seq = 0;

function mkEvent(partial: AgendoEventPayload): string {
  seq += 1;
  const event = { id: seq, sessionId: 'sess-1', ts: Date.now(), ...partial } as AgendoEvent;
  return `[${event.id}|${event.type}] ${JSON.stringify(event)}`;
}

function buildLog(lines: string[]): string {
  return lines.join('\n') + '\n';
}

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sess-1',
    agentId: 'agent-1',
    agentName: 'Claude Code',
    agentSlug: 'claude-code-1',
    capLabel: 'Chat',
    taskTitle: 'My Task',
    projectName: 'My Project',
    logFilePath: '/tmp/test.log',
    status: 'ended',
    permissionMode: 'bypassPermissions',
    kind: 'conversation',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('context-extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seq = 0;
    mockState.sessionResult = makeSession();
    mockState.readFileResult = null;
    mockState.readFileError = null;
    mockState.geminiResult = null;
    mockState.geminiError = null;
    clearSummaryCache();
  });

  // -------------------------------------------------------------------------
  // 1. logFilePath is null
  // -------------------------------------------------------------------------
  it('returns empty context when logFilePath is null', async () => {
    mockState.sessionResult = makeSession({ logFilePath: null });

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(0);
    expect(result.meta.summarizedTurns).toBe(0);
    expect(result.meta.includedVerbatimTurns).toBe(0);
    expect(result.prompt).toBeTruthy(); // header + footer still present
    expect(result.prompt).toContain('Continue from where');
  });

  // -------------------------------------------------------------------------
  // 2. readFile throws (file doesn't exist)
  // -------------------------------------------------------------------------
  it('returns empty context when readFile throws', async () => {
    mockState.readFileError = new Error('ENOENT: no such file');

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(0);
    expect(result.meta.summarizedTurns).toBe(0);
    expect(result.prompt).toContain('Continue from where');
  });

  // -------------------------------------------------------------------------
  // 3. Log has no parseable events
  // -------------------------------------------------------------------------
  it('returns empty context when log has no parseable events', async () => {
    mockState.readFileResult = 'garbage\nnot valid json\n';

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(0);
    expect(result.meta.summarizedTurns).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Full mode: all turns rendered verbatim, summarizedTurns === 0
  // -------------------------------------------------------------------------
  it('full mode: renders all turns verbatim, summarizedTurns === 0', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Hello agent' }),
      mkEvent({ type: 'agent:text', text: 'Hi there!' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 500 }),
      mkEvent({ type: 'user:message', text: 'Do something' }),
      mkEvent({ type: 'agent:text', text: 'Done.' }),
      mkEvent({ type: 'agent:result', costUsd: 0.002, turns: 1, durationMs: 300 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(2);
    expect(result.meta.summarizedTurns).toBe(0);
    expect(result.meta.includedVerbatimTurns).toBe(2);
    expect(result.prompt).toContain('Hello agent');
    expect(result.prompt).toContain('Hi there!');
    expect(result.prompt).toContain('Do something');
    expect(result.prompt).toContain('Done.');
  });

  // -------------------------------------------------------------------------
  // 5. Hybrid mode with 7 turns, recentTurnCount=3: 4 summarized + 3 verbatim
  // -------------------------------------------------------------------------
  it('hybrid mode with 7 turns and recentTurnCount=3 yields 4 summarized + 3 verbatim', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(mkEvent({ type: 'user:message', text: `User message ${i}` }));
      lines.push(mkEvent({ type: 'agent:text', text: `Agent reply ${i}` }));
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001 * i, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 3,
    });

    expect(result.meta.totalTurns).toBe(7);
    expect(result.meta.summarizedTurns).toBe(4);
    expect(result.meta.includedVerbatimTurns).toBe(3);
    // Older turns must be in the summarized section (compact single line),
    // NOT rendered as standalone verbatim blocks.
    // The verbatim block header pattern for turn 1 would be "**Turn 1 (User):**"
    expect(result.prompt).not.toContain('**Turn 1 (User):**');
    expect(result.prompt).not.toContain('**Turn 1 (Assistant):**');
    expect(result.prompt).not.toContain('**Turn 4 (User):**');
    // Recent turns verbatim
    expect(result.prompt).toContain('User message 5');
    expect(result.prompt).toContain('User message 7');
  });

  // -------------------------------------------------------------------------
  // 6. Hybrid mode with fewer turns than recentTurnCount: 0 summarized, all verbatim
  // -------------------------------------------------------------------------
  it('hybrid mode with fewer turns than recentTurnCount: all verbatim, 0 summarized', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 2; i++) {
      lines.push(mkEvent({ type: 'user:message', text: `User ${i}` }));
      lines.push(mkEvent({ type: 'agent:text', text: `Reply ${i}` }));
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 5,
    });

    expect(result.meta.totalTurns).toBe(2);
    expect(result.meta.summarizedTurns).toBe(0);
    expect(result.meta.includedVerbatimTurns).toBe(2);
    expect(result.prompt).toContain('User 1');
    expect(result.prompt).toContain('User 2');
  });

  // -------------------------------------------------------------------------
  // 7. Tool call summarization
  // -------------------------------------------------------------------------
  it('summarizes tool calls: Edit shows file path, Bash shows command', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Fix the bug' }),
      mkEvent({ type: 'agent:text', text: 'Sure.' }),
      mkEvent({
        type: 'agent:tool-start',
        toolUseId: 'tc-1',
        toolName: 'Edit',
        input: { file_path: 'src/lib/foo.ts', old_string: 'a', new_string: 'b' },
      }),
      mkEvent({ type: 'agent:tool-end', toolUseId: 'tc-1', content: 'ok' }),
      mkEvent({
        type: 'agent:tool-start',
        toolUseId: 'tc-2',
        toolName: 'Bash',
        input: { command: 'pnpm test --run' },
      }),
      mkEvent({ type: 'agent:tool-end', toolUseId: 'tc-2', content: 'ok' }),
      mkEvent({ type: 'agent:result', costUsd: 0.005, turns: 1, durationMs: 1000 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 0, // force summary for all turns
    });

    expect(result.prompt).toContain('Edit(src/lib/foo.ts)');
    expect(result.prompt).toContain('Bash(`pnpm test --run`)');
  });

  // -------------------------------------------------------------------------
  // 8. maxChars truncation: output capped correctly
  // -------------------------------------------------------------------------
  it('truncates output to maxChars', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(
        mkEvent({
          type: 'user:message',
          text: `User message number ${i} with some extra text to make it longer`,
        }),
      );
      lines.push(
        mkEvent({
          type: 'agent:text',
          text: `Agent reply number ${i} with some extra content to make it longer`,
        }),
      );
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'full',
      maxChars: 500,
    });

    expect(result.prompt.length).toBeLessThanOrEqual(500);
  });

  // -------------------------------------------------------------------------
  // 9. estimatedTokens = Math.ceil(prompt.length / 4)
  // -------------------------------------------------------------------------
  it('estimatedTokens equals Math.ceil(prompt.length / 4)', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Hello' }),
      mkEvent({ type: 'agent:text', text: 'World' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.estimatedTokens).toBe(Math.ceil(result.prompt.length / 4));
  });

  // -------------------------------------------------------------------------
  // 10. Turn segmentation: user:message starts new turn, agent:result flushes
  // -------------------------------------------------------------------------
  it('segments turns correctly: user:message starts new turn, agent:result flushes', async () => {
    const lines = [
      // Turn 1
      mkEvent({ type: 'user:message', text: 'First question' }),
      mkEvent({ type: 'agent:text', text: 'First answer' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }),
      // Noise: non-turn events between turns
      mkEvent({ type: 'system:info', message: 'some info' }),
      // Turn 2
      mkEvent({ type: 'user:message', text: 'Second question' }),
      mkEvent({ type: 'agent:text', text: 'Second answer' }),
      mkEvent({ type: 'agent:result', costUsd: 0.002, turns: 1, durationMs: 200 }),
      // Turn 3 (no result event — flushed by next user:message start)
      mkEvent({ type: 'user:message', text: 'Third question' }),
      mkEvent({ type: 'agent:text', text: 'Third answer' }),
      mkEvent({ type: 'agent:result', costUsd: 0.003, turns: 1, durationMs: 300 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(3);
    expect(result.prompt).toContain('First question');
    expect(result.prompt).toContain('Second question');
    expect(result.prompt).toContain('Third question');
  });

  // -------------------------------------------------------------------------
  // Extra: metadata is populated from session details
  // -------------------------------------------------------------------------
  it('populates meta fields from session details', async () => {
    mockState.sessionResult = makeSession({
      agentName: 'Gemini CLI',
      agentSlug: 'gemini-cli-1',
      taskTitle: 'Refactor auth',
      projectName: 'Agendo',
    });
    mockState.readFileResult = buildLog([]);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.previousAgent).toBe('Gemini CLI');
    expect(result.meta.taskTitle).toBe('Refactor auth');
    expect(result.meta.projectName).toBe('Agendo');
  });

  // -------------------------------------------------------------------------
  // Extra: MCP tool summarization strips mcp__agendo__ prefix
  // -------------------------------------------------------------------------
  it('summarizes MCP tool calls by stripping mcp__agendo__ prefix', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Update the task' }),
      mkEvent({ type: 'agent:text', text: 'Updating.' }),
      mkEvent({
        type: 'agent:tool-start',
        toolUseId: 'mcp-1',
        toolName: 'mcp__agendo__update_task',
        input: { taskId: '123', status: 'done' },
      }),
      mkEvent({ type: 'agent:tool-end', toolUseId: 'mcp-1', content: 'ok' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 200 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 0,
    });

    expect(result.prompt).toContain('MCP(update_task)');
  });

  // -------------------------------------------------------------------------
  // Extra: agent:text-delta events are skipped
  // -------------------------------------------------------------------------
  it('skips agent:text-delta events', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Question' }),
      mkEvent({ type: 'agent:text-delta', text: 'par' }),
      mkEvent({ type: 'agent:text-delta', text: 'tial' }),
      mkEvent({ type: 'agent:text', text: 'Full answer here' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.meta.totalTurns).toBe(1);
    expect(result.prompt).toContain('Full answer here');
    // delta text should not appear as standalone content
    expect(result.prompt).not.toContain('partial');
  });

  // -------------------------------------------------------------------------
  // Extra: total cost summed across turns, omitted when all null
  // -------------------------------------------------------------------------
  it('includes total cost when costUsd is present', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Go' }),
      mkEvent({ type: 'agent:text', text: 'Done' }),
      mkEvent({ type: 'agent:result', costUsd: 0.005, turns: 1, durationMs: 100 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.prompt).toContain('cost');
  });

  it('omits total cost line when all costUsd are null', async () => {
    const lines = [
      mkEvent({ type: 'user:message', text: 'Go' }),
      mkEvent({ type: 'agent:text', text: 'Done' }),
      mkEvent({ type: 'agent:result', costUsd: null, turns: 1, durationMs: 100 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.prompt).not.toMatch(/total cost/i);
  });

  // -------------------------------------------------------------------------
  // LLM summarization tests
  // -------------------------------------------------------------------------

  it('hybrid mode uses LLM summary when Gemini succeeds', async () => {
    mockState.geminiResult =
      'The agent worked on fixing auth bugs. Modified src/auth.ts. Tests now pass.';

    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(mkEvent({ type: 'user:message', text: `User message ${i}` }));
      lines.push(mkEvent({ type: 'agent:text', text: `Agent reply ${i}` }));
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001 * i, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 3,
    });

    expect(result.prompt).toContain('summarized by AI');
    expect(result.prompt).toContain('fixing auth bugs');
    expect(result.meta.llmSummarized).toBe(true);
    // Old per-turn summary format should NOT be present
    expect(result.prompt).not.toContain('- Turn 1: User asked:');
  });

  it('hybrid mode falls back to per-turn truncation when Gemini fails', async () => {
    mockState.geminiError = new Error('Gemini CLI not available');

    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(mkEvent({ type: 'user:message', text: `User message ${i}` }));
      lines.push(mkEvent({ type: 'agent:text', text: `Agent reply ${i}` }));
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001 * i, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 3,
    });

    // Should fall back to old format
    expect(result.prompt).toContain('Earlier turns (summarized)');
    expect(result.prompt).toContain('- Turn 1: User asked:');
    expect(result.meta.llmSummarized).toBe(false);
  });

  it('full mode does not call LLM summarization', async () => {
    mockState.geminiResult = 'Should not appear';

    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(mkEvent({ type: 'user:message', text: `User message ${i}` }));
      lines.push(mkEvent({ type: 'agent:text', text: `Agent reply ${i}` }));
      lines.push(mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }));
    }
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', { mode: 'full' });

    expect(result.prompt).not.toContain('summarized by AI');
    expect(result.prompt).not.toContain('Should not appear');
  });

  it('hybrid mode skips LLM when all turns fit in verbatim window', async () => {
    mockState.geminiResult = 'Should not appear';

    const lines = [
      mkEvent({ type: 'user:message', text: 'Hello' }),
      mkEvent({ type: 'agent:text', text: 'Hi' }),
      mkEvent({ type: 'agent:result', costUsd: 0.001, turns: 1, durationMs: 100 }),
    ];
    mockState.readFileResult = buildLog(lines);

    const result = await extractSessionContext('sess-1', {
      mode: 'hybrid',
      recentTurnCount: 5,
    });

    // Only 1 turn, fits in verbatim window — no summarization needed
    expect(result.meta.summarizedTurns).toBe(0);
    expect(result.prompt).not.toContain('summarized by AI');
  });
});
