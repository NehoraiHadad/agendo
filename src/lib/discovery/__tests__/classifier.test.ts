import { describe, it, expect, vi } from 'vitest';
import { classifyBinary, type ToolType } from '../classifier';

// Mock node:child_process so classifyBinary's internal subprocess calls
// (isSystemdService, getManSection) don't run on the real system.
// This is a test stub that rejects all calls -- safe, no shell execution.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error('not found'), '', '');
    },
  ),
}));

describe('classifyBinary', () => {
  it('classifies "claude" as ai-agent', async () => {
    const result: ToolType = await classifyBinary({ name: 'claude', packageSection: null });
    expect(result).toBe('ai-agent');
  });

  it('classifies "gemini" as ai-agent', async () => {
    const result: ToolType = await classifyBinary({ name: 'gemini', packageSection: null });
    expect(result).toBe('ai-agent');
  });

  it('classifies "codex" as ai-agent', async () => {
    const result: ToolType = await classifyBinary({ name: 'codex', packageSection: null });
    expect(result).toBe('ai-agent');
  });

  it('classifies "vim" as interactive-tui', async () => {
    const result: ToolType = await classifyBinary({ name: 'vim', packageSection: null });
    expect(result).toBe('interactive-tui');
  });

  it('classifies "ls" as shell-util', async () => {
    const result: ToolType = await classifyBinary({ name: 'ls', packageSection: null });
    expect(result).toBe('shell-util');
  });

  it('defaults unknown tool to cli-tool', async () => {
    const result: ToolType = await classifyBinary({ name: 'xyzunknown123', packageSection: null });
    expect(result).toBe('cli-tool');
  });
});
