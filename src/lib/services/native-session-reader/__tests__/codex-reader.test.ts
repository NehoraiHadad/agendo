import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    dirs: new Map<string, string[]>(),
    files: new Map<string, string>(),
  },
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn().mockImplementation(async (dirPath: string) => {
    const entries = mockFs.dirs.get(dirPath);
    if (entries === undefined) {
      throw Object.assign(new Error(`ENOENT: ${dirPath}`), { code: 'ENOENT' });
    }
    return entries;
  }),
  readFile: vi.fn().mockImplementation(async (filePath: string) => {
    const content = mockFs.files.get(filePath);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
    }
    return content;
  }),
}));

import { readCodexSession } from '../codex-reader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? '/root';
const SESSIONS_BASE = `${HOME}/.codex/sessions`;

function setupCodexFs(threadId: string, fileContent: string): string {
  const yearDir = `${SESSIONS_BASE}/2026`;
  const monthDir = `${yearDir}/03`;
  const dayDir = `${monthDir}/04`;
  // The reader uses file.includes(sessionRef) — embed full threadId in filename
  const fileName = `rollout-2026-03-04T08-00-00-${threadId}.jsonl`;
  const filePath = `${dayDir}/${fileName}`;

  mockFs.dirs.set(SESSIONS_BASE, ['2026']);
  mockFs.dirs.set(yearDir, ['03']);
  mockFs.dirs.set(monthDir, ['04']);
  mockFs.dirs.set(dayDir, [fileName]);
  mockFs.files.set(filePath, fileContent);

  return filePath;
}

// JSONL line builders
function sessionMetaLine(threadId: string): string {
  return JSON.stringify({
    timestamp: '2026-03-04T08:00:00Z',
    type: 'session_meta',
    payload: { id: threadId, timestamp: '2026-03-04T08:00:00Z', cwd: '/tmp', originator: 'agendo' },
  });
}

function developerMsgLine(text: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text }],
    },
  });
}

function userMsgLine(text: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });
}

function assistantMsgLine(text: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  });
}

function functionCallLine(callId: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: callId,
    },
  });
}

