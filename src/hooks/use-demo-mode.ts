'use client';

/**
 * Returns `true` if the app is running in demo mode.
 *
 * Reads `process.env.NEXT_PUBLIC_DEMO_MODE` which Next.js inlines at build
 * time as a string literal — the check is therefore a compile-time constant
 * in production bundles.
 *
 * Usage in components:
 *   const isDemo = useDemoMode();
 *
 * Testing with module toggling:
 *   vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
 *   vi.resetModules();
 *   const { useDemoMode } = await import('@/hooks/use-demo-mode');
 *   expect(useDemoMode()).toBe(true);
 */
export function useDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}
