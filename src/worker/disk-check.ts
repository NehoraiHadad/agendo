import { statfs } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';

const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/**
 * Check if there is sufficient disk space in the log directory.
 * Creates the directory if it doesn't exist.
 * @returns true if >= 5GB free space
 */
export async function checkDiskSpace(logDir: string): Promise<boolean> {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const stats = await statfs(logDir);
  const freeBytes = stats.bavail * stats.bsize;
  const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);

  console.log(`[worker] Disk space available: ${freeGB} GB`);
  return freeBytes >= MIN_FREE_BYTES;
}
