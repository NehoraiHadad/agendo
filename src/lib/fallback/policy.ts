export const FALLBACK_MODES = ['off', 'model_only', 'model_then_agent'] as const;

export type FallbackMode = (typeof FALLBACK_MODES)[number];

export const FALLBACK_TRIGGER_ERRORS = [
  'usage_limit',
  'auth_error',
  'rate_limited',
  'provider_unavailable',
  'model_unavailable',
] as const;

export type FallbackTriggerError = (typeof FALLBACK_TRIGGER_ERRORS)[number];

export interface FallbackModelPolicy {
  byProvider?: Record<string, string[]>;
  byAgent?: Record<string, string[]>;
}

export interface FallbackPolicy {
  enabled?: boolean;
  mode?: FallbackMode;
  preservePinnedModel?: boolean;
  allowedFallbackModels?: FallbackModelPolicy;
  allowedFallbackAgents?: string[];
  triggerErrors?: FallbackTriggerError[];
}

export interface ResolvedFallbackPolicy {
  enabled: boolean;
  mode: FallbackMode;
  preservePinnedModel: boolean;
  allowedFallbackModels: {
    byProvider: Record<string, string[]>;
    byAgent: Record<string, string[]>;
  };
  allowedFallbackAgents: string[];
  triggerErrors: FallbackTriggerError[];
}

export const DEFAULT_FALLBACK_POLICY: ResolvedFallbackPolicy = {
  enabled: true,
  mode: 'model_then_agent',
  preservePinnedModel: true,
  allowedFallbackModels: {
    byProvider: {},
    byAgent: {},
  },
  allowedFallbackAgents: [],
  triggerErrors: ['usage_limit', 'auth_error', 'provider_unavailable', 'model_unavailable'],
};

function cloneModelPolicy(
  policy: ResolvedFallbackPolicy['allowedFallbackModels'],
): ResolvedFallbackPolicy['allowedFallbackModels'] {
  return {
    byProvider: Object.fromEntries(
      Object.entries(policy.byProvider).map(([key, value]) => [key, [...value]]),
    ),
    byAgent: Object.fromEntries(
      Object.entries(policy.byAgent).map(([key, value]) => [key, [...value]]),
    ),
  };
}

function cloneResolvedPolicy(policy: ResolvedFallbackPolicy): ResolvedFallbackPolicy {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    preservePinnedModel: policy.preservePinnedModel,
    allowedFallbackModels: cloneModelPolicy(policy.allowedFallbackModels),
    allowedFallbackAgents: [...policy.allowedFallbackAgents],
    triggerErrors: [...policy.triggerErrors],
  };
}

export function resolveFallbackPolicy(
  ...policies: Array<FallbackPolicy | null | undefined>
): ResolvedFallbackPolicy {
  const resolved = cloneResolvedPolicy(DEFAULT_FALLBACK_POLICY);

  for (const policy of policies) {
    if (!policy) {
      continue;
    }

    if (policy.enabled !== undefined) {
      resolved.enabled = policy.enabled;
    }

    if (policy.mode !== undefined) {
      resolved.mode = policy.mode;
    }

    if (policy.preservePinnedModel !== undefined) {
      resolved.preservePinnedModel = policy.preservePinnedModel;
    }

    if (policy.allowedFallbackModels?.byProvider !== undefined) {
      resolved.allowedFallbackModels.byProvider = Object.fromEntries(
        Object.entries(policy.allowedFallbackModels.byProvider).map(([key, value]) => [
          key,
          [...value],
        ]),
      );
    }

    if (policy.allowedFallbackModels?.byAgent !== undefined) {
      resolved.allowedFallbackModels.byAgent = Object.fromEntries(
        Object.entries(policy.allowedFallbackModels.byAgent).map(([key, value]) => [
          key,
          [...value],
        ]),
      );
    }

    if (policy.allowedFallbackAgents !== undefined) {
      resolved.allowedFallbackAgents = [...policy.allowedFallbackAgents];
    }

    if (policy.triggerErrors !== undefined) {
      resolved.triggerErrors = [...policy.triggerErrors];
    }
  }

  if (!resolved.enabled || resolved.mode === 'off') {
    resolved.enabled = false;
    resolved.mode = 'off';
  }

  return resolved;
}

export function isFallbackEnabled(
  policy: FallbackPolicy | ResolvedFallbackPolicy | null | undefined,
) {
  if (!policy) {
    return DEFAULT_FALLBACK_POLICY.enabled;
  }

  if ('enabled' in policy && policy.enabled === false) {
    return false;
  }

  return policy.mode !== 'off';
}
