import * as path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getAgentById } from '@/lib/services/agent-service';
import { checkAuthStatus } from '@/lib/services/agent-auth-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Agent');
    const agent = await getAgentById(id);
    const binaryName = path.basename(agent.binaryPath);
    const status = checkAuthStatus(binaryName);
    return NextResponse.json(status);
  },
);
