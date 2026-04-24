/**
 * Tests for DemoWebTerminal frame scheduler logic.
 *
 * We test the pure scheduling module directly (no DOM / React rendering required),
 * keeping vitest in node environment and avoiding @testing-library/react which is
 * not installed.
 *
 * The scheduler module is extracted to src/lib/demo/terminal-scheduler.ts and
 * tested in full isolation with fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleFrames, type TerminalFrame } from '@/lib/demo/terminal-scheduler';

describe('scheduleFrames', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls write for each frame in order', () => {
    const writes: string[] = [];
    const write = (data: string) => writes.push(data);

    const frames: TerminalFrame[] = [
      { atMs: 0, data: 'frame0\r\n' },
      { atMs: 100, data: 'frame1\r\n' },
      { atMs: 200, data: 'frame2\r\n' },
    ];

    const scheduler = scheduleFrames({ frames, write, speed: 1.0 });

    // t=0: frame0 fires immediately
    vi.advanceTimersByTime(0);
    expect(writes).toEqual(['frame0\r\n']);

    // t=100: frame1 fires
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(['frame0\r\n', 'frame1\r\n']);

    // t=200: frame2 fires
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(['frame0\r\n', 'frame1\r\n', 'frame2\r\n']);

    scheduler.cancel();
  });

  it('applies speed=2 — all 3 frames written by 100ms', () => {
    const writes: string[] = [];
    const write = (data: string) => writes.push(data);

    const frames: TerminalFrame[] = [
      { atMs: 0, data: 'a' },
      { atMs: 100, data: 'b' },
      { atMs: 200, data: 'c' },
    ];

    // speed=2 halves atMs so frame at 200ms fires at effective 100ms
    const scheduler = scheduleFrames({ frames, write, speed: 2.0 });

    vi.advanceTimersByTime(0);
    expect(writes).toEqual(['a']);

    vi.advanceTimersByTime(100);
    // All three should have fired (0ms, 50ms, 100ms effective)
    expect(writes).toEqual(['a', 'b', 'c']);

    scheduler.cancel();
  });

  it('cancel() clears pending timeouts — no writes after cancel', () => {
    const writes: string[] = [];
    const write = (data: string) => writes.push(data);

    const frames: TerminalFrame[] = [
      { atMs: 0, data: 'first' },
      { atMs: 100, data: 'second' },
      { atMs: 200, data: 'third' },
    ];

    const scheduler = scheduleFrames({ frames, write, speed: 1.0 });

    // Let first frame fire
    vi.advanceTimersByTime(0);
    expect(writes).toEqual(['first']);

    // Cancel before remaining frames fire
    scheduler.cancel();

    // Advance time — no more writes should happen
    vi.advanceTimersByTime(500);
    expect(writes).toEqual(['first']);
  });

  it('fires onComplete callback after last frame + 200ms', () => {
    const writes: string[] = [];
    const onComplete = vi.fn();

    const frames: TerminalFrame[] = [
      { atMs: 0, data: 'x' },
      { atMs: 50, data: 'y' },
    ];

    const scheduler = scheduleFrames({
      frames,
      write: (d) => writes.push(d),
      speed: 1.0,
      onComplete,
    });

    vi.advanceTimersByTime(50);
    expect(onComplete).not.toHaveBeenCalled();

    // Last frame at 50ms + 200ms grace = 250ms total
    vi.advanceTimersByTime(200);
    expect(onComplete).toHaveBeenCalledTimes(1);

    scheduler.cancel();
  });

  it('returns a scheduler with a restart() that resets writes', () => {
    const writes: string[] = [];
    const write = (data: string) => writes.push(data);

    const frames: TerminalFrame[] = [
      { atMs: 0, data: 'hello' },
      { atMs: 100, data: 'world' },
    ];

    const scheduler = scheduleFrames({ frames, write, speed: 1.0 });
    vi.advanceTimersByTime(100);
    expect(writes).toEqual(['hello', 'world']);

    // restart re-schedules from t=0
    writes.length = 0;
    scheduler.restart();

    vi.advanceTimersByTime(0);
    expect(writes).toEqual(['hello']);

    vi.advanceTimersByTime(100);
    expect(writes).toEqual(['hello', 'world']);

    scheduler.cancel();
  });

  it('empty frames array — onComplete fires at 200ms', () => {
    const onComplete = vi.fn();
    const scheduler = scheduleFrames({ frames: [], write: vi.fn(), speed: 1.0, onComplete });

    vi.advanceTimersByTime(199);
    expect(onComplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    scheduler.cancel();
  });
});

describe('TerminalFrame type', () => {
  it('has atMs and data fields', () => {
    const frame: TerminalFrame = { atMs: 42, data: '\x1b[32mhello\x1b[0m' };
    expect(frame.atMs).toBe(42);
    expect(frame.data).toBe('\x1b[32mhello\x1b[0m');
  });
});
