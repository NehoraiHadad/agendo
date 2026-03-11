import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    files: new Map<string, string>(),
    accessError: null as Error | null,
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockImplementation(async (filePath: string) => {
    const content = mockFs.files.get(filePath);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
    }
    return content;
  }),
  access: vi.fn().mockImplementation(async (filePath: string) => {
    if (mockFs.accessError) throw mockFs.accessError;
    if (!mockFs.files.has(filePath)) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
    }
  }),
}));

import { readClaudeSession } from '../claude-reader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build path the reader expects for a given sessionRef + cwd */
function claudePath(sessionRef: string, cwd: string): string {
  const home = process.env.HOME ?? '/root';
  const hash = cwd.replace(/\//g, '-');
  return `${home}/.claude/projects/${hash}/${sessionRef}.jsonl`;
}

function userLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    sessionId,
    message: { role: 'user', content: text },
  });
}

function userLineWithBlocks(sessionId: string, blocks: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    sessionId,
    message: { role: 'user', content: blocks },
  });
}

function assistantLine(sessionId: string, content: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId,
    message: { role: 'assistant', content, model: 'claude-opus-4-5', stop_reason: 'end_turn' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readClaudeSession', () => {
  const SESSION_REF = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CWD = '/home/ubuntu/projects/test';
  const FILE_PATH = claudePath(SESSION_REF, CWD);

  beforeEach(() => {
    mockFs.files.clear();
    mockFs.accessError = null;
  });

  it('returns null when the file does not exist', async () => {
    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).toBeNull();
  });

  it('returns null when access throws an error', async () => {
    mockFs.accessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).toBeNull();
  });

  it('parses a simple user+assistant exchange', async () => {
    const lines = [
      userLine(SESSION_REF, 'Hello agent'),
      assistantLine(SESSION_REF, [{ type: 'text', text: 'Hello user' }]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('claude');
    expect(result!.sessionId).toBe(SESSION_REF);

    // Should have 2 turns: user + assistant
    const userTurn = result!.turns.find((t) => t.role === 'user');
    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(userTurn).toBeDefined();
    expect(userTurn!.text).toBe('Hello agent');
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toBe('Hello user');
  });

  it('skips sidechain messages', async () => {
    const sidechain = JSON.stringify({
      type: 'user',
      isSidechain: true,
      sessionId: SESSION_REF,
      message: { role: 'user', content: 'should be skipped' },
    });
    const lines = [
      sidechain,
      userLine(SESSION_REF, 'Real message'),
      assistantLine(SESSION_REF, [{ type: 'text', text: 'Real response' }]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();
    const userTurns = result!.turns.filter((t) => t.role === 'user');
    // Only 1 user turn (sidechain skipped)
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].text).toBe('Real message');
  });

  it('skips file-history-snapshot and queue-operation lines', async () => {
    const snapshot = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'abc',
      snapshot: {},
    });
    const queueOp = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
    });
    const lines = [
      snapshot,
      queueOp,
      userLine(SESSION_REF, 'Hello'),
      assistantLine(SESSION_REF, [{ type: 'text', text: 'Hi' }]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();
    expect(result!.turns.length).toBeGreaterThan(0);
  });

  it('attaches tool_results to the preceding assistant turn', async () => {
    const toolUseId = 'toolu_01';
    const lines = [
      userLine(SESSION_REF, 'Read a file'),
      assistantLine(SESSION_REF, [
        { type: 'text', text: 'I will read it' },
        { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/tmp/foo.txt' } },
      ]),
      userLineWithBlocks(SESSION_REF, [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'file content here' },
      ]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.toolCalls).toHaveLength(1);
    expect(assistantTurn!.toolCalls[0].toolName).toBe('Read');
    expect(assistantTurn!.toolResults).toHaveLength(1);
    expect(assistantTurn!.toolResults[0].content).toBe('file content here');
    expect(assistantTurn!.toolResults[0].toolUseId).toBe(toolUseId);
  });

  it('truncates tool results when maxToolResultChars is set', async () => {
    const toolUseId = 'toolu_02';
    const longContent = 'x'.repeat(5000);
    const lines = [
      userLine(SESSION_REF, 'Read a large file'),
      assistantLine(SESSION_REF, [
        { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/big.txt' } },
      ]),
      userLineWithBlocks(SESSION_REF, [
        { type: 'tool_result', tool_use_id: toolUseId, content: longContent },
      ]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD, {
      maxToolResultChars: 100,
    });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.toolResults[0].content).toHaveLength(100 + '...(truncated)'.length);
    expect(assistantTurn!.toolResults[0].content).toContain('...(truncated)');
  });

  it('omits tool results when includeToolResults=false', async () => {
    const toolUseId = 'toolu_03';
    const lines = [
      userLine(SESSION_REF, 'Do something'),
      assistantLine(SESSION_REF, [
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'echo hi' } },
      ]),
      userLineWithBlocks(SESSION_REF, [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'hi' },
      ]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD, { includeToolResults: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.toolResults).toHaveLength(0);
  });

  it('skips Bash tool results when includeBashOutput=false', async () => {
    const bashId = 'toolu_bash';
    const readId = 'toolu_read';
    const lines = [
      userLine(SESSION_REF, 'Do work'),
      assistantLine(SESSION_REF, [
        { type: 'tool_use', id: bashId, name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: readId, name: 'Read', input: { file_path: '/x' } },
      ]),
      userLineWithBlocks(SESSION_REF, [
        { type: 'tool_result', tool_use_id: bashId, content: 'bash output' },
        { type: 'tool_result', tool_use_id: readId, content: 'file content' },
      ]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD, { includeBashOutput: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    // Only the non-Bash result should be included
    expect(assistantTurn!.toolResults).toHaveLength(1);
    expect(assistantTurn!.toolResults[0].toolUseId).toBe(readId);
  });

  it('applies maxTurns limit', async () => {
    const lines: string[] = [];
    // Build 5 user+assistant exchanges
    for (let n = 0; n < 5; n++) {
      lines.push(userLine(SESSION_REF, `Message ${n}`));
      lines.push(assistantLine(SESSION_REF, [{ type: 'text', text: `Response ${n}` }]));
    }
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD, { maxTurns: 2 });
    expect(result).not.toBeNull();
    expect(result!.turns.length).toBe(2);
    // Re-indexed from 0
    expect(result!.turns[0].index).toBe(0);
    expect(result!.turns[1].index).toBe(1);
  });

  it('tracks rawResultChars correctly', async () => {
    const toolUseId = 'toolu_04';
    const content = 'hello world'; // 11 chars
    const lines = [
      userLine(SESSION_REF, 'Do it'),
      assistantLine(SESSION_REF, [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }]),
      userLineWithBlocks(SESSION_REF, [{ type: 'tool_result', tool_use_id: toolUseId, content }]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();
    expect(result!.rawResultChars).toBe(content.length);
  });

  it('skips thinking blocks in assistant messages', async () => {
    const lines = [
      userLine(SESSION_REF, 'Think about it'),
      assistantLine(SESSION_REF, [
        { type: 'thinking', thinking: 'Internal thoughts...' },
        { type: 'text', text: 'My answer' },
      ]),
    ];
    mockFs.files.set(FILE_PATH, lines.join('\n'));

    const result = await readClaudeSession(SESSION_REF, CWD);
    expect(result).not.toBeNull();
    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.text).toBe('My answer');
    // No tool calls from thinking blocks
    expect(assistantTurn!.toolCalls).toHaveLength(0);
  });
});
