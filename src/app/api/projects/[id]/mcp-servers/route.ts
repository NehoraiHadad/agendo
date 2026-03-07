import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getProjectMcpServers } from '@/lib/services/mcp-server-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Project');
    const overrides = await getProjectMcpServers(id);
    return NextResponse.json(overrides);
  },
);
