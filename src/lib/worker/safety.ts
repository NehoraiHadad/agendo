import { realpathSync, accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ValidationError } from '@/lib/errors';
import { allowedWorkingDirs } from '@/lib/config';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function validateWorkingDir(workingDir: string): Promise<string> {
  if (!isAbsolute(workingDir)) {
    throw new ValidationError(`Working directory must be absolute: ${workingDir}`);
  }
  if (!existsSync(workingDir)) {
    throw new ValidationError(`Working directory does not exist: ${workingDir}`);
  }
  const resolved = realpathSync(workingDir);
  const isAllowed = allowedWorkingDirs.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + '/'),
  );
  if (isAllowed) return resolved;

  // Fall back to querying active project rootPaths from DB
  const activeProjects = await db
    .select({ rootPath: projects.rootPath })
    .from(projects)
    .where(eq(projects.isActive, true));

  const isProjectAllowed = activeProjects.some(
    (p) => resolved === p.rootPath || resolved.startsWith(p.rootPath + '/'),
  );
  if (isProjectAllowed) return resolved;

  throw new ValidationError(
    `Working directory not in allowlist: ${resolved}. Allowed: ${allowedWorkingDirs.join(', ')}`,
  );
}

export function validateBinary(binaryPath: string): void {
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new ValidationError(`Binary not found or not executable: ${binaryPath}`);
  }
}
