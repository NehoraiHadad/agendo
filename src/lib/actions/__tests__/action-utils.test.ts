import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { withAction, withValidatedAction } from '../action-utils';

// Stub next/cache so revalidatePath doesn't crash outside Next.js runtime
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// withAction — demo mode OFF (normal path)
// ---------------------------------------------------------------------------
describe('withAction — demo mode off', () => {
  it('invokes the handler and wraps its return value in a success envelope', async () => {
    const handler = vi.fn().mockResolvedValue({ id: '1' });
    const action = withAction(handler);

    const result = await action({ foo: 'bar' });

    expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
    expect(result).toEqual({ success: true, data: { id: '1' } });
  });

  it('returns a failure envelope when the handler throws a generic error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('oops'));
    const action = withAction(handler);

    const result = await action({});

    expect(result).toEqual({ success: false, error: 'oops' });
  });

  it('returns a failure envelope with first issue message for ZodError', async () => {
    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockImplementation(async (input: unknown) => {
      schema.parse(input); // forces ZodError
      return 'ok';
    });
    const action = withAction(handler);

    const result = await action({ name: 42 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// withAction — demo mode ON (short-circuit path)
// ---------------------------------------------------------------------------
describe('withAction — demo mode on', () => {
  it('returns success without invoking the handler', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');

    const handler = vi.fn().mockResolvedValue({ id: '1' });
    const action = withAction(handler);

    const result = await action({ foo: 'bar' });

    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('does not throw even when the handler would throw', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');

    const handler = vi.fn().mockRejectedValue(new Error('should not run'));
    const action = withAction(handler);

    await expect(action({})).resolves.toMatchObject({ success: true });
  });
});

// ---------------------------------------------------------------------------
// withValidatedAction — demo mode OFF (normal path)
// ---------------------------------------------------------------------------
describe('withValidatedAction — demo mode off', () => {
  it('validates input with schema and passes typed value to handler', async () => {
    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('done');
    const action = withValidatedAction(schema, handler);

    const result = await action({ name: 'Alice' });

    expect(handler).toHaveBeenCalledWith({ name: 'Alice' });
    expect(result).toEqual({ success: true, data: 'done' });
  });

  it('returns failure when schema validation fails', async () => {
    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('done');
    const action = withValidatedAction(schema, handler);

    const result = await action({ name: 42 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withValidatedAction — demo mode ON (short-circuit skips schema + handler)
// ---------------------------------------------------------------------------
describe('withValidatedAction — demo mode on', () => {
  it('returns success without invoking the handler', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('done');
    const action = withValidatedAction(schema, handler);

    const result = await action({ name: 'Alice' });

    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('returns success even when input is schema-invalid (short-circuit precedes validation)', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');

    const schema = z.object({ name: z.string() });
    const handler = vi.fn().mockResolvedValue('done');
    const action = withValidatedAction(schema, handler);

    // This input is schema-invalid — in normal mode it would produce a ZodError failure.
    // In demo mode the schema must never run, so we expect success.
    const result = await action({ wrong: 123 });

    expect(handler).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
