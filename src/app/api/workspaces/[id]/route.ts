import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getWorkspace, updateWorkspace, deleteWorkspace } from '@/lib/services/workspace-service';

const workspacePanelSchema = z.object({
  sessionId: z.string().uuid(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

const workspaceLayoutSchema = z.object({
  panels: z.array(workspacePanelSchema),
  gridCols: z.number().int().min(1),
});

const patchWorkspaceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  layout: workspaceLayoutSchema.optional(),
  isActive: z.boolean().optional(),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'AgentWorkspace');

    const workspace = await getWorkspace(id);
    return NextResponse.json({ data: workspace });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'AgentWorkspace');

    const body = patchWorkspaceSchema.parse(await req.json());
    const updated = await updateWorkspace(id, body);
    return NextResponse.json({ data: updated });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'AgentWorkspace');

    await deleteWorkspace(id);
    return NextResponse.json({ data: { id } });
  },
);
