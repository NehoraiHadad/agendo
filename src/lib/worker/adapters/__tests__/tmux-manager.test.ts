import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

import { execFileSync } from 'node:child_process';
import {
  createSession,
  killSession,
  capturePane,
  hasSession,
  sendInput,
  pressEnter,
  listSessions,
  sendCommand,
} from '@/lib/worker/tmux-manager';

describe('tmux-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default (no-op) implementation after each test
    vi.mocked(execFileSync).mockReturnValue('');
  });

  describe('createSession', () => {
    it('calls tmux new-session with correct args', () => {
      createSession('test-session', { cwd: '/tmp' });
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['new-session', '-d', '-s', 'test-session']),
        expect.any(Object),
      );
    });

    it('includes command when provided', () => {
      createSession('test', { cwd: '/tmp', command: 'bash' });
      const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      expect(args).toContain('bash');
    });
  });

  describe('killSession', () => {
    it('calls tmux kill-session', () => {
      killSession('test-session');
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'test-session'],
        expect.any(Object),
      );
    });

    it('does not throw if session already dead', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('session not found');
      });
      expect(() => killSession('dead-session')).not.toThrow();
    });
  });

  describe('capturePane', () => {
    it('returns captured text', () => {
      vi.mocked(execFileSync).mockReturnValue('captured output\n');
      const result = capturePane('test-session');
      expect(result).toBe('captured output\n');
    });
  });

  describe('hasSession', () => {
    it('returns true when session exists', () => {
      vi.mocked(execFileSync).mockImplementation(() => '');
      expect(hasSession('test')).toBe(true);
    });

    it('returns false when session does not exist', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('session not found');
      });
      expect(hasSession('test')).toBe(false);
    });
  });

  describe('sendInput', () => {
    it('uses -l flag for literal text', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      sendInput('test', 'hello');
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test', '-l', 'hello'],
        expect.any(Object),
      );
    });
  });

  describe('pressEnter', () => {
    it('sends Enter key', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      pressEnter('test');
      expect(execFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test', 'Enter'],
        expect.any(Object),
      );
    });
  });

  describe('listSessions', () => {
    it('returns session names', () => {
      vi.mocked(execFileSync).mockReturnValue('session1\nsession2\n');
      const sessions = listSessions();
      expect(sessions).toEqual(['session1', 'session2']);
    });

    it('returns empty array on error', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('no server');
      });
      expect(listSessions()).toEqual([]);
    });
  });

  describe('sendCommand', () => {
    it('sends text then Enter', () => {
      vi.mocked(execFileSync).mockReturnValue('');
      sendCommand('test', 'ls -la');
      expect(execFileSync).toHaveBeenCalledTimes(2);
    });
  });
});
