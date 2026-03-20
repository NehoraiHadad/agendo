import { describe, expect, it } from 'vitest';
import { DEFAULT_FALLBACK_POLICY, isFallbackEnabled, resolveFallbackPolicy } from '../policy';

describe('resolveFallbackPolicy', () => {
  it('returns the default policy when no overrides are provided', () => {
    expect(resolveFallbackPolicy()).toEqual(DEFAULT_FALLBACK_POLICY);
  });

  it('applies later overrides with precedence and keeps unspecified defaults', () => {
    const resolved = resolveFallbackPolicy(
      {
        mode: 'model_only',
        allowedFallbackModels: {
          byProvider: { openai: ['gpt-4o'] },
        },
      },
      {
        preservePinnedModel: false,
        allowedFallbackModels: {
          byAgent: { 'codex-cli-1': ['o3-mini'] },
        },
        allowedFallbackAgents: ['claude-code-1'],
        triggerErrors: ['usage_limit', 'auth_error'],
      },
    );

    expect(resolved.mode).toBe('model_only');
    expect(resolved.enabled).toBe(true);
    expect(resolved.preservePinnedModel).toBe(false);
    expect(resolved.allowedFallbackModels.byProvider).toEqual({ openai: ['gpt-4o'] });
    expect(resolved.allowedFallbackModels.byAgent).toEqual({ 'codex-cli-1': ['o3-mini'] });
    expect(resolved.allowedFallbackAgents).toEqual(['claude-code-1']);
    expect(resolved.triggerErrors).toEqual(['usage_limit', 'auth_error']);
  });

  it('forces mode off when explicitly disabled', () => {
    const resolved = resolveFallbackPolicy({ mode: 'model_then_agent' }, { enabled: false });
    expect(resolved.enabled).toBe(false);
    expect(resolved.mode).toBe('off');
  });
});

describe('isFallbackEnabled', () => {
  it('treats undefined policy as enabled by default', () => {
    expect(isFallbackEnabled(undefined)).toBe(true);
  });

  it('treats mode off as disabled', () => {
    expect(isFallbackEnabled({ mode: 'off' })).toBe(false);
  });

  it('treats explicit enabled false as disabled', () => {
    expect(isFallbackEnabled({ enabled: false, mode: 'model_only' })).toBe(false);
  });
});
