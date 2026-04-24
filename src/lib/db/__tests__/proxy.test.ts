import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub pg Pool so the non-demo path doesn't try to connect.
// Must be defined before any dynamic imports.
vi.mock('pg', () => ({
  Pool: vi.fn(() => ({ end: vi.fn() })),
}));

describe('db/index.ts — demo mode proxy', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear the globalThis caches so each test starts fresh
    const g = globalThis as Record<string, unknown>;
    delete g.__agendoPool;
    delete g.__agendoDb;
  });

  it('throws on any property access when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    // Also provide a dummy DATABASE_URL / JWT_SECRET so config doesn't exit
    process.env.DATABASE_URL = 'postgres://demo@demo.invalid:5432/demo';
    process.env.JWT_SECRET = 'demo-mode-placeholder-secret-00';
    try {
      vi.resetModules();
      const { db } = await import('../index');

      expect(() => db.select).toThrow('[demo] DB accessed directly');
      expect(() => db.query).toThrow('[demo] DB accessed directly');
      expect(() => db.insert).toThrow('[demo] DB accessed directly');
    } finally {
      delete process.env.NEXT_PUBLIC_DEMO_MODE;
    }
  });

  it('returns a real Drizzle instance with .select as a function when flag is unset', async () => {
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    process.env.DATABASE_URL = 'postgres://demo@demo.invalid:5432/demo';
    process.env.JWT_SECRET = 'demo-mode-placeholder-secret-00';
    vi.resetModules();
    const { db } = await import('../index');

    expect(typeof db.select).toBe('function');
  });
});
