import { describe, expect, it } from 'vitest';
import { buildToolStartEvent, buildToolEndEvent, buildErrorResultEvent } from '../event-builders';

describe('event-builders', () => {
  // ---------------------------------------------------------------------------
  // buildToolStartEvent
  // ---------------------------------------------------------------------------
  describe('buildToolStartEvent', () => {
    it('returns correct agent:tool-start shape', () => {
      const input = { file_path: '/tmp/foo.ts' };
      const result = buildToolStartEvent('tool-123', 'Read', input);

      expect(result).toEqual({
        type: 'agent:tool-start',
        toolUseId: 'tool-123',
        toolName: 'Read',
        input,
      });
    });

    it('handles empty input', () => {
      const result = buildToolStartEvent('abc', 'Bash', {});
      expect(result.type).toBe('agent:tool-start');
      expect(result).toHaveProperty('input', {});
    });
  });

  // ---------------------------------------------------------------------------
  // buildToolEndEvent
  // ---------------------------------------------------------------------------
  describe('buildToolEndEvent', () => {
    it('returns correct agent:tool-end shape', () => {
      const result = buildToolEndEvent('tool-123', 'file contents here');

      expect(result).toEqual({
        type: 'agent:tool-end',
        toolUseId: 'tool-123',
        content: 'file contents here',
      });
    });

    it('accepts complex content', () => {
      const content = { output: 'hello', exitCode: 0 };
      const result = buildToolEndEvent('tool-456', content);

      expect(result.type).toBe('agent:tool-end');
      expect(result).toHaveProperty('content', content);
    });

    it('accepts null content', () => {
      const result = buildToolEndEvent('tool-789', null);
      expect(result).toHaveProperty('content', null);
    });
  });

  // ---------------------------------------------------------------------------
  // buildErrorResultEvent
  // ---------------------------------------------------------------------------
  describe('buildErrorResultEvent', () => {
    it('returns array with error result event using default subtype', () => {
      const result = buildErrorResultEvent('Something went wrong');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'agent:result',
        costUsd: null,
        turns: null,
        durationMs: null,
        isError: true,
        subtype: 'error',
        errors: ['Something went wrong'],
      });
    });

    it('returns correct subtype when specified', () => {
      const result = buildErrorResultEvent('Timed out after 300s', 'timeout');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'agent:result',
        isError: true,
        subtype: 'timeout',
        errors: ['Timed out after 300s'],
      });
    });

    it('returns null cost/turns/duration fields', () => {
      const [event] = buildErrorResultEvent('fail');
      expect(event).toHaveProperty('costUsd', null);
      expect(event).toHaveProperty('turns', null);
      expect(event).toHaveProperty('durationMs', null);
    });
  });
});
