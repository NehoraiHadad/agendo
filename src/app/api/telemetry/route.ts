import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withErrorBoundary } from '@/lib/api-handler';
import { createLogger } from '@/lib/logger';
import { formatAsGitHubIssue, type BrainstormTelemetryReport } from '@/lib/brainstorm/telemetry';
import { ValidationError } from '@/lib/errors';

const log = createLogger('telemetry-api');
const execFileAsync = promisify(execFile);

/**
 * The upstream agendo repo where telemetry issues are collected.
 * This is hardcoded so that forked instances send telemetry to the
 * maintainer, not to the user's own fork.
 * Can be overridden via TELEMETRY_GITHUB_REPO env var.
 */
const UPSTREAM_REPO = 'NehoraiHadad/agendo';

function resolveRepo(): string {
  return process.env.TELEMETRY_GITHUB_REPO ?? UPSTREAM_REPO;
}

/**
 * GET /api/telemetry — check telemetry config status
 * Returns whether GitHub telemetry is available (repo resolvable + gh CLI authenticated).
 */
export const GET = withErrorBoundary(async () => {
  const repo = resolveRepo();

  // Check if gh CLI is installed and authenticated
  let ghAuthed = false;
  try {
    await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
    ghAuthed = true;
  } catch {
    // gh not installed or not authenticated
  }

  return NextResponse.json({
    data: {
      githubEnabled: ghAuthed,
      repo,
    },
  });
});

/**
 * POST /api/telemetry — submit a telemetry report as a GitHub Issue
 *
 * Uses `gh issue create` (which uses the user's existing gh auth).
 * No separate token needed — just `gh auth login` once on the machine.
 *
 * Sends to the upstream agendo repo (NehoraiHadad/agendo) by default,
 * so forked instances report back to the maintainer.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const repo = resolveRepo();

  const report = (await req.json()) as BrainstormTelemetryReport;

  // Basic validation — must have the schema version
  if (report.v !== 1 || !report.ts || !report.endState) {
    throw new ValidationError('Invalid telemetry report format.');
  }

  const issue = formatAsGitHubIssue(report);

  try {
    // Try with labels first; if labels don't exist in the repo, retry without
    const args = ['issue', 'create', '--repo', repo, '--title', issue.title, '--body', issue.body];
    let stdout: string;
    try {
      const result = await execFileAsync('gh', [...args, '--label', issue.labels.join(',')], {
        timeout: 30000,
      });
      stdout = result.stdout;
    } catch (labelErr) {
      const msg = labelErr instanceof Error ? labelErr.message : '';
      if (msg.includes('not found') || msg.includes('label')) {
        // Labels don't exist in the repo — create issue without them
        log.info({ repo }, 'Labels not found in repo, creating issue without labels');
        const result = await execFileAsync('gh', args, { timeout: 30000 });
        stdout = result.stdout;
      } else {
        throw labelErr;
      }
    }

    // gh issue create prints the URL of the created issue
    const issueUrl = stdout.trim();
    const issueNumber = issueUrl.match(/\/issues\/(\d+)/)?.[1];

    log.info({ repo, issueNumber, url: issueUrl }, 'Telemetry issue created on GitHub');

    return NextResponse.json({
      data: {
        submitted: true,
        issueUrl: issueUrl || null,
        issueNumber: issueNumber ? Number(issueNumber) : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ repo, err }, 'Failed to create GitHub telemetry issue');
    return NextResponse.json(
      {
        error: {
          code: 'GITHUB_ERROR',
          message: `gh issue create failed: ${message}`,
        },
      },
      { status: 502 },
    );
  }
});
