/**
 * Tests for Playbook config schema, presets, and resolvePlaybook().
 */

import { describe, it, expect } from 'vitest';
import {
  PLAYBOOK_DEFAULTS,
  PLAYBOOK_PRESETS,
  DEFAULT_MAX_WAVES,
  resolvePlaybook,
  getPreset,
} from '../playbook';
import type { BrainstormConfig } from '@/lib/db/schema';
import { DEFAULT_FALLBACK_POLICY } from '@/lib/fallback/policy';

// ============================================================================
// Defaults
// ============================================================================

describe('PLAYBOOK_DEFAULTS', () => {
  it('has correct default values', () => {
    expect(PLAYBOOK_DEFAULTS.waveTimeoutSec).toBe(120);
    expect(PLAYBOOK_DEFAULTS.wave0ExtraTimeoutSec).toBe(180);
    expect(PLAYBOOK_DEFAULTS.convergenceMode).toBe('unanimous');
    expect(PLAYBOOK_DEFAULTS.minWavesBeforePass).toBe(2);
    expect(PLAYBOOK_DEFAULTS.requiredObjections).toBe(0);
    expect(PLAYBOOK_DEFAULTS.synthesisMode).toBe('single');
    expect(PLAYBOOK_DEFAULTS.fallback).toEqual(DEFAULT_FALLBACK_POLICY);
  });

  it('DEFAULT_MAX_WAVES is 10', () => {
    expect(DEFAULT_MAX_WAVES).toBe(10);
  });
});

// ============================================================================
// Presets
// ============================================================================

describe('PLAYBOOK_PRESETS', () => {
  it('has exactly 3 presets', () => {
    expect(PLAYBOOK_PRESETS).toHaveLength(3);
  });

  it('Quick Decision preset has correct values', () => {
    const preset = PLAYBOOK_PRESETS.find((p) => p.id === 'quick-decision')!;
    expect(preset).toBeDefined();
    expect(preset.label).toBe('Quick Decision');
    expect(preset.maxWaves).toBe(5);
    expect(preset.config.convergenceMode).toBe('majority');
    expect(preset.config.waveTimeoutSec).toBe(90);
  });

  it('Architecture Review preset has correct values', () => {
    const preset = PLAYBOOK_PRESETS.find((p) => p.id === 'architecture-review')!;
    expect(preset).toBeDefined();
    expect(preset.label).toBe('Architecture Review');
    expect(preset.maxWaves).toBe(10);
    expect(preset.config.synthesisMode).toBe('validated');
    expect(preset.config.requiredObjections).toBe(2);
  });

  it('Deep Debate preset has correct values', () => {
    const preset = PLAYBOOK_PRESETS.find((p) => p.id === 'deep-debate')!;
    expect(preset).toBeDefined();
    expect(preset.label).toBe('Deep Debate');
    expect(preset.maxWaves).toBe(15);
    expect(preset.config.waveTimeoutSec).toBe(180);
    expect(preset.config.minWavesBeforePass).toBe(3);
  });

  it('all presets have unique IDs', () => {
    const ids = PLAYBOOK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all presets have required fields', () => {
    for (const preset of PLAYBOOK_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.maxWaves).toBeGreaterThanOrEqual(1);
      expect(preset.config).toBeDefined();
    }
  });
});

// ============================================================================
// resolvePlaybook
// ============================================================================

describe('resolvePlaybook', () => {
  it('returns all defaults when config is null', () => {
    const resolved = resolvePlaybook(null);
    expect(resolved.waveTimeoutSec).toBe(120);
    expect(resolved.wave0ExtraTimeoutSec).toBe(180);
    expect(resolved.convergenceMode).toBe('unanimous');
    expect(resolved.minWavesBeforePass).toBe(2);
    expect(resolved.requiredObjections).toBe(0);
    expect(resolved.synthesisMode).toBe('single');
    expect(resolved.synthesisAgentId).toBeUndefined();
    expect(resolved.language).toBeUndefined();
    expect(resolved.roles).toBeUndefined();
    expect(resolved.fallback).toEqual(DEFAULT_FALLBACK_POLICY);
  });

  it('returns all defaults when config is undefined', () => {
    const resolved = resolvePlaybook(undefined);
    expect(resolved.waveTimeoutSec).toBe(120);
    expect(resolved.convergenceMode).toBe('unanimous');
  });

  it('returns all defaults when config is empty object', () => {
    const resolved = resolvePlaybook({});
    expect(resolved.waveTimeoutSec).toBe(120);
    expect(resolved.convergenceMode).toBe('unanimous');
  });

  it('overrides specific fields while keeping defaults for the rest', () => {
    const config: BrainstormConfig = {
      waveTimeoutSec: 90,
      convergenceMode: 'majority',
    };
    const resolved = resolvePlaybook(config);
    expect(resolved.waveTimeoutSec).toBe(90);
    expect(resolved.convergenceMode).toBe('majority');
    // Defaults for unset fields
    expect(resolved.wave0ExtraTimeoutSec).toBe(180);
    expect(resolved.minWavesBeforePass).toBe(2);
    expect(resolved.requiredObjections).toBe(0);
    expect(resolved.synthesisMode).toBe('single');
  });

  it('passes through optional fields when set', () => {
    const config: BrainstormConfig = {
      synthesisAgentId: 'agent-123',
      language: 'Spanish',
      roles: { critic: 'claude-code-1', advocate: 'gemini-cli-1' },
    };
    const resolved = resolvePlaybook(config);
    expect(resolved.synthesisAgentId).toBe('agent-123');
    expect(resolved.language).toBe('Spanish');
    expect(resolved.roles).toEqual({ critic: 'claude-code-1', advocate: 'gemini-cli-1' });
  });

  it('passes through participantReadyTimeoutSec', () => {
    const resolved = resolvePlaybook({ participantReadyTimeoutSec: 600 });
    expect(resolved.participantReadyTimeoutSec).toBe(600);
  });

  it('merges fallback policy with defaults', () => {
    const resolved = resolvePlaybook({
      fallback: {
        mode: 'model_only',
        preservePinnedModel: false,
        triggerErrors: ['usage_limit', 'auth_error'],
      },
    });

    expect(resolved.fallback.enabled).toBe(true);
    expect(resolved.fallback.mode).toBe('model_only');
    expect(resolved.fallback.preservePinnedModel).toBe(false);
    expect(resolved.fallback.triggerErrors).toEqual(['usage_limit', 'auth_error']);
    expect(resolved.fallback.allowedFallbackAgents).toEqual([]);
  });
});

// ============================================================================
// getPreset
// ============================================================================

describe('getPreset', () => {
  it('returns preset by ID', () => {
    const preset = getPreset('quick-decision');
    expect(preset).toBeDefined();
    expect(preset?.label).toBe('Quick Decision');
  });

  it('returns undefined for unknown ID', () => {
    expect(getPreset('nonexistent')).toBeUndefined();
  });
});
