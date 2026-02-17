import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  getCapabilitiesByAgent,
  createCapability,
} from '@/lib/services/capability-service';

const createCapabilitySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  interactionMode: z.enum(['template', 'prompt']),
  commandTokens: z.array(z.string()).nullable().optional(),
  promptTemplate: z.string().nullable().optional(),
  argsSchema: z.record(z.unknown()).optional().default({}),
  dangerLevel: z.number().int().min(0).max(3).optional().default(0),
  timeoutSec: z.number().int().min(1).optional().default(300),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const data = await getCapabilitiesByAgent(id);
    return NextResponse.json({ data });
  },
);

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const validated = createCapabilitySchema.parse(body);
    const capability = await createCapability({ ...validated, agentId: id });
    return NextResponse.json({ data: capability }, { status: 201 });
  },
);
