import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Server as SocketIOServer } from 'socket.io';
import * as pty from 'node-pty';
import { verifyTerminalToken, type TerminalTokenPayload } from './auth';
import { createLogger } from '../lib/logger';

// --- Config ---

const PORT = parseInt(process.env.TERMINAL_PORT ?? '4101', 10);
const JWT_SECRET = process.env.TERMINAL_JWT_SECRET ?? process.env.JWT_SECRET ?? '';

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
  viewers: Set<string>;
}

// --- State ---

const sessions = new Map<string, SessionEntry>();

// --- HTTP + Socket.io Server ---

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terminal server OK');
});

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true, // JWT auth is the security layer; allow any origin
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e6,
});

// --- Connection Handler ---

io.on('connection', (socket) => {
  const token = socket.handshake.query.token as string | undefined;
  if (!token) {
    socket.emit('terminal:error', { message: 'Missing authentication token' });
    socket.disconnect(true);
    return;
  }

  let payload: TerminalTokenPayload;
  try {
    payload = verifyTerminalToken(token, JWT_SECRET);
  } catch (err) {
    socket.emit('terminal:error', {
      message: `Authentication failed: ${(err as Error).message}`,
    });
    socket.disconnect(true);
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
        // Create tmux session if it doesn't already exist (e.g. after server restart).
        // On subsequent connections the session persists and we just re-attach.
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

      // Both shell and attach modes connect via tmux attach-session.
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
      };
      entry = newEntry;

      ptyProcess.onData((data) => {
        for (const viewerId of newEntry.viewers) {
          io.to(viewerId).emit('terminal:output', data);
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        log.info(`PTY exited for ${sessionName} (code: ${exitCode})`);
        for (const viewerId of newEntry.viewers) {
          io.to(viewerId).emit('terminal:exit', { exitCode });
        }
        sessions.delete(sessionName);
      });

      sessions.set(sessionName, newEntry);
      log.info(`Attached PTY to tmux session: ${sessionName}`);
    } catch (err) {
      socket.emit('terminal:error', {
        message: `Failed to attach to session: ${(err as Error).message}`,
      });
      socket.disconnect(true);
      return;
    }
  }

  entry.viewers.add(socket.id);
  log.info(`Viewer connected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`);

  socket.on('terminal:input', (data: string) => {
    entry?.ptyProcess.write(data);
  });

  socket.on('terminal:resize', ({ cols, rows }: { cols: number; rows: number }) => {
    if (cols > 0 && rows > 0 && cols <= 500 && rows <= 200) {
      entry?.ptyProcess.resize(cols, rows);
    }
  });

  socket.on('disconnect', () => {
    if (entry) {
      entry.viewers.delete(socket.id);
      log.info(
        `Viewer disconnected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`,
      );

      if (entry.viewers.size === 0) {
        log.info(`No viewers for ${sessionName}, killing PTY (tmux detaches)`);
        entry.ptyProcess.kill();
        sessions.delete(sessionName);
      }
    }
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
    entry.ptyProcess.kill();
  }
  sessions.clear();

  io.close();
  httpServer.close(() => {
    serverLog.info('Shut down cleanly');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
