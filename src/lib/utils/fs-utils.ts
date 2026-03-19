import { unlink } from 'node:fs/promises';

/** Safely delete a file, ignoring errors if it doesn't exist or is already gone. */
export async function safeUnlink(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  await unlink(filePath).catch(() => {});
}

/** Safely delete multiple files, ignoring errors for each. */
export async function safeUnlinkMany(paths: (string | null | undefined)[]): Promise<void> {
  await Promise.allSettled(paths.map((p) => safeUnlink(p)));
}
