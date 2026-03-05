import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getAgentById, updateAgent, deleteAgent } from '@/lib/services/agent-service';

const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    workingDir: z.string().nullable().optional(),
    envAllowlist: z.array(z.string()).optional(),
    maxConcurrent: z.number().int().min(1).max(10).optional(),
    isActive: z.boolean().optional(),
    mcpEnabled: z.boolean().optional(),
  })
  .strict();

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');
    const agent = await getAgentById(id);
    return NextResponse.json({ data: agent });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');
    const body = await req.json();
    const validated = updateAgentSchema.parse(body);
    const agent = await updateAgent(id, validated);
    return NextResponse.json({ data: agent });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');
    await deleteAgent(id);
    return NextResponse.json({ success: true });
  },
);
