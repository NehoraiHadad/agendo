import { createServer, type IncomingMessage } from 'node:http';
import { spawnSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { verifyTerminalToken, type TerminalTokenPayload } from './auth';
import { createLogger } from '../lib/logger';

// --- Config ---

const PORT = parseInt(process.env.TERMINAL_PORT ?? '4101', 10);
const JWT_SECRET = process.env.TERMINAL_JWT_SECRET ?? process.env.JWT_SECRET ?? '';
const SCROLLBACK_LIMIT = 50 * 1024; // 50 KB ring buffer per session

const serverLog = createLogger('terminal-server');
const log = createLogger('terminal');

if (!JWT_SECRET) {
  serverLog.error('TERMINAL_JWT_SECRET or JWT_SECRET is required');
  process.exit(1);
}

// --- Types ---

interface SessionEntry {
  tmuxName: string;
  ptyProcess: pty.IPty;
  viewers: Set<WebSocket>;
  scrollback: string;
}

// --- State ---

const sessions = new Map<string, SessionEntry>();

// --- HTTP Server (health check) ---

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terminal server OK');
});

// --- WebSocket Server ---

const wss = new WebSocketServer({ server: httpServer });

function authenticateRequest(req: IncomingMessage): TerminalTokenPayload {
  const url = new URL(req.url ?? '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Missing authentication token');
  return verifyTerminalToken(token, JWT_SECRET);
}

function appendScrollback(entry: SessionEntry, data: string): void {
  entry.scrollback += data;
  if (entry.scrollback.length > SCROLLBACK_LIMIT) {
    entry.scrollback = entry.scrollback.slice(-SCROLLBACK_LIMIT);
  }
}

function sendControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastData(entry: SessionEntry, data: string): void {
  for (const viewer of entry.viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(Buffer.from(data, 'utf-8'));
    }
  }
}

// --- Connection Handler ---

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  let payload: TerminalTokenPayload;
  try {
    payload = authenticateRequest(req);
  } catch (err) {
    sendControl(ws, { type: 'error', message: (err as Error).message });
    ws.close(4001, 'Auth failed');
    return;
  }

  const { sessionName } = payload;
  let entry = sessions.get(sessionName);

  if (!entry) {
    try {
      const isShellMode = payload.mode === 'shell';
      const cwd = payload.cwd ?? process.env.HOME ?? '/tmp';
      const fullEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as NodeJS.ProcessEnv;

      if (isShellMode) {
        const { status } = spawnSync('tmux', ['has-session', '-t', sessionName], {
          stdio: 'ignore',
        });
        const tmuxExists = status === 0;
        if (!tmuxExists) {
          spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], {
            env: fullEnv,
            stdio: 'ignore',
          });
          if (payload.initialHint) {
            const hint = payload.initialHint.replace(/'/g, "'\\''");
            spawnSync(
              'tmux',
              [
                'send-keys',
                '-t',
                sessionName,
                `echo '--- Agendo Session Terminal ---'; echo '${hint}'; echo ''`,
                'Enter',
              ],
              { env: fullEnv, stdio: 'ignore' },
            );
          }
          log.info(`Created tmux session for shell mode: ${sessionName} (cwd=${cwd})`);
        } else {
          log.info(`Reusing existing tmux session: ${sessionName}`);
        }
      }

      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd,
        env: fullEnv,
      });

      const newEntry: SessionEntry = {
        tmuxName: sessionName,
        ptyProcess,
        viewers: new Set(),
        scrollback: '',
      };
      entry = newEntry;

      ptyProcess.onData((data) => {
        appendScrollback(newEntry, data);
        broadcastData(newEntry, data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        log.info(`PTY exited for ${sessionName} (code: ${exitCode})`);
        for (const viewer of newEntry.viewers) {
          sendControl(viewer, { type: 'exit', exitCode });
        }
        sessions.delete(sessionName);
      });

      sessions.set(sessionName, newEntry);
      log.info(`Attached PTY to tmux session: ${sessionName}`);
    } catch (err) {
      sendControl(ws, {
        type: 'error',
        message: `Failed to attach to session: ${(err as Error).message}`,
      });
      ws.close(4000, 'PTY failed');
      return;
    }
  }

  // Replay scrollback for reconnecting clients
  if (entry.scrollback.length > 0) {
    ws.send(Buffer.from(entry.scrollback, 'utf-8'));
  }

  entry.viewers.add(ws);
  sendControl(ws, { type: 'connected', session: sessionName });
  log.info(`Viewer connected: ${sessionName} (${entry.viewers.size} viewers)`);

  // Binary frames = terminal input, Text frames = JSON control
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!entry || !sessions.has(entry.tmuxName)) return;

    if (isBinary) {
      try {
        entry.ptyProcess.write(Buffer.from(data as Buffer).toString('utf-8'));
      } catch {
        // PTY already dead
      }
    } else {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; cols?: number; rows?: number };
        if (
          msg.type === 'resize' &&
          typeof msg.cols === 'number' &&
          typeof msg.rows === 'number' &&
          msg.cols > 0 &&
          msg.rows > 0 &&
          msg.cols <= 500 &&
          msg.rows <= 200
        ) {
          try {
            entry.ptyProcess.resize(msg.cols, msg.rows);
          } catch {
            // PTY already dead — ignore (EBADF)
          }
        }
      } catch {
        // Invalid JSON — ignore
      }
    }
  });

  ws.on('close', () => {
    if (entry) {
      entry.viewers.delete(ws);
      log.info(`Viewer disconnected: ${sessionName} (${entry.viewers.size} viewers)`);

      if (entry.viewers.size === 0 && sessions.has(sessionName)) {
        log.info(`No viewers for ${sessionName}, killing PTY (tmux detaches)`);
        sessions.delete(sessionName);
        try {
          entry.ptyProcess.kill();
        } catch {
          // Already dead
        }
      }
    }
  });

  ws.on('error', (err) => {
    log.info(`WebSocket error for ${sessionName}: ${err.message}`);
  });
});

// --- Startup ---

httpServer.listen(PORT, '0.0.0.0', () => {
  serverLog.info(`Listening on 0.0.0.0:${PORT}`);
});

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  serverLog.info(`Received ${signal}, shutting down...`);

  for (const [name, entry] of sessions) {
    log.info(`Killing PTY for ${name}`);
    try {
      entry.ptyProcess.kill();
    } catch {
      // Already dead
    }
  }
  sessions.clear();

  wss.close();
  httpServer.close(() => {
    serverLog.info('Shut down cleanly');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
