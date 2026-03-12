import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getRunningAuthProcess } from '@/lib/services/agent-auth-service';
import { BadRequestError, NotFoundError } from '@/lib/errors';

/**
 * POST /api/agents/[id]/auth-input
 *
 * Sends user input (e.g. an authorization code) to a running auth CLI process's stdin.
 * Used by the OAuth code-paste flow: CLI prints a URL, user authenticates in browser,
 * copies the code, pastes it here → piped to the CLI's stdin.
 */
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');

    const body: unknown = await req.json();
    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Request body must be a JSON object');
    }

    const { input } = body as Record<string, unknown>;
    if (typeof input !== 'string' || !input) {
      throw new BadRequestError('input is required and must be a non-empty string');
    }

    const proc = getRunningAuthProcess(id);
    if (!proc || proc.killed) {
      throw new NotFoundError('No running auth process for this agent');
    }

    if (!proc.stdin || proc.stdin.destroyed) {
      throw new BadRequestError('Auth process stdin is not available');
    }

    // Write input + newline to the process stdin
    proc.stdin.write(input + '\n');

    return NextResponse.json({ success: true });
  },
);
