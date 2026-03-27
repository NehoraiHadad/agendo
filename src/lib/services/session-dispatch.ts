import { config } from '@/lib/config';
import { enqueueSession, type RunSessionJobData } from '@/lib/worker/queue';
import { sendSessionStart } from '@/lib/realtime/worker-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-dispatch');

/**
 * Dispatch a session to the worker — either via pg-boss (legacy) or direct HTTP (new).
 * Controlled by the DIRECT_DISPATCH feature flag.
 *
 * When DIRECT_DISPATCH=true:
 *   POST worker:4102/sessions/:id/start → worker calls runSession() directly.
 *   Falls back to pg-boss if the HTTP call fails (worker unreachable).
 *
 * When DIRECT_DISPATCH=false (default):
 *   enqueueSession() → pg-boss DB → worker polls → handleSessionJob().
 */
export async function dispatchSession(data: RunSessionJobData): Promise<void> {
  if (config.DIRECT_DISPATCH) {
    log.info({ sessionId: data.sessionId }, 'Direct dispatch to worker');
    try {
      const result = await sendSessionStart(data.sessionId, data);
      if (!result.ok) {
        log.warn({ sessionId: data.sessionId }, 'Direct dispatch failed, falling back to pg-boss');
        await enqueueSession(data);
      }
    } catch (err) {
      log.warn(
        { err, sessionId: data.sessionId },
        'Direct dispatch error, falling back to pg-boss',
      );
      await enqueueSession(data);
    }
  } else {
    await enqueueSession(data);
  }
}
