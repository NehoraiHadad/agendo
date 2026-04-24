/**
 * Tests for useDemoMode hook.
 *
 * Note: Because Next.js inlines process.env.NEXT_PUBLIC_DEMO_MODE at build time,
 * we test the runtime behaviour by resetting modules and re-importing after
 * setting the env variable with vi.stubEnv. Each case uses vi.resetModules()
 * to guarantee a fresh module evaluation.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('useDemoMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns false when NEXT_PUBLIC_DEMO_MODE is not set', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
    vi.resetModules();
    const { useDemoMode } = await import('../use-demo-mode');
    expect(useDemoMode()).toBe(false);
  });

  it('returns true when NEXT_PUBLIC_DEMO_MODE is "true"', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();
    const { useDemoMode } = await import('../use-demo-mode');
    expect(useDemoMode()).toBe(true);
  });

  it('returns false when NEXT_PUBLIC_DEMO_MODE is "false"', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'false');
    vi.resetModules();
    const { useDemoMode } = await import('../use-demo-mode');
    expect(useDemoMode()).toBe(false);
  });

  it('returns false for arbitrary non-"true" strings', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '1');
    vi.resetModules();
    const { useDemoMode } = await import('../use-demo-mode');
    expect(useDemoMode()).toBe(false);
  });
});
