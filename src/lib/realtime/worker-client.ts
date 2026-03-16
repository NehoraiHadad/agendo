import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';

const log = createLogger('worker-client');

function workerUrl(path: string): string {
  return `http://localhost:${config.WORKER_HTTP_PORT}${path}`;
}

interface WorkerResponse {
  ok: boolean;
  dispatched?: boolean;
}

async function postToWorker(path: string, payload: unknown): Promise<WorkerResponse> {
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
      return { ok: false };
    }
    const body = (await res.json()) as { dispatched?: boolean };
    return { ok: true, dispatched: body.dispatched };
  } catch (err) {
    log.warn({ err, path }, 'Worker HTTP request error');
    return { ok: false };
  }
}

/** Send a control message to a session running in the worker. */
export async function sendSessionControl(
  sessionId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/sessions/${sessionId}/control`, payload);
}

/** Send a synthetic event to a session running in the worker. */
export async function sendSessionEvent(
  sessionId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/sessions/${sessionId}/events`, payload);
}

/** Send a control message to a brainstorm room running in the worker. */
export async function sendBrainstormControl(
  roomId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/brainstorms/${roomId}/control`, payload);
}

/** Send a synthetic event to a brainstorm room running in the worker. */
export async function sendBrainstormEvent(
  roomId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/brainstorms/${roomId}/events`, payload);
}

export type { WorkerResponse };
