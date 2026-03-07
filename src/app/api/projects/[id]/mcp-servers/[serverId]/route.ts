import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { setProjectMcpOverride, removeProjectMcpOverride } from '@/lib/services/mcp-server-service';

const putSchema = z.object({
  enabled: z.boolean(),
  envOverrides: z.record(z.string()).optional(),
});

export const PUT = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id, serverId } = await params;
    assertUUID(id, 'Project');
    assertUUID(serverId, 'McpServer');
    const body = await req.json();
    const { enabled, envOverrides } = putSchema.parse(body);
    await setProjectMcpOverride(id, serverId, { enabled, envOverrides });
    return NextResponse.json({ success: true });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id, serverId } = await params;
    assertUUID(id, 'Project');
    assertUUID(serverId, 'McpServer');
    await removeProjectMcpOverride(id, serverId);
    return new NextResponse(null, { status: 204 });
  },
);
