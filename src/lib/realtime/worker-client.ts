import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';

const log = createLogger('worker-client');

function workerUrl(path: string): string {
  return `http://localhost:${config.WORKER_HTTP_PORT}${path}`;
}

async function postToWorker(path: string, payload: unknown): Promise<boolean> {
  try {
    const res = await fetch(workerUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.JWT_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn({ path, status: res.status }, 'Worker HTTP request failed');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err, path }, 'Worker HTTP request error');
    return false;
  }
}

/** Send a control message to a session running in the worker. */
export async function sendSessionControl(sessionId: string, payload: unknown): Promise<boolean> {
  return postToWorker(`/sessions/${sessionId}/control`, payload);
}

/** Send a synthetic event to a session running in the worker. */
export async function sendSessionEvent(sessionId: string, payload: unknown): Promise<boolean> {
  return postToWorker(`/sessions/${sessionId}/events`, payload);
}

/** Send a control message to a brainstorm room running in the worker. */
export async function sendBrainstormControl(roomId: string, payload: unknown): Promise<boolean> {
  return postToWorker(`/brainstorms/${roomId}/control`, payload);
}

/** Send a synthetic event to a brainstorm room running in the worker. */
export async function sendBrainstormEvent(roomId: string, payload: unknown): Promise<boolean> {
  return postToWorker(`/brainstorms/${roomId}/events`, payload);
}
