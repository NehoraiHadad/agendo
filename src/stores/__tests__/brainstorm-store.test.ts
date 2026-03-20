import { beforeEach, describe, expect, it } from 'vitest';
import { useBrainstormStore } from '../brainstorm-store';

describe('brainstorm-store participant errors', () => {
  beforeEach(() => {
    useBrainstormStore.getState().reset();
  });

  it('stores participant errors from status events and clears them on thinking', () => {
    const store = useBrainstormStore.getState();

    store.handleEvent({
      id: 1,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:joined',
      agentId: 'agent-1',
      agentName: 'Codex',
    });

    store.handleEvent({
      id: 2,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:status',
      agentId: 'agent-1',
      agentName: 'Codex',
      status: 'timeout',
      error: 'usageLimitExceeded',
    });

    expect(useBrainstormStore.getState().participants.get('agent-1')?.error).toBe(
      'usageLimitExceeded',
    );

    useBrainstormStore.getState().handleEvent({
      id: 3,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:status',
      agentId: 'agent-1',
      agentName: 'Codex',
      status: 'thinking',
      error: null,
    });

    expect(useBrainstormStore.getState().participants.get('agent-1')?.error).toBeNull();
  });

  it('preserves participant errors on participant:left events', () => {
    const store = useBrainstormStore.getState();

    store.handleEvent({
      id: 1,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:joined',
      agentId: 'agent-2',
      agentName: 'Claude',
    });

    store.handleEvent({
      id: 2,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:left',
      agentId: 'agent-2',
      agentName: 'Claude',
      error: 'Auth error: invalid API key',
    });

    const participant = useBrainstormStore.getState().participants.get('agent-2');
    expect(participant?.status).toBe('left');
    expect(participant?.error).toBe('Auth error: invalid API key');
  });
});
