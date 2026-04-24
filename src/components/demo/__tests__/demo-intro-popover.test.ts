/**
 * Tests for DemoIntroPopover pure logic helpers.
 *
 * DOM rendering / localStorage side-effect tests require @testing-library/react
 * + jsdom which are not in this project's deps. Those are deferred to Phase 5
 * E2E tests.
 *
 * Here we test the extracted pure helpers for auto-open logic and localStorage
 * key handling.
 */
import { describe, it, expect } from 'vitest';
import { DEMO_INTRO_DISMISSED_KEY, shouldAutoOpen, getInstallLink } from '../demo-utils';

describe('DEMO_INTRO_DISMISSED_KEY', () => {
  it('has the expected storage key', () => {
    expect(DEMO_INTRO_DISMISSED_KEY).toBe('agendo-demo-intro-dismissed');
  });
});

describe('shouldAutoOpen', () => {
  it('returns true when dismissed key is not set', () => {
    expect(shouldAutoOpen(null)).toBe(true);
  });

  it('returns false when dismissed key is "1"', () => {
    expect(shouldAutoOpen('1')).toBe(false);
  });

  it('returns true for arbitrary non-"1" stored values', () => {
    expect(shouldAutoOpen('0')).toBe(true);
    expect(shouldAutoOpen('')).toBe(true);
    expect(shouldAutoOpen('false')).toBe(true);
  });
});

describe('getInstallLink', () => {
  it('returns the readme link', () => {
    const link = getInstallLink();
    expect(typeof link).toBe('string');
    expect(link.length).toBeGreaterThan(0);
  });
});
