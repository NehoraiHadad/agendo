import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('isDemoMode', () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env.NEXT_PUBLIC_DEMO_MODE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
    } else {
      process.env.NEXT_PUBLIC_DEMO_MODE = originalValue;
    }
    vi.resetModules();
  });

  it('returns false when flag is unset', async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    const { isDemoMode } = await import('../flag');
    expect(isDemoMode()).toBe(false);
  });

  it('returns true when flag === "true"', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    const { isDemoMode } = await import('../flag');
    expect(isDemoMode()).toBe(true);
  });

  it('returns false when flag === "false"', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'false';
    const { isDemoMode } = await import('../flag');
    expect(isDemoMode()).toBe(false);
  });

  it('returns false when flag === "1"', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = '1';
    const { isDemoMode } = await import('../flag');
    expect(isDemoMode()).toBe(false);
  });

  it('returns false when flag === ""', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = '';
    const { isDemoMode } = await import('../flag');
    expect(isDemoMode()).toBe(false);
  });
});
