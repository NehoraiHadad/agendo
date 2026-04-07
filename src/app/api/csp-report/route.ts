/**
 * CSP Violation Report Endpoint
 *
 * Receives CSP violation reports from the browser (via `report-uri` directive
 * on the /mcp-app page). Logs violations for debugging and security auditing.
 *
 * Per spec: https://www.w3.org/TR/CSP3/#report-serialization
 * Content-Type is `application/csp-report` (JSON body with csp-report key).
 */

import { NextRequest } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const contentType = req.headers.get('content-type') ?? '';
  if (
    !contentType.includes('application/csp-report') &&
    !contentType.includes('application/json')
  ) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  try {
    const body = (await req.json()) as { 'csp-report'?: Record<string, unknown> };
    const report = body['csp-report'] ?? body;

    // Log to server console for visibility — these indicate iframe sandboxing
    // bypass attempts or misconfigured CSP on /mcp-app.
    console.warn('[CSP Violation]', JSON.stringify(report));
  } catch {
    // Malformed report — ignore silently
  }

  // 204 No Content is the standard response for CSP reports
  return new Response(null, { status: 204 });
});
