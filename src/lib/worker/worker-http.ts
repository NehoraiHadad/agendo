import * as http from 'node:http';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { getSessionProc, getActiveSessionCount, runSession } from '@/lib/worker/session-runner';
import { handleSessionSSE, handleBrainstormSSE } from '@/lib/worker/worker-sse';
import type { RunSessionJobData } from '@/lib/worker/queue';

const log = createLogger('worker-http');

/**
 * Placeholder map for brainstorm control handlers.
 * Agent B will wire up the real handlers from brainstorm-orchestrator.ts.
 */
export const liveBrainstormHandlers = new Map<string, (payload: string) => void>();

/**
 * Feedback handlers: roomId → callback invoked when a feedback signal arrives.
 * Registered by BrainstormOrchestrator during active review windows.
 */
export const liveBrainstormFeedbackHandlers = new Map<
  string,
  (
    wave: number,
    agentId: string,
    signal: 'thumbs_up' | 'thumbs_down' | 'focus',
    participantId?: string,
  ) => void
>();

let server: http.Server | null = null;

/**
 * Optional callback to track in-flight session promises from direct dispatch.
 * Set by worker/index.ts via registerInFlightTracker() so the shutdown handler
 * can wait for directly-dispatched sessions the same way as pg-boss sessions.
 */
let inFlightTracker: ((promise: Promise<void>) => void) | null = null;

/** Register a callback that receives every fire-and-forget session promise. */
export function registerInFlightTracker(tracker: (promise: Promise<void>) => void): void {
  inFlightTracker = tracker;
}

/**
 * Factory that creates a POST dispatcher for a handler map.
 * Reads the body, looks up the handler by id, invokes it, and responds.
 */
