import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getAgentBySlug } from '@/lib/services/agent-service';
import { createSession } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';

// ─── Skill installer ─────────────────────────────────────────────────────────

const REPO_URL = 'https://github.com/alexgreensh/token-optimizer';

/**
 * Clones the token-optimizer repo from GitHub and installs the skill into
 * ~/.claude/skills/token-optimizer/. Idempotent — no-op when already present.
 */
function ensureSkillInstalled(): void {
  const dest = path.join(os.homedir(), '.claude', 'skills', 'token-optimizer');
  if (fs.existsSync(dest)) return;

  const cloneDir = path.join(os.tmpdir(), `token-optimizer-install-${Date.now()}`);
  try {
    const result = spawnSync('git', ['clone', '--depth=1', REPO_URL, cloneDir], {
      timeout: 60_000,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new BadRequestError(
        `git clone failed (exit ${result.status ?? 'signal'}): ${result.stderr ?? ''}`.trim(),
      );
    }
    const src = path.join(cloneDir, 'skills', 'token-optimizer');
    if (!fs.existsSync(src)) {
      throw new BadRequestError(
        `Unexpected repo layout: skills/token-optimizer not found after cloning ${REPO_URL}`,
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  } finally {
    fs.rmSync(cloneDir, { recursive: true, force: true });
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

  // 3. Create the session (no task — ad-hoc analysis run)
  const session = await createSession({
    agentId: agent.id,
    initialPrompt: INITIAL_PROMPT,
    permissionMode: 'bypassPermissions',
    kind: 'execution',
  });

  // 5. Enqueue immediately (initial prompt is set)
  await enqueueSession({ sessionId: session.id });

  return NextResponse.json({ data: { sessionId: session.id } }, { status: 201 });
});
