import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { parseNdjsonLine, ndjsonStream } from '../ndjson-stream';

describe('parseNdjsonLine', () => {
  it('parses valid JSON', () => {
    const result = parseNdjsonLine('{"type":"init","model":"gemini-2.5"}');
    expect(result).toEqual({ type: 'init', model: 'gemini-2.5' });
  });

  it('returns null for empty lines', () => {
    expect(parseNdjsonLine('')).toBeNull();
    expect(parseNdjsonLine('   ')).toBeNull();
    expect(parseNdjsonLine('\n')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseNdjsonLine('not json')).toBeNull();
    expect(parseNdjsonLine('{broken')).toBeNull();
  });

  it('trims whitespace before parsing', () => {
    const result = parseNdjsonLine('  {"a": 1}  ');
    expect(result).toEqual({ a: 1 });
  });

  it('uses validator when provided', () => {
    interface Typed {
      type: string;
    }
    const isTyped = (obj: unknown): obj is Typed =>
      typeof obj === 'object' && obj !== null && 'type' in obj;

    expect(parseNdjsonLine('{"type":"init"}', isTyped)).toEqual({ type: 'init' });
    expect(parseNdjsonLine('{"noType": true}', isTyped)).toBeNull();
  });
});

describe('ndjsonStream', () => {
  function createReadableFromLines(lines: string[]): Readable {
    const stream = new Readable({ read() {} });
    // Push all lines as a single chunk with newlines
    process.nextTick(() => {
      stream.push(lines.join('\n') + '\n');
      stream.push(null); // EOF → triggers 'close'
    });
    return stream;
  }

  it('yields parsed objects from a stream', async () => {
    const stream = createReadableFromLines([
      '{"type":"init","id":1}',
      '{"type":"data","id":2}',
      '{"type":"end","id":3}',
    ]);

    const results: unknown[] = [];
    for await (const item of ndjsonStream({ stream })) {
      results.push(item);
    }

    expect(results).toEqual([
      { type: 'init', id: 1 },
      { type: 'data', id: 2 },
      { type: 'end', id: 3 },
    ]);
  });

  it('handles data split across chunks', async () => {
    const stream = new Readable({ read() {} });

    process.nextTick(() => {
      // Split a JSON line across two chunks
      stream.push('{"type":"ini');
      stream.push('t","id":1}\n{"type":"end","id":2}\n');
      stream.push(null);
    });

    const results: unknown[] = [];
    for await (const item of ndjsonStream({ stream })) {
      results.push(item);
    }

    expect(results).toEqual([
      { type: 'init', id: 1 },
      { type: 'end', id: 2 },
    ]);
  });

  it('skips blank lines and invalid JSON', async () => {
    const stream = createReadableFromLines(['{"valid":true}', '', 'not json', '{"also":"valid"}']);

    const results: unknown[] = [];
    for await (const item of ndjsonStream({ stream })) {
      results.push(item);
    }

    expect(results).toEqual([{ valid: true }, { also: 'valid' }]);
  });

  it('flushes partial line on stream close', async () => {
    const stream = new Readable({ read() {} });

    process.nextTick(() => {
      // Push data without trailing newline
      stream.push('{"partial":true}');
      stream.push(null);
    });

    const results: unknown[] = [];
    for await (const item of ndjsonStream({ stream })) {
      results.push(item);
    }

    expect(results).toEqual([{ partial: true }]);
  });

  it('applies validator to filter objects', async () => {
    interface WithType {
      type: string;
    }
    const isWithType = (obj: unknown): obj is WithType =>
      typeof obj === 'object' && obj !== null && 'type' in obj;

    const stream = createReadableFromLines([
      '{"type":"init"}',
      '{"noType":true}',
      '{"type":"end"}',
    ]);

    const results: WithType[] = [];
    for await (const item of ndjsonStream<WithType>({ stream, validate: isWithType })) {
      results.push(item);
    }

    expect(results).toEqual([{ type: 'init' }, { type: 'end' }]);
  });

  it('propagates stream errors', async () => {
    const stream = new Readable({ read() {} });

    process.nextTick(() => {
      stream.destroy(new Error('connection reset'));
    });

    const results: unknown[] = [];
    await expect(async () => {
      for await (const item of ndjsonStream({ stream })) {
        results.push(item);
      }
    }).rejects.toThrow('connection reset');
  });

  it('calls onClose when stream ends', async () => {
    const stream = createReadableFromLines(['{"a":1}']);
    let closeCalled = false;

    for await (const _item of ndjsonStream({
      stream,
      onClose: () => {
        closeCalled = true;
      },
    })) {
      // consume
    }

    expect(closeCalled).toBe(true);
  });
});
