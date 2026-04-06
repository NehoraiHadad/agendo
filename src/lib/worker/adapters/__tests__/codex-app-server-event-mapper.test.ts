import { describe, it, expect } from 'vitest';
import {
  mapAppServerEventToPayloads,
  isAppServerSyntheticEvent,
  normalizeThreadItem,
  type AppServerSyntheticEvent,
  type AppServerMcpToolCallItem,
} from '../codex-app-server-event-mapper';

describe('mapAppServerEventToPayloads', () => {
  // -----------------------------------------------------------------------
  // as:usage → agent:usage
  // -----------------------------------------------------------------------
  describe('as:usage → agent:usage', () => {
    it('maps usage event with real context window', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:usage',
        used: 45000,
        size: 128000,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'agent:usage', used: 45000, size: 128000 }]);
    });

    it('maps usage event with default 200K fallback', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:usage',
        used: 10000,
        size: 200000,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'agent:usage', used: 10000, size: 200000 }]);
    });
  });

  // -----------------------------------------------------------------------
  // as:diff-update → system:info
  // -----------------------------------------------------------------------
  describe('as:diff-update → system:info', () => {
    it('maps diff update to system:info with diff formatting', () => {
      const diff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n foo\n+bar';
      const event: AppServerSyntheticEvent = {
        type: 'as:diff-update',
        diff,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'system:info',
        message: expect.stringContaining('```diff'),
      });
      expect((result[0] as { message: string }).message).toContain(diff);
    });

    it('returns empty array for empty diff', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:diff-update',
        diff: '',
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Existing events still work
  // -----------------------------------------------------------------------
  describe('existing event types', () => {
    it('maps thread.started to session:init', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:thread.started',
        threadId: 'thread-1',
        model: 'o4-mini',
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([
        {
          type: 'session:init',
          sessionRef: 'thread-1',
          slashCommands: [],
          mcpServers: [],
          model: 'o4-mini',
        },
      ]);
    });

    it('maps turn.completed success to agent:result', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'completed',
        error: null,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
        },
      ]);
    });

    it('maps turn.completed failure to agent:result with error', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'failed',
        error: { message: 'Rate limited' },
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        type: 'agent:result',
        isError: true,
        errors: ['Rate limited'],
      });
      expect(result[1]).toMatchObject({ type: 'system:error' });
    });

    it('maps turn.completed interrupted to compact-start', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:turn.completed',
        status: 'interrupted',
        error: null,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([{ type: 'system:compact-start', trigger: 'auto' }]);
    });

    it('maps command output deltas to tool progress events', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:cmd-delta',
        itemId: 'cmd-1',
        text: 'streaming stdout\n',
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toEqual([
        {
          type: 'agent:tool-progress',
          toolUseId: 'cmd-1',
          content: 'streaming stdout\n',
        },
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // as:item.completed mcpToolCall — MCP result content extraction
  // -----------------------------------------------------------------------
  describe('as:item.completed mcpToolCall → agent:tool-end', () => {
    it('extracts content from standard MCP content blocks (render_artifact)', () => {
      const artifactJson = JSON.stringify({
        id: '7ea4a741-4c9a-452d-a60e-68f86482895d',
        title: 'Pipeline Size Check',
        type: 'html',
      });
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_abc123',
          server: 'agendo',
          tool: 'render_artifact',
          arguments: { title: 'Test', content: '<html></html>' },
          result: {
            content: [{ type: 'text', text: artifactJson }],
            structuredContent: null,
          },
          error: null,
          status: 'completed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'agent:tool-end',
        toolUseId: 'call_abc123',
      });
      // Content should be the MCP content block array — extractToolContent() in
      // the frontend will then extract the text from it.
      const toolEnd = result[0] as { content: unknown };
      expect(toolEnd.content).toEqual([{ type: 'text', text: artifactJson }]);
    });

    it('extracts content from multiple text blocks', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_multi',
          server: 'agendo',
          tool: 'list_tasks',
          arguments: {},
          result: {
            content: [
              { type: 'text', text: 'Task 1' },
              { type: 'text', text: 'Task 2' },
            ],
          },
          error: null,
          status: 'completed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      const toolEnd = result[0] as { content: unknown };
      expect(toolEnd.content).toEqual([
        { type: 'text', text: 'Task 1' },
        { type: 'text', text: 'Task 2' },
      ]);
    });

    it('falls back to legacy output field', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_legacy',
          server: 'agendo',
          tool: 'get_task',
          arguments: {},
          result: { output: 'legacy result text' },
          error: null,
          status: 'completed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      const toolEnd = result[0] as { content: unknown };
      expect(toolEnd.content).toBe('legacy result text');
    });

    it('falls back to error message when result is null', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_err',
          server: 'agendo',
          tool: 'render_artifact',
          arguments: {},
          result: null,
          error: { message: 'Tool execution failed' },
          status: 'failed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      const toolEnd = result[0] as { content: unknown };
      expect(toolEnd.content).toBe('Tool execution failed');
    });

    it('returns empty string when both result and error are null', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_empty',
          server: 'agendo',
          tool: 'update_task',
          arguments: {},
          result: null,
          error: null,
          status: 'completed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      const toolEnd = result[0] as { content: unknown };
      expect(toolEnd.content).toBe('');
    });

    it('handles result with empty content array', () => {
      const event: AppServerSyntheticEvent = {
        type: 'as:item.completed',
        item: {
          type: 'mcpToolCall',
          id: 'call_empty_content',
          server: 'agendo',
          tool: 'update_task',
          arguments: {},
          result: { content: [] },
          error: null,
          status: 'completed',
        } as AppServerMcpToolCallItem,
      };
      const result = mapAppServerEventToPayloads(event);
      expect(result).toHaveLength(1);
      const toolEnd = result[0] as { content: unknown };
      // Empty content array falls through to empty string
      expect(toolEnd.content).toBe('');
    });
  });
});

// -----------------------------------------------------------------------
// normalizeThreadItem — mcpToolCall result shape
// -----------------------------------------------------------------------
describe('normalizeThreadItem mcpToolCall', () => {
  it('preserves MCP content block result shape', () => {
    const raw = {
      type: 'mcpToolCall',
      id: 'call_norm1',
      server: 'agendo',
      tool: 'render_artifact',
      arguments: { title: 'Test' },
      result: {
        content: [{ type: 'text', text: '{"id":"abc"}' }],
        structuredContent: null,
      },
      error: null,
      status: 'completed',
    };
    const normalized = normalizeThreadItem(raw) as AppServerMcpToolCallItem;
    expect(normalized).not.toBeNull();
    expect(normalized.result).toEqual({
      content: [{ type: 'text', text: '{"id":"abc"}' }],
      structuredContent: null,
    });
  });
});

describe('isAppServerSyntheticEvent', () => {
  it('detects as: prefixed events', () => {
    expect(isAppServerSyntheticEvent({ type: 'as:usage', used: 0, size: 0 })).toBe(true);
    expect(isAppServerSyntheticEvent({ type: 'as:diff-update', diff: '' })).toBe(true);
    expect(isAppServerSyntheticEvent({ type: 'as:thread.started' })).toBe(true);
  });

  it('rejects non-synthetic events', () => {
    expect(isAppServerSyntheticEvent({ type: 'agent:text', text: '' })).toBe(false);
    expect(isAppServerSyntheticEvent({ type: 'session:init' })).toBe(false);
    expect(isAppServerSyntheticEvent({})).toBe(false);
  });
});
