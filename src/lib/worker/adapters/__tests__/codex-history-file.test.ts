/**
 * Tests for codex-history-file.ts — reads Codex JSONL session files from disk
 * and maps them to AgendoEventPayload[] for post-restart history recovery.
 *
 * The Codex JSONL format has `{ timestamp, type, payload }` per line with types:
 *   session_meta, response_item, event_msg, turn_context
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgendoEventPayload } from '@/lib/realtime/events';

// We'll mock fs and os so tests don't touch the real filesystem
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  readCodexSessionFile,
  findCodexSessionFile,
  mapCodexJsonlToEvents,
} from '../codex-history-file';

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test fixture: minimal JSONL lines
// ---------------------------------------------------------------------------

function jsonl(...lines: Array<Record<string, unknown>>): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const SESSION_ID = '019d2c30-e774-7d83-8d11-eb27903db7a5';

const META_LINE = {
  timestamp: '2026-03-26T22:08:15.792Z',
  type: 'session_meta',
  payload: {
    id: SESSION_ID,
    timestamp: '2026-03-26T22:08:15.732Z',
    cwd: '/home/ubuntu/projects/agendo',
    cli_version: '0.104.0',
    model_provider: 'openai',
  },
};

const USER_MESSAGE_LINE = {
  timestamp: '2026-03-26T22:08:15.795Z',
  type: 'event_msg',
  payload: {
    type: 'user_message',
    message: 'Hello, please help me with this task.',
  },
};

const AGENT_REASONING_LINE = {
  timestamp: '2026-03-26T22:08:25.901Z',
  type: 'event_msg',
  payload: {
    type: 'agent_reasoning',
    text: 'Let me think about this...',
  },
};

const AGENT_MESSAGE_LINE = {
  timestamp: '2026-03-26T22:08:28.453Z',
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    message: 'I will help you implement this feature.',
  },
};

const EXEC_COMMAND_END_LINE = {
  timestamp: '2026-03-26T22:08:28.565Z',
  type: 'event_msg',
  payload: {
    type: 'exec_command_end',
    call_id: 'call_abc123',
    command: ['/bin/bash', '-lc', 'ls -la'],
    cwd: '/home/ubuntu/projects/agendo',
    stdout: '',
    stderr: '',
    aggregated_output: 'file1.ts\nfile2.ts\n',
    exit_code: 0,
    status: 'completed',
  },
};

const FUNCTION_CALL_LINE = {
  timestamp: '2026-03-26T22:08:28.477Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: '{"cmd":"ls -la","workdir":"/home/ubuntu/projects/agendo"}',
    call_id: 'call_abc123',
  },
};

const FUNCTION_CALL_OUTPUT_LINE = {
  timestamp: '2026-03-26T22:08:28.566Z',
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: 'call_abc123',
    output: 'file1.ts\nfile2.ts\n',
  },
};

const TASK_COMPLETE_LINE = {
  timestamp: '2026-03-26T22:10:37.748Z',
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: 'turn-1',
    last_agent_message: 'Done!',
  },
};

const TURN_CONTEXT_LINE = {
  timestamp: '2026-03-26T22:08:16.087Z',
  type: 'turn_context',
  payload: {
    turn_id: 'turn-1',
    model: 'gpt-5.4',
    cwd: '/home/ubuntu/projects/agendo',
  },
};

const TOKEN_COUNT_LINE = {
  timestamp: '2026-03-26T22:08:17.843Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: null,
  },
};

const DEVELOPER_MESSAGE_LINE = {
  timestamp: '2026-03-26T22:08:15.792Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [
      { type: 'input_text', text: '<permissions instructions>...</permissions instructions>' },
    ],
  },
};

const ASSISTANT_MESSAGE_LINE = {
  timestamp: '2026-03-26T22:08:28.453Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Here is my response.' }],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codex-history-file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findCodexSessionFile', () => {
    it('returns null for empty sessionRef', () => {
      expect(findCodexSessionFile('')).toBeNull();
    });

    it('finds file by scanning date directories', () => {
      // The function needs to glob for rollout-*-{sessionId}.jsonl
      // Since we mock fs, we need to test the path construction logic
      // This test verifies the function returns null when no file matches
      mockExistsSync.mockReturnValue(false);
      const result = findCodexSessionFile(SESSION_ID);
      // Without filesystem access, it returns null
      expect(result).toBeNull();
    });
  });

  describe('mapCodexJsonlToEvents', () => {
    it('maps user_message to user:message', () => {
      const events = mapCodexJsonlToEvents(jsonl(USER_MESSAGE_LINE));
      expect(events).toContainEqual({
        type: 'user:message',
        text: 'Hello, please help me with this task.',
      });
    });

    it('maps agent_message to agent:text', () => {
      const events = mapCodexJsonlToEvents(jsonl(AGENT_MESSAGE_LINE));
      expect(events).toContainEqual({
        type: 'agent:text',
        text: 'I will help you implement this feature.',
      });
    });

    it('maps agent_reasoning to agent:thinking', () => {
      const events = mapCodexJsonlToEvents(jsonl(AGENT_REASONING_LINE));
      expect(events).toContainEqual({
        type: 'agent:thinking',
        text: 'Let me think about this...',
      });
    });

    it('maps exec_command_end to tool-start + tool-end', () => {
      const events = mapCodexJsonlToEvents(jsonl(EXEC_COMMAND_END_LINE));
      const toolStart = events.find((e) => e.type === 'agent:tool-start') as
        | Extract<AgendoEventPayload, { type: 'agent:tool-start' }>
        | undefined;
      const toolEnd = events.find((e) => e.type === 'agent:tool-end') as
        | Extract<AgendoEventPayload, { type: 'agent:tool-end' }>
        | undefined;

      expect(toolStart).toBeDefined();
      expect(toolStart!.toolUseId).toBe('call_abc123');
      expect(toolStart!.toolName).toBe('Bash');

      expect(toolEnd).toBeDefined();
      expect(toolEnd!.toolUseId).toBe('call_abc123');
      expect(toolEnd!.content).toBe('file1.ts\nfile2.ts\n');
    });

    it('maps exec_command_end with non-zero exit code', () => {
      const line = {
        ...EXEC_COMMAND_END_LINE,
        payload: {
          ...EXEC_COMMAND_END_LINE.payload,
          exit_code: 1,
          aggregated_output: 'Error: command not found',
        },
      };
      const events = mapCodexJsonlToEvents(jsonl(line));
      const toolEnd = events.find((e) => e.type === 'agent:tool-end') as
        | Extract<AgendoEventPayload, { type: 'agent:tool-end' }>
        | undefined;
      expect(toolEnd).toBeDefined();
      expect(toolEnd!.content).toBe('[exit 1] Error: command not found');
    });

    it('maps task_complete to agent:result', () => {
      const events = mapCodexJsonlToEvents(jsonl(TASK_COMPLETE_LINE));
      const result = events.find((e) => e.type === 'agent:result') as
        | Extract<AgendoEventPayload, { type: 'agent:result' }>
        | undefined;
      expect(result).toBeDefined();
      expect(result!.costUsd).toBeNull();
      expect(result!.turns).toBe(1);
    });

    it('maps turn_context with model to session:init', () => {
      const events = mapCodexJsonlToEvents(jsonl(TURN_CONTEXT_LINE));
      const init = events.find((e) => e.type === 'session:init') as
        | Extract<AgendoEventPayload, { type: 'session:init' }>
        | undefined;
      expect(init).toBeDefined();
      expect(init!.model).toBe('gpt-5.4');
    });

    it('skips token_count lines (no meaningful mapping)', () => {
      const events = mapCodexJsonlToEvents(jsonl(TOKEN_COUNT_LINE));
      expect(events).toHaveLength(0);
    });

    it('skips developer message lines', () => {
      const events = mapCodexJsonlToEvents(jsonl(DEVELOPER_MESSAGE_LINE));
      expect(events).toHaveLength(0);
    });

    it('maps assistant response_item/message to agent:text', () => {
      const events = mapCodexJsonlToEvents(jsonl(ASSISTANT_MESSAGE_LINE));
      expect(events).toContainEqual({
        type: 'agent:text',
        text: 'Here is my response.',
      });
    });

    it('handles a full conversation sequence', () => {
      const content = jsonl(
        META_LINE,
        TURN_CONTEXT_LINE,
        USER_MESSAGE_LINE,
        AGENT_REASONING_LINE,
        AGENT_MESSAGE_LINE,
        FUNCTION_CALL_LINE,
        EXEC_COMMAND_END_LINE,
        FUNCTION_CALL_OUTPUT_LINE,
        TASK_COMPLETE_LINE,
      );
      const events = mapCodexJsonlToEvents(content);

      const types = events.map((e) => e.type);
      // Should have: session:init, user:message, agent:thinking, agent:text,
      // agent:tool-start, agent:tool-end, agent:result
      expect(types).toContain('session:init');
      expect(types).toContain('user:message');
      expect(types).toContain('agent:thinking');
      expect(types).toContain('agent:text');
      expect(types).toContain('agent:tool-start');
      expect(types).toContain('agent:tool-end');
      expect(types).toContain('agent:result');
    });

    it('skips session_meta (no event mapping)', () => {
      const events = mapCodexJsonlToEvents(jsonl(META_LINE));
      expect(events).toHaveLength(0);
    });
  });

  describe('mapCodexJsonlToEvents — malformed data', () => {
    it('skips malformed JSON lines gracefully', () => {
      const content = '{"bad json\n' + JSON.stringify(AGENT_MESSAGE_LINE) + '\n';
      const events = mapCodexJsonlToEvents(content);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent:text');
    });

    it('skips empty lines', () => {
      const content = '\n\n' + JSON.stringify(AGENT_MESSAGE_LINE) + '\n\n';
      const events = mapCodexJsonlToEvents(content);
      expect(events).toHaveLength(1);
    });

    it('handles completely empty content', () => {
      const events = mapCodexJsonlToEvents('');
      expect(events).toHaveLength(0);
    });

    it('handles lines with missing payload', () => {
      const events = mapCodexJsonlToEvents(jsonl({ timestamp: '2026-01-01', type: 'event_msg' }));
      expect(events).toHaveLength(0);
    });

    it('handles event_msg with unknown payload type', () => {
      const events = mapCodexJsonlToEvents(
        jsonl({
          timestamp: '2026-01-01',
          type: 'event_msg',
          payload: { type: 'unknown_future_type', data: 'foo' },
        }),
      );
      expect(events).toHaveLength(0);
    });
  });

  describe('readCodexSessionFile', () => {
    it('returns empty array when sessionRef is empty', () => {
      const result = readCodexSessionFile('');
      expect(result).toEqual([]);
    });

    it('returns empty array when file is not found', () => {
      mockExistsSync.mockReturnValue(false);
      const result = readCodexSessionFile(SESSION_ID);
      expect(result).toEqual([]);
    });

    it('returns events when file exists and has valid content', () => {
      const content = jsonl(USER_MESSAGE_LINE, AGENT_MESSAGE_LINE, TASK_COMPLETE_LINE);
      // Mock filesystem: sessions dir exists, date dir exists, file found
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue([`rollout-2026-03-26T22-08-15-${SESSION_ID}.jsonl`]);
      mockReadFileSync.mockReturnValue(content);

      const result = readCodexSessionFile(SESSION_ID);
      expect(result.length).toBeGreaterThan(0);

      const types = result.map((e) => e.type);
      expect(types).toContain('user:message');
      expect(types).toContain('agent:text');
      expect(types).toContain('agent:result');
    });

    it('returns empty array on read error', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });
      const result = readCodexSessionFile(SESSION_ID);
      expect(result).toEqual([]);
    });
  });
});
