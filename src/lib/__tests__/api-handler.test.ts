import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ZodError, ZodIssueCode } from 'zod';
import { withErrorBoundary } from '../api-handler';
import { AppError, NotFoundError, ValidationError } from '../errors';

function makeRequest(url = 'http://localhost/api/test'): NextRequest {
  return new NextRequest(url);
}

const defaultContext = { params: Promise.resolve({}) };

describe('withErrorBoundary', () => {
  it('passes through a successful response', async () => {
    const handler = withErrorBoundary(async () => {
      return NextResponse.json({ data: 'ok' }, { status: 200 });
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ data: 'ok' });
  });

  it('returns correct status and JSON for AppError', async () => {
    const handler = withErrorBoundary(async () => {
      throw new AppError('Something broke', 503, 'SERVICE_UNAVAILABLE');
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.message).toBe('Something broke');
  });

  it('returns 404 for NotFoundError', async () => {
    const handler = withErrorBoundary(async () => {
      throw new NotFoundError('Agent', 'abc-123');
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('abc-123');
  });

  it('returns 422 for ValidationError', async () => {
    const handler = withErrorBoundary(async () => {
      throw new ValidationError('Invalid input', { field: 'name' });
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.context).toEqual({ field: 'name' });
  });

  it('returns 422 with issues array for ZodError', async () => {
    const handler = withErrorBoundary(async () => {
      throw new ZodError([
        {
          code: ZodIssueCode.invalid_type,
          expected: 'string',
          received: 'number',
          path: ['name'],
          message: 'Expected string, received number',
        },
      ]);
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Request validation failed');
    expect(body.error.context.issues).toHaveLength(1);
    expect(body.error.context.issues[0].path).toEqual(['name']);
  });

  it('returns 500 with no internal details for unknown Error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handler = withErrorBoundary(async () => {
      throw new Error('Database connection failed');
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An unexpected error occurred');
    // Must NOT leak the actual error message
    expect(JSON.stringify(body)).not.toContain('Database connection failed');

    consoleSpy.mockRestore();
  });

  it('returns 500 for non-Error thrown values', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handler = withErrorBoundary(async () => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });

    const res = await handler(makeRequest(), defaultContext);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');

    consoleSpy.mockRestore();
  });
});
