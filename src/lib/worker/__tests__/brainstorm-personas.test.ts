import { describe, expect, it } from 'vitest';
import {
  buildBrainstormProviderLens,
  getBrainstormProviderPersona,
  getProviderTint,
  inferProviderFromAgentSlug,
} from '@/lib/worker/brainstorm-personas';

describe('brainstorm-personas', () => {
  describe('inferProviderFromAgentSlug', () => {
    it('maps known agent slugs to providers', () => {
      expect(inferProviderFromAgentSlug('claude-code-1')).toBe('anthropic');
      expect(inferProviderFromAgentSlug('codex-cli-1')).toBe('openai');
      expect(inferProviderFromAgentSlug('gemini-cli-1')).toBe('google');
      expect(inferProviderFromAgentSlug('github-copilot-cli')).toBe('github');
    });

    it('returns null for unknown slugs', () => {
      expect(inferProviderFromAgentSlug('custom-agent')).toBeNull();
    });
  });

  describe('getProviderTint', () => {
    it('returns a tint for each supported provider', () => {
      expect(getProviderTint('anthropic')?.label).toBe('Claude');
      expect(getProviderTint('openai')?.label).toBe('Codex');
      expect(getProviderTint('google')?.label).toBe('Gemini');
      expect(getProviderTint('github')?.label).toBe('Copilot');
    });

    it('includes a tint sentence for each provider', () => {
      const tint = getProviderTint('anthropic');
      expect(tint?.tint).toContain('deep reasoning');
      expect(tint?.tint).toContain('architectural consistency');
    });

    it('returns null when provider is missing', () => {
      expect(getProviderTint(null)).toBeNull();
      expect(getProviderTint(undefined)).toBeNull();
    });
  });

  describe('getBrainstormProviderPersona (deprecated compat)', () => {
    it('returns a tint for each supported provider', () => {
      expect(getBrainstormProviderPersona('anthropic')?.label).toBe('Claude');
      expect(getBrainstormProviderPersona('openai')?.label).toBe('Codex');
      expect(getBrainstormProviderPersona('google')?.label).toBe('Gemini');
      expect(getBrainstormProviderPersona('github')?.label).toBe('Copilot');
    });

    it('returns null when provider is missing', () => {
      expect(getBrainstormProviderPersona(null)).toBeNull();
    });
  });

  describe('buildBrainstormProviderLens (deprecated compat)', () => {
    it('builds a provider lens with label and tint', () => {
      const lens = buildBrainstormProviderLens('anthropic');
      expect(lens).toContain('Claude');
      expect(lens).toContain('deep reasoning');
      expect(lens).toContain('architectural consistency');
    });

    it('returns a lens regardless of role (role behavior now in skill files)', () => {
      const lens = buildBrainstormProviderLens('openai', 'pragmatist');
      expect(lens).toContain('Codex');
      expect(lens).toContain('implementation realism');
    });

    it('returns null for unknown providers', () => {
      expect(buildBrainstormProviderLens(null, 'critic')).toBeNull();
    });
  });
});