function createPostDispatcher(
  handlerMap: { get(id: string): ((payload: string) => void | Promise<void>) | undefined },
  entityLabel: string,
): (req: http.IncomingMessage, res: http.ServerResponse, id: string) => Promise<void> {
  return async (req, res, id) => {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    const handler = handlerMap.get(id);
    if (!handler) {
      log.warn({ id }, `No live ${entityLabel} handler found`);
      ok(res, { dispatched: false, reason: `${entityLabel} not found on this worker` });
      return;
    }
    await handler(body);
    ok(res, { dispatched: true });
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function badRequest(res: http.ServerResponse, message: string): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function ok(res: http.ServerResponse, body: Record<string, unknown> = {}): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function checkAuth(req: http.IncomingMessage): boolean {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return false;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  return parts[1] === config.JWT_SECRET;
}

/**
 * Parse a URL path like /sessions/:id/control into its parts.
 * Returns { resource, id, action } or null if no match.
 */
function parsePath(
  pathname: string,
): { resource: 'sessions' | 'brainstorms'; id: string; action: string } | null {
  const match = /^\/(sessions|brainstorms)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  return {
    resource: match[1] as 'sessions' | 'brainstorms',
    id: match[2],
    action: match[3],
  };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${config.WORKER_HTTP_PORT}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase() ?? 'GET';

  // GET /health — no auth required
  if (method === 'GET' && pathname === '/health') {
    ok(res, { status: 'ok', sessions: getActiveSessionCount() });
    return;
  }

  // SSE routes — no Bearer auth (proxied from Next.js route handler on same machine)
  if (method === 'GET') {
    const sseMatch = /^\/(sessions|brainstorms)\/([^/]+)\/events$/.exec(pathname);
    if (sseMatch) {
      const resource = sseMatch[1] as 'sessions' | 'brainstorms';
      const id = sseMatch[2];
      const lastEventId =
        parseInt(
          (req.headers['last-event-id'] as string | undefined) ??
            url.searchParams.get('lastEventId') ??
            '0',
          10,
        ) || 0;
      if (resource === 'sessions') {
        await handleSessionSSE(req, res, id, lastEventId);
      } else {
        await handleBrainstormSSE(req, res, id, lastEventId);
      }
      return;
    }
  }

  // All other routes require auth
  if (!checkAuth(req)) {
    unauthorized(res);
    return;
  }

  const parsed = parsePath(pathname);
  if (!parsed) {
    notFound(res);
    return;
  }

  const { resource, id, action } = parsed;

  // ─── Direct dispatch: POST /sessions/:id/start ───────────────────────
  // Accepts RunSessionJobData, starts the session asynchronously (fire-and-forget).
  if (method === 'POST' && resource === 'sessions' && action === 'start') {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    let data: RunSessionJobData;
    try {
      data = JSON.parse(body) as RunSessionJobData;
    } catch {
      badRequest(res, 'Invalid JSON body');
      return;
    }
    if (!data.sessionId) {
      badRequest(res, 'Missing sessionId in body');
      return;
    }

    // Fire-and-forget: start session asynchronously, respond 200 immediately.
    // Track the promise so graceful shutdown can wait for it.
    const promise = runSession(
      data.sessionId,
      config.WORKER_ID,
      data.resumeRef,
      data.resumeSessionAt,
      data.resumePrompt,
      data.skipResumeContext,
      data.resumeClientId,
    ).catch((err: unknown) => {
      log.error({ err, sessionId: data.sessionId }, 'Direct-dispatched session failed');
    });

    // Expose to inFlightSessions set (registered via registerInFlightTracker)
    if (inFlightTracker) inFlightTracker(promise);

    ok(res, { dispatched: true });
    return;
  }

  // Session control & event injection both route through onControl
  const sessionControlMap = {
    get(sid: string) {
      const proc = getSessionProc(sid);
      return proc ? (payload: string) => proc.onControl(payload) : undefined;
    },
  };
  const dispatchSessionPost = createPostDispatcher(sessionControlMap, 'session');

  if (
    method === 'POST' &&
    resource === 'sessions' &&
    (action === 'control' || action === 'events')
  ) {
    await dispatchSessionPost(req, res, id);
    return;
  }

  const dispatchBrainstormPost = createPostDispatcher(liveBrainstormHandlers, 'brainstorm');

  if (method === 'POST' && resource === 'brainstorms' && action === 'control') {
    await dispatchBrainstormPost(req, res, id);
    return;
  }

  if (method === 'POST' && resource === 'brainstorms' && action === 'feedback') {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      badRequest(res, 'Invalid JSON body');
      return;
    }
    const { wave, agentId, signal, participantId } = parsed as {
      wave?: unknown;
      agentId?: unknown;
      signal?: unknown;
      participantId?: unknown;
    };
    if (
      typeof wave !== 'number' ||
      typeof agentId !== 'string' ||
      !['thumbs_up', 'thumbs_down', 'focus'].includes(signal as string)
    ) {
      badRequest(res, 'Invalid feedback payload');
      return;
    }
    const feedbackHandler = liveBrainstormFeedbackHandlers.get(id);
    if (!feedbackHandler) {
      log.warn({ roomId: id }, 'No live brainstorm feedback handler found');
      ok(res, { dispatched: false, reason: 'brainstorm not found on this worker' });
      return;
    }
    feedbackHandler(
      wave,
      agentId,
      signal as 'thumbs_up' | 'thumbs_down' | 'focus',
      typeof participantId === 'string' ? participantId : undefined,
    );
    ok(res, { dispatched: true });
    return;
  }

  if (method === 'POST' && resource === 'brainstorms' && action === 'events') {
    await dispatchBrainstormPost(req, res, id);
    return;
  }

  notFound(res);
}

export function startWorkerHttp(): http.Server {
  if (server) {
    log.warn('Worker HTTP server already started');
    return server;
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      log.error({ err }, 'Unhandled error in worker HTTP handler');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  const port = config.WORKER_HTTP_PORT;
  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'Worker HTTP server listening');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error({ err }, 'Worker HTTP server error');
  });

  return server;
}

export function stopWorkerHttp(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => {
      server = null;
      if (err) {
        log.error({ err }, 'Error stopping worker HTTP server');
        reject(err);
      } else {
        log.info('Worker HTTP server stopped');
        resolve();
      }
    });
  });
}
