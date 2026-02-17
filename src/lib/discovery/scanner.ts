import { readdir, stat, access, constants, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ScannedBinary {
  name: string;
  path: string;
  realPath: string;
  isSymlink: boolean;
  dir: string;
}

/**
 * Scan all PATH directories and return a deduplicated map of executables.
 * First match wins (matches `which` behavior).
 * Resolves symlinks via realpath().
 */
export async function scanPATH(): Promise<Map<string, ScannedBinary>> {
  const envPath = process.env.PATH || '';
  const pathDirs = envPath.replace(/["]+/g, '').split(path.delimiter).filter(Boolean);

  // Deduplicate PATH dirs (common: /usr/bin and /bin are often the same)
  const uniqueDirs = [...new Set(pathDirs)];

  const binaries = new Map<string, ScannedBinary>();

  for (const dir of uniqueDirs) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (binaries.has(entry.name)) continue; // first match wins

        const fullPath = path.join(dir, entry.name);

        try {
          const stats = await stat(fullPath);
          if (!stats.isFile()) continue;

          await access(fullPath, constants.X_OK);

          let resolvedPath = fullPath;
          let isSymlink = false;
          try {
            resolvedPath = await realpath(fullPath);
            isSymlink = resolvedPath !== fullPath;
          } catch {
            // realpath failed -- use original path
          }

          binaries.set(entry.name, {
            name: entry.name,
            path: fullPath,
            realPath: resolvedPath,
            isSymlink,
            dir,
          });
        } catch {
          // Not executable or stat failed -- skip
        }
      }
    } catch {
      // Directory doesn't exist or not readable -- skip
    }
  }

  return binaries;
}
