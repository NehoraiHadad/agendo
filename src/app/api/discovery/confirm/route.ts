import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createFromDiscovery } from '@/lib/services/agent-service';
import type { DiscoveredTool } from '@/lib/discovery';

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const tool: DiscoveredTool = await req.json();
  const agent = await createFromDiscovery(tool);
  return NextResponse.json({ data: agent }, { status: 201 });
});
