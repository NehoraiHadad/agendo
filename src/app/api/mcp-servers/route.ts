import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { listMcpServers, createMcpServer } from '@/lib/services/mcp-server-service';

const createMcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  transportType: z.enum(['stdio', 'http']),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({}),
  url: z.string().nullable().optional(),
  headers: z.record(z.string()).optional().default({}),
  enabled: z.boolean().optional().default(true),
  isDefault: z.boolean().optional().default(false),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const enabledParam = url.searchParams.get('enabled');

  const filters = enabledParam !== null ? { enabled: enabledParam === 'true' } : undefined;

  const servers = await listMcpServers(filters);
  return NextResponse.json(servers);
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const validated = createMcpServerSchema.parse(body);
  const server = await createMcpServer(validated);
  return NextResponse.json({ data: server }, { status: 201 });
});
