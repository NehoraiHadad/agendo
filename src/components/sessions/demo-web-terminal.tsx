'use client';

/**
 * DemoWebTerminal — xterm.js terminal that replays a pre-recorded frame array
 * instead of opening a WebSocket connection to port 4101.
 *
 * Drop-in replacement for <WebTerminal> when NEXT_PUBLIC_DEMO_MODE=true.
 * Accepts a superset of WebTerminal's props so the parent site works unchanged.
 */

import { useRef, useEffect, useState, useCallback, type JSX } from 'react';
import { cn } from '@/lib/utils';
import { DEMO_TERMINAL_FRAMES } from '@/lib/demo/fixtures/terminals/index';
import { scheduleFrames, type FrameScheduler } from '@/lib/demo/terminal-scheduler';
import type { TerminalFrame } from '@/lib/demo/terminal-scheduler';

export type { TerminalFrame };

export interface DemoWebTerminalProps {
  /** Used to pick which fixture arc to play. */
  sessionId?: string;
  /** Matches WebTerminal's optional executionId — unused in demo mode. */
  executionId?: string;
  /** Optional override; if not provided, resolved via sessionId → DEMO_TERMINAL_FRAMES. */
  frames?: TerminalFrame[];
  /** Speed multiplier on atMs gaps. Default 1.0. */
  speed?: number;
  /** Called when replay completes naturally. */
  onComplete?: () => void;
  /** Font size forwarded to the Terminal instance (matches WebTerminal). */
  fontSize?: number;
  /** CSS class forwarded to the outer wrapper. */
  className?: string;
}

export function DemoWebTerminal({
  sessionId,
  executionId: _executionId,
  frames: framesProp,
  speed = 1.0,
  onComplete,
  fontSize = 14,
  className,
}: DemoWebTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const schedulerRef = useRef<FrameScheduler | null>(null);
  const [replayCount, setReplayCount] = useState(0);
  const [isDone, setIsDone] = useState(false);

  // Resolve frames: explicit prop wins, otherwise look up by sessionId
  const frames: TerminalFrame[] | undefined =
    framesProp ?? (sessionId ? DEMO_TERMINAL_FRAMES[sessionId] : undefined);

  // Stable ref so the effect sees the latest callbacks without re-running
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const handleComplete = useCallback(() => {
    setIsDone(true);
    onCompleteRef.current?.();
  }, []);

  // Terminal setup + initial playback
  useEffect(() => {
    // SSR guard — xterm requires DOM
    if (typeof window === 'undefined') return;
    if (!containerRef.current) return;

    const resolved = framesRef.current;
    // No frames → render placeholder, do not mount xterm
    if (!resolved || resolved.length === 0) return;

    const container = containerRef.current;
    let disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        if (disposed) return;

        // Inject xterm CSS once per page load
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
        terminal.open(container);
        fitAddon.fit();

        const resizeObserver = new ResizeObserver(() => {
          fitAddon.fit();
        });
        resizeObserver.observe(container);

        function startPlayback() {
          schedulerRef.current?.cancel();
          const current = framesRef.current ?? [];
          schedulerRef.current = scheduleFrames({
            frames: current,
            write: (data) => terminal.write(data),
            speed: speedRef.current,
            onComplete: handleComplete,
          });
        }

        startPlayback();

        // Expose a function the replay button can call
        // Store terminal + resizeObserver on a ref for cleanup and for the
        // replay button handler (which is set up outside this closure).
        stateRef.current = { terminal, fitAddon, resizeObserver, startPlayback, disposed: false };
      } catch {
        // init failed — silently ignore (component shows nothing, which is fine in demo)
      }
    }

    void init();

    return () => {
      disposed = true;
      stateRef.current.disposed = true;
      schedulerRef.current?.cancel();
      schedulerRef.current = null;
      stateRef.current.resizeObserver?.disconnect();
      stateRef.current.terminal?.dispose();
      stateRef.current.terminal = null;
      stateRef.current.resizeObserver = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally once — replayCount triggers the replay button path below

  // Internal mutable state for the terminal instance (not React state — avoids re-renders)
  const stateRef = useRef<{
    terminal: import('@xterm/xterm').Terminal | null;
    fitAddon: import('@xterm/addon-fit').FitAddon | null;
    resizeObserver: ResizeObserver | null;
    startPlayback: (() => void) | null;
    disposed: boolean;
  }>({
    terminal: null,
    fitAddon: null,
    resizeObserver: null,
    startPlayback: null,
    disposed: false,
  });

  // Replay button handler — triggered by replayCount > 0 increments
  useEffect(() => {
    if (replayCount === 0) return;
    const { terminal, startPlayback } = stateRef.current;
    if (!terminal || !startPlayback) return;
    setIsDone(false);
    terminal.reset();
    terminal.clear();
    startPlayback();
  }, [replayCount]);

  const handleReplay = useCallback(() => {
    setReplayCount((c) => c + 1);
  }, []);

  // No frames resolved — render placeholder without mounting xterm
  if (!frames || frames.length === 0) {
    return (
      <div
        className={cn(
          'relative overflow-hidden rounded-lg border border-white/[0.06] bg-[#1a1b26] flex items-center justify-center',
          className,
        )}
      >
        <span className="text-sm text-zinc-500">No terminal replay for this session</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-white/[0.06] bg-[#1a1b26]',
        className,
      )}
    >
      {/* Replay button overlay — top-right corner */}
      <button
        type="button"
        onClick={handleReplay}
        className="absolute right-2 top-2 z-10 rounded border border-zinc-600 bg-zinc-800/80 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700 active:bg-zinc-600 backdrop-blur-sm transition-colors"
        title="Replay terminal recording"
      >
        &#9654; Replay
      </button>

      {/* "Demo complete" overlay — shown after last frame fires */}
      {isDone && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-end pb-4 pointer-events-none">
          <div className="rounded border border-zinc-700/60 bg-zinc-900/70 px-3 py-1.5 backdrop-blur-sm">
            <span className="text-xs text-zinc-400">Demo terminal — click &#9654; to replay</span>
          </div>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
