import { z } from 'zod';
import { createGetByIdRoute, createPatchRoute, createDeleteRoute } from '@/lib/api-routes';
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

export const GET = createGetByIdRoute(getWorkspace, 'AgentWorkspace');

export const PATCH = createPatchRoute(updateWorkspace, patchWorkspaceSchema, 'AgentWorkspace');

export const DELETE = createDeleteRoute(deleteWorkspace, 'AgentWorkspace');
