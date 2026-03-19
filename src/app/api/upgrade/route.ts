import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { ConflictError } from '@/lib/errors';
import {
  getUpgradeStatus,
  startUpgrade,
  UpgradeAlreadyRunningError,
} from '@/lib/upgrade/upgrade-manager';
import { z } from 'zod';

const startSchema = z.object({
  targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'Must be semver e.g. "1.2.3"'),
});

/**
 * GET /api/upgrade
 * Returns current upgrade status.
 */
export const GET = withErrorBoundary(async () => {
  return NextResponse.json(getUpgradeStatus());
});

/**
 * POST /api/upgrade
 * Start an upgrade. Body: { targetVersion: "1.2.3" }
 * Returns 409 if already running.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = startSchema.parse(await req.json());

  try {
    const { jobId } = await startUpgrade(body.targetVersion);
    return NextResponse.json({ jobId, targetVersion: body.targetVersion });
  } catch (err) {
    if (err instanceof UpgradeAlreadyRunningError) {
      throw new ConflictError(err.message);
    }
    throw err;
  }
});
