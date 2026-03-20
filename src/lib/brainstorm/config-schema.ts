import { z } from 'zod';
import type { BrainstormConfig } from '@/lib/db/schema';
import { FALLBACK_MODES, FALLBACK_TRIGGER_ERRORS } from '@/lib/fallback/policy';

export const brainstormFallbackPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(FALLBACK_MODES).optional(),
    preservePinnedModel: z.boolean().optional(),
    allowedFallbackModels: z
      .object({
        byProvider: z.record(z.string(), z.array(z.string().min(1))).optional(),
        byAgent: z.record(z.string(), z.array(z.string().min(1))).optional(),
      })
      .optional(),
    allowedFallbackAgents: z.array(z.string().min(1)).max(10).optional(),
    triggerErrors: z.array(z.enum(FALLBACK_TRIGGER_ERRORS)).max(10).optional(),
  })
  .strict();

export const brainstormConfigSchema: z.ZodType<BrainstormConfig> = z
  .object({
    waveTimeoutSec: z.number().int().min(10).max(600).optional(),
    wave0ExtraTimeoutSec: z.number().int().min(0).max(600).optional(),
    convergenceMode: z.enum(['unanimous', 'majority']).optional(),
    minWavesBeforePass: z.number().int().min(0).max(50).optional(),
    requiredObjections: z.number().int().min(0).max(50).optional(),
    synthesisMode: z.enum(['single', 'validated']).optional(),
    synthesisAgentId: z.string().uuid().optional(),
    language: z.string().trim().min(1).max(100).optional(),
    roles: z.record(z.string(), z.string()).optional(),
    participantReadyTimeoutSec: z.number().int().min(60).max(1800).optional(),
    relatedRoomIds: z.array(z.string().uuid()).max(3).optional(),
    reactiveInjection: z.boolean().optional(),
    maxResponsesPerWave: z.number().int().min(1).max(20).optional(),
    evictionThreshold: z.number().int().min(1).max(20).optional(),
    roleInstructions: z.record(z.string(), z.string()).optional(),
    reviewPauseSec: z.number().int().min(0).max(300).optional(),
    goal: z.string().trim().min(1).max(1000).optional(),
    constraints: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    deliverableType: z
      .enum(['decision', 'options_list', 'action_plan', 'risk_assessment', 'exploration'])
      .optional(),
    targetAudience: z.string().trim().min(1).max(200).optional(),
    autoReflection: z.boolean().optional(),
    reflectionInterval: z.number().int().min(1).max(20).optional(),
    fallback: brainstormFallbackPolicySchema.optional(),
  })
  .strict();

export const createBrainstormRequestSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  title: z.string().min(1),
  topic: z.string().min(1),
  maxWaves: z.number().int().min(1).max(100).optional(),
  config: brainstormConfigSchema.optional(),
  participants: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        model: z.string().optional(),
      }),
    )
    .min(2, 'At least 2 participants are required'),
});

export type BrainstormConfigInput = z.infer<typeof brainstormConfigSchema>;
export type CreateBrainstormRequest = z.infer<typeof createBrainstormRequestSchema>;
