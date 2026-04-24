/**
 * Pure frame-scheduling logic for the demo terminal replay.
 *
 * Extracted from the React component so it can be tested in the node
 * vitest environment without any DOM or React dependencies.
 */

export interface TerminalFrame {
  /** Milliseconds from replay start when this frame should be written. */
  atMs: number;
  /** Raw ANSI-encoded bytes as a UTF-8 string. */
  data: string;
}

export interface ScheduleFramesOptions {
  frames: TerminalFrame[];
  /** Called with each frame's data at its scheduled time. */
  write: (data: string) => void;
  /** Speed multiplier applied to atMs gaps. Default 1.0. */
  speed?: number;
  /** Called after the last frame fires + 200 ms grace period. */
  onComplete?: () => void;
}

export interface FrameScheduler {
  /** Cancel all pending timeouts. Does nothing if already cancelled. */
  cancel: () => void;
  /** Cancel existing timeouts and reschedule all frames from t=0. */
  restart: () => void;
}

/**
 * Schedule all frames and return a controller for cancel / restart.
 *
 * Each frame is written via `options.write` at `frame.atMs / speed` ms.
 * After the last frame's effective time + 200 ms, `onComplete` is called.
 */
export function scheduleFrames(options: ScheduleFramesOptions): FrameScheduler {
  const { frames, write, speed = 1.0, onComplete } = options;
  let handles: ReturnType<typeof setTimeout>[] = [];

  function schedule(): void {
    handles = [];

    for (const frame of frames) {
      const delay = Math.round(frame.atMs / speed);
      const handle = setTimeout(() => {
        write(frame.data);
      }, delay);
      handles.push(handle);
    }

    // Fire onComplete 200ms after the last frame's effective time
    const lastMs = frames.length > 0 ? Math.round(frames[frames.length - 1].atMs / speed) : 0;
    const completionHandle = setTimeout(() => {
      onComplete?.();
    }, lastMs + 200);
    handles.push(completionHandle);
  }

  function cancel(): void {
    for (const h of handles) {
      clearTimeout(h);
    }
    handles = [];
  }

  function restart(): void {
    cancel();
    schedule();
  }

  schedule();

  return { cancel, restart };
}
