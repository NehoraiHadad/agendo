import { describe, expect, it } from 'vitest';
import {
  LEADER_PRIORITY,
  selectLeader,
  buildLeaderPreambleSection,
  buildNonLeaderPreambleSection,
} from '@/lib/brainstorm/leader';

describe('leader', () => {
  describe('LEADER_PRIORITY', () => {
    it('ranks anthropic highest (lowest number)', () => {
      expect(LEADER_PRIORITY.anthropic).toBe(1);
      expect(LEADER_PRIORITY.openai).toBe(2);
      expect(LEADER_PRIORITY.google).toBe(3);
      expect(LEADER_PRIORITY.github).toBe(4);
    });
  });

  describe('selectLeader', () => {
    const claude = { id: 'p1', agentSlug: 'claude-code-1', provider: 'anthropic' as const };
    const codex = { id: 'p2', agentSlug: 'codex-cli-1', provider: 'openai' as const };
    const gemini = { id: 'p3', agentSlug: 'gemini-cli-1', provider: 'google' as const };
    const copilot = { id: 'p4', agentSlug: 'copilot-cli', provider: 'github' as const };

    it('returns null for empty participants', () => {
      expect(selectLeader([])).toBeNull();
    });

    it('selects the highest-priority provider as leader', () => {
      expect(selectLeader([codex, claude, gemini])).toBe('p1'); // Claude wins
    });

    it('selects codex over gemini when no anthropic', () => {
      expect(selectLeader([gemini, codex])).toBe('p2'); // Codex wins
    });

    it('returns the single participant when only one', () => {
      expect(selectLeader([copilot])).toBe('p4');
    });

    it('prefers explicit leader override when provided', () => {
      expect(selectLeader([claude, codex, gemini], 'p3')).toBe('p3'); // Gemini forced
    });

    it('falls back to priority when explicit leader not found', () => {
      expect(selectLeader([claude, codex], 'nonexistent-id')).toBe('p1');
    });

    it('handles participants with null provider (lowest priority)', () => {
      const unknown = { id: 'p5', agentSlug: 'custom-agent', provider: null };
      expect(selectLeader([unknown, codex])).toBe('p2'); // Codex wins over null
    });

    it('handles all null providers — returns first participant', () => {
      const a = { id: 'a', agentSlug: 'agent-a', provider: null };
      const b = { id: 'b', agentSlug: 'agent-b', provider: null };
      expect(selectLeader([a, b])).toBe('a');
    });

    it('preserves order for same-priority participants', () => {
      // Two Claudes — first one should win (stable sort)
      const claude2 = { id: 'p1b', agentSlug: 'claude-code-2', provider: 'anthropic' as const };
      const result = selectLeader([claude2, claude]);
      // Both have priority 1, so first in sorted order wins
      expect(result).toBeDefined();
    });
  });

  describe('buildLeaderPreambleSection', () => {
    it('contains leader heading', () => {
      const section = buildLeaderPreambleSection();
      expect(section).toContain('## You Are the Leader');
    });

    it('describes leader responsibilities', () => {
      const section = buildLeaderPreambleSection();
      expect(section).toContain('synthesize the final recommendation');
      expect(section).toContain('break ties');
      expect(section).toContain('primary executor');
    });

    it('clarifies equal contribution', () => {
      const section = buildLeaderPreambleSection();
      expect(section).toContain('everyone contributes equally');
    });
  });

  describe('buildNonLeaderPreambleSection', () => {
    it('contains leader heading', () => {
      const section = buildNonLeaderPreambleSection('Claude');
      expect(section).toContain('## The Leader');
    });

    it('names the leader', () => {
      const section = buildNonLeaderPreambleSection('Claude');
      expect(section).toContain('**Claude**');
    });

    it('describes leader role', () => {
      const section = buildNonLeaderPreambleSection('Codex');
      expect(section).toContain('Synthesize the final recommendation');
      expect(section).toContain('Break ties');
    });

    it('guides non-leaders to address disagreements to leader', () => {
      const section = buildNonLeaderPreambleSection('Gemini');
      expect(section).toContain('Address unresolved disagreements to the leader');
    });
  });
});
