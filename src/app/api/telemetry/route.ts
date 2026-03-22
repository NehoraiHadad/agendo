import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createLogger } from '@/lib/logger';
import { formatAsGitHubIssue, type BrainstormTelemetryReport } from '@/lib/brainstorm/telemetry';
import { ValidationError } from '@/lib/errors';

const log = createLogger('telemetry-api');

/**
 * GET /api/telemetry — check telemetry config status
 * Returns whether GitHub telemetry is configured and the target repo.
 */
export const GET = withErrorBoundary(async () => {
  const repo = process.env.TELEMETRY_GITHUB_REPO;
  const token = process.env.TELEMETRY_GITHUB_TOKEN;

  return NextResponse.json({
    data: {
      githubEnabled: Boolean(repo && token),
      repo: repo ?? null,
    },
  });
});

/**
 * POST /api/telemetry — submit a telemetry report to GitHub Issues
 *
 * The frontend shows the full report to the user for confirmation
 * before calling this endpoint. This ensures user sees exactly what is sent.
 *
 * Required env vars:
 * - TELEMETRY_GITHUB_REPO: e.g. "username/agendo"
 * - TELEMETRY_GITHUB_TOKEN: GitHub PAT with `repo` or `public_repo` scope
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const repo = process.env.TELEMETRY_GITHUB_REPO;
  const token = process.env.TELEMETRY_GITHUB_TOKEN;

  if (!repo || !token) {
    throw new ValidationError(
      'GitHub telemetry not configured. Set TELEMETRY_GITHUB_REPO and TELEMETRY_GITHUB_TOKEN.',
    );
  }

  const report = (await req.json()) as BrainstormTelemetryReport;

  // Basic validation — must have the schema version
  if (report.v !== 1 || !report.ts || !report.endState) {
    throw new ValidationError('Invalid telemetry report format.');
  }

  const issue = formatAsGitHubIssue(report);

  // Create GitHub Issue via REST API
  const ghResponse = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': `agendo/${report.agendoVersion}`,
    },
    body: JSON.stringify({
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    }),
  });

  if (!ghResponse.ok) {
    const errorBody = await ghResponse.text();
    log.error(
      { repo, status: ghResponse.status, errorBody },
      'Failed to create GitHub telemetry issue',
    );
    return NextResponse.json(
      {
        error: {
          code: 'GITHUB_ERROR',
          message: `GitHub API returned ${ghResponse.status}`,
        },
      },
      { status: 502 },
    );
  }

  const ghData = (await ghResponse.json()) as { html_url?: string; number?: number };

  log.info(
    { repo, issueNumber: ghData.number, url: ghData.html_url },
    'Telemetry issue created on GitHub',
  );

  return NextResponse.json({
    data: {
      submitted: true,
      issueUrl: ghData.html_url ?? null,
      issueNumber: ghData.number ?? null,
    },
  });
});
