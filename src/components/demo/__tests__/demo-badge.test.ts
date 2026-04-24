/**
 * Tests for DemoBadge pure logic helpers.
 *
 * DOM rendering tests require @testing-library/react + jsdom which are not
 * in this project's deps. Those are deferred to Phase 5 E2E tests.
 *
 * Here we test the extracted pure helper that drives render/no-render.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('demoBadgeShouldRender', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns false when demo mode is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '');
    vi.resetModules();
    const { demoBadgeShouldRender } = await import('../demo-utils');
    expect(demoBadgeShouldRender()).toBe(false);
  });

  it('returns true when demo mode is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();
    const { demoBadgeShouldRender } = await import('../demo-utils');
    expect(demoBadgeShouldRender()).toBe(true);
  });
});
