import * as path from 'node:path';
import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getAgentBySlug } from '@/lib/services/agent-service';
import { createSession } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import { db } from '@/lib/db';
import { agentCapabilities } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { syncTarget, getTarget, DEFAULT_MANIFEST_PATH } from '@/lib/services/repo-sync';

// ─── Skill installer (via repo-sync) ────────────────────────────────────────

function ensureSkillInstalled(): void {
  const target = getTarget('token-optimizer');
  if (!target) throw new BadRequestError('token-optimizer sync target not configured');
  const projectRoot = path.resolve(import.meta.dirname, '../../../../..');
  const result = syncTarget(target, path.join(projectRoot, DEFAULT_MANIFEST_PATH));
  if (result.error) {
    throw new BadRequestError(`token-optimizer sync failed: ${result.error}`);
  }
}

// ─── Session prompt ───────────────────────────────────────────────────────────

const INITIAL_PROMPT = `\
You are running the token-optimizer skill in headless/automated mode inside an Agendo session.

Skill location: ~/.claude/skills/token-optimizer/SKILL.md

Follow SKILL.md exactly, with these adjustments:
- Phase 0: Skip the SessionEnd hook installation (step 4). Do the backup and COORD_PATH creation as normal.
- Phase 1: Run all 6 audit agents in parallel as described.
- Phase 2: Run the synthesis agent (use opus; fall back to sonnet if unavailable).
- Phase 3: Print the full optimization plan as markdown directly in this session. Do NOT open any browser or run \`measure.py dashboard\`. Do NOT pause or wait for user input — proceed automatically through all phases.
- Stop after Phase 3. Do NOT run Phase 4 (implementation) or Phase 5 (verification) unless the user asks.

When the optimization plan is printed, finish by listing the top 5 quick-win actions with their estimated token savings.`;

// ─── Route handler ────────────────────────────────────────────────────────────

export const POST = withErrorBoundary(async () => {
  // 1. Ensure skill is installed at ~/.claude/skills/token-optimizer/
  ensureSkillInstalled();

  // 2. Look up the Claude agent
  const agent = await getAgentBySlug('claude-code-1');
  if (!agent) throw new BadRequestError('Claude agent (claude-code-1) not found');

  // 3. Find its prompt-mode capability
  const [cap] = await db
    .select({ id: agentCapabilities.id })
    .from(agentCapabilities)
    .where(
      and(
        eq(agentCapabilities.agentId, agent.id),
        eq(agentCapabilities.interactionMode, 'prompt'),
        eq(agentCapabilities.isEnabled, true),
      ),
    )
    .limit(1);

  if (!cap) throw new BadRequestError('No prompt-mode capability found for Claude agent');

  // 4. Create the session (no task — ad-hoc analysis run)
  const session = await createSession({
    agentId: agent.id,
    capabilityId: cap.id,
    initialPrompt: INITIAL_PROMPT,
    permissionMode: 'bypassPermissions',
    kind: 'execution',
  });

  // 5. Enqueue immediately (initial prompt is set)
  await enqueueSession({ sessionId: session.id });

  return NextResponse.json({ data: { sessionId: session.id } }, { status: 201 });
});
