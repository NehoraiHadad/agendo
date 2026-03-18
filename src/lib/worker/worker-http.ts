import * as http from 'node:http';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { allSessionProcs } from '@/lib/worker/session-runner';
import { handleSessionSSE, handleBrainstormSSE } from '@/lib/worker/worker-sse';

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
  (wave: number, agentId: string, signal: 'thumbs_up' | 'thumbs_down' | 'focus') => void
>();

let server: http.Server | null = null;

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
    ok(res, { status: 'ok', sessions: allSessionProcs.size });
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

  if (method === 'POST' && resource === 'sessions' && action === 'control') {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    const proc = allSessionProcs.get(id);
    if (!proc) {
      log.warn({ sessionId: id }, 'No live session proc found for control dispatch');
      // Return 200 — session may be on a different worker
      ok(res, { dispatched: false, reason: 'session not found on this worker' });
      return;
    }
    await proc.onControl(body);
    ok(res, { dispatched: true });
    return;
  }

  if (method === 'POST' && resource === 'sessions' && action === 'events') {
    // Synthetic event injection — used by team API and future Phase 2 work
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    const proc = allSessionProcs.get(id);
    if (!proc) {
      log.warn({ sessionId: id }, 'No live session proc found for event injection');
      ok(res, { dispatched: false, reason: 'session not found on this worker' });
      return;
    }
    // Route synthetic events through onControl so the session can react.
    // Phase 2 will add a dedicated emitEvent injection path.
    await proc.onControl(body);
    ok(res, { dispatched: true });
    return;
  }

  if (method === 'POST' && resource === 'brainstorms' && action === 'control') {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    const handler = liveBrainstormHandlers.get(id);
    if (!handler) {
      log.warn({ roomId: id }, 'No live brainstorm handler found for control dispatch');
      ok(res, { dispatched: false, reason: 'brainstorm not found on this worker' });
      return;
    }
    handler(body);
    ok(res, { dispatched: true });
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
    const { wave, agentId, signal } = parsed as {
      wave?: unknown;
      agentId?: unknown;
      signal?: unknown;
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
    feedbackHandler(wave, agentId, signal as 'thumbs_up' | 'thumbs_down' | 'focus');
    ok(res, { dispatched: true });
    return;
  }

  if (method === 'POST' && resource === 'brainstorms' && action === 'events') {
    const body = await readBody(req);
    if (!body) {
      badRequest(res, 'Missing request body');
      return;
    }
    const handler = liveBrainstormHandlers.get(id);
    if (!handler) {
      log.warn({ roomId: id }, 'No live brainstorm handler found for event injection');
      ok(res, { dispatched: false, reason: 'brainstorm not found on this worker' });
      return;
    }
    handler(body);
    ok(res, { dispatched: true });
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
