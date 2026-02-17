# Web-Based Terminal for AI Agent Sessions — Research Document

> Generated: 2026-02-17
> Purpose: Research findings for "Agent Monitor" — a Next.js web app feature to attach/detach
> from running AI CLI agent sessions (Claude Code, Codex CLI, Gemini CLI, etc.)

---

## Table of Contents

1. [xterm.js Fundamentals](#1-xtermjs-fundamentals)
2. [node-pty Backend](#2-node-pty-backend)
3. [WebSocket Bridge](#3-websocket-bridge)
4. [tmux Integration Pattern](#4-tmux-integration-pattern)
5. [Security Considerations](#5-security-considerations)
6. [Existing Implementations](#6-existing-implementations)
7. [Architecture Options](#7-architecture-options)
8. [Recommended Architecture](#8-recommended-architecture)
9. [Implementation Plan](#9-implementation-plan)
10. [Performance Considerations](#10-performance-considerations)
11. [Security Checklist](#11-security-checklist)
12. [Package Reference](#12-package-reference)
13. [Sources](#13-sources)

---

## 1. xterm.js Fundamentals

### Package Overview

xterm.js has been rebranded from `xterm` to scoped `@xterm/*` packages. The old unscoped
packages are **deprecated** and will no longer be maintained.

| Package | Latest Version | Purpose |
|---------|---------------|---------|
| `@xterm/xterm` | 6.0.0 | Core terminal emulator |
| `@xterm/addon-fit` | 0.10.0 | Auto-fit terminal to container |
| `@xterm/addon-web-links` | 0.12.0 | Clickable URLs in terminal output |
| `@xterm/addon-search` | 0.15.0 | Search terminal buffer |
| `@xterm/addon-webgl` | 0.19.0 | WebGL2 GPU-accelerated renderer |
| `@xterm/addon-serialize` | 0.14.0 | Serialize terminal state |

### Version 6 Breaking Changes

- **Bundle size reduced 30%**: 379kb down to 265kb
- **Canvas renderer deprecated**: Use `@xterm/addon-webgl` instead
- API cleanup and breaking changes from v5
- New underline style/color support
- Hyperlink escape sequence support with `linkHandler` option
- Minimum contrast ratio feature
- Inactive selection background via `ITheme.selectionInactiveBackground`

### Installation

```bash
pnpm add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-search @xterm/addon-webgl
```

### Next.js Integration — Critical SSR Issue

xterm.js accesses the `window` object and **cannot run server-side**. You MUST use dynamic
imports with `ssr: false` in Next.js.

```typescript
// components/Terminal.tsx
'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { Terminal as XTerminal } from '@xterm/xterm';

interface TerminalProps {
  sessionId: string;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function TerminalComponent({ sessionId, onData, onResize }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);

  useEffect(() => {
    // Dynamic import to avoid SSR issues
    let terminal: XTerminal;
    let disposed = false;

    const init = async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');
      const { WebglAddon } = await import('@xterm/addon-webgl');
      const { SearchAddon } = await import('@xterm/addon-search');

      if (disposed || !containerRef.current) return;

      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        lineHeight: 1.2,
        scrollback: 5000,
        theme: DARK_THEME,
        allowTransparency: false,
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.loadAddon(new SearchAddon());

      terminal.open(containerRef.current);

      // Try WebGL first, fall back to default DOM renderer
      try {
        terminal.loadAddon(new WebglAddon());
      } catch (e) {
        console.warn('WebGL renderer not available, using DOM renderer');
      }

      fitAddon.fit();
      terminalRef.current = terminal;

      // Handle user input
      terminal.onData((data) => {
        onData?.(data);
      });

      // Handle resize
      terminal.onResize(({ cols, rows }) => {
        onResize?.(cols, rows);
      });

      // Fit on window resize
      const observer = new ResizeObserver(() => {
        fitAddon.fit();
      });
      observer.observe(containerRef.current);

      return () => observer.disconnect();
    };

    init();

    return () => {
      disposed = true;
      terminal?.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
```

**Page-level dynamic import (required for Next.js):**

```typescript
// app/terminal/[sessionId]/page.tsx
'use client';

import dynamic from 'next/dynamic';

const Terminal = dynamic(
  () => import('@/components/Terminal').then(m => m.TerminalComponent),
  { ssr: false, loading: () => <div className="terminal-loading">Loading terminal...</div> }
);

export default function TerminalPage({ params }: { params: { sessionId: string } }) {
  return <Terminal sessionId={params.sessionId} />;
}
```

### Theme Configuration

```typescript
import type { ITheme } from '@xterm/xterm';

const DARK_THEME: ITheme = {
  background: '#1a1b26',        // Tokyo Night background
  foreground: '#a9b1d6',        // Light gray text
  cursor: '#c0caf5',            // Bright cursor
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467C',
  selectionForeground: '#c0caf5',
  selectionInactiveBackground: '#292e42',
  black: '#15161E',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
};
```

### Performance Notes

- **Scrollback**: Default 1000 lines. A 160x24 terminal with 5000-line scrollback uses ~34MB.
  Keep scrollback at 5000-10000 max for agent sessions.
- **Write buffer**: Hardcoded 50MB limit. Data exceeding this is **discarded**.
- **Throughput**: xterm.js processes 5-35 MB/s depending on content complexity.
- **WebGL renderer**: Up to **900% faster** than canvas renderer. Falls back to DOM renderer
  if WebGL2 is unavailable.
- **No virtual scrolling**: xterm.js keeps all scrollback lines in memory. It does NOT
  virtualize rows the way a list virtualizer would. This is why scrollback limits matter.

### React Wrapper Libraries

Several wrapper libraries exist but **none are well-maintained** for xterm v6:

| Library | Stars | Last Update | Verdict |
|---------|-------|-------------|---------|
| `xterm-for-react` | ~200 | 2021 | Dead, uses old xterm |
| `react-xtermjs` (Qovery) | ~100 | 2024 | Hook-based, decent but not v6 |
| `xterm-react` (PabloLION) | ~50 | 2024 | Functional but limited |

**Recommendation**: Write your own thin React wrapper (as shown above). It is only ~60 lines
and gives full control over initialization, addon loading, and cleanup. All the wrapper
libraries lag behind xterm releases and add unnecessary abstraction.

---

## 2. node-pty Backend

### Package Info

- **Package**: `node-pty` v1.1.0 (by Microsoft, same team as VS Code)
- **Purpose**: Fork pseudoterminals in Node.js
- **Platforms**: Linux, macOS, Windows (via ConPTY or winpty)
- **Requirement**: Node.js 16+ (native addon, requires build tools)

### Core API

```typescript
import * as pty from 'node-pty';

// Spawn a new PTY process
const ptyProcess = pty.spawn('/bin/bash', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.env.HOME,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  },
});

// Read output
ptyProcess.onData((data: string) => {
  // data is a string of terminal output (may contain ANSI escape codes)
  console.log('PTY output:', data);
});

// Write input
ptyProcess.write('ls -la\r');

// Resize
ptyProcess.resize(120, 40);

// Access properties
console.log('PID:', ptyProcess.pid);
console.log('Cols:', ptyProcess.cols);
console.log('Rows:', ptyProcess.rows);
console.log('Process:', ptyProcess.process); // Current foreground process name

// Handle exit
ptyProcess.onExit(({ exitCode, signal }) => {
  console.log(`PTY exited: code=${exitCode}, signal=${signal}`);
});

// Kill
ptyProcess.kill('SIGTERM');
```

### IPtyForkOptions (Full Interface)

```typescript
interface IPtyForkOptions {
  name?: string;       // Terminal type, sets $TERM (default: 'xterm')
  cols?: number;       // Initial columns (default: 80)
  rows?: number;       // Initial rows (default: 24)
  cwd?: string;        // Working directory
  env?: Record<string, string>; // Environment variables
  encoding?: string | null;     // Data encoding (default: 'utf8', null = Buffer)
  uid?: number;        // Unix user ID
  gid?: number;        // Unix group ID
  handleFlowControl?: boolean;  // Enable XON/XOFF flow control (experimental)
  flowControlPause?: string;    // Pause character (default: '\x13' = Ctrl+S)
  flowControlResume?: string;   // Resume character (default: '\x11' = Ctrl+Q)
}
```

### Can node-pty Attach to an Existing Process?

**No.** node-pty can only **spawn new processes**. It cannot attach to an already-running
process or an existing PTY file descriptor.

**To attach to existing agent sessions, you MUST use tmux (or screen) as an intermediary.**

The pattern is:
1. Agent runs inside a tmux session
2. node-pty spawns `tmux attach-session -t <session-name>`
3. This creates a new PTY that is connected to the existing tmux session
4. When the WebSocket disconnects, the tmux session (and agent) keeps running

### Spawning tmux attach via node-pty

```typescript
function attachToAgentSession(sessionName: string, cols: number, rows: number) {
  const ptyProcess = pty.spawn('/usr/bin/tmux', [
    'attach-session', '-t', sessionName,
  ], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: '/tmp',
    env: {
      ...process.env,
      TERM: 'xterm-256color',
    },
  });

  return ptyProcess;
}
```

### Signal Forwarding

node-pty properly forwards signals through the PTY:
- **Ctrl+C** sends SIGINT to the foreground process group
- **Ctrl+Z** sends SIGTSTP
- **Ctrl+\\** sends SIGQUIT

These work naturally because node-pty creates a real pseudoterminal with proper
terminal discipline. When attached to tmux, signals are forwarded to the process
running inside the tmux pane.

### Memory Usage

node-pty itself is lightweight — each instance creates a PTY pair (master/slave file
descriptors) and a child process. The overhead per PTY is minimal (~1-2MB for the
node-pty bookkeeping). The real memory cost is the child process itself (e.g., tmux
client process is ~5-10MB, a shell is ~3-5MB).

---

## 3. WebSocket Bridge

### Architecture Overview

```
+-----------------------------------------------------------------+
| Browser                                                         |
|  +----------+     +----------+     +-------------+              |
|  | React UI |---->| xterm.js |---->| WebSocket   |              |
|  | (ctrls)  |     | (term)   |     | Client      |              |
|  +----------+     +----------+     +------+------+              |
+-------------------------------------------------|---------------+
                                                   | wss://
                                                   |
+--------------------------------------------------|--------------+
| Server (Next.js + WS)                            |              |
|  +-------------+     +----------+     +----------v-----------+  |
|  | Session      |---->| node-pty |---->| WebSocket            |  |
|  | Manager      |     | (PTY)    |     | Server               |  |
|  +------+------+     +-----+----+     +----------------------+  |
|         |                   |                                    |
|         |             +-----v------+                             |
|         |             | tmux attach|                             |
|         |             | -t session |                             |
|         |             +-----+------+                             |
+---------|-------------------|------------------------------------+
          |                   |
   +------v------+     +-----v--------+
   | Session DB  |     | tmux         |
   | (metadata)  |     | Sessions     |
   +-------------+     | +----------+ |
                        | | Agent 1  | |
                        | | (claude) | |
                        | +----------+ |
                        | | Agent 2  | |
                        | | (codex)  | |
                        | +----------+ |
                        | | Agent 3  | |
                        | | (gemini) | |
                        | +----------+ |
                        +--------------+
```

### Next.js WebSocket Options

Next.js does **not** natively support WebSockets. Three approaches:

#### Option A: `next-ws` Package (Simplest)

Patches Next.js to allow `UPGRADE` exports in route handlers.

```bash
pnpm add next-ws ws
# Add to package.json scripts:
# "prepare": "next-ws patch"
```

```typescript
// app/api/terminal/route.ts
import type { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';

export function UPGRADE(
  client: WebSocket,
  server: WebSocketServer,
  request: NextRequest,
) {
  // Authenticate
  const token = new URL(request.url).searchParams.get('token');
  if (!validateToken(token)) {
    client.close(4001, 'Unauthorized');
    return;
  }

  const sessionId = new URL(request.url).searchParams.get('session');
  // ... attach to PTY
}
```

**Pros**: Clean integration with app directory, no custom server
**Cons**: Requires patching Next.js (fragile across upgrades), only works with `next start`
  (not serverless)

#### Option B: Custom Server (Most Flexible)

```typescript
// server.ts
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { terminalManager } from './lib/terminal-manager';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    handle(req, res, parse(req.url!, true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname, searchParams } = new URL(
      request.url!,
      `http://${request.headers.host}`
    );

    if (pathname === '/api/terminal') {
      // Authenticate before upgrade
      const token = searchParams.get('token');
      if (!authenticateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const sessionId = searchParams.get('session')!;
        terminalManager.attachClient(ws, sessionId);
      });
    }
  });

  server.listen(3000, () => {
    console.log('> Ready on http://localhost:3000');
  });
});
```

**Pros**: Full control, no patching, supports all WebSocket features
**Cons**: Requires custom server setup, slightly different dev workflow

#### Option C: Separate WebSocket Server (Recommended for Production)

Run a dedicated terminal WebSocket server on a different port (e.g., 3001) alongside
the Next.js app. This decouples terminal connections from the web app.

```typescript
// terminal-server.ts (standalone)
import { WebSocketServer } from 'ws';
import { TerminalManager } from './terminal-manager';

const PORT = parseInt(process.env.TERMINAL_WS_PORT || '3001');
const wss = new WebSocketServer({ port: PORT });
const manager = new TerminalManager();

wss.on('connection', (ws, request) => {
  const url = new URL(request.url!, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('session');

  if (!validateToken(token) || !sessionId) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  manager.attachClient(ws, sessionId);
});

console.log(`Terminal WebSocket server on port ${PORT}`);
```

**Pros**: Independent scaling, crash isolation, simpler testing, can run as separate PM2 process
**Cons**: Extra port, CORS configuration needed, two processes to manage

**For Agent Monitor on instance-neo: Option C is recommended.** Run the terminal WS server
as a separate PM2 process. This keeps it isolated from the Next.js app and prevents terminal
crashes from taking down the web UI.

### Binary vs Text Data

- **PTY output** (node-pty `onData`): Returns UTF-8 strings containing raw terminal bytes
  including ANSI escape codes. xterm.js `write()` accepts strings.
- **User input** (xterm.js `onData`): Returns UTF-8 strings of keystrokes.
- **Recommendation**: Use **text mode** WebSocket frames for terminal data. Binary mode
  is unnecessary since node-pty already handles encoding. This simplifies debugging (you
  can read WebSocket frames in devtools).

### Reconnection Strategy

```typescript
// Client-side reconnection with exponential backoff
class TerminalWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseDelay = 1000; // 1 second
  private maxDelay = 30000; // 30 seconds
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private messageQueue: string[] = [];

  constructor(
    private url: string,
    private onMessage: (data: string) => void,
    private onStatusChange: (status: 'connecting' | 'connected' | 'disconnected') => void,
  ) {}

  connect() {
    this.onStatusChange('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatusChange('connected');
      this.startHeartbeat();
      // Flush queued messages
      while (this.messageQueue.length > 0) {
        this.ws?.send(this.messageQueue.shift()!);
      }
    };

    this.ws.onmessage = (event) => {
      const data = event.data as string;
      if (data === 'pong') return; // Heartbeat response
      this.onMessage(data);
    };

    this.ws.onclose = (event) => {
      this.stopHeartbeat();
      this.onStatusChange('disconnected');

      if (event.code === 4001) {
        // Authentication failure -- do not reconnect
        console.error('Terminal auth failed');
        return;
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(
          this.baseDelay * Math.pow(2, this.reconnectAttempts),
          this.maxDelay
        );
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  send(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.messageQueue.push(data);
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, 25000); // 25 second heartbeat
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  disconnect() {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    this.stopHeartbeat();
    this.ws?.close(1000, 'Client disconnect');
  }
}
```

### Flow Control (Critical for Performance)

When the agent produces output faster than the WebSocket can deliver it, you need
flow control. Use the watermark approach from xterm.js official docs:

```typescript
// Server-side: PTY to WebSocket with backpressure
function bridgePtyToWebSocket(ptyProcess: IPty, ws: WebSocket) {
  const CALLBACK_BYTE_LIMIT = 100_000; // 100KB
  const HIGH_WATERMARK = 5;
  const LOW_WATERMARK = 2;
  let bytesWritten = 0;
  let pendingAcks = 0;

  ptyProcess.onData((data) => {
    if (ws.readyState !== ws.OPEN) return;

    ws.send(data, (err) => {
      if (err) console.error('WS send error:', err);
    });

    bytesWritten += data.length;
    if (bytesWritten > CALLBACK_BYTE_LIMIT) {
      pendingAcks++;
      bytesWritten = 0;
      // Request ACK from client
      ws.send('\x00ACK_REQUEST');
      if (pendingAcks > HIGH_WATERMARK) {
        ptyProcess.pause();
      }
    }
  });

  ws.on('message', (msg: string) => {
    if (msg === '\x00ACK') {
      pendingAcks = Math.max(pendingAcks - 1, 0);
      if (pendingAcks < LOW_WATERMARK) {
        ptyProcess.resume();
      }
      return;
    }
    // Regular input from user
    ptyProcess.write(msg);
  });
}
```

### Multiple Concurrent Sessions

Each browser tab can have its own WebSocket connection to a different agent session.
The server maps connections to PTY instances via a session manager:

```typescript
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';

class TerminalManager {
  // sessionId -> { pty, clients[] }
  private sessions = new Map<string, {
    pty: IPty;
    clients: Set<WebSocket>;
    lastActivity: number;
  }>();

  attachClient(ws: WebSocket, sessionId: string) {
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Spawn new PTY attached to tmux session
      const ptyProcess = pty.spawn('/usr/bin/tmux', [
        'attach-session', '-t', sessionId,
      ], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      session = {
        pty: ptyProcess,
        clients: new Set(),
        lastActivity: Date.now(),
      };

      ptyProcess.onData((data) => {
        session!.lastActivity = Date.now();
        for (const client of session!.clients) {
          if (client.readyState === client.OPEN) {
            client.send(data);
          }
        }
      });

      ptyProcess.onExit(() => {
        for (const client of session!.clients) {
          client.close(4002, 'Session ended');
        }
        this.sessions.delete(sessionId);
      });

      this.sessions.set(sessionId, session);
    }

    session.clients.add(ws);

    // Forward client input to PTY
    ws.on('message', (data: Buffer) => {
      const msg = data.toString();
      if (msg.startsWith('\x01')) {
        // Control messages (resize, etc.)
        this.handleControlMessage(sessionId, msg.slice(1));
        return;
      }
      session!.pty.write(msg);
      session!.lastActivity = Date.now();
    });

    ws.on('close', () => {
      session?.clients.delete(ws);
      // If no clients remain, detach PTY after timeout
      if (session && session.clients.size === 0) {
        setTimeout(() => {
          if (session!.clients.size === 0) {
            session!.pty.kill();
            this.sessions.delete(sessionId);
          }
        }, 30_000); // 30s grace period
      }
    });
  }

  handleControlMessage(sessionId: string, msg: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const parsed = JSON.parse(msg);
    if (parsed.type === 'resize') {
      session.pty.resize(parsed.cols, parsed.rows);
    }
  }

  listSessions(): { id: string; lastActivity: number; clientCount: number }[] {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      lastActivity: s.lastActivity,
      clientCount: s.clients.size,
    }));
  }
}
```

---

## 4. tmux Integration Pattern

### Why tmux is Essential

tmux solves the fundamental "attach/detach" problem:

| Requirement | Without tmux | With tmux |
|-------------|-------------|-----------|
| Agent survives browser close | No | Yes |
| Multiple viewers same session | Complex | Built-in |
| Detach and reattach | Impossible | Native |
| Session persists across server restart | No | Yes (with resurrect) |
| Process isolation | Shared PTY | Separate process groups |

### Session Lifecycle

```
Phase 1: SPAWN -- Agent starts in tmux
  tmux new-session -d -s "agent-abc123" -x 120 -y 40
  tmux send-keys -t "agent-abc123" "claude --resume latest" Enter

Phase 2: STREAM -- SSE log streaming (non-interactive)
  tmux pipe-pane -t "agent-abc123" -o 'cat >> /tmp/agent-abc123.log'
  OR
  tmux capture-pane -t "agent-abc123" -p  (poll periodically)

Phase 3: ATTACH -- User wants interactive control
  Server spawns via node-pty:
  pty.spawn('tmux', ['attach-session', '-t', 'agent-abc123'])
  xterm.js connects via WebSocket to this PTY

Phase 4: DETACH -- User closes terminal tab
  PTY process exits (tmux client detaches)
  Agent keeps running in tmux session
  SSE streaming can resume
```

### Creating Agent Sessions

```typescript
import { execFileSync } from 'child_process';

interface AgentSessionConfig {
  id: string;           // Unique session identifier
  agentType: 'claude' | 'codex' | 'gemini';
  command: string;      // Full command to run
  cwd: string;          // Working directory
  cols?: number;
  rows?: number;
}

function createAgentSession(config: AgentSessionConfig): void {
  const { id, command, cwd, cols = 120, rows = 40 } = config;
  const sessionName = `agent-${id}`;

  // Create detached tmux session with specific size
  execFileSync('tmux', [
    'new-session', '-d', '-s', sessionName,
    '-x', String(cols), '-y', String(rows),
    '-c', cwd,
  ]);

  // Set environment variables in the session
  execFileSync('tmux', ['set-environment', '-t', sessionName, 'AGENT_ID', id]);
  execFileSync('tmux', ['set-environment', '-t', sessionName, 'AGENT_TYPE', config.agentType]);

  // Start the agent command
  execFileSync('tmux', ['send-keys', '-t', sessionName, command, 'Enter']);

  // Start log piping for SSE streaming
  const logPath = `/tmp/agent-${id}.log`;
  execFileSync('tmux', ['pipe-pane', '-t', sessionName, '-o', `cat >> ${logPath}`]);
}
```

### Reading Output for SSE Streaming (Non-Interactive)

Two approaches for the "view only" mode:

#### Approach A: `pipe-pane` + File Tailing

```typescript
import { spawn, execFileSync } from 'child_process';

function streamAgentOutput(sessionId: string, onData: (chunk: string) => void): () => void {
  const logPath = `/tmp/agent-${sessionId}.log`;

  // Enable pipe-pane if not already
  execFileSync('tmux', [
    'pipe-pane', '-t', `agent-${sessionId}`, '-o', `cat >> ${logPath}`,
  ]);

  // Tail the log file
  const tail = spawn('tail', ['-f', '-n', '100', logPath]);
  tail.stdout.on('data', (chunk: Buffer) => onData(chunk.toString()));

  return () => {
    tail.kill();
    // Optionally stop pipe-pane
    execFileSync('tmux', ['pipe-pane', '-t', `agent-${sessionId}`]);
  };
}
```

#### Approach B: Periodic `capture-pane` (Simpler, No File)

```typescript
import { execFileSync } from 'child_process';

function pollAgentOutput(
  sessionId: string,
  onData: (content: string) => void,
  intervalMs = 500
): () => void {
  let lastContent = '';

  const timer = setInterval(() => {
    try {
      const content = execFileSync('tmux', [
        'capture-pane', '-t', `agent-${sessionId}`, '-p', '-S', '-100',
      ], { encoding: 'utf-8' });

      if (content !== lastContent) {
        onData(content);
        lastContent = content;
      }
    } catch {
      // Session may have ended
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
```

### Switching Between View-Only and Interactive Modes

```typescript
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';

type SessionMode = 'view' | 'interactive';

class AgentSessionProxy {
  private mode: SessionMode = 'view';
  private stopStreaming?: () => void;
  private ptyProcess?: IPty;

  constructor(
    private sessionId: string,
    private ws: WebSocket,
  ) {
    this.enterViewMode();
  }

  enterViewMode() {
    // Kill interactive PTY if exists
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = undefined;
    }

    this.mode = 'view';
    this.stopStreaming = streamAgentOutput(this.sessionId, (data) => {
      this.ws.send(JSON.stringify({ type: 'output', data }));
    });
  }

  enterInteractiveMode(cols: number, rows: number) {
    // Stop SSE streaming
    this.stopStreaming?.();
    this.stopStreaming = undefined;

    this.mode = 'interactive';

    // Attach to tmux session via node-pty
    this.ptyProcess = pty.spawn('/usr/bin/tmux', [
      'attach-session', '-t', `agent-${this.sessionId}`,
    ], {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    this.ptyProcess.onData((data) => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(data);
      }
    });

    this.ptyProcess.onExit(() => {
      // User detached or session ended -- go back to view mode
      this.enterViewMode();
    });
  }

  handleInput(data: string) {
    if (this.mode === 'interactive' && this.ptyProcess) {
      this.ptyProcess.write(data);
    }
    // In view mode, input is ignored (read-only)
  }
}
```

### tmux Control Mode (`-CC`)

tmux control mode is a text-based protocol for programmatic interaction. Instead of
rendering to a terminal, tmux sends structured notifications prefixed with `%`.

```typescript
// Using tmux control mode for metadata extraction
function getTmuxControlClient(sessionId: string) {
  const controlProcess = pty.spawn('/usr/bin/tmux', [
    '-CC', 'attach-session', '-t', `agent-${sessionId}`,
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });

  controlProcess.onData((data) => {
    // Data comes as control mode notifications:
    // %begin <timestamp> <cmd-number> <flags>
    // ... command output ...
    // %end <timestamp> <cmd-number> <flags>
    //
    // %output %0 <data>  -- pane output
    // %session-changed $1 <name>
    // %window-add @1
    // etc.
    parseControlOutput(data);
  });

  // Send commands via stdin
  controlProcess.write('list-sessions\n');

  return controlProcess;
}
```

**Note**: Control mode is useful for monitoring but adds complexity. For Agent Monitor,
the simpler approach (spawn `tmux attach` via node-pty for interactive, `capture-pane`/
`pipe-pane` for viewing) is preferred.

### tmux Session Discovery

```typescript
import { execFileSync } from 'child_process';

function listAgentSessions(): { name: string; created: string; attached: boolean }[] {
  const output = execFileSync('tmux', [
    'list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}',
  ], { encoding: 'utf-8' }).trim();

  return output.split('\n')
    .filter(line => line.startsWith('agent-'))
    .map(line => {
      const [name, created, attached] = line.split('|');
      return {
        name,
        created: new Date(parseInt(created) * 1000).toISOString(),
        attached: attached === '1',
      };
    });
}
```

---

## 5. Security Considerations

### Threat Model

Terminal access through a web browser is **equivalent to SSH access**. Anyone with a valid
terminal WebSocket connection can:

- Read all agent output (potentially containing secrets, API keys, code)
- Send keystrokes to the agent (approve actions, type commands)
- If the agent has shell access, effectively have shell access themselves
- Ctrl+C to kill the agent, Ctrl+Z to suspend, etc.

### Authentication for WebSocket

WebSockets do **not** share typical browser security features:
- No CORS restrictions on WebSocket connections
- No automatic cookie/CSRF protections
- Origin header can be spoofed by non-browser clients

**Required**: Token-based authentication on every WebSocket connection.

```typescript
// Token validation middleware
import { verify, sign } from 'jsonwebtoken';

interface TerminalToken {
  userId: string;
  sessionId: string;
  permissions: ('read' | 'write')[];
  exp: number;
}

function validateTerminalToken(token: string): TerminalToken | null {
  try {
    const decoded = verify(token, process.env.TERMINAL_JWT_SECRET!) as TerminalToken;

    // Check expiry (short-lived tokens: 15 minutes)
    if (decoded.exp < Date.now() / 1000) return null;

    // Verify session exists
    if (!tmuxSessionExists(decoded.sessionId)) return null;

    return decoded;
  } catch {
    return null;
  }
}

// Generate token (called from authenticated Next.js API route)
function generateTerminalToken(userId: string, sessionId: string): string {
  return sign(
    {
      userId,
      sessionId,
      permissions: ['read', 'write'],
      exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
    },
    process.env.TERMINAL_JWT_SECRET!,
  );
}
```

### Restricting Terminal Access

Since the user connects to a tmux session (not a raw shell), the attack surface is
limited to what the agent's tmux session provides. However:

1. **No shell escape prevention**: If the agent CLI has a shell escape feature
   (e.g., `!bash` in some tools), the user gets full shell access.
2. **tmux command mode**: Pressing the tmux prefix (Ctrl+b by default) gives access
   to tmux commands, which could spawn new windows/panes.

**Mitigation strategies:**

```bash
# Disable tmux prefix key in agent sessions
tmux set-option -t "agent-ID" prefix None
tmux set-option -t "agent-ID" prefix2 None

# Use a restricted tmux config for agent sessions
# File: ~/.tmux-agent.conf
# set -g prefix None
# set -g prefix2 None
# set -g mouse off
# set -g status off
# unbind-key -a  # Unbind all keys except basic input
```

```typescript
// Input filtering on the server (defense in depth)
const BLOCKED_SEQUENCES = [
  '\x02',       // Ctrl+B (tmux prefix)
  '\x01',       // Ctrl+A (screen prefix)
];

function filterInput(data: string): string {
  let filtered = data;
  for (const seq of BLOCKED_SEQUENCES) {
    filtered = filtered.replaceAll(seq, '');
  }
  return filtered;
}
```

### Read-Only Mode

For "view only" connections, disable input entirely:

```typescript
// Server-side: ignore all input from read-only clients
if (token.permissions.includes('write')) {
  ws.on('message', (data: Buffer) => ptyProcess.write(data.toString()));
} else {
  // Read-only: only send output, ignore input
  ws.on('message', () => {
    // Silently drop input from read-only connections
  });
}
```

### Audit Logging

```typescript
interface AuditEntry {
  timestamp: string;
  userId: string;
  sessionId: string;
  action: 'connect' | 'disconnect' | 'input' | 'resize' | 'mode_change';
  data?: string;  // For input events: the keys sent (be careful with secrets!)
}

class AuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'timestamp'>) {
    const fullEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(fullEntry);

    // Write to file or database
    // WARNING: Do not log passwords or secrets in input data.
    // Consider redacting or hashing sensitive input.
    if (entry.action === 'input') {
      // Log that input occurred, but not the content
      console.log(
        `[AUDIT] ${fullEntry.timestamp} user=${entry.userId} ` +
        `session=${entry.sessionId} action=input length=${entry.data?.length}`
      );
    } else {
      console.log(`[AUDIT] ${JSON.stringify(fullEntry)}`);
    }
  }
}
```

### Rate Limiting Input

Prevent abuse (e.g., paste-bombing the terminal):

```typescript
class InputRateLimiter {
  private byteCount = 0;
  private lastReset = Date.now();
  private readonly maxBytesPerSecond = 10_000; // 10KB/s
  private readonly maxBytesPerMessage = 4_096; // 4KB per message

  shouldAllow(data: string): boolean {
    const now = Date.now();
    if (now - this.lastReset > 1000) {
      this.byteCount = 0;
      this.lastReset = now;
    }

    if (data.length > this.maxBytesPerMessage) {
      return false; // Single message too large
    }

    this.byteCount += data.length;
    return this.byteCount <= this.maxBytesPerSecond;
  }
}
```

---

## 6. Existing Implementations

### Web Terminal Projects

| Project | Language | Frontend | Backend | Stars | Status |
|---------|----------|----------|---------|-------|--------|
| **ttyd** | C | xterm.js | libwebsockets | 8k+ | Active, very fast |
| **Wetty** | Node.js | xterm.js | node-pty + SSH | 4k+ | Active |
| **GoTTY** | Go | hterm | gorilla/ws | 18k+ | Unmaintained |
| **gotty (fork)** | Go | hterm | gorilla/ws | 2k+ | Maintained fork |

**ttyd** is the most relevant reference implementation. It is a single-binary C program
that exposes any CLI command over the web using xterm.js + WebSocket. It uses
libwebsockets for high performance and supports authentication, SSL, and read-only mode.

**Wetty** is Node.js-based and closest to our stack. It connects to a local or remote
shell via SSH and serves it through xterm.js. However, it targets SSH connections,
not tmux sessions.

### AI Agent Terminal Managers

| Project | Language | Architecture | Stars |
|---------|----------|-------------|-------|
| **Agent of Empires** | Rust | TUI + tmux sessions | 200+ |
| **Agent Deck** | Go (Bubble Tea) | TUI + tmux + MCP | 800+ |

Both are **TUI applications** (terminal-based), not web-based. Key learnings:

- **Both use tmux as the session backend**, confirming tmux is the right approach
- **Agent Deck** detects agent status (running/waiting/idle/error) by parsing tmux pane output
- **Agent of Empires** supports git worktrees for parallel agent branches
- Neither provides web-based access -- this is the gap Agent Monitor fills

### VS Code Terminal Architecture

VS Code's integrated terminal uses exactly the stack we are considering:
- **Frontend**: xterm.js (maintained by the same Microsoft team)
- **Backend**: node-pty (also maintained by Microsoft)
- **Communication**: IPC (not WebSocket, since it is within the same app)

Key architectural decisions from VS Code:
- WebGL renderer as default with canvas fallback
- Separate renderer and pty processes for crash isolation
- Terminal reconnection on window reload via serialization
- `@xterm/addon-serialize` to save and restore terminal state

### Jupyter Terminal

Jupyter Notebook/Lab includes a web terminal that uses:
- xterm.js frontend
- Python `terminado` library (similar to node-pty but Python)
- WebSocket via Tornado

### How Cursor/Windsurf Show Agent Terminal

These AI-powered editors show agent activity inline in their UI. They do NOT expose a
raw terminal -- instead they show:
- Streamed log output (like our SSE approach)
- Diff views for file changes
- Action approval buttons (not terminal input)

This is a **different paradigm** from what we are building. We want actual terminal
access for power users who need to interact with the raw agent CLI.

---

## 7. Architecture Options

### Option A: Direct node-pty

```
Browser -> xterm.js -> WebSocket -> node-pty -> AI CLI process
```

| Aspect | Assessment |
|--------|-----------|
| Complexity | Low |
| Latency | Lowest (~1ms) |
| Detach/reattach | Not possible -- process dies with connection |
| Process survival | No -- agent dies if server restarts |
| Multiple viewers | Possible but requires manual fan-out |
| Use case | Quick prototype, ephemeral sessions |

**Verdict**: Not suitable for Agent Monitor. Agents MUST survive disconnections.

### Option B: tmux Intermediary

```
Browser -> xterm.js -> WebSocket -> node-pty -> tmux attach -> AI CLI in tmux
```

| Aspect | Assessment |
|--------|-----------|
| Complexity | Medium |
| Latency | Low (~2-5ms additional from tmux) |
| Detach/reattach | Native tmux feature |
| Process survival | Yes -- tmux keeps agent running |
| Multiple viewers | tmux supports multiple clients natively |
| Use case | Production agent management |

**Verdict**: Best fit for Agent Monitor. Standard approach used by Agent Deck and
Agent of Empires.

### Option C: Hybrid (SSE + tmux on-demand)

```
Default:   Browser -> SSE -> tail log file <- tmux pipe-pane <- AI CLI in tmux
On-demand: Browser -> xterm.js -> WebSocket -> node-pty -> tmux attach -> AI CLI in tmux
```

| Aspect | Assessment |
|--------|-----------|
| Complexity | Medium-High |
| Default resource usage | Very low (SSE is just HTTP) |
| Interactive resource usage | Same as Option B |
| User experience | Smooth transition from viewing to interacting |
| Scalability | Best -- most connections are lightweight SSE |

**Verdict**: Recommended. Most users will just watch (SSE). Only power users will
attach interactively (WebSocket + PTY). This matches how Agent Deck works -- most of
the time you are viewing status, only sometimes attaching.

---

## 8. Recommended Architecture

### Architecture: Hybrid (Option C) with Separate WS Server

```
+---------------------------------------------------------------------+
|                        Browser (Agent Monitor)                      |
|                                                                     |
|  +-----------------------------------+  +------------------------+  |
|  | Agent List / Dashboard            |  | Terminal Panel          |  |
|  | +------+ +------+ +------+       |  | +------------------+   |  |
|  | |Agent1| |Agent2| |Agent3|       |  | |   xterm.js       |   |  |
|  | |  *   | |  o   | |  .   |       |  | |                  |   |  |
|  | +--+---+ +------+ +------+       |  | |  $ claude        |   |  |
|  |    |                              |  | |  > Working on... |   |  |
|  |    | click "Attach"               |  | |  > [approve?] y  |   |  |
|  |    v                              |  | |                  |   |  |
|  | +------------------+             |  | +------------------+   |  |
|  | | SSE Log Stream   |-------------+--| [View] [Interactive]  |  |
|  | | (read-only)      |  upgrade     |  | [Detach]              |  |
|  | +------------------+             |  +------------------------+  |
|  +-----------------------------------+                              |
+-------------+------------------------------------------+------------+
              | HTTP/SSE (:3000)                         | WebSocket (:3001)
              |                                          |
+-------------v------------------+  +--------------------v----------------+
| Next.js App (PM2: agent-mon)  |  | Terminal WS Server                  |
| Port 3000                     |  | Port 3001                           |
|                                |  |                                      |
| - Dashboard UI                |  | - JWT validation                     |
| - Agent CRUD API              |  | - PTY management                     |
| - SSE streaming endpoints     |  | - tmux attach/detach                 |
| - Token generation API        |  | - Resize handling                    |
| - Session metadata DB         |  | - Flow control                       |
|                                |  | - Audit logging                      |
+-------------------+------------+  +-------------------+------------------+
                    |                                    |
                    v                                    v
            +----------------------------------------------+
            |              tmux Server                      |
            |                                               |
            |  Session: agent-abc123 (claude)    * running   |
            |  Session: agent-def456 (codex)     o waiting   |
            |  Session: agent-ghi789 (gemini)    . idle      |
            +----------------------------------------------+
```

### PM2 Configuration Addition

```javascript
// Add to ecosystem.config.js
{
  name: 'terminal-ws',
  script: 'pnpm',
  args: 'run start:terminal-server',
  cwd: '/home/ubuntu/projects/agent-monitor',
  interpreter: 'none',
  env: {
    NODE_ENV: 'production',
    TERMINAL_WS_PORT: '3001',
    TERMINAL_JWT_SECRET: '...',
    NODE_OPTIONS: '--max-old-space-size=512',
  },
}
```

### Data Flow

1. **Agent Creation**:
   - Next.js API creates tmux session, starts agent CLI
   - Stores session metadata in DB (id, type, start time, tmux session name)
   - Starts `pipe-pane` for log file output

2. **Viewing (SSE)**:
   - Client connects to `/api/agents/:id/stream` (SSE endpoint)
   - Server tails the pipe-pane log file
   - Lightweight, many clients can connect

3. **Attaching (Interactive)**:
   - Client requests terminal token from `/api/agents/:id/terminal-token` (authenticated)
   - Client opens WebSocket to `ws://host:3001?token=...&session=...`
   - Terminal WS server validates token, spawns `tmux attach` via node-pty
   - Full bidirectional terminal access

4. **Detaching**:
   - Client closes WebSocket (or clicks "Detach")
   - Server kills the PTY (tmux client detaches)
   - Agent keeps running in tmux
   - Client can switch back to SSE viewing

---

## 9. Implementation Plan

### Phase 1: Core Terminal Component (Frontend)

```
Files to create:
  components/terminal/Terminal.tsx         -- xterm.js wrapper (dynamic import)
  components/terminal/TerminalToolbar.tsx  -- controls (attach/detach/mode toggle)
  components/terminal/useTerminalWs.ts    -- WebSocket hook with reconnection
  components/terminal/themes.ts           -- terminal themes
  lib/terminal-token.ts                   -- token generation/validation
```

### Phase 2: Terminal WebSocket Server (Backend)

```
Files to create:
  server/terminal-server.ts     -- standalone WS server entry point
  server/terminal-manager.ts    -- PTY lifecycle management
  server/tmux-utils.ts          -- tmux session helpers
  server/audit-logger.ts        -- terminal audit logging
  server/input-filter.ts        -- input sanitization and rate limiting
```

### Phase 3: tmux Session Management

```
Files to create/modify:
  lib/agent-session.ts          -- create/destroy/list tmux sessions
  lib/agent-stream.ts           -- SSE streaming from pipe-pane logs
  app/api/agents/[id]/stream/route.ts     -- SSE endpoint
  app/api/agents/[id]/terminal-token/route.ts -- token generation
```

### Phase 4: Integration and Polish

```
- Mode switching (view <-> interactive) with smooth transitions
- Terminal search (Ctrl+Shift+F using addon-search)
- Copy/paste support
- Terminal font size controls
- Multiple terminal tabs (different agent sessions)
- Connection status indicator in UI
```

### Dependency Summary

```json
{
  "dependencies": {
    "@xterm/xterm": "^6.0.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.12.0",
    "@xterm/addon-search": "^0.15.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/addon-serialize": "^0.14.0",
    "node-pty": "^1.1.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0"
  }
}
```

**Note on node-pty**: It is a native addon requiring build tools (`python3`, `make`, `gcc`).
On the server (instance-neo, Ubuntu), these are typically pre-installed. If using Docker,
include build-essential in the image.

---

## 10. Performance Considerations

### Resource Budget per Agent Session

| Component | Memory | CPU | File Descriptors |
|-----------|--------|-----|-----------------|
| tmux session | 5-10 MB | Negligible | 3-5 |
| node-pty instance | 1-2 MB | Negligible | 2 (PTY pair) |
| Agent CLI (claude) | 100-300 MB | Variable | 10-20 |
| WebSocket connection | <1 MB | Negligible | 1 |
| SSE connection | <1 MB | Negligible | 1 |

**On instance-neo (16GB RAM)**: Can comfortably run 10-15 agent sessions
simultaneously, depending on agent CLI memory usage.

### Scaling Considerations

- **SSE streaming**: Very lightweight. 100+ simultaneous viewers per agent is fine.
- **Interactive terminals**: Each interactive session creates a node-pty instance and
  tmux client. Keep to 5-10 simultaneous interactive connections.
- **WebSocket server**: The `ws` library handles thousands of connections. The bottleneck
  is PTY count, not WebSocket count.

### Flow Control Thresholds

| Parameter | Recommended Value | Rationale |
|-----------|------------------|-----------|
| Write buffer high watermark | 500 KB | Keeps keystroke latency <100ms |
| Write buffer low watermark | 100 KB | Resume before buffer empties |
| ACK callback interval | 100 KB | Reduce callback overhead |
| WebSocket message size limit | 64 KB | Prevent memory spikes |
| Scrollback lines | 5,000 | Balance between history and memory |
| Heartbeat interval | 25 seconds | Detect dead connections |
| Reconnect max attempts | 10 | With exponential backoff up to 30s |

### xterm.js Renderer Selection

| Renderer | Speed | GPU Required | Fallback |
|----------|-------|-------------|----------|
| WebGL | Fastest (up to 900% faster) | Yes (WebGL2) | Canvas/DOM |
| Canvas | Medium | No | DOM |
| DOM | Slowest but most compatible | No | N/A |

**Strategy**: Try WebGL first, catch errors, fall back to DOM. Canvas is deprecated in v6.

---

## 11. Security Checklist

### Pre-Deployment

- [ ] Terminal WebSocket server on separate port from web app
- [ ] JWT tokens for WebSocket authentication (short-lived: 15 min)
- [ ] Token generation only via authenticated Next.js API route
- [ ] WSS (WebSocket Secure) in production -- never plain WS
- [ ] Origin header validation on WebSocket upgrade
- [ ] Rate limiting on terminal input (10KB/s max)
- [ ] Maximum message size enforcement (64KB)
- [ ] tmux prefix key disabled in agent sessions
- [ ] Input filtering for dangerous escape sequences

### Operational

- [ ] Audit logging for all terminal connections and disconnections
- [ ] Audit logging for terminal input events (length only, not content)
- [ ] Session timeout -- auto-disconnect idle interactive sessions (30 min)
- [ ] Maximum concurrent interactive sessions per user (3)
- [ ] Health check endpoint for terminal WS server
- [ ] Graceful shutdown -- close all WebSockets before process exit

### Defense in Depth

- [ ] Read-only mode available (viewer role with no write permission)
- [ ] Per-session permissions (user A can only access their own agents)
- [ ] No direct shell spawning -- only tmux attach to existing sessions
- [ ] Environment variable filtering -- strip secrets from tmux env
- [ ] Terminal WS server runs as non-root user
- [ ] Log rotation for pipe-pane output files

---

## 12. Package Reference

### Core Packages

| Package | Version | Purpose | Link |
|---------|---------|---------|------|
| `@xterm/xterm` | 6.0.0 | Terminal emulator | https://www.npmjs.com/package/@xterm/xterm |
| `@xterm/addon-fit` | 0.10.0 | Auto-resize terminal | https://www.npmjs.com/package/@xterm/addon-fit |
| `@xterm/addon-web-links` | 0.12.0 | Clickable URLs | https://www.npmjs.com/package/@xterm/addon-web-links |
| `@xterm/addon-search` | 0.15.0 | Search buffer | https://www.npmjs.com/package/@xterm/addon-search |
| `@xterm/addon-webgl` | 0.19.0 | GPU renderer | https://www.npmjs.com/package/@xterm/addon-webgl |
| `@xterm/addon-serialize` | 0.14.0 | State serialization | https://www.npmjs.com/package/@xterm/addon-serialize |
| `node-pty` | 1.1.0 | Pseudo-terminal | https://www.npmjs.com/package/node-pty |
| `ws` | 8.x | WebSocket server | https://www.npmjs.com/package/ws |
| `next-ws` | 2.1.16 | Next.js WS routes | https://www.npmjs.com/package/next-ws |

### CSS Import

```typescript
// Must import xterm CSS in your component or layout
import '@xterm/xterm/css/xterm.css';
```

### tmux Version Requirement

tmux 3.0+ recommended for control mode features. Check with `tmux -V`.

---

## 13. Sources

### Official Documentation
- xterm.js official site: https://xtermjs.org/
- xterm.js API -- ITerminalOptions: https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
- xterm.js API -- ITheme: https://xtermjs.org/docs/api/terminal/interfaces/itheme/
- xterm.js Flow Control Guide: https://xtermjs.org/docs/guides/flowcontrol/
- xterm.js Security Guide: https://xtermjs.org/docs/guides/security/
- xterm.js GitHub Releases: https://github.com/xtermjs/xterm.js/releases
- node-pty GitHub: https://github.com/microsoft/node-pty
- node-pty TypeScript Definitions: https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts
- node-pty API (jsDocs): https://www.jsdocs.io/package/node-pty
- tmux Control Mode Wiki: https://github.com/tmux/tmux/wiki/Control-Mode
- tmux Advanced Use Wiki: https://github.com/tmux/tmux/wiki/Advanced-Use
- tmux Man Page: https://man7.org/linux/man-pages/man1/tmux.1.html

### Next.js WebSocket Integration
- next-ws GitHub: https://github.com/apteryxxyz/next-ws
- Next.js WebSocket Discussion: https://github.com/vercel/next.js/discussions/58698
- Next.js + xterm.js Discussion: https://github.com/vercel/next.js/discussions/22409
- WebSockets with Next.js on Fly.io: https://fly.io/javascript-journal/websockets-with-nextjs/

### Web Terminal Projects
- ttyd: https://github.com/tsl0922/ttyd
- Wetty: https://github.com/butlerx/wetty
- GoTTY: https://github.com/yudai/gotty
- GoTTY (maintained fork): https://github.com/sorenisanerd/gotty

### AI Agent Terminal Managers
- Agent of Empires: https://github.com/njbrake/agent-of-empires
- Agent Deck: https://github.com/asheshgoplani/agent-deck

### Tutorials and Articles
- Web Terminal with xterm.js, node-pty and WebSockets: https://ashishpoudel.substack.com/p/web-terminal-with-xtermjs-node-pty
- Scalable node-pty with Socket.io: https://medium.com/@deysouvik700/efficient-and-scalable-usage-of-node-js-pty-with-socket-io-for-multiple-users-402851075c4a
- RWX Remote Debugger with Node and tmux: https://www.rwx.com/blog/implementing-a-remote-debugger-with-node-and-tmux
- VS Code Terminal Advanced Docs: https://code.visualstudio.com/docs/terminal/advanced
- VS Code Terminal Architecture (DeepWiki): https://deepwiki.com/microsoft/vscode/6.6-terminal-ui-and-layout
- tmux capture-pane Guide: https://tmuxai.dev/tmux-capture-pane/
- tmux pipe-pane Guide: https://tmuxai.dev/tmux-pipe-pane/
- tmux Session Logging (Baeldung): https://www.baeldung.com/linux/tmux-logging

### Security References
- WebSocket Authentication 2025: https://www.videosdk.live/developer-hub/websocket/websocket-authentication
- WebSocket Security Hardening: https://websocket.org/guides/security/
- JWT Security Best Practices: https://curity.io/resources/learn/jwt-best-practices/
- WebSocket Reconnection Logic: https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection-logic/view
- WebSocket Heartbeat Ping-Pong: https://oneuptime.com/blog/post/2026-01-24-websocket-heartbeat-ping-pong/view
- xterm.js Vulnerability (Teleport): https://goteleport.com/blog/xterm-js-vulnerability-affects-vs-code-users/

---

## Appendix A: Quick Start -- Minimal Working Prototype

The smallest possible prototype to prove the concept. ~100 lines total.

### Server (terminal-server.ts)

```typescript
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const wss = new WebSocketServer({ port: 3001 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, 'http://localhost:3001');
  const session = url.searchParams.get('session') || 'default';

  console.log(`Client connected to session: ${session}`);

  // Spawn tmux attach (or new session if it does not exist)
  // The -A flag means: attach if exists, otherwise create new
  const ptyProcess = pty.spawn('/usr/bin/tmux', [
    'new-session', '-A', '-s', session,
  ], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  // PTY output -> WebSocket
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  // WebSocket input -> PTY
  ws.on('message', (msg: Buffer) => {
    const data = msg.toString();
    if (data.startsWith('\x01resize:')) {
      const [cols, rows] = data.slice(8).split(',').map(Number);
      ptyProcess.resize(cols, rows);
    } else {
      ptyProcess.write(data);
    }
  });

  // Cleanup
  ptyProcess.onExit(() => ws.close());
  ws.on('close', () => ptyProcess.kill());
});

console.log('Terminal server on ws://localhost:3001');
```

### Client (components/terminal/QuickTerminal.tsx)

```typescript
'use client';

import { useEffect, useRef } from 'react';

export function QuickTerminal({ session }: { session: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      await import('@xterm/xterm/css/xterm.css');

      if (disposed || !ref.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        theme: { background: '#1a1b26', foreground: '#a9b1d6' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();

      const ws = new WebSocket(`ws://localhost:3001?session=${session}`);

      ws.onmessage = (e) => term.write(e.data);
      term.onData((data) => ws.send(data));
      term.onResize(({ cols, rows }) => {
        ws.send(`\x01resize:${cols},${rows}`);
      });

      const observer = new ResizeObserver(() => fit.fit());
      observer.observe(ref.current);

      return () => {
        observer.disconnect();
        ws.close();
        term.dispose();
      };
    })();

    return () => { disposed = true; };
  }, [session]);

  return <div ref={ref} style={{ width: '100%', height: '400px' }} />;
}
```

---

## Appendix B: Key Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Session backend | tmux | Only way to detach/reattach. Proven by Agent Deck, Agent of Empires |
| Terminal emulator | @xterm/xterm v6 | Industry standard. Used by VS Code, Jupyter, ttyd |
| PTY library | node-pty v1.1.0 | By Microsoft (VS Code team). Only maintained option for Node.js |
| WebSocket approach | Separate WS server (port 3001) | Crash isolation from Next.js. Can scale independently |
| Renderer | WebGL with DOM fallback | 900% faster than canvas. Canvas deprecated in v6 |
| Default mode | SSE (view-only) | Lightweight for most users. Interactive on-demand |
| Authentication | Short-lived JWT per session | 15-minute tokens. Generated via authenticated API |
| React wrapper | Custom (no library) | All wrapper libs lag behind xterm releases |
| Flow control | Watermark approach with custom ACKs | Per official xterm.js docs. Prevents buffer overflow |
| Input safety | Rate limiting + sequence filtering | Defense in depth for terminal access |
