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
 * Resolve the target GitHub repo for telemetry issues.
 * Priority: TELEMETRY_GITHUB_REPO env var > git remote origin.
 */
async function resolveRepo(): Promise<string | null> {
  // Explicit override
  const envRepo = process.env.TELEMETRY_GITHUB_REPO;
  if (envRepo) return envRepo;

  // Auto-detect from git remote
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { timeout: 5000 },
    );
    const detected = stdout.trim();
    return detected || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/telemetry — check telemetry config status
 * Returns whether GitHub telemetry is available (repo resolvable + gh CLI authenticated).
 */
export const GET = withErrorBoundary(async () => {
  const repo = await resolveRepo();

  // Check if gh CLI is authenticated
  let ghAuthed = false;
  if (repo) {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 5000 });
      ghAuthed = true;
    } catch {
      // gh not installed or not authenticated
    }
  }

  return NextResponse.json({
    data: {
      githubEnabled: Boolean(repo) && ghAuthed,
      repo: repo ?? null,
    },
  });
});

/**
 * POST /api/telemetry — submit a telemetry report as a GitHub Issue
 *
 * Uses `gh issue create` (which uses the user's existing gh auth).
 * No separate token needed — just `gh auth login` once on the machine.
 *
 * Auto-detects repo from git remote if TELEMETRY_GITHUB_REPO is not set.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const repo = await resolveRepo();

  if (!repo) {
    throw new ValidationError(
      'Cannot determine GitHub repo. Set TELEMETRY_GITHUB_REPO or ensure this is a GitHub repo.',
    );
  }

  const report = (await req.json()) as BrainstormTelemetryReport;

  // Basic validation — must have the schema version
  if (report.v !== 1 || !report.ts || !report.endState) {
    throw new ValidationError('Invalid telemetry report format.');
  }

  const issue = formatAsGitHubIssue(report);

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        issue.title,
        '--body',
        issue.body,
        '--label',
        issue.labels.join(','),
      ],
      { timeout: 30000 },
    );

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
