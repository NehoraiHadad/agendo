import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    dirs: new Map<string, string[]>(), // path → list of names
    files: new Map<string, string>(), // path → content
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

import { readGeminiSession } from '../gemini-reader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? '/root';
const GEMINI_TMP = `${HOME}/.gemini/tmp`;

interface MockGeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  content: string | Array<{ text: string }>;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: Array<{
      functionResponse?: {
        id: string;
        name: string;
        response: Record<string, unknown>;
      };
    }>;
    status?: string;
  }>;
}

function makeGeminiFile(sessionId: string, messages: MockGeminiMessage[]): string {
  return JSON.stringify({
    sessionId,
    projectHash: 'deadbeef',
    startTime: '2026-01-01T00:00:00Z',
    messages,
  });
}

function setupGeminiFs(sessionId: string, fileContent: string): string {
  const projectDir = 'my-project';
  const chatsDir = `${GEMINI_TMP}/${projectDir}/chats`;
  const prefix8 = sessionId.slice(0, 8);
  const fileName = `session-2026-01-01T00-00-${prefix8}.json`;
  const filePath = `${chatsDir}/${fileName}`;

  mockFs.dirs.set(GEMINI_TMP, [projectDir]);
  mockFs.dirs.set(chatsDir, [fileName]);
  mockFs.files.set(filePath, fileContent);

  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readGeminiSession', () => {
  const SESSION_REF = 'aabbccdd-1111-2222-3333-444455556666';

  beforeEach(() => {
    mockFs.dirs.clear();
    mockFs.files.clear();
  });

  it('returns null when gemini tmp dir does not exist', async () => {
    // dirs map is empty — readdir will throw
    const result = await readGeminiSession(SESSION_REF);
    expect(result).toBeNull();
  });

  it('returns null when no file matches the sessionId', async () => {
    const projectDir = 'my-project';
    const chatsDir = `${GEMINI_TMP}/${projectDir}/chats`;
    mockFs.dirs.set(GEMINI_TMP, [projectDir]);
    mockFs.dirs.set(chatsDir, ['session-2026-01-01T00-00-ffffffff.json']);
    mockFs.files.set(
      `${chatsDir}/session-2026-01-01T00-00-ffffffff.json`,
      JSON.stringify({ sessionId: 'ffffffff-0000-0000-0000-000000000000', messages: [] }),
    );

    const result = await readGeminiSession(SESSION_REF);
    expect(result).toBeNull();
  });

  it('parses a simple user+gemini exchange', async () => {
    const messages: MockGeminiMessage[] = [
      {
        id: 'msg-1',
        timestamp: '2026-01-01T00:00:01Z',
        type: 'user',
        content: 'Hello from user',
      },
      {
        id: 'msg-2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'Hello from Gemini',
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gemini');
    expect(result!.sessionId).toBe(SESSION_REF);
    expect(result!.turns).toHaveLength(2);

    const userTurn = result!.turns[0];
    expect(userTurn.role).toBe('user');
    expect(userTurn.text).toBe('Hello from user');

    const assistantTurn = result!.turns[1];
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.text).toBe('Hello from Gemini');
  });

  it('extracts toolCalls and results from gemini messages', async () => {
    const messages: MockGeminiMessage[] = [
      {
        id: 'msg-1',
        timestamp: '2026-01-01T00:00:01Z',
        type: 'user',
        content: 'List files',
      },
      {
        id: 'msg-2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'I will list them',
        toolCalls: [
          {
            id: 'list_dir-123',
            name: 'list_directory',
            args: { dir_path: '/home' },
            result: [
              {
                functionResponse: {
                  id: 'list_dir-123',
                  name: 'list_directory',
                  response: { output: 'ubuntu\n' },
                },
              },
            ],
            status: 'success',
          },
        ],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF);
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns[1];
    expect(assistantTurn.toolCalls).toHaveLength(1);
    expect(assistantTurn.toolCalls[0].toolName).toBe('list_directory');
    expect(assistantTurn.toolCalls[0].toolUseId).toBe('list_dir-123');
    expect(assistantTurn.toolResults).toHaveLength(1);
    expect(assistantTurn.toolResults[0].content).toBe('ubuntu\n');
  });

  it('truncates tool results when maxToolResultChars is set', async () => {
    const longOutput = 'y'.repeat(3000);
    const messages: MockGeminiMessage[] = [
      { id: 'm1', timestamp: '2026-01-01T00:00:01Z', type: 'user', content: 'Go' },
      {
        id: 'm2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'Done',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'read_file',
            args: { file_path: '/big.txt' },
            result: [
              {
                functionResponse: {
                  id: 'tc-1',
                  name: 'read_file',
                  response: { output: longOutput },
                },
              },
            ],
          },
        ],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF, { maxToolResultChars: 50 });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns[1];
    expect(assistantTurn.toolResults[0].content).toContain('...(truncated)');
    expect(assistantTurn.toolResults[0].content.length).toBe(50 + '...(truncated)'.length);
  });

  it('omits tool results when includeToolResults=false', async () => {
    const messages: MockGeminiMessage[] = [
      { id: 'm1', timestamp: '2026-01-01T00:00:01Z', type: 'user', content: 'Go' },
      {
        id: 'm2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'Done',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'read_file',
            args: {},
            result: [
              {
                functionResponse: {
                  id: 'tc-1',
                  name: 'read_file',
                  response: { output: 'some content' },
                },
              },
            ],
          },
        ],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF, { includeToolResults: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns[1];
    expect(assistantTurn.toolCalls).toHaveLength(1); // still has toolCalls
    expect(assistantTurn.toolResults).toHaveLength(0); // no results
  });

  it('skips bash output when includeBashOutput=false', async () => {
    const messages: MockGeminiMessage[] = [
      { id: 'm1', timestamp: '2026-01-01T00:00:01Z', type: 'user', content: 'Run stuff' },
      {
        id: 'm2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'Running',
        toolCalls: [
          {
            id: 'tc-bash',
            name: 'run_shell_command',
            args: { command: 'ls' },
            result: [
              {
                functionResponse: {
                  id: 'tc-bash',
                  name: 'run_shell_command',
                  response: { output: 'file1\nfile2\n' },
                },
              },
            ],
          },
          {
            id: 'tc-read',
            name: 'read_file',
            args: { file_path: '/x' },
            result: [
              {
                functionResponse: {
                  id: 'tc-read',
                  name: 'read_file',
                  response: { output: 'file content' },
                },
              },
            ],
          },
        ],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF, { includeBashOutput: false });
    expect(result).not.toBeNull();

    const assistantTurn = result!.turns[1];
    expect(assistantTurn.toolCalls).toHaveLength(2);
    // Only non-shell result included
    expect(assistantTurn.toolResults).toHaveLength(1);
    expect(assistantTurn.toolResults[0].toolUseId).toBe('tc-read');
  });

  it('applies maxTurns (keep last N turns)', async () => {
    const messages: MockGeminiMessage[] = [];
    for (let n = 0; n < 6; n++) {
      messages.push({
        id: `u${n}`,
        timestamp: '2026-01-01T00:00:01Z',
        type: 'user',
        content: `User ${n}`,
      });
      messages.push({
        id: `g${n}`,
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: `Reply ${n}`,
      });
    }
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF, { maxTurns: 3 });
    expect(result).not.toBeNull();
    expect(result!.turns).toHaveLength(3);
    // Re-indexed
    expect(result!.turns[0].index).toBe(1);
  });

  it('handles user content as array of text items', async () => {
    const messages: MockGeminiMessage[] = [
      {
        id: 'm1',
        timestamp: '2026-01-01T00:00:01Z',
        type: 'user',
        content: [{ text: 'Part A' }, { text: ' Part B' }],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF);
    expect(result).not.toBeNull();
    expect(result!.turns[0].text).toBe('Part A Part B');
  });

  it('tracks rawResultChars correctly', async () => {
    const output = 'hello'; // 5 chars
    const messages: MockGeminiMessage[] = [
      { id: 'm1', timestamp: '2026-01-01T00:00:01Z', type: 'user', content: 'Go' },
      {
        id: 'm2',
        timestamp: '2026-01-01T00:00:02Z',
        type: 'gemini',
        content: 'Done',
        toolCalls: [
          {
            id: 'tc-1',
            name: 'read_file',
            args: {},
            result: [
              {
                functionResponse: {
                  id: 'tc-1',
                  name: 'read_file',
                  response: { output },
                },
              },
            ],
          },
        ],
      },
    ];
    setupGeminiFs(SESSION_REF, makeGeminiFile(SESSION_REF, messages));

    const result = await readGeminiSession(SESSION_REF);
    expect(result).not.toBeNull();
    expect(result!.rawResultChars).toBe(output.length);
  });
});
