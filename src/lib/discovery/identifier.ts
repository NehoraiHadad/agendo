import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BinaryIdentity {
  packageName: string | null;
  packageSection: string | null;
  description: string | null;
  fileType: string | null;
  version: string | null;
}

/**
 * Identify a binary: what package owns it, what section, etc.
 */
export async function identifyBinary(name: string, binaryPath: string): Promise<BinaryIdentity> {
  const [packageName, fileType, version] = await Promise.all([
    getPackageName(binaryPath),
    getFileType(binaryPath),
    getVersion(name),
  ]);

  let packageSection: string | null = null;
  let description: string | null = null;

  if (packageName) {
    const metadata = await getPackageMetadata(packageName);
    packageSection = metadata.section;
    description = metadata.description;
  }

  return { packageName, packageSection, description, fileType, version };
}

/**
 * Map binary path to owning package via `dpkg -S`.
 * Returns null if binary is not from a package.
 */
async function getPackageName(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('dpkg', ['-S', binaryPath], {
      timeout: 5000,
    });
    return stdout.split(':')[0].trim();
  } catch {
    return null;
  }
}

/**
 * Get package metadata from apt-cache.
 */
async function getPackageMetadata(
  packageName: string,
): Promise<{ section: string | null; description: string | null }> {
  try {
    const { stdout } = await execFileAsync('apt-cache', ['show', packageName], {
      timeout: 5000,
    });

    const sectionMatch = stdout.match(/^Section:\s*(.+)$/m);
    const descMatch = stdout.match(/^Description(?:-en)?:\s*(.+)$/m);

    return {
      section: sectionMatch ? sectionMatch[1].trim() : null,
      description: descMatch ? descMatch[1].trim() : null,
    };
  } catch {
    return { section: null, description: null };
  }
}

/**
 * Detect file type using the `file` command (ELF, script, symlink).
 */
export async function getFileType(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('file', ['-b', binaryPath], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get version by running `<tool> --version`. Parses first line.
 * Falls back to `-V` and `version` subcommand.
 */
export async function getVersion(name: string): Promise<string | null> {
  for (const args of [['--version'], ['-V'], ['version']]) {
    try {
      const { stdout, stderr } = await execFileAsync(name, args, {
        timeout: 5000,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
      });
      const output = stdout || stderr;
      const firstLine = output.split('\n')[0].trim();
      if (firstLine.length > 0 && firstLine.length < 200) {
        return firstLine;
      }
    } catch {
      continue;
    }
  }
  return null;
}
