import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { AppError, NotFoundError } from './errors';

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

/**
 * Wraps an API route handler with consistent error handling.
 * - AppError subclasses map to their HTTP status code
 * - ZodError returns 422 with field-level details
 * - Unknown errors return 500 with no internal details exposed
 */
export function assertUUID(id: string, resource: string): void {
  if (!z.string().uuid().safeParse(id).success) {
    throw new NotFoundError(resource, id);
  }
}

export function withErrorBoundary(handler: RouteHandler): RouteHandler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof AppError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode });
      }

      if (error instanceof ZodError) {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              context: { issues: error.issues },
            },
          },
          { status: 422 },
        );
      }

      console.error('Unhandled API error:', error);
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          },
        },
        { status: 500 },
      );
    }
  };
}
