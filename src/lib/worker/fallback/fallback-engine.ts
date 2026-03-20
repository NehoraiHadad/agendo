import {
  resolveFallbackPolicy,
  type FallbackPolicy,
  type FallbackTriggerError,
} from '@/lib/fallback/policy';
import { getModelsForProvider, type Provider } from '@/lib/services/model-service';
import type { ClassifiedSessionError } from '@/lib/worker/fallback/error-classifier';

export interface FallbackParticipantContext {
  agentId: string;
  agentName: string;
  agentSlug: string;
  provider: Provider | null;
  model: string | null;
  modelPinned: boolean;
  supportsModelSwitch: boolean;
}

export interface FallbackAgentCandidate {
  agentId: string;
  agentName: string;
  agentSlug: string;
  provider: Provider | null;
}

interface SharedFallbackDecisionFields {
  reason: FallbackTriggerError;
  summary: string;
  triggerError: string;
}

export type FallbackDecision =
  | ({ type: 'none' } & SharedFallbackDecisionFields)
  | ({ type: 'terminal'; message: string } & SharedFallbackDecisionFields)
  | ({ type: 'switch_model'; model: string } & SharedFallbackDecisionFields)
  | ({ type: 'switch_agent'; agent: FallbackAgentCandidate } & SharedFallbackDecisionFields);

export interface FallbackDecisionContext {
  policy?: FallbackPolicy | null;
  error: ClassifiedSessionError;
  participant: FallbackParticipantContext;
  attemptedModels: string[];
  attemptedAgents: string[];
  availableAgents: FallbackAgentCandidate[];
}

export async function resolveFallbackModelCandidates(input: {
  policy?: FallbackPolicy | null;
  participant: Pick<FallbackParticipantContext, 'agentSlug' | 'provider' | 'model'>;
  attemptedModels: string[];
}): Promise<string[]> {
  const policy = resolveFallbackPolicy(input.policy);
  const agentScoped = policy.allowedFallbackModels.byAgent[input.participant.agentSlug];
  const providerScoped = input.participant.provider
    ? policy.allowedFallbackModels.byProvider[input.participant.provider]
    : undefined;

  const configuredCandidates = agentScoped?.length
    ? agentScoped
    : providerScoped?.length
      ? providerScoped
      : null;

  const availableModels =
    configuredCandidates ??
    (input.participant.provider
      ? (await getModelsForProvider(input.participant.provider)).map((model) => model.id)
      : []);

  const attempted = new Set(input.attemptedModels);
  return Array.from(new Set(availableModels)).filter(
    (model) => model !== input.participant.model && !attempted.has(model),
  );
}

export function selectFallbackAgentCandidate(input: {
  policy?: FallbackPolicy | null;
  participant: Pick<FallbackParticipantContext, 'agentId' | 'agentSlug'>;
  attemptedAgents: string[];
  availableAgents: FallbackAgentCandidate[];
}): FallbackAgentCandidate | null {
  const policy = resolveFallbackPolicy(input.policy);
  const attempted = new Set([...input.attemptedAgents, input.participant.agentId]);
  const preferredOrder =
    policy.allowedFallbackAgents.length > 0
      ? policy.allowedFallbackAgents
      : input.availableAgents.map((candidate) => candidate.agentSlug);

  for (const slug of preferredOrder) {
    const candidate = input.availableAgents.find((entry) => entry.agentSlug === slug);
    if (!candidate || attempted.has(candidate.agentId)) {
      continue;
    }
    return candidate;
  }

  return null;
}

export async function decideFallback(context: FallbackDecisionContext): Promise<FallbackDecision> {
  const policy = resolveFallbackPolicy(context.policy);
  const sharedFields: SharedFallbackDecisionFields = {
    reason: context.error.category,
    summary: context.error.summary,
    triggerError: context.error.rawMessage,
  };

  if (!policy.enabled || !policy.triggerErrors.includes(context.error.category)) {
    return { type: 'none', ...sharedFields };
  }

  const modelFallbackAllowed =
    context.participant.supportsModelSwitch &&
    policy.mode !== 'off' &&
    !(
      policy.preservePinnedModel &&
      context.participant.modelPinned &&
      context.participant.model !== null
    );

  if (modelFallbackAllowed) {
    const modelCandidates = await resolveFallbackModelCandidates({
      policy,
      participant: context.participant,
      attemptedModels: context.attemptedModels,
    });
    const nextModel = modelCandidates[0];
    if (nextModel) {
      return {
        type: 'switch_model',
        model: nextModel,
        ...sharedFields,
      };
    }
  }

  if (policy.mode === 'model_then_agent') {
    const candidate = selectFallbackAgentCandidate({
      policy,
      participant: context.participant,
      attemptedAgents: context.attemptedAgents,
      availableAgents: context.availableAgents,
    });
    if (candidate) {
      return {
        type: 'switch_agent',
        agent: candidate,
        ...sharedFields,
      };
    }
  }

  const blockedByPinnedModel =
    policy.preservePinnedModel &&
    context.participant.modelPinned &&
    context.participant.model !== null;
  const message = blockedByPinnedModel
    ? `${context.error.summary}. Automatic model fallback is disabled because this participant uses a pinned model.`
    : `${context.error.summary}. No eligible automatic fallback remained.`;

  return {
    type: 'terminal',
    message,
    ...sharedFields,
  };
}
