import { z } from 'zod';
import { createGetByIdRoute, createPatchRoute, createDeleteRoute } from '@/lib/api-routes';
import { getSnapshot, updateSnapshot, deleteSnapshot } from '@/lib/services/snapshot-service';

const keyFindingsSchema = z.object({
  filesExplored: z.array(z.string()),
  findings: z.array(z.string()),
  hypotheses: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

const patchSchema = z.object({
  name: z.string().optional(),
  summary: z.string().optional(),
  keyFindings: keyFindingsSchema.optional(),
});

export const GET = createGetByIdRoute(getSnapshot, 'ContextSnapshot');

export const PATCH = createPatchRoute(updateSnapshot, patchSchema, 'ContextSnapshot');

export const DELETE = createDeleteRoute(deleteSnapshot, 'ContextSnapshot');
