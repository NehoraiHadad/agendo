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

vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  executions: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  config: { LOG_DIR: '/tmp/test-logs' },
}));

import { FileLogWriter, resolveLogPath } from '@/lib/worker/log-writer';

describe('FileLogWriter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('opens file and starts flush timer', () => {
    const writer = new FileLogWriter('test-id', '/tmp/test.log');
    writer.open();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('writes prefixed output', () => {
    const writer = new FileLogWriter('test-id', '/tmp/test.log');
    writer.open();
    writer.write('hello world\n', 'stdout');
    expect(mockWrite).toHaveBeenCalledWith(expect.any(Buffer));
    const written = mockWrite.mock.calls[0][0].toString();
    expect(written).toContain('[stdout] hello world');
  });

  it('writes system messages', () => {
    const writer = new FileLogWriter('test-id', '/tmp/test.log');
    writer.open();
    writer.writeSystem('Starting execution');
    const written = mockWrite.mock.calls[0][0].toString();
    expect(written).toContain('[system] Starting execution');
  });

  it('tracks byte size and line count', () => {
    const writer = new FileLogWriter('test-id', '/tmp/test.log');
    writer.open();
    writer.write('line 1\nline 2\n', 'stdout');
    expect(writer.stats.lineCount).toBe(2);
    expect(writer.stats.byteSize).toBeGreaterThan(0);
  });

  it('returns stats on close', async () => {
    const writer = new FileLogWriter('test-id', '/tmp/test.log');
    writer.open();
    writer.write('data\n', 'stdout');
    const stats = await writer.close();
    expect(stats.lineCount).toBe(1);
    expect(stats.byteSize).toBeGreaterThan(0);
  });
});

describe('resolveLogPath', () => {
  it('generates path with year/month partition', () => {
    const path = resolveLogPath('abc-123');
    expect(path).toMatch(/\/tmp\/test-logs\/\d{4}\/\d{2}\/abc-123\.log$/);
  });
});
