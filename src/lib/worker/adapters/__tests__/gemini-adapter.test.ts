import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/worker/tmux-manager', () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  hasSession: vi.fn(() => true),
  sendInput: vi.fn(),
  pressEnter: vi.fn(),
  capturePane: vi.fn(() => ''),
  pipePaneToFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => '12345\n'),
}));

import * as tmux from '@/lib/worker/tmux-manager';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const opts: SpawnOpts = {
  cwd: '/tmp',
  env: { PATH: '/usr/bin' },
  executionId: 'test-exec',
  timeoutSec: 300,
  maxOutputBytes: 1024,
};

describe('GeminiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('creates tmux session with gemini command', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    expect(tmux.createSession).toHaveBeenCalledWith(
      'gemini-test-exec',
      expect.objectContaining({
        cwd: '/tmp',
        command: expect.stringContaining('gemini'),
      }),
    );
  });

  it('sendMessage calls tmux send-keys with -l flag', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    adapter.sendMessage('follow-up question');
    expect(tmux.sendInput).toHaveBeenCalledWith('gemini-test-exec', 'follow-up question');
    expect(tmux.pressEnter).toHaveBeenCalledWith('gemini-test-exec');
  });

  it('returns tmux session name as session ID', () => {
    const adapter = new GeminiAdapter();
    adapter.spawn('test prompt', opts);
    expect(adapter.extractSessionId('')).toBe('gemini-test-exec');
  });
});
