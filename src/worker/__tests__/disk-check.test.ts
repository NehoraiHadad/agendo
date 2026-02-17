import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  statfs: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { statfs } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { checkDiskSpace } from '../disk-check';

const mockStatfs = vi.mocked(statfs);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('checkDiskSpace', () => {
  it('returns true when >= 5GB free', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatfs.mockResolvedValue({
      bavail: 6_000_000,
      bsize: 4096,
    } as never);

    const result = await checkDiskSpace('/data/logs');

    expect(result).toBe(true);
  });

  it('returns false when < 5GB free', async () => {
    mockExistsSync.mockReturnValue(true);
    // 1000 blocks * 4096 bytes = ~4MB, well under 5GB
    mockStatfs.mockResolvedValue({
      bavail: 1000,
      bsize: 4096,
    } as never);

    const result = await checkDiskSpace('/data/logs');

    expect(result).toBe(false);
  });

  it('creates directory if missing', async () => {
    mockExistsSync.mockReturnValue(false);
    mockStatfs.mockResolvedValue({
      bavail: 6_000_000,
      bsize: 4096,
    } as never);

    await checkDiskSpace('/data/logs');

    expect(mockMkdirSync).toHaveBeenCalledWith('/data/logs', { recursive: true });
  });

  it('does not create directory if it exists', async () => {
    mockExistsSync.mockReturnValue(true);
    mockStatfs.mockResolvedValue({
      bavail: 6_000_000,
      bsize: 4096,
    } as never);

    await checkDiskSpace('/data/logs');

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('logs free space in GB', async () => {
    mockExistsSync.mockReturnValue(true);
    // 2_621_440 blocks * 4096 bytes = 10 GB exactly
    mockStatfs.mockResolvedValue({
      bavail: 2_621_440,
      bsize: 4096,
    } as never);

    await checkDiskSpace('/data/logs');

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('10.00 GB'));
  });
});
