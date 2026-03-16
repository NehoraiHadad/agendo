import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AcpTerminalHandler } from '../acp-terminal-handler';

describe('AcpTerminalHandler', () => {
  let handler: AcpTerminalHandler;

  beforeEach(() => {
    handler = new AcpTerminalHandler();
  });

  afterEach(() => {
    handler.releaseAll();
  });

  // ---------------------------------------------------------------------------
  // createTerminal
  // ---------------------------------------------------------------------------
  it('createTerminal spawns a process and returns a terminalId', async () => {
    const result = await handler.createTerminal({
      command: 'bash',
      args: ['-c', 'echo hello'],
      cwd: '/tmp',
    });

    expect(result).toHaveProperty('terminalId');
    expect(typeof result.terminalId).toBe('string');
    expect(result.terminalId.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // terminalOutput
  // ---------------------------------------------------------------------------
  it('terminalOutput returns captured output', async () => {
    const { terminalId } = await handler.createTerminal({
      command: 'bash',
      args: ['-c', 'echo hello'],
      cwd: '/tmp',
    });

    // Must wait for process to finish so output is fully captured
    await handler.waitForTerminalExit(terminalId);
    const output = handler.terminalOutput(terminalId);
    expect(typeof output).toBe('string');
    expect(output).toContain('hello');
  });

  // ---------------------------------------------------------------------------
  // waitForTerminalExit
  // ---------------------------------------------------------------------------
  it('waitForTerminalExit resolves with exit status on completion', async () => {
    const { terminalId } = await handler.createTerminal({
      command: 'true',
      args: [],
      cwd: '/tmp',
    });

    const exitStatus = await handler.waitForTerminalExit(terminalId);
    expect(exitStatus).toHaveProperty('exitCode');
    expect(exitStatus.exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // killTerminal
  // ---------------------------------------------------------------------------
  it('killTerminal sends SIGTERM to the process', async () => {
    const { terminalId } = await handler.createTerminal({
      command: 'sleep',
      args: ['60'],
      cwd: '/tmp',
    });

    // Should not throw
    handler.killTerminal(terminalId);

    const exitStatus = await handler.waitForTerminalExit(terminalId);
    expect(exitStatus).toHaveProperty('exitCode');
  });

  // ---------------------------------------------------------------------------
  // releaseTerminal
  // ---------------------------------------------------------------------------
  it('releaseTerminal cleans up the terminal entry', async () => {
    const { terminalId } = await handler.createTerminal({
      command: 'true',
      args: [],
      cwd: '/tmp',
    });

    handler.releaseTerminal(terminalId);

    // After release, operations on this terminal should fail
    expect(() => handler.terminalOutput(terminalId)).toThrow();
  });

  // ---------------------------------------------------------------------------
  // maxOutputBytes truncation
  // ---------------------------------------------------------------------------
  it('createTerminal respects maxOutputBytes truncation', async () => {
    const maxOutputBytes = 100;
    const { terminalId } = await handler.createTerminal({
      command: 'bash',
      args: ['-c', 'yes | head -n 1000'],
      cwd: '/tmp',
      maxOutputBytes,
    });

    await handler.waitForTerminalExit(terminalId);
    const output = handler.terminalOutput(terminalId);
    // Output should be truncated to maxOutputBytes
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(maxOutputBytes);
  });
});
