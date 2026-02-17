import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/lib/config';
import { getWorkerConfigNumber } from './worker-config-service';

export async function rotateOldLogs(retentionDays?: number): Promise<{ deleted: number }> {
  const retention = retentionDays ?? (await getWorkerConfigNumber('log_retention_days', 30));
  const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
  const logDir = config.LOG_DIR;
  let deleted = 0;

  try {
    const years = await readdir(logDir);
    for (const year of years) {
      const yearPath = join(logDir, year);
      const yearStat = await stat(yearPath);
      if (!yearStat.isDirectory()) continue;

      const months = await readdir(yearPath);
      for (const month of months) {
        const monthPath = join(yearPath, month);
        const monthStat = await stat(monthPath);
        if (!monthStat.isDirectory()) continue;

        const files = await readdir(monthPath);
        for (const file of files) {
          if (!file.endsWith('.log')) continue;
          const filePath = join(monthPath, file);
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoff) {
            await unlink(filePath);
            deleted++;
          }
        }

        // Clean empty month dirs
        const remaining = await readdir(monthPath);
        if (remaining.length === 0) {
          await rmdir(monthPath);
        }
      }

      // Clean empty year dirs
      const remainingMonths = await readdir(yearPath).catch(() => []);
      if (remainingMonths.length === 0) {
        await rmdir(yearPath);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Log dir doesn't exist yet, nothing to rotate
      return { deleted: 0 };
    }
    throw err;
  }

  return { deleted };
}
