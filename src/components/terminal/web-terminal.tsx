'use client';

import { useRef, useEffect, useState } from 'react';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';

interface WebTerminalProps {
  executionId: string;
  fontSize?: number;
  className?: string;
}

export function WebTerminal({ executionId, fontSize = 14, className }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    let terminal: import('@xterm/xterm').Terminal | null = null;
    let socket: import('socket.io-client').Socket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let fitAddon: import('@xterm/addon-fit').FitAddon | null = null;
    let disposed = false;

    async function init() {
      try {
        // Dynamic imports for SSR safety
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { io }] =
          await Promise.all([
            import('@xterm/xterm'),
            import('@xterm/addon-fit'),
            import('@xterm/addon-web-links'),
            import('@xterm/addon-search'),
            import('socket.io-client'),
          ]);

        if (disposed) return;

        // Inject xterm CSS
        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/_next/static/css/xterm.css';
          // Use a CDN fallback for the xterm CSS
          const style = document.createElement('style');
          style.id = 'xterm-css';
          style.textContent = `@import url('https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.min.css');`;
          document.head.appendChild(style);
        }

        // Create terminal
        terminal = new Terminal({
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

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());
        terminal.loadAddon(new SearchAddon());

        // Try WebGL addon for performance
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl');
          if (!disposed) {
            terminal.loadAddon(new WebglAddon());
          }
        } catch {
          // Canvas renderer fallback (default)
        }

        if (disposed || !containerRef.current) return;

        terminal.open(containerRef.current);
        fitAddon.fit();

        // Get terminal token
        const tokenResult = await apiFetch<ApiResponse<{ token: string }>>('/api/terminal/token', {
          method: 'POST',
          body: JSON.stringify({ executionId }),
        });

        if (disposed) return;

        // Connect socket.io
        const terminalServerUrl =
          typeof window !== 'undefined'
            ? `${window.location.protocol}//${window.location.hostname}:4101`
            : 'http://localhost:4101';

        socket = io(terminalServerUrl, {
          query: { token: tokenResult.data.token },
          transports: ['websocket'],
        });

        socket.on('connect', () => {
          if (!disposed) setIsConnecting(false);
        });

        socket.on('terminal:output', (data: string) => {
          terminal?.write(data);
        });

        socket.on('connect_error', (err) => {
          if (!disposed) setError(`Connection error: ${err.message}`);
        });

        socket.on('disconnect', (reason) => {
          if (!disposed && reason !== 'io client disconnect') {
            setError(`Disconnected: ${reason}`);
          }
        });

        // Send terminal input to server
        terminal.onData((data) => {
          socket?.emit('terminal:input', data);
        });

        // Handle resize
        resizeObserver = new ResizeObserver(() => {
          if (fitAddon && terminal) {
            fitAddon.fit();
            socket?.emit('terminal:resize', {
              cols: terminal.cols,
              rows: terminal.rows,
            });
          }
        });

        resizeObserver.observe(containerRef.current);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to initialize terminal');
          setIsConnecting(false);
        }
      }
    }

    init();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      socket?.disconnect();
      terminal?.dispose();
    };
  }, [executionId, fontSize]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border bg-[#1a1b26]', className)}>
      {isConnecting && !error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#1a1b26]">
          <span className="text-sm text-zinc-400">Connecting to terminal...</span>
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
