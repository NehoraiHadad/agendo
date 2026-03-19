import { z } from 'zod';
import { requireFound } from '@/lib/api-handler';
import { createGetByIdRoute, createPatchRoute, createDeleteRoute } from '@/lib/api-routes';
import { getMcpServer, updateMcpServer, deleteMcpServer } from '@/lib/services/mcp-server-service';

const updateMcpServerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().nullable().optional(),
    transportType: z.enum(['stdio', 'http']).optional(),
    command: z.string().nullable().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    url: z.string().nullable().optional(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

async function getMcpServerOrThrow(id: string) {
  const server = await getMcpServer(id);
  return requireFound(server, 'McpServer', id);
}

export const GET = createGetByIdRoute(getMcpServerOrThrow, 'McpServer');

export const PATCH = createPatchRoute(updateMcpServer, updateMcpServerSchema, 'McpServer');

export const DELETE = createDeleteRoute(deleteMcpServer, 'McpServer');
