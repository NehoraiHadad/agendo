/**
 * Brainstorm Playbook — presets and defaults for brainstorm room configuration.
 *
 * A Playbook is the full set of configurable parameters for a brainstorm room.
 * The BrainstormConfig interface (schema.ts) stores these in the `config` JSONB column.
 */

import type { BrainstormConfig } from '@/lib/db/schema';

// ============================================================================
// Defaults
// ============================================================================

/** Default values for all Playbook fields */
export const PLAYBOOK_DEFAULTS: Required<
  Omit<
    BrainstormConfig,
    'synthesisAgentId' | 'language' | 'roles' | 'participantReadyTimeoutSec' | 'relatedRoomIds'
  >
> = {
  waveTimeoutSec: 120,
  wave0ExtraTimeoutSec: 180,
  convergenceMode: 'unanimous',
  minWavesBeforePass: 2,
  requiredObjections: 0,
  synthesisMode: 'single',
  reactiveInjection: false,
  maxResponsesPerWave: 2,
  evictionThreshold: 2,
  roleInstructions: {},
} as const;

/** Default maxWaves (stored on the room row, not in config) */
export const DEFAULT_MAX_WAVES = 10;

// ============================================================================
// Presets
// ============================================================================

export interface PlaybookPreset {
  id: string;
  label: string;
  description: string;
  maxWaves: number;
  config: BrainstormConfig;
}

export const PLAYBOOK_PRESETS: PlaybookPreset[] = [
  {
    id: 'quick-decision',
    label: 'Quick Decision',
    description: 'Fast convergence with majority rule — 5 waves, 90s timeout',
    maxWaves: 5,
    config: {
      convergenceMode: 'majority',
      waveTimeoutSec: 90,
    },
  },
  {
    id: 'architecture-review',
    label: 'Architecture Review',
    description: 'Thorough review with validated synthesis — 10 waves, requires 2 objections',
    maxWaves: 10,
    config: {
      synthesisMode: 'validated',
      requiredObjections: 2,
    },
  },
  {
    id: 'deep-debate',
    label: 'Deep Debate',
    description: 'Extended discussion with high bar — 15 waves, 3-min timeout, min 3 waves',
    maxWaves: 15,
    config: {
      waveTimeoutSec: 180,
      minWavesBeforePass: 3,
    },
  },
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a full playbook from a partial BrainstormConfig, applying defaults.
 * This is the single source of truth for how config values are resolved.
 */
export function resolvePlaybook(config: BrainstormConfig | null | undefined): Required<
  Omit<
    BrainstormConfig,
    'synthesisAgentId' | 'language' | 'roles' | 'participantReadyTimeoutSec' | 'relatedRoomIds'
  >
> & {
  synthesisAgentId?: string;
  language?: string;
  roles?: Record<string, string>;
  participantReadyTimeoutSec?: number;
} {
  return {
    waveTimeoutSec: config?.waveTimeoutSec ?? PLAYBOOK_DEFAULTS.waveTimeoutSec,
    wave0ExtraTimeoutSec: config?.wave0ExtraTimeoutSec ?? PLAYBOOK_DEFAULTS.wave0ExtraTimeoutSec,
    convergenceMode: config?.convergenceMode ?? PLAYBOOK_DEFAULTS.convergenceMode,
    minWavesBeforePass: config?.minWavesBeforePass ?? PLAYBOOK_DEFAULTS.minWavesBeforePass,
    requiredObjections: config?.requiredObjections ?? PLAYBOOK_DEFAULTS.requiredObjections,
    synthesisMode: config?.synthesisMode ?? PLAYBOOK_DEFAULTS.synthesisMode,
    reactiveInjection: config?.reactiveInjection ?? PLAYBOOK_DEFAULTS.reactiveInjection,
    maxResponsesPerWave: config?.maxResponsesPerWave ?? PLAYBOOK_DEFAULTS.maxResponsesPerWave,
    evictionThreshold: config?.evictionThreshold ?? PLAYBOOK_DEFAULTS.evictionThreshold,
    roleInstructions: config?.roleInstructions ?? PLAYBOOK_DEFAULTS.roleInstructions,
    synthesisAgentId: config?.synthesisAgentId,
    language: config?.language,
    roles: config?.roles,
    participantReadyTimeoutSec: config?.participantReadyTimeoutSec,
  };
}

/**
 * Find a preset by ID. Returns undefined if not found.
 */
export function getPreset(id: string): PlaybookPreset | undefined {
  return PLAYBOOK_PRESETS.find((p) => p.id === id);
}
