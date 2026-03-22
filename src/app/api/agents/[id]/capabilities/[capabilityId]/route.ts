import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID, requireFound } from '@/lib/api-handler';
import {
  getCapability,
  updateCapability,
  deleteCapability,
} from '@/lib/services/capability-service';

type RouteContext = { params: Promise<Record<string, string>> };

// ---------------------------------------------------------------------------
// GET /api/agents/:id/capabilities/:capabilityId
// ---------------------------------------------------------------------------

export const GET = withErrorBoundary(async (_req: NextRequest, { params }: RouteContext) => {
  const { id, capabilityId } = await params;
  assertUUID(id, 'Agent');
  assertUUID(capabilityId, 'Capability');

  const data = requireFound(await getCapability(capabilityId), 'Capability', capabilityId);
  return NextResponse.json({ data });
});

// ---------------------------------------------------------------------------
// PATCH /api/agents/:id/capabilities/:capabilityId
// ---------------------------------------------------------------------------

const updateCapabilitySchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    isEnabled: z.boolean().optional(),
    supportStatus: z.enum(['verified', 'untested', 'unsupported']).optional(),
    providerNotes: z.string().nullable().optional(),
    lastTestedAt: z.string().datetime().nullable().optional(),
    dangerLevel: z.number().int().min(0).max(3).optional(),
    timeoutSec: z.number().int().min(1).max(86400).optional(),
    requiresApproval: z.boolean().optional(),
    promptTemplate: z.string().nullable().optional(),
    commandTokens: z.array(z.string()).nullable().optional(),
    argsSchema: z.record(z.unknown()).optional(),
  })
  .strict();

export const PATCH = withErrorBoundary(async (req: NextRequest, { params }: RouteContext) => {
  const { id, capabilityId } = await params;
  assertUUID(id, 'Agent');
  assertUUID(capabilityId, 'Capability');

  const body = updateCapabilitySchema.parse(await req.json());
  const { lastTestedAt: rawTestedAt, ...rest } = body;
  const updateData: Parameters<typeof updateCapability>[1] = {
    ...rest,
    ...(rawTestedAt !== undefined
      ? { lastTestedAt: rawTestedAt ? new Date(rawTestedAt) : null }
      : {}),
  };
  const data = requireFound(
    await updateCapability(capabilityId, updateData),
    'Capability',
    capabilityId,
  );
  return NextResponse.json({ data });
});

// ---------------------------------------------------------------------------
// DELETE /api/agents/:id/capabilities/:capabilityId
// ---------------------------------------------------------------------------

export const DELETE = withErrorBoundary(async (_req: NextRequest, { params }: RouteContext) => {
  const { id, capabilityId } = await params;
  assertUUID(id, 'Agent');
  assertUUID(capabilityId, 'Capability');

  const deleted = await deleteCapability(capabilityId);
  if (!deleted) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Capability not found' } },
      { status: 404 },
    );
  }
  return new NextResponse(null, { status: 204 });
});
