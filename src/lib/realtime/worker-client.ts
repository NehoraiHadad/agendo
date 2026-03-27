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

/** Dispatch a new session start to the worker via HTTP. */
export async function sendSessionStart(sessionId: string, data: unknown): Promise<WorkerResponse> {
  return postToWorker(`/sessions/${sessionId}/start`, data);
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

/** Dispatch a brainstorm start to the worker via HTTP. */
export async function sendBrainstormStart(roomId: string): Promise<WorkerResponse> {
  return postToWorker(`/brainstorms/${roomId}/start`, { roomId });
}

/** Send a control message to a brainstorm room running in the worker. */
export async function sendBrainstormControl(
  roomId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/brainstorms/${roomId}/control`, payload);
}

/** Probe whether a brainstorm currently has a live orchestrator handler in the worker. */
export async function probeBrainstormOrchestrator(roomId: string): Promise<boolean> {
  const result = await sendBrainstormControl(roomId, { type: 'ping' });
  return result.ok && result.dispatched === true;
}

/** Send a synthetic event to a brainstorm room running in the worker. */
export async function sendBrainstormEvent(
  roomId: string,
  payload: unknown,
): Promise<WorkerResponse> {
  return postToWorker(`/brainstorms/${roomId}/events`, payload);
}

export type { WorkerResponse };
