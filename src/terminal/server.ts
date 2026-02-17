import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import * as pty from 'node-pty';
import { verifyTerminalToken, type TerminalTokenPayload } from './auth';

// --- Config ---

const PORT = parseInt(process.env.TERMINAL_PORT ?? '4101', 10);
const JWT_SECRET = process.env.TERMINAL_JWT_SECRET ?? process.env.JWT_SECRET ?? '';
const NEXT_ORIGIN = process.env.NEXT_PUBLIC_URL ?? 'http://localhost:4100';

if (!JWT_SECRET) {
  console.error('[terminal-server] TERMINAL_JWT_SECRET or JWT_SECRET is required');
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
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionName], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: process.env.HOME ?? '/tmp',
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          HOME: process.env.HOME ?? '/tmp',
          PATH: process.env.PATH ?? '/usr/bin:/bin',
        },
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
        console.log(`[terminal] PTY exited for ${sessionName} (code: ${exitCode})`);
        for (const viewerId of newEntry.viewers) {
          io.to(viewerId).emit('terminal:exit', { exitCode });
        }
        sessions.delete(sessionName);
      });

      sessions.set(sessionName, newEntry);
      console.log(`[terminal] Created PTY for tmux session: ${sessionName}`);
    } catch (err) {
      socket.emit('terminal:error', {
        message: `Failed to attach to session: ${(err as Error).message}`,
      });
      socket.disconnect(true);
      return;
    }
  }

  entry.viewers.add(socket.id);
  console.log(
    `[terminal] Viewer connected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`,
  );

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
      console.log(
        `[terminal] Viewer disconnected: ${socket.id} -> ${sessionName} (${entry.viewers.size} viewers)`,
      );

      if (entry.viewers.size === 0) {
        console.log(`[terminal] No viewers for ${sessionName}, killing PTY (tmux detaches)`);
        entry.ptyProcess.kill();
        sessions.delete(sessionName);
      }
    }
  });
});

// --- Startup ---

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[terminal-server] Listening on 0.0.0.0:${PORT}`);
});

// --- Graceful Shutdown ---

function shutdown(signal: string): void {
  console.log(`[terminal-server] Received ${signal}, shutting down...`);

  for (const [name, entry] of sessions) {
    console.log(`[terminal] Killing PTY for ${name}`);
    entry.ptyProcess.kill();
  }
  sessions.clear();

  io.close();
  httpServer.close(() => {
    console.log('[terminal-server] Shut down cleanly');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
