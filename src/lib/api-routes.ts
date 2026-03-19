/**
 * Factory helpers for common CRUD API route patterns.
 * Use these to eliminate boilerplate in routes that are direct passthroughs
 * to a service function (assertUUID + service call + JSON response).
 */
import { NextRequest, NextResponse } from 'next/server';
import { ZodSchema } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';

type RouteContext = { params: Promise<Record<string, string>> };

/**
 * Factory for GET /api/resources/[id] routes.
 * Validates the id param as a UUID, calls getter, returns `{ data: result }`.
 */
export function createGetByIdRoute<T>(getter: (id: string) => Promise<T>, resourceName: string) {
  return withErrorBoundary(async (_req: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    assertUUID(id, resourceName);
    const data = await getter(id);
    return NextResponse.json({ data });
  });
}

/**
 * Factory for PATCH /api/resources/[id] routes.
 * Validates the id param as a UUID, parses the request body with the provided
 * Zod schema, calls updater with the validated data, returns `{ data: result }`.
 */
export function createPatchRoute<TOutput, TInput>(
  updater: (id: string, data: TInput) => Promise<TOutput>,
  schema: ZodSchema<TInput>,
  resourceName: string,
) {
  return withErrorBoundary(async (req: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    assertUUID(id, resourceName);
    const body = schema.parse(await req.json());
    const data = await updater(id, body);
    return NextResponse.json({ data });
  });
}

/**
 * Factory for DELETE /api/resources/[id] routes.
 * Validates the id param as a UUID, calls deleter, returns 204 No Content.
 * Pass a custom buildResponse only when the caller genuinely needs a body
 * (e.g. the integration removal route that returns a sessionId).
 */
export function createDeleteRoute(
  deleter: (id: string) => Promise<void>,
  resourceName: string,
  buildResponse?: (id: string) => NextResponse,
) {
  return withErrorBoundary(async (_req: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    assertUUID(id, resourceName);
    await deleter(id);
    return buildResponse ? buildResponse(id) : new NextResponse(null, { status: 204 });
  });
}
