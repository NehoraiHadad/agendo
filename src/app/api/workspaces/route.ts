import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createWorkspace, listWorkspaces } from '@/lib/services/workspace-service';

const workspacePanelSchema = z.object({
  sessionId: z.string().uuid(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

const workspaceLayoutSchema = z.object({
  panels: z.array(workspacePanelSchema),
  gridCols: z.union([z.literal(2), z.literal(3)]),
});

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().uuid().optional(),
  layout: workspaceLayoutSchema.optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? undefined;

  const data = await listWorkspaces({ projectId });
  return NextResponse.json({ data });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createWorkspaceSchema.parse(await req.json());
  const workspace = await createWorkspace(body);
  return NextResponse.json({ data: workspace }, { status: 201 });
});
