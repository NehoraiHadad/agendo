'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';

interface WebTerminalProps {
  executionId?: string;
  sessionId?: string;
  fontSize?: number;
  className?: string;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 5000;

export function WebTerminal({
  executionId,
  sessionId,
  fontSize = 14,
  className,
}: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);

  // Stable ref for reconnect state across closure boundaries
  const stateRef = useRef({
    disposed: false,
    ws: null as WebSocket | null,
    terminal: null as import('@xterm/xterm').Terminal | null,
    fitAddon: null as import('@xterm/addon-fit').FitAddon | null,
    resizeObserver: null as ResizeObserver | null,
    reconnectAttempt: 0,
    reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  });

  const connect = useCallback(
    async (
      terminal: import('@xterm/xterm').Terminal,
      fitAddon: import('@xterm/addon-fit').FitAddon,
    ) => {
      const state = stateRef.current;
      if (state.disposed) return;

      try {
        // Get fresh token for each connection attempt
        const tokenBody = sessionId ? { sessionId } : { executionId };
        const tokenResult = await apiFetch<ApiResponse<{ token: string }>>('/api/terminal/token', {
          method: 'POST',
          body: JSON.stringify(tokenBody),
        });

        if (state.disposed) return;

        const wsPort = process.env.NEXT_PUBLIC_TERMINAL_WS_PORT || '4101';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.hostname}:${wsPort}?token=${encodeURIComponent(tokenResult.data.token)}`;

        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        state.ws = ws;

        ws.onopen = () => {
          if (state.disposed) return;
          state.reconnectAttempt = 0;
          setIsConnecting(false);
          setReconnecting(false);
          setError(null);

          // Send current terminal size
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        };

        ws.onmessage = (ev: MessageEvent) => {
          if (state.disposed) return;

          if (ev.data instanceof ArrayBuffer) {
            // Binary frame = terminal output
            terminal.write(new Uint8Array(ev.data));
          } else if (typeof ev.data === 'string') {
            // Text frame = JSON control message
            try {
              const msg = JSON.parse(ev.data) as { type: string; message?: string };
              if (msg.type === 'error') {
                setError(msg.message ?? 'Unknown error');
              }
            } catch {
              // Not JSON — ignore
            }
          }
        };

        ws.onclose = (ev: CloseEvent) => {
          if (state.disposed) return;
          state.ws = null;

          // Auth failures — don't retry
          if (ev.code === 4001 || ev.code === 4003) {
            setError(`Authentication failed`);
            setReconnecting(false);
            return;
          }

          // Attempt reconnection
          if (state.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            state.reconnectAttempt++;
            const delay = Math.min(
              RECONNECT_BASE_DELAY * Math.pow(1.5, state.reconnectAttempt - 1),
              RECONNECT_MAX_DELAY,
            );
            setReconnecting(true);
            terminal.write('\r\n\x1b[33m[Reconnecting...]\x1b[0m\r\n');
            state.reconnectTimer = setTimeout(() => {
              if (!state.disposed) connect(terminal, fitAddon);
            }, delay);
          } else {
            setReconnecting(false);
            setError('Connection lost — reload to retry');
          }
        };

        ws.onerror = () => {
          // onclose will fire after this — reconnection handled there
        };
      } catch (err) {
        if (!state.disposed) {
          if (state.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            state.reconnectAttempt++;
            const delay = Math.min(
              RECONNECT_BASE_DELAY * Math.pow(1.5, state.reconnectAttempt - 1),
              RECONNECT_MAX_DELAY,
            );
            setReconnecting(true);
            state.reconnectTimer = setTimeout(() => {
              if (!state.disposed) connect(terminal, fitAddon);
            }, delay);
          } else {
            setError(err instanceof Error ? err.message : 'Failed to connect');
            setReconnecting(false);
            setIsConnecting(false);
          }
        }
      }
    },
    [executionId, sessionId],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const state = stateRef.current;
    state.disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
        ]);

        if (state.disposed) return;

        // Inject xterm CSS
        if (!document.getElementById('xterm-css')) {
          const style = document.createElement('style');
          style.id = 'xterm-css';
          style.textContent = `@import url('https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.min.css');`;
          document.head.appendChild(style);
        }

        const terminal = new Terminal({
          fontSize,
          fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
          theme: {
            background: '#1a1b26',
            foreground: '#a9b1d6',
            cursor: '#c0caf5',
            selectionBackground: '#33467c',
          },
          cursorBlink: true,
          allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());
        terminal.loadAddon(new SearchAddon());
        state.terminal = terminal;
        state.fitAddon = fitAddon;

        // Try WebGL addon for performance
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl');
          if (!state.disposed) {
            terminal.loadAddon(new WebglAddon());
          }
        } catch {
          // Canvas renderer fallback (default)
        }

        if (state.disposed || !containerRef.current) return;

        terminal.open(containerRef.current);
        fitAddon.fit();

        // Send terminal input as binary frames
        terminal.onData((data) => {
          if (state.ws?.readyState === WebSocket.OPEN) {
            state.ws.send(new TextEncoder().encode(data));
          }
        });

        // Handle resize
        const resizeObserver = new ResizeObserver(() => {
          if (fitAddon && terminal) {
            fitAddon.fit();
            if (state.ws?.readyState === WebSocket.OPEN) {
              state.ws.send(
                JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }),
              );
            }
          }
        });

        resizeObserver.observe(containerRef.current);
        state.resizeObserver = resizeObserver;

        // Connect
        await connect(terminal, fitAddon);
      } catch (err) {
        if (!state.disposed) {
          setError(err instanceof Error ? err.message : 'Failed to initialize terminal');
          setIsConnecting(false);
        }
      }
    }

    init();

    return () => {
      state.disposed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.resizeObserver?.disconnect();
      state.ws?.close();
      state.terminal?.dispose();
      state.ws = null;
      state.terminal = null;
      state.fitAddon = null;
      state.resizeObserver = null;
      state.reconnectAttempt = 0;
    };
  }, [executionId, sessionId, fontSize, connect]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border bg-[#1a1b26]', className)}>
      {isConnecting && !error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#1a1b26]">
          <span className="text-sm text-zinc-400">Connecting to terminal...</span>
        </div>
      )}
      {reconnecting && !error && (
        <div className="absolute right-3 top-3 z-10 rounded bg-yellow-900/80 px-2 py-1">
          <span className="text-xs text-yellow-300">Reconnecting...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#1a1b26]">
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
