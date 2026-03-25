/**
 * Tests for claude-history.ts — maps Claude SDK getSessionMessages() output
 * to AgendoEventPayload[] for SSE reconnect fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  buildConversationChain,
  mapClaudeJsonlToEvents,
  mapClaudeSessionMessages,
} from '../claude-history';
import type { ChainNode, RawUserRecord, RawAssistantRecord } from '../claude-history';
import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Helper: build a minimal SessionMessage-like object
// ---------------------------------------------------------------------------

interface MockSessionMessage {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: null;
}

function makeUserMessage(text: string, uuid = 'u-1'): MockSessionMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'sess-1',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

function makeAssistantTextMessage(
  text: string,
  uuid = 'a-1',
  model = 'claude-opus-4-6',
): MockSessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      id: 'msg_01',
      model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    parent_tool_use_id: null,
  };
}

function makeAssistantToolUseMessage(
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown>,
  uuid = 'a-2',
): MockSessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-1',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      id: 'msg_02',
      model: 'claude-opus-4-6',
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 100 },
    },
    parent_tool_use_id: null,
  };
}

function makeToolResultMessage(
  toolUseId: string,
  resultText: string,
  uuid = 'u-2',
): MockSessionMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'sess-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultText }],
    },
    parent_tool_use_id: null,
  };
}

function makeAssistantThinkingMessage(
  thinkingText: string,
  assistantText: string,
  uuid = 'a-3',
): MockSessionMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: 'sess-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thinkingText, signature: 'sig' },
        { type: 'text', text: assistantText },
      ],
      id: 'msg_03',
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 300, output_tokens: 150 },
    },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapClaudeSessionMessages', () => {
  it('returns empty array for empty input', () => {
    expect(mapClaudeSessionMessages([])).toEqual([]);
  });

  it('maps a simple user message to user:message', () => {
    const messages = [makeUserMessage('Hello world')];
    const events = mapClaudeSessionMessages(messages);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user:message',
      text: 'Hello world',
    });
  });

  it('maps an assistant text message to agent:text', () => {
    const messages = [makeAssistantTextMessage('I will help you')];
    const events = mapClaudeSessionMessages(messages);

    const textEvents = events.filter((e) => e.type === 'agent:text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toMatchObject({
      type: 'agent:text',
      text: 'I will help you',
    });
  });

  it('maps assistant thinking blocks to agent:thinking', () => {
    const messages = [makeAssistantThinkingMessage('Let me think...', 'Here is my answer')];
    const events = mapClaudeSessionMessages(messages);

    const thinkingEvents = events.filter((e) => e.type === 'agent:thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]).toMatchObject({
      type: 'agent:thinking',
      text: 'Let me think...',
    });

    const textEvents = events.filter((e) => e.type === 'agent:text');
    expect(textEvents).toHaveLength(1);
  });

  it('maps tool_use to agent:tool-start and pairs with tool_result as agent:tool-end', () => {
    const messages = [
      makeAssistantToolUseMessage('Read', 'toolu_01', { file_path: '/tmp/foo.ts' }),
      makeToolResultMessage('toolu_01', 'File contents here'),
    ];
    const events = mapClaudeSessionMessages(messages);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toMatchObject({
      type: 'agent:tool-start',
      toolUseId: 'toolu_01',
      toolName: 'Read',
      input: { file_path: '/tmp/foo.ts' },
    });

    const toolEnds = events.filter((e) => e.type === 'agent:tool-end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]).toMatchObject({
      type: 'agent:tool-end',
      toolUseId: 'toolu_01',
      content: 'File contents here',
    });
  });

  it('handles a full conversation: user → assistant (thinking + text + tool) → tool_result → assistant', () => {
    const messages = [
      makeUserMessage('Fix the bug', 'u-1'),
      makeAssistantToolUseMessage('Edit', 'toolu_02', { file_path: '/tmp/bar.ts' }, 'a-1'),
      makeToolResultMessage('toolu_02', 'File updated', 'u-2'),
      makeAssistantTextMessage('Done! The bug is fixed.', 'a-2'),
    ];
    const events = mapClaudeSessionMessages(messages);

    const types = events.map((e) => e.type);
    expect(types).toContain('user:message');
    expect(types).toContain('agent:tool-start');
    expect(types).toContain('agent:tool-end');
    expect(types).toContain('agent:text');
  });

  it('emits agent:result after each assistant turn', () => {
    const messages = [makeUserMessage('Hello'), makeAssistantTextMessage('Hi there')];
    const events = mapClaudeSessionMessages(messages);

    const results = events.filter((e) => e.type === 'agent:result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });
  });

  it('handles user messages with image content blocks', () => {
    const messages: MockSessionMessage[] = [
      {
        type: 'user',
        uuid: 'u-img',
        session_id: 'sess-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', data: 'abc', media_type: 'image/png' } },
          ],
        },
        parent_tool_use_id: null,
      },
    ];
    const events = mapClaudeSessionMessages(messages);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user:message',
      text: 'What is this?',
      hasImage: true,
    });
  });

  it('handles tool_use with no matching tool_result (session interrupted)', () => {
    const messages = [makeAssistantToolUseMessage('Bash', 'toolu_orphan', { command: 'ls' })];
    const events = mapClaudeSessionMessages(messages);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(1);
    // No tool-end since there's no tool_result message
    const toolEnds = events.filter((e) => e.type === 'agent:tool-end');
    expect(toolEnds).toHaveLength(0);
  });

  it('handles multiple tool_use blocks in a single assistant message', () => {
    const msg: MockSessionMessage = {
      type: 'assistant',
      uuid: 'a-multi',
      session_id: 'sess-1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: { pattern: 'foo' } },
        ],
        id: 'msg_multi',
        model: 'claude-opus-4-6',
        stop_reason: 'tool_use',
        usage: { input_tokens: 500, output_tokens: 200 },
      },
      parent_tool_use_id: null,
    };
    const events = mapClaudeSessionMessages([msg]);

    const toolStarts = events.filter((e) => e.type === 'agent:tool-start');
    expect(toolStarts).toHaveLength(2);
    expect(
      (toolStarts[0] as Extract<AgendoEventPayload, { type: 'agent:tool-start' }>).toolName,
    ).toBe('Read');
    expect(
      (toolStarts[1] as Extract<AgendoEventPayload, { type: 'agent:tool-start' }>).toolName,
    ).toBe('Grep');
  });
});

// ---------------------------------------------------------------------------
// Helpers for buildConversationChain tests
// ---------------------------------------------------------------------------

function makeRawUserRecord(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  text = 'msg',
): RawUserRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp,
    permissionMode: 'bypassPermissions',
    cwd: '/tmp',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  };
}

function makeRawAssistantRecord(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  text = 'reply',
): RawAssistantRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp,
    requestId: `req-${uuid}`,
    cwd: '/tmp',
    gitBranch: 'main',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
      id: `msg-${uuid}`,
    },
  };
}

function makeProgressNode(uuid: string, parentUuid: string, timestamp: string): ChainNode {
  return {
    type: 'progress',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// buildConversationChain tests
// ---------------------------------------------------------------------------

describe('buildConversationChain', () => {
  it('traverses through progress records to build the full chain', () => {
    // Simulates the real bug: user→progress→progress→assistant→progress→user
    // Without progress records in the traversal map, the chain breaks.
    const base = '2026-03-25T06:00:';
    const conversationRecords = [
      makeRawUserRecord('u1', null, `${base}00.000Z`, 'hello'),
      makeRawAssistantRecord('a1', 'p2', `${base}03.000Z`, 'thinking...'),
      makeRawUserRecord('u2', 'p4', `${base}06.000Z`, 'continue'),
      makeRawAssistantRecord('a2', 'u2', `${base}07.000Z`, 'done'),
    ];

    const allChainNodes: ChainNode[] = [
      // user record
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        timestamp: `${base}00.000Z`,
      },
      // progress records linking u1 → a1
      {
        type: 'progress',
        uuid: 'p1',
        parentUuid: 'u1',
        isSidechain: false,
        timestamp: `${base}01.000Z`,
      },
      {
        type: 'progress',
        uuid: 'p2',
        parentUuid: 'p1',
        isSidechain: false,
        timestamp: `${base}02.000Z`,
      },
      // assistant record (parentUuid = p2, a progress record!)
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'p2',
        isSidechain: false,
        timestamp: `${base}03.000Z`,
      },
      // more progress records linking a1 → u2
      {
        type: 'progress',
        uuid: 'p3',
        parentUuid: 'a1',
        isSidechain: false,
        timestamp: `${base}04.000Z`,
      },
      {
        type: 'progress',
        uuid: 'p4',
        parentUuid: 'p3',
        isSidechain: false,
        timestamp: `${base}05.000Z`,
      },
      // user record (parentUuid = p4, a progress record!)
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'p4',
        isSidechain: false,
        timestamp: `${base}06.000Z`,
      },
      // assistant record
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        isSidechain: false,
        timestamp: `${base}07.000Z`,
      },
    ];

    const chain = buildConversationChain(conversationRecords, allChainNodes);

    // Should get ALL 4 conversation records, traversing through progress nodes
    expect(chain).toHaveLength(4);
    expect(chain.map((r) => r.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('without allChainNodes, chain breaks at progress record boundaries', () => {
    // This test demonstrates the bug when no chain nodes are provided:
    // u2.parentUuid = 'p4' (a progress record), but p4 is not in byUuid
    // → chain walk stops at u2, losing u1 and a1.
    const base = '2026-03-25T06:00:';
    const conversationRecords = [
      makeRawUserRecord('u1', null, `${base}00.000Z`, 'hello'),
      makeRawAssistantRecord('a1', 'u1', `${base}01.000Z`, 'hi'),
      makeRawUserRecord('u2', 'p1', `${base}04.000Z`, 'continue'), // parentUuid is a progress record
      makeRawAssistantRecord('a2', 'u2', `${base}05.000Z`, 'done'),
    ];

    // Without chain nodes (old behavior), chain breaks at u2
    const brokenChain = buildConversationChain(conversationRecords);
    expect(brokenChain).toHaveLength(2); // only u2 → a2

    // With chain nodes including the progress record, chain is complete
    const allChainNodes: ChainNode[] = [
      ...conversationRecords.map((r) => ({
        type: r.type,
        uuid: r.uuid,
        parentUuid: r.parentUuid,
        isSidechain: r.isSidechain,
        timestamp: r.timestamp,
      })),
      makeProgressNode('p1', 'a1', `${base}02.000Z`),
    ];

    const fixedChain = buildConversationChain(conversationRecords, allChainNodes);
    expect(fixedChain).toHaveLength(4);
    expect(fixedChain.map((r) => r.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('progress records are NOT included in the output chain', () => {
    const base = '2026-03-25T06:00:';
    const conversationRecords = [
      makeRawUserRecord('u1', null, `${base}00.000Z`),
      makeRawAssistantRecord('a1', 'p1', `${base}02.000Z`),
    ];
    const allChainNodes: ChainNode[] = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        timestamp: `${base}00.000Z`,
      },
      makeProgressNode('p1', 'u1', `${base}01.000Z`),
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'p1',
        isSidechain: false,
        timestamp: `${base}02.000Z`,
      },
    ];

    const chain = buildConversationChain(conversationRecords, allChainNodes);
    expect(chain).toHaveLength(2);
    // Only user/assistant, no progress
    expect(chain.every((r) => r.type === 'user' || r.type === 'assistant')).toBe(true);
  });

  it('handles a simple chain with no progress records', () => {
    const records = [
      makeRawUserRecord('u1', null, '2026-03-25T06:00:00.000Z'),
      makeRawAssistantRecord('a1', 'u1', '2026-03-25T06:00:01.000Z'),
      makeRawUserRecord('u2', 'a1', '2026-03-25T06:00:02.000Z'),
    ];

    const chain = buildConversationChain(records);
    expect(chain).toHaveLength(3);
    expect(chain.map((r) => r.uuid)).toEqual(['u1', 'a1', 'u2']);
  });

  it('returns empty array when all records are sidechains', () => {
    const records = [
      { ...makeRawUserRecord('u1', null, '2026-03-25T06:00:00.000Z'), isSidechain: true },
    ];
    const chain = buildConversationChain(records);
    expect(chain).toEqual([]);
  });
});

describe('mapClaudeJsonlToEvents', () => {
  it('maps non-immediate dequeue queue operations into user:message-dequeued', () => {
    const events = mapClaudeJsonlToEvents([
      {
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-03-23T19:00:00.000Z',
        sessionId: 'sess-1',
        content: 'wait',
      },
      {
        type: 'queue-operation',
        operation: 'dequeue',
        timestamp: '2026-03-23T19:00:05.000Z',
        sessionId: 'sess-1',
      },
    ]);

    expect(events).toEqual([
      { type: 'user:message', text: 'wait' },
      { type: 'user:message-dequeued' },
    ]);
  });
});
