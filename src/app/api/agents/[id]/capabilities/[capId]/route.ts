import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { updateCapability, deleteCapability } from '@/lib/services/capability-service';

const updateCapabilitySchema = z
  .object({
    label: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    interactionMode: z.enum(['template', 'prompt']).optional(),
    commandTokens: z.array(z.string()).nullable().optional(),
    promptTemplate: z.string().nullable().optional(),
    argsSchema: z.record(z.unknown()).optional(),
    isEnabled: z.boolean().optional(),
    dangerLevel: z.number().int().min(0).max(3).optional(),
    timeoutSec: z.number().int().min(1).optional(),
  })
  .strict();

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { capId } = await params;
    const body = await req.json();
    const validated = updateCapabilitySchema.parse(body);
    const capability = await updateCapability(capId, validated);
    return NextResponse.json({ data: capability });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { capId } = await params;
    await deleteCapability(capId);
    return NextResponse.json({ success: true });
  },
);
