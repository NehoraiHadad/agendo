import type { Provider } from '@/lib/services/model-service';

/**
 * Provider Tints — lightweight modifier for brainstorm participants.
 *
 * Role behavior lives in the brainstorm-role-* skill files now.
 * These tints are just 2-3 sentences describing each provider's natural tendency,
 * injected into the preamble as a secondary flavor.
 */

export interface ProviderTint {
  label: string;
  tint: string;
}

const PROVIDER_TINTS: Record<Provider, ProviderTint> = {
  anthropic: {
    label: 'Claude',
    tint: 'You tend toward deep reasoning, architectural consistency, and surfacing hidden assumptions that the room has not made explicit yet.',
  },
  openai: {
    label: 'Codex',
    tint: 'You tend toward implementation realism, code-level consequences, and finding the smallest robust change that actually solves the problem.',
  },
  google: {
    label: 'Gemini',
    tint: 'You tend toward breadth, alternative approaches, and ecosystem context that others may miss due to local focus.',
  },
  github: {
    label: 'Copilot',
    tint: 'You tend toward execution clarity, developer workflow friction, and practical guardrails that make delivery smooth.',
  },
};

export function inferProviderFromAgentSlug(agentSlug: string | undefined): Provider | null {
  if (!agentSlug) return null;
  if (agentSlug.includes('claude')) return 'anthropic';
  if (agentSlug.includes('codex')) return 'openai';
  if (agentSlug.includes('gemini')) return 'google';
  if (agentSlug.includes('copilot')) return 'github';
  return null;
}

/**
 * Get the provider tint for a given provider.
 * Returns null if the provider is not recognized.
 */
export function getProviderTint(provider: Provider | null | undefined): ProviderTint | null {
  if (!provider) return null;
  return PROVIDER_TINTS[provider] ?? null;
}

/**
 * Build a short provider lens string for the preamble.
 * Returns the label + tint sentence. Role behavior is in skill files now.
 *
 * @deprecated Use getProviderTint() directly — this wrapper exists for backward compat
 * with brainstorm-orchestrator.ts until the Phase 4 preamble rewrite.
 */
export function buildBrainstormProviderLens(
  provider: Provider | null | undefined,
  _role?: string | null,
): string | null {
  const tint = getProviderTint(provider);
  if (!tint) return null;
  return `You are contributing with the **${tint.label}** lens.\n${tint.tint}`;
}

// Legacy compat — re-export old types for any external consumers
/** @deprecated Use ProviderTint instead */
export type BrainstormProviderPersona = ProviderTint & {
  headline: string;
  phaseLens: { divergent: string; critique: string; convergence: string };
  roleLens: Partial<Record<string, string>>;
};

/** @deprecated Use getProviderTint instead */
export function getBrainstormProviderPersona(
  provider: Provider | null | undefined,
): ProviderTint | null {
  return getProviderTint(provider);
}
