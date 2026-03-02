import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWrite = vi.fn();
const mockEnd = vi.fn((cb?: () => void) => {
  if (cb) cb();
});

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({
    write: mockWrite,
    end: mockEnd,
  })),
  mkdirSync: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: { LOG_DIR: '/tmp/test-logs' },
}));

import { FileLogWriter, resolveSessionLogPath } from '@/lib/worker/log-writer';

describe('FileLogWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens file stream on open()', () => {
    const writer = new FileLogWriter('/tmp/test.log');
    writer.open();
    expect(mockWrite).not.toHaveBeenCalled(); // no writes yet
  });

  it('writes prefixed output', () => {
    const writer = new FileLogWriter('/tmp/test.log');
    writer.open();
    writer.write('hello world\n', 'stdout');
    expect(mockWrite).toHaveBeenCalledWith(expect.any(Buffer));
    const written = mockWrite.mock.calls[0][0].toString();
    expect(written).toContain('[stdout] hello world');
  });

  it('writes system messages', () => {
    const writer = new FileLogWriter('/tmp/test.log');
    writer.open();
    writer.writeSystem('Starting session');
    const written = mockWrite.mock.calls[0][0].toString();
    expect(written).toContain('[system] Starting session');
  });

  it('tracks byte size and line count', () => {
    const writer = new FileLogWriter('/tmp/test.log');
    writer.open();
    writer.write('line 1\nline 2\n', 'stdout');
    expect(writer.stats.lineCount).toBe(2);
    expect(writer.stats.byteSize).toBeGreaterThan(0);
  });

  it('returns stats on close', async () => {
    const writer = new FileLogWriter('/tmp/test.log');
    writer.open();
    writer.write('data\n', 'stdout');
    const stats = await writer.close();
    expect(stats.lineCount).toBe(1);
    expect(stats.byteSize).toBeGreaterThan(0);
  });
});

describe('resolveSessionLogPath', () => {
  it('generates path with year/month partition', () => {
    const path = resolveSessionLogPath('abc-123');
    expect(path).toMatch(/\/tmp\/test-logs\/\d{4}\/\d{2}\/session-abc-123\.log$/);
  });
});
