/**
 * Plan file utilities for SessionProcess.
 *
 * Handles finding and reading the Claude plan file that ExitPlanMode writes
 * to ~/.claude/plans/ — used for the "clear context & restart" flow and
 * for auto-saving plans to the plans table on approval.
 */

import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { db } from '@/lib/db';
import { sessions, plans } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { Session } from '@/lib/types';

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

/**
 * Auto-save plan content to the plans table when ExitPlanMode is approved.
 * Reads the captured plan file, creates a plan record, and links it to the session's project.
 */
export async function savePlanFromSession(session: Session): Promise<void> {
  const content = await readPlanFromFile(session.id);
  if (!content) {
    console.warn(`[session-plan-utils] No plan content found for session ${session.id}`);
    return;
  }

  const projectId = session.projectId;
  if (!projectId) {
    console.warn(
      `[session-plan-utils] Session ${session.id} has no projectId — skipping plan save`,
    );
    return;
  }

  // Extract a title from the first heading or first line of the plan content
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? 'Untitled Plan';
  const title =
    firstLine
      .replace(/^#+\s*/, '')
      .trim()
      .slice(0, 200) || 'Untitled Plan';

  const [plan] = await db
    .insert(plans)
    .values({
      projectId,
      title,
      content,
      sourceSessionId: session.id,
      status: 'ready',
      metadata: {},
    })
    .returning({ id: plans.id });

  console.log(
    `[session-plan-utils] Saved plan ${plan.id} from session ${session.id} (${content.length} chars)`,
  );
}
