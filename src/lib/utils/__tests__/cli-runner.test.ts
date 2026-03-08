import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripBlockedEnvVars, collectCliOutput, spawnCli } from '../cli-runner';

describe('stripBlockedEnvVars', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT', () => {
    process.env['CLAUDECODE'] = '1';
    process.env['CLAUDE_CODE_ENTRYPOINT'] = '/usr/bin/claude';
    process.env['PATH'] = '/usr/bin';
    process.env['HOME'] = '/home/test';

    const env = stripBlockedEnvVars();

    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/test');
  });

  it('preserves all other env vars', () => {
    process.env['MY_CUSTOM_VAR'] = 'hello';
    process.env['SOME_OTHER_VAR'] = 'world';

    const env = stripBlockedEnvVars();

    expect(env['MY_CUSTOM_VAR']).toBe('hello');
    expect(env['SOME_OTHER_VAR']).toBe('world');
  });

  it('skips undefined values', () => {
    // Explicitly delete a var to ensure it's undefined
    delete process.env['NONEXISTENT_VAR'];

    const env = stripBlockedEnvVars();

    expect('NONEXISTENT_VAR' in (env as Record<string, string>)).toBe(false);
  });
});

describe('spawnCli', () => {
  it('returns a process and cleanup function', () => {
    const { process: cp, cleanup } = spawnCli({
      command: 'echo',
      args: ['hello'],
    });

    expect(cp).toBeDefined();
    expect(cp.pid).toBeDefined();
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const { process: cp, cleanup } = spawnCli({
      command: 'sleep',
      args: ['10'],
      signal: controller.signal,
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      cp.on('close', resolve);
    });

    controller.abort();
    const code = await exitPromise;
    cleanup();

    // SIGTERM produces non-zero exit (or null on some systems)
    expect(code).not.toBe(0);
  });
});

describe('collectCliOutput', () => {
  it('collects stdout from a simple command', async () => {
    const output = await collectCliOutput({
      command: 'echo',
      args: ['hello world'],
    });

    expect(output.trim()).toBe('hello world');
  });

  it('rejects on non-zero exit code', async () => {
    await expect(
      collectCliOutput({
        command: 'sh',
        args: ['-c', 'echo "err msg" >&2; exit 1'],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it('rejects on command not found', async () => {
    await expect(
      collectCliOutput({
        command: 'nonexistent_command_xyz_12345',
        args: [],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  });

  it('respects cwd option', async () => {
    const output = await collectCliOutput({
      command: 'pwd',
      args: [],
      cwd: '/tmp',
    });

    expect(output.trim()).toBe('/tmp');
  });

  it('uses sanitized env (no CLAUDECODE)', async () => {
    process.env['CLAUDECODE'] = '1';

    const output = await collectCliOutput({
      command: 'sh',
      args: ['-c', 'echo ${CLAUDECODE:-unset}'],
    });

    expect(output.trim()).toBe('unset');
  });
});
