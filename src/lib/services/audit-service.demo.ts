/**
 * Demo-mode shadow for audit-service.
 *
 * All writes are no-ops (fire-and-forget audit calls produce no side effects).
 * This service is worker/runtime-only plumbing — its output is never displayed
 * in the demo UI, so shadows return void or undefined.
 */

export async function logAudit(
  _actor: string | null,
  _action: string,
  _resourceType: string,
  _resourceId?: string,
  _metadata?: Record<string, unknown>,
): Promise<void> {
  // No-op in demo mode — audit writes have no DB to target.
}

export async function logSessionAudit(
  _action: string,
  _sessionId: string,
  _metadata?: Record<string, unknown>,
): Promise<void> {
  // No-op in demo mode.
}

export async function logTaskAudit(
  _action: string,
  _taskId: string,
  _metadata?: Record<string, unknown>,
): Promise<void> {
  // No-op in demo mode.
}
