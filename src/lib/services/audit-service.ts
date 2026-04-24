import { db } from '@/lib/db';
import { auditLog } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';
import { isDemoMode } from '@/lib/demo/flag';

const log = createLogger('audit-service');

/**
 * Write a fire-and-forget audit log entry.
 * NEVER throws — errors are logged and swallowed.
 */
export async function logAudit(
  actor: string | null,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./audit-service.demo');
    return demo.logAudit(actor, action, resourceType, resourceId, metadata);
  }
  try {
    await db.insert(auditLog).values({ actor, action, resourceType, resourceId, metadata });
  } catch (err) {
    log.error({ err }, '[audit] write failed');
    // NEVER throw — fire-and-forget
  }
}

/** Convenience: audit a session action with actor='system'. */
export async function logSessionAudit(
  action: string,
  sessionId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./audit-service.demo');
    return demo.logSessionAudit(action, sessionId, metadata);
  }
  return logAudit('system', action, 'session', sessionId, metadata);
}

/** Convenience: audit a task action, extracting actor from metadata if present. */
export async function logTaskAudit(
  action: string,
  taskId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./audit-service.demo');
    return demo.logTaskAudit(action, taskId, metadata);
  }
  const actor = metadata && typeof metadata.actor === 'string' ? metadata.actor : 'system';
  return logAudit(actor, action, 'task', taskId, metadata);
}
