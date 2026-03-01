/**
 * Plan file utilities for SessionProcess.
 *
 * Handles finding and reading the Claude plan file that ExitPlanMode writes
 * to ~/.claude/plans/ — used for the "clear context & restart" flow.
 */

import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Eagerly find the plan file in ~/.claude/plans/ (most recently modified .md)
 * and persist its path to the DB. Called when ExitPlanMode fires (session is
 * still active) so the plan path is available even if the session goes idle
 * before the user clicks "clear context".
 */
export async function capturePlanFilePath(sessionId: string): Promise<void> {
  const homePlansDir = join(process.env.HOME ?? '/home/ubuntu', '.claude', 'plans');
  try {
    const files = readdirSync(homePlansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f, mtime: statSync(join(homePlansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return;
    const planFilePath = join(homePlansDir, files[0].name);
    await db.update(sessions).set({ planFilePath }).where(eq(sessions.id, sessionId));
    console.log(
      `[session-plan-utils] Stored plan_file_path for session ${sessionId}: ${planFilePath}`,
    );
  } catch (err) {
    console.warn(`[session-plan-utils] Failed to capture plan file path:`, err);
  }
}

/**
 * Read plan content from the stored plan_file_path in the DB.
 */
export async function readPlanFromFile(sessionId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ planFilePath: sessions.planFilePath })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row?.planFilePath) return null;
    const content = readFileSync(row.planFilePath, 'utf-8').trim();
    if (!content) return null;
    console.log(
      `[session-plan-utils] Read plan from ${row.planFilePath} (${content.length} chars)`,
    );
    return content;
  } catch (err) {
    console.warn(`[session-plan-utils] Failed to read plan from DB path:`, err);
    return null;
  }
}
