import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID, requireFound } from '@/lib/api-handler';
import { getMcpServer, updateMcpServer, deleteMcpServer } from '@/lib/services/mcp-server-service';

const updateMcpServerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().nullable().optional(),
    transportType: z.enum(['stdio', 'http']).optional(),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().nullable().optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'McpServer');
    const server = await getMcpServer(id);
    requireFound(server, 'McpServer', id);
    return NextResponse.json({ data: server });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'McpServer');
    const body = await req.json();
    const validated = updateMcpServerSchema.parse(body);
    const server = await updateMcpServer(id, validated);
    return NextResponse.json({ data: server });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'McpServer');
    await deleteMcpServer(id);
    return NextResponse.json({ success: true });
  },
);
