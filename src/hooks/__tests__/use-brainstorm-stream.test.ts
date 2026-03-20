import { describe, expect, it } from 'vitest';
import { shouldCloseBrainstormStream } from '../use-brainstorm-stream';
import type { BrainstormEvent } from '@/lib/realtime/event-types';

describe('shouldCloseBrainstormStream', () => {
  it('does not close on the synthetic ended snapshot event', () => {
    const event: BrainstormEvent = {
      id: 0,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'room:state',
      status: 'ended',
    };

    expect(shouldCloseBrainstormStream(event)).toBe(false);
  });

  it('closes on a persisted ended room:state event', () => {
    const event: BrainstormEvent = {
      id: 42,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'room:state',
      status: 'ended',
    };

    expect(shouldCloseBrainstormStream(event)).toBe(true);
  });

  it('does not close on non-terminal brainstorm events', () => {
    const event: BrainstormEvent = {
      id: 42,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'room:synthesis',
      synthesis: 'done',
    };

    expect(shouldCloseBrainstormStream(event)).toBe(false);
  });
});
