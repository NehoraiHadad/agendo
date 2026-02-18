import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockUnlink = vi.fn();
const mockRmdir = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  rmdir: (...args: unknown[]) => mockRmdir(...args),
}));

vi.mock('@/lib/config', () => ({
  config: {
    LOG_DIR: '/data/agendo/logs',
  },
}));

vi.mock('@/lib/services/worker-config-service', () => ({
  getWorkerConfigNumber: vi.fn().mockResolvedValue(30),
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

vi.mock('@/lib/db/schema', () => ({
  workerConfig: { key: 'key', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

import { rotateOldLogs } from '@/lib/services/log-rotation';

describe('log-rotation', () => {
  const NOW = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnlink.mockResolvedValue(undefined);
    mockRmdir.mockResolvedValue(undefined);
  });

  it('deletes files older than retention period', async () => {
    mockReaddir
      .mockResolvedValueOnce(['2025']) // years
      .mockResolvedValueOnce(['01']) // months in 2025
      .mockResolvedValueOnce(['old.log']) // files in 01
      .mockResolvedValueOnce([]) // remaining in month dir after deletion
      .mockResolvedValueOnce([]); // remaining in year dir

    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // 2025 dir
      .mockResolvedValueOnce({ isDirectory: () => true }) // 01 dir
      .mockResolvedValueOnce({ mtimeMs: NOW - 60 * DAY_MS }); // old.log: 60 days old

    const result = await rotateOldLogs(30);
    expect(result.deleted).toBe(1);
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it('keeps files newer than retention period', async () => {
    mockReaddir
      .mockResolvedValueOnce(['2026']) // years
      .mockResolvedValueOnce(['02']) // months
      .mockResolvedValueOnce(['recent.log']) // files
      .mockResolvedValueOnce(['recent.log']) // remaining in month dir
      .mockResolvedValueOnce(['02']); // remaining in year dir

    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // 2026 dir
      .mockResolvedValueOnce({ isDirectory: () => true }) // 02 dir
      .mockResolvedValueOnce({ mtimeMs: NOW - 5 * DAY_MS }); // recent.log: 5 days old

    const result = await rotateOldLogs(30);
    expect(result.deleted).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('handles missing log directory gracefully (ENOENT)', async () => {
    const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
    enoentError.code = 'ENOENT';
    mockReaddir.mockRejectedValueOnce(enoentError);

    const result = await rotateOldLogs(30);
    expect(result.deleted).toBe(0);
  });

  it('cleans empty directories', async () => {
    mockReaddir
      .mockResolvedValueOnce(['2024']) // years
      .mockResolvedValueOnce(['06']) // months
      .mockResolvedValueOnce(['deleted.log']) // files
      .mockResolvedValueOnce([]) // month dir empty after deletion
      .mockResolvedValueOnce([]); // year dir empty

    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // 2024 dir
      .mockResolvedValueOnce({ isDirectory: () => true }) // 06 dir
      .mockResolvedValueOnce({ mtimeMs: NOW - 90 * DAY_MS }); // deleted.log: 90 days old

    await rotateOldLogs(30);
    expect(mockRmdir).toHaveBeenCalledTimes(2); // both month and year dirs
  });

  it('returns count of deleted files', async () => {
    mockReaddir
      .mockResolvedValueOnce(['2024']) // years
      .mockResolvedValueOnce(['03']) // months
      .mockResolvedValueOnce(['a.log', 'b.log']) // files
      .mockResolvedValueOnce([]) // month dir empty after both deleted
      .mockResolvedValueOnce([]); // year dir empty

    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // 2024 dir
      .mockResolvedValueOnce({ isDirectory: () => true }) // 03 dir
      .mockResolvedValueOnce({ mtimeMs: NOW - 60 * DAY_MS }) // a.log: old
      .mockResolvedValueOnce({ mtimeMs: NOW - 45 * DAY_MS }); // b.log: old

    const result = await rotateOldLogs(30);
    expect(result.deleted).toBe(2);
    expect(mockUnlink).toHaveBeenCalledTimes(2);
  });

  it('skips non-log files', async () => {
    mockReaddir
      .mockResolvedValueOnce(['2024']) // years
      .mockResolvedValueOnce(['01']) // months
      .mockResolvedValueOnce(['data.json', 'notes.txt']) // non-log files
      .mockResolvedValueOnce(['data.json', 'notes.txt']) // remaining in month
      .mockResolvedValueOnce(['01']); // remaining in year

    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true }) // 2024 dir
      .mockResolvedValueOnce({ isDirectory: () => true }); // 01 dir

    const result = await rotateOldLogs(30);
    expect(result.deleted).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});
