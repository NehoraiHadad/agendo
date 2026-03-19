import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSessionFiles,
  deregisterSession,
  checkContention,
  clearRegistry,
  type SessionFileState,
  type ContentionAlert as _ContentionAlert,
} from '../file-contention';

describe('file-contention registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  const makeState = (
    overrides: Partial<SessionFileState> & { sessionId: string },
  ): SessionFileState => ({
    agentName: 'Claude Code',
    agentSlug: 'claude-code-1',
    branch: 'main',
    files: new Set<string>(),
    ...overrides,
  });

  describe('registerSessionFiles', () => {
    it('returns null when no other sessions are registered', () => {
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts', '/src/bar.ts']),
        }),
      );
      expect(result).toBeNull();
    });

    it('returns null when sessions have no overlapping files', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          files: new Set(['/src/bar.ts']),
        }),
      );
      expect(result).toBeNull();
    });

    it('returns critical when same file on same branch', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          files: new Set(['/src/foo.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'main',
          files: new Set(['/src/foo.ts', '/src/bar.ts']),
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('critical');
      expect(result!.conflictingFiles).toEqual(['/src/foo.ts']);
      expect(result!.sessions).toHaveLength(2);
    });

    it('returns warning when same file on different branches', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          files: new Set(['/src/foo.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'feature-x',
          files: new Set(['/src/foo.ts']),
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('warning');
      expect(result!.conflictingFiles).toEqual(['/src/foo.ts']);
    });

    it('returns critical when mixed severity (critical wins)', () => {
      // session-a on main with file1 and file2
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          files: new Set(['/src/file1.ts', '/src/file2.ts']),
        }),
      );
      // session-b on feature with file1 (warning), session-c on main with file2 (critical)
      registerSessionFiles(
        makeState({
          sessionId: 'session-c',
          branch: 'main',
          files: new Set(['/src/file2.ts']),
        }),
      );
      // Now register session-b that overlaps with session-a on different branch
      // AND session-a overlaps with session-c on same branch
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'feature-x',
          files: new Set(['/src/file1.ts']),
        }),
      );
      // session-b only overlaps with session-a on file1, different branches → warning
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('warning');
    });

    it('includes all overlapping sessions in the alert', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          agentName: 'Claude',
          files: new Set(['/src/shared.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'main',
          agentName: 'Codex',
          files: new Set(['/src/shared.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-c',
          branch: 'main',
          agentName: 'Gemini',
          files: new Set(['/src/shared.ts']),
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('critical');
      expect(result!.sessions).toHaveLength(3);
      const slugs = result!.sessions.map((s) => s.sessionId).sort();
      expect(slugs).toEqual(['session-a', 'session-b', 'session-c']);
    });

    it('updates files when re-registering same session', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          files: new Set(['/src/bar.ts']),
        }),
      );
      // session-a now modifies bar.ts instead of foo.ts
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/bar.ts']),
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.conflictingFiles).toEqual(['/src/bar.ts']);
    });

    it('includes taskTitle in session info when provided', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          taskTitle: 'Fix auth bug',
          files: new Set(['/src/auth.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          taskTitle: 'Refactor auth',
          files: new Set(['/src/auth.ts']),
        }),
      );
      expect(result).not.toBeNull();
      const taskTitles = result!.sessions.map((s) => s.taskTitle);
      expect(taskTitles).toContain('Fix auth bug');
      expect(taskTitles).toContain('Refactor auth');
    });

    it('returns null when session registers empty file set', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts']),
        }),
      );
      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          files: new Set(),
        }),
      );
      expect(result).toBeNull();
    });
  });

  describe('deregisterSession', () => {
    it('removes session from registry so no further contention is detected', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts']),
        }),
      );
      deregisterSession('session-a');

      const result = registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          files: new Set(['/src/foo.ts']),
        }),
      );
      expect(result).toBeNull();
    });

    it('is a no-op for unknown session ids', () => {
      // Should not throw
      expect(() => deregisterSession('nonexistent')).not.toThrow();
    });
  });

  describe('checkContention', () => {
    it('returns null when session has no overlaps', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          files: new Set(['/src/foo.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          files: new Set(['/src/bar.ts']),
        }),
      );
      const result = checkContention('session-a');
      expect(result).toBeNull();
    });

    it('returns alert for existing contention', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          files: new Set(['/src/foo.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'main',
          files: new Set(['/src/foo.ts']),
        }),
      );
      const result = checkContention('session-a');
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('critical');
      expect(result!.conflictingFiles).toEqual(['/src/foo.ts']);
    });

    it('returns null for unknown session id', () => {
      const result = checkContention('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('three-way overlap', () => {
    it('detects contention across three sessions', () => {
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          agentName: 'Claude',
          files: new Set(['/src/shared.ts', '/src/a-only.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'feature',
          agentName: 'Codex',
          files: new Set(['/src/shared.ts', '/src/b-only.ts']),
        }),
      );
      registerSessionFiles(
        makeState({
          sessionId: 'session-c',
          branch: 'main',
          agentName: 'Gemini',
          files: new Set(['/src/shared.ts', '/src/c-only.ts']),
        }),
      );

      // Check from session-a's perspective
      const result = checkContention('session-a');
      expect(result).not.toBeNull();
      // session-a (main) vs session-b (feature) = warning, vs session-c (main) = critical
      // Overall severity should be critical
      expect(result!.severity).toBe('critical');
      expect(result!.conflictingFiles).toContain('/src/shared.ts');
      expect(result!.sessions).toHaveLength(3);
    });
  });

  describe('severity escalation', () => {
    it('escalates from warning to critical when any overlap is same-branch', () => {
      // session-a on main touches file1 and file2
      registerSessionFiles(
        makeState({
          sessionId: 'session-a',
          branch: 'main',
          files: new Set(['/src/file1.ts', '/src/file2.ts']),
        }),
      );
      // session-b on feature touches file1 (warning) and also file2 on main would be critical
      // But session-b is on feature, so both are warning
      registerSessionFiles(
        makeState({
          sessionId: 'session-b',
          branch: 'feature',
          files: new Set(['/src/file1.ts']),
        }),
      );

      const result = checkContention('session-a');
      expect(result).not.toBeNull();
      expect(result!.severity).toBe('warning');

      // Now add session-c on main touching file2 → critical
      registerSessionFiles(
        makeState({
          sessionId: 'session-c',
          branch: 'main',
          files: new Set(['/src/file2.ts']),
        }),
      );

      const result2 = checkContention('session-a');
      expect(result2).not.toBeNull();
      expect(result2!.severity).toBe('critical');
    });
  });
});
