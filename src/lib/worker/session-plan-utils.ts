/**
 * Plan file utilities for SessionProcess.
 *
 * Handles finding and reading the Claude plan file that ExitPlanMode writes
 * to ~/.claude/plans/ — used for the "clear context & restart" flow and
 * for auto-saving plans to the plans table on approval.
 */

import { join } from 'node:path';
import os from 'node:os';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-plan-utils');
import { sessions, plans } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { savePlanContent } from '@/lib/services/plan-service';
import type { Session } from '@/lib/types';

/**
 * Eagerly find the plan file in ~/.claude/plans/ (most recently modified .md)
 * and persist its path to the DB. Called when ExitPlanMode fires (session is
 * still active) so the plan path is available even if the session goes idle
 * before the user clicks "clear context".
 */
export async function capturePlanFilePath(sessionId: string): Promise<void> {
  const homePlansDir = join(process.env.HOME ?? os.homedir(), '.claude', 'plans');
  try {
    const files = readdirSync(homePlansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f, mtime: statSync(join(homePlansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return;
    const planFilePath = join(homePlansDir, files[0].name);
    await db.update(sessions).set({ planFilePath }).where(eq(sessions.id, sessionId));
    log.info({ sessionId, planFilePath }, 'Stored plan_file_path');
  } catch (err) {
    log.warn({ err }, 'Failed to capture plan file path');
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
    log.info({ planFilePath: row.planFilePath, chars: content.length }, 'Read plan from file');
    return content;
  } catch (err) {
    log.warn({ err }, 'Failed to read plan from DB path');
    return null;
  }
}

/**
 * Auto-save plan content to the plans table when ExitPlanMode is approved.
 *
 * If this session is a plan's conversationSessionId, UPDATE that plan's content
 * and create a new version. Otherwise create a new plan record + version 1.
 */
export async function savePlanFromSession(session: Session): Promise<void> {
  const content = await readPlanFromFile(session.id);
  if (!content) {
    log.warn({ sessionId: session.id }, 'No plan content found for session');
    return;
  }

  const projectId = session.projectId;
  if (!projectId) {
    log.warn({ sessionId: session.id }, 'Session has no projectId — skipping plan save');
    return;
  }

  const versionMeta = { source: 'exitPlanMode' as const, sessionId: session.id };

  // Check if this session is linked to an existing plan (via conversationSessionId).
  const [existingPlan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.conversationSessionId, session.id))
    .limit(1);

  if (existingPlan) {
    await db
      .update(plans)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(plans.id, existingPlan.id));
    const version = await savePlanContent(existingPlan.id, content, versionMeta);
    log.info(
      {
        planId: existingPlan.id,
        sessionId: session.id,
        version: version?.version ?? 'deduped',
        chars: content.length,
      },
      'Updated plan from session',
    );
    return;
  }

  // Extract title for the new plan record
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? 'Untitled Plan';
  const title =
    firstLine
      .replace(/^#+\s*/, '')
      .trim()
      .slice(0, 200) || 'Untitled Plan';

  // No linked plan — create a new record.
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

  await savePlanContent(plan.id, content, versionMeta);

  log.info(
    { planId: plan.id, sessionId: session.id, chars: content.length },
    'Created plan from session (v1)',
  );
}
