import { z } from 'zod';
import { createGetByIdRoute, createPatchRoute, createDeleteRoute } from '@/lib/api-routes';
import { getAgentById, updateAgent, deleteAgent } from '@/lib/services/agent-service';

const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    workingDir: z.string().nullable().optional(),
    envAllowlist: z.array(z.string()).optional(),
    maxConcurrent: z.number().int().min(1).max(10).optional(),
    isActive: z.boolean().optional(),
    mcpEnabled: z.boolean().optional(),
  })
  .strict();

export const GET = createGetByIdRoute(getAgentById, 'Agent');

export const PATCH = createPatchRoute(updateAgent, updateAgentSchema, 'Agent');

export const DELETE = createDeleteRoute(deleteAgent, 'Agent');
