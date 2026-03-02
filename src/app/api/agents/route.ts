import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  listAgents,
  listAgentsWithCapabilities,
  createAgent,
  getAgentBySlug,
} from '@/lib/services/agent-service';

const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  binaryPath: z.string().min(1),
  workingDir: z.string().nullable().optional(),
  envAllowlist: z.array(z.string()).optional().default([]),
  maxConcurrent: z.number().int().min(1).max(10).optional().default(1),
  toolType: z.string().optional().default('ai-agent'),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');

  if (slug) {
    const agent = await getAgentBySlug(slug);
    return NextResponse.json({ data: agent ? [agent] : [] });
  }

  const withCapabilities = url.searchParams.get('capabilities') === 'true';
  const data = withCapabilities ? await listAgentsWithCapabilities() : await listAgents();
  return NextResponse.json({ data });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const validated = createAgentSchema.parse(body);
  const agent = await createAgent(validated);
  return NextResponse.json({ data: agent }, { status: 201 });
});
