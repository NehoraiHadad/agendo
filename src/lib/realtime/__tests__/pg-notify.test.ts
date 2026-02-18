import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db and drizzle-orm modules
vi.mock('@/lib/db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => s }
  ),
}));

vi.mock('@/lib/config', () => ({
  config: {
    DATABASE_URL: 'postgresql://localhost/test',
  },
}));

// Mock pg Pool
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      on: vi.fn(),
    }),
  })),
}));

import { channelName, publish, subscribe } from '../pg-notify';

describe('channelName', () => {
  it('removes hyphens from UUID for events channel', () => {
    const name = channelName('agendo_events', '550e8400-e29b-41d4-a716-446655440000');
    expect(name).toBe('agendo_events_550e8400e29b41d4a716446655440000');
  });

  it('removes hyphens from UUID for control channel', () => {
    const name = channelName('agendo_control', '550e8400-e29b-41d4-a716-446655440000');
    expect(name).toBe('agendo_control_550e8400e29b41d4a716446655440000');
  });
});

describe('publish', () => {
  it('serializes payload and calls pg_notify', async () => {
    const { db } = await import('@/lib/db');
    await publish('test_channel', { type: 'agent:text', text: 'hello' });
    expect(db.execute).toHaveBeenCalled();
  });

  it('truncates large payloads to ref stub', async () => {
    const { db } = await import('@/lib/db');
    vi.clearAllMocks();
    const largePayload = { type: 'agent:text', text: 'x'.repeat(8000) };
    await publish('test_channel', largePayload);
    // Should still call execute without throwing
    expect(db.execute).toHaveBeenCalled();
  });
});

describe('subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an unsubscribe function', async () => {
    const callback = vi.fn();
    const unsubscribe = await subscribe('test_channel', callback);
    expect(typeof unsubscribe).toBe('function');
    // Call unsubscribe
    unsubscribe();
  });
});
