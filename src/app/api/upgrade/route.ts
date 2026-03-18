import { NextRequest, NextResponse } from 'next/server';
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
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getUpgradeStatus());
}

/**
 * POST /api/upgrade
 * Start an upgrade. Body: { targetVersion: "1.2.3" }
 * Returns 409 if already running.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body: unknown = await req.json();
  const parsed = startSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: parsed.error.message } },
      { status: 400 },
    );
  }

  try {
    const { jobId } = await startUpgrade(parsed.data.targetVersion);
    return NextResponse.json({ jobId, targetVersion: parsed.data.targetVersion });
  } catch (err) {
    if (err instanceof UpgradeAlreadyRunningError) {
      return NextResponse.json(
        { error: { code: 'UPGRADE_RUNNING', message: err.message } },
        { status: 409 },
      );
    }
    throw err;
  }
}
