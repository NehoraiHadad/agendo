import { describe, expect, it } from 'vitest';
import {
  buildBrainstormProviderLens,
  getBrainstormProviderPersona,
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

  describe('getBrainstormProviderPersona', () => {
    it('returns a persona for each supported provider', () => {
      expect(getBrainstormProviderPersona('anthropic')?.label).toBe('Claude');
      expect(getBrainstormProviderPersona('openai')?.label).toBe('Codex');
      expect(getBrainstormProviderPersona('google')?.label).toBe('Gemini');
      expect(getBrainstormProviderPersona('github')?.label).toBe('Copilot');
    });

    it('returns null when provider is missing', () => {
      expect(getBrainstormProviderPersona(null)).toBeNull();
    });
  });

  describe('buildBrainstormProviderLens', () => {
    it('builds a provider lens with phase guidance', () => {
      const lens = buildBrainstormProviderLens('anthropic');
      expect(lens).toContain('Claude');
      expect(lens).toContain('architectural consistency');
      expect(lens).toContain('In early exploration');
      expect(lens).toContain('In convergence');
    });

    it('appends role-specific guidance when a known role is provided', () => {
      const lens = buildBrainstormProviderLens('openai', 'pragmatist');
      expect(lens).toContain('Codex');
      expect(lens).toContain('As Codex in the pragmatist seat');
      expect(lens).toContain('files, modules, interfaces');
    });

    it('returns null for unknown providers', () => {
      expect(buildBrainstormProviderLens(null, 'critic')).toBeNull();
    });
  });
});