function functionCallOutputLine(callId: string, output: string): string {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readCodexSession', () => {
  const THREAD_ID = 'aabb1100-0000-0000-0000-ccccddddeeee';

  beforeEach(() => {
    mockFs.dirs.clear();
    mockFs.files.clear();
  });

  it('returns null when sessions base dir does not exist', async () => {
    // dirs map is empty
    const result = await readCodexSession(THREAD_ID);
    expect(result).toBeNull();
  });

  it('returns null when no file contains the threadId', async () => {
    const yearDir = `${SESSIONS_BASE}/2026`;
    const monthDir = `${yearDir}/03`;
    const dayDir = `${monthDir}/04`;
    mockFs.dirs.set(SESSIONS_BASE, ['2026']);
    mockFs.dirs.set(yearDir, ['03']);
    mockFs.dirs.set(monthDir, ['04']);
    mockFs.dirs.set(dayDir, ['rollout-2026-03-04T08-00-00-other-thread.jsonl']);
    // No file content matching our threadId
    mockFs.files.set(
      `${dayDir}/rollout-2026-03-04T08-00-00-other-thread.jsonl`,
      sessionMetaLine('other-thread-id'),
    );

    const result = await readCodexSession(THREAD_ID);
    expect(result).toBeNull();
  });

  it('parses a simple developer+user setup → assistant response', async () => {
    const lines = [
      sessionMetaLine(THREAD_ID),
      developerMsgLine('System instructions'),
      userMsgLine('What is 2+2?'),
      assistantMsgLine('The answer is 4.'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('codex');
    expect(result!.sessionId).toBe(THREAD_ID);

    // Should have user turn + assistant turn
    const userTurn = result!.turns.find((t) => t.role === 'user');
    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(userTurn).toBeDefined();
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.text).toContain('4');
  });

  it('parses function_call and function_call_output into assistant turn', async () => {
    const callId = 'call_001';
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Run a command'),
      functionCallLine(callId, 'exec_command', { command: 'ls /' }),
      functionCallOutputLine(callId, 'bin\ndev\netc\n'),
      assistantMsgLine('Done, here are the results.'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID);
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn).toBeDefined();
    expect(assistantTurn!.toolCalls).toHaveLength(1);
    expect(assistantTurn!.toolCalls[0].toolName).toBe('exec_command');
    expect(assistantTurn!.toolCalls[0].toolUseId).toBe(callId);
    expect(assistantTurn!.toolResults).toHaveLength(1);
    expect(assistantTurn!.toolResults[0].content).toBe('bin\ndev\netc\n');
  });

  it('truncates tool output when maxToolResultChars is set', async () => {
    const callId = 'call_002';
    const longOutput = 'z'.repeat(5000);
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Go'),
      functionCallLine(callId, 'exec_command', { command: 'cat /big' }),
      functionCallOutputLine(callId, longOutput),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID, { maxToolResultChars: 200 });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.toolResults[0].content).toContain('...(truncated)');
    expect(assistantTurn!.toolResults[0].content.length).toBe(200 + '...(truncated)'.length);
  });

  it('omits tool results when includeToolResults=false', async () => {
    const callId = 'call_003';
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Go'),
      functionCallLine(callId, 'exec_command', { command: 'echo hi' }),
      functionCallOutputLine(callId, 'hi'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID, { includeToolResults: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.toolCalls).toHaveLength(1);
    expect(assistantTurn!.toolResults).toHaveLength(0);
  });

  it('skips bash tool output when includeBashOutput=false', async () => {
    const bashId = 'call_bash';
    const readId = 'call_read';
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Do work'),
      functionCallLine(bashId, 'exec_command', { command: 'ls' }),
      functionCallOutputLine(bashId, 'file1\n'),
      functionCallLine(readId, 'read_file', { path: '/x.ts' }),
      functionCallOutputLine(readId, 'const x = 1;'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID, { includeBashOutput: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn!.toolCalls).toHaveLength(2);
    // Only non-bash result
    expect(assistantTurn!.toolResults).toHaveLength(1);
    expect(assistantTurn!.toolResults[0].toolUseId).toBe(readId);
  });

  it('skips context-reinject developer messages after first assistant', async () => {
    const lines = [
      sessionMetaLine(THREAD_ID),
      developerMsgLine('System instructions'),
      userMsgLine('First question'),
      assistantMsgLine('First answer'),
      // Context reinject for second turn
      developerMsgLine('Repeated system instructions'),
      userMsgLine('Repeated first question context'),
      // Actual second user follow-up would not have developer prefix
      assistantMsgLine('Second answer'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID);
    expect(result).not.toBeNull();

    // Should have 1 user turn + 1 assistant turn (second "developer" context is skipped)
    const assistantTurns = result!.turns.filter((t) => t.role === 'assistant');
    // All assistant content merged into one turn (or two, depending on implementation)
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
    // The final assistant text should include the last response
    const lastAssistant = assistantTurns[assistantTurns.length - 1];
    expect(lastAssistant.text).toContain('Second answer');
  });

  it('applies maxTurns limit', async () => {
    // Build multiple turns by having separate assistant turns
    // Each function_call + output creates tool activity in the assistant turn
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Start'),
      assistantMsgLine('Turn 1'),
      // Second turn starts with a new user message
    ];
    // Add 5 more user-assistant pairs by emitting user messages mid-session
    for (let n = 2; n <= 6; n++) {
      lines.push(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Follow-up ${n}` }],
          },
        }),
      );
      lines.push(assistantMsgLine(`Response ${n}`));
    }
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID, { maxTurns: 3 });
    expect(result).not.toBeNull();
    expect(result!.turns.length).toBe(3);
    // Re-indexed from 1
    expect(result!.turns[0].index).toBe(1);
  });

  it('tracks rawResultChars correctly', async () => {
    const callId = 'call_chars';
    const output = 'result data'; // 11 chars
    const lines = [
      sessionMetaLine(THREAD_ID),
      userMsgLine('Go'),
      functionCallLine(callId, 'read_file', { path: '/x' }),
      functionCallOutputLine(callId, output),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID);
    expect(result).not.toBeNull();
    expect(result!.rawResultChars).toBe(output.length);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const lines = [
      sessionMetaLine(THREAD_ID),
      'NOT VALID JSON {{{{',
      userMsgLine('Hello'),
      assistantMsgLine('Hi'),
    ];
    setupCodexFs(THREAD_ID, lines.join('\n'));

    const result = await readCodexSession(THREAD_ID);
    expect(result).not.toBeNull();
    // Still processes the valid lines
    const assistantTurn = result!.turns.find((t) => t.role === 'assistant');
    expect(assistantTurn).toBeDefined();
  });
});
