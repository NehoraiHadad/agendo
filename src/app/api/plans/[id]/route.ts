import { z } from 'zod';
import { createGetByIdRoute, createPatchRoute, createDeleteRoute } from '@/lib/api-routes';
import { getPlan, updatePlan, archivePlan } from '@/lib/services/plan-service';

const patchPlanSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  status: z.enum(['draft', 'ready', 'stale', 'executing', 'done', 'archived']).optional(),
  metadata: z
    .object({
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .optional(),
});

export const GET = createGetByIdRoute(getPlan, 'Plan');

export const PATCH = createPatchRoute(updatePlan, patchPlanSchema, 'Plan');

export const DELETE = createDeleteRoute(archivePlan, 'Plan');
