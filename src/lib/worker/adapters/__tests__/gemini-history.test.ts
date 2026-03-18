/**
 * Tests for getHistory() on GeminiAdapter and CopilotAdapter.
 *
 * Both adapters use an in-memory accumulator on AcpTransport to collect
 * structural AgendoEventPayloads during a session. getHistory() returns
 * the buffer, or null when it is empty/unavailable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AcpTransport } from '../gemini-acp-transport';
import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// AcpTransport accumulator tests
// ---------------------------------------------------------------------------

describe('AcpTransport message history accumulator', () => {
  let transport: AcpTransport;

  beforeEach(() => {
    transport = new AcpTransport();
  });

  it('returns empty array from getMessageHistory() when nothing has been pushed', () => {
    expect(transport.getMessageHistory()).toEqual([]);
  });

  it('accumulates pushed events and returns them in order', () => {
    const event1: AgendoEventPayload = { type: 'agent:text', text: 'Hello world' };
    const event2: AgendoEventPayload = {
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    };

    transport.pushToHistory(event1);
    transport.pushToHistory(event2);

    const history = transport.getMessageHistory();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(event1);
    expect(history[1]).toEqual(event2);
  });

  it('returns a copy so mutations do not affect the internal buffer', () => {
    const event: AgendoEventPayload = { type: 'agent:text', text: 'original' };
    transport.pushToHistory(event);

    const history = transport.getMessageHistory();
    history.push({ type: 'agent:text', text: 'injected' });

    expect(transport.getMessageHistory()).toHaveLength(1);
  });

  it('clearHistory() resets the buffer to empty', () => {
    transport.pushToHistory({ type: 'agent:text', text: 'first' });
    transport.pushToHistory({ type: 'agent:text', text: 'second' });
    transport.clearHistory();

    expect(transport.getMessageHistory()).toEqual([]);
  });

  it('accumulates events across multiple turns correctly', () => {
    // Simulate turn 1
    transport.pushToHistory({ type: 'agent:text', text: 'Turn 1 response' });
    transport.pushToHistory({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });
    // Simulate turn 2
    transport.pushToHistory({ type: 'agent:text', text: 'Turn 2 response' });
    transport.pushToHistory({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });

    const history = transport.getMessageHistory();
    expect(history).toHaveLength(4);
    expect(history.filter((e) => e.type === 'agent:text')).toHaveLength(2);
    expect(history.filter((e) => e.type === 'agent:result')).toHaveLength(2);
  });

  it('only stores structural events, not streaming deltas', () => {
    // These are the events that SHOULD be stored
    const textEvent: AgendoEventPayload = { type: 'agent:text', text: 'Full message' };
    const resultEvent: AgendoEventPayload = {
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    };
    const toolStartEvent: AgendoEventPayload = {
      type: 'agent:tool-start',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    };
    const toolEndEvent: AgendoEventPayload = {
      type: 'agent:tool-end',
      toolUseId: 'tool-1',
      content: 'file1.ts\nfile2.ts',
    };

    transport.pushToHistory(textEvent);
    transport.pushToHistory(resultEvent);
    transport.pushToHistory(toolStartEvent);
    transport.pushToHistory(toolEndEvent);

    // Only 4 structural events — deltas are never pushed in real usage
    expect(transport.getMessageHistory()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// GeminiAdapter.getHistory() tests
// ---------------------------------------------------------------------------

describe('GeminiAdapter.getHistory()', () => {
  it('returns null when transport has no history', async () => {
    // Import after mocks are set up (dynamic import to avoid hoisting issues)
    const { GeminiAdapter } = await import('../gemini-adapter');
    const adapter = new GeminiAdapter();

    // Access the private transport via cast
    const result = await adapter.getHistory('some-session-ref');
    expect(result).toBeNull();
  });

  it('returns accumulated history from the transport', async () => {
    const { GeminiAdapter } = await import('../gemini-adapter');
    const adapter = new GeminiAdapter();

    // Access private transport and push events directly
    const transport = (adapter as unknown as { transport: AcpTransport }).transport;
    transport.pushToHistory({ type: 'agent:text', text: 'Hello from Gemini' });
    transport.pushToHistory({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });

    const result = await adapter.getHistory('session-ref');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toMatchObject({ type: 'agent:text', text: 'Hello from Gemini' });
    expect(result![1]).toMatchObject({ type: 'agent:result' });
  });

  it('ignores the sessionRef parameter (uses in-memory buffer)', async () => {
    const { GeminiAdapter } = await import('../gemini-adapter');
    const adapter = new GeminiAdapter();

    const transport = (adapter as unknown as { transport: AcpTransport }).transport;
    transport.pushToHistory({ type: 'agent:text', text: 'Memory buffer' });

    // sessionRef doesn't matter for ACP adapters — it's an in-memory buffer
    const result = await adapter.getHistory('ignored-ref');
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CopilotAdapter.getHistory() tests
// ---------------------------------------------------------------------------

describe('CopilotAdapter.getHistory()', () => {
  it('returns null when transport has no history', async () => {
    const { CopilotAdapter } = await import('../copilot-adapter');
    const adapter = new CopilotAdapter();

    const result = await adapter.getHistory('some-session-ref');
    expect(result).toBeNull();
  });

  it('returns accumulated history from the transport', async () => {
    const { CopilotAdapter } = await import('../copilot-adapter');
    const adapter = new CopilotAdapter();

    const transport = (adapter as unknown as { transport: AcpTransport }).transport;
    transport.pushToHistory({ type: 'agent:text', text: 'Hello from Copilot' });
    transport.pushToHistory({
      type: 'agent:tool-start',
      toolUseId: 'tool-1',
      toolName: 'WriteFile',
      input: { path: '/tmp/foo.ts' },
    });

    const result = await adapter.getHistory('session-ref');
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toMatchObject({ type: 'agent:text', text: 'Hello from Copilot' });
    expect(result![1]).toMatchObject({ type: 'agent:tool-start', toolName: 'WriteFile' });
  });
});
