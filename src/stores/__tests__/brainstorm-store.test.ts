import { beforeEach, describe, expect, it } from 'vitest';
import { useBrainstormStore } from '../brainstorm-store';

describe('brainstorm-store participant errors', () => {
  const participantId1 = 'participant-1';
  const participantId2 = 'participant-2';
  const participantId3 = 'participant-3';

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
      participantId: participantId1,
      agentId: 'agent-1',
      agentName: 'Codex',
    });

    store.handleEvent({
      id: 2,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:status',
      participantId: participantId1,
      agentId: 'agent-1',
      agentName: 'Codex',
      status: 'timeout',
      error: 'usageLimitExceeded',
    });

    expect(useBrainstormStore.getState().participants.get(participantId1)?.error).toBe(
      'usageLimitExceeded',
    );

    useBrainstormStore.getState().handleEvent({
      id: 3,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:status',
      participantId: participantId1,
      agentId: 'agent-1',
      agentName: 'Codex',
      status: 'thinking',
      error: null,
    });

    expect(useBrainstormStore.getState().participants.get(participantId1)?.error).toBeNull();
  });

  it('preserves participant errors on participant:left events', () => {
    const store = useBrainstormStore.getState();

    store.handleEvent({
      id: 1,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:joined',
      participantId: participantId2,
      agentId: 'agent-2',
      agentName: 'Claude',
    });

    store.handleEvent({
      id: 2,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:left',
      participantId: participantId2,
      agentId: 'agent-2',
      agentName: 'Claude',
      error: 'Auth error: invalid API key',
    });

    const participant = useBrainstormStore.getState().participants.get(participantId2);
    expect(participant?.status).toBe('left');
    expect(participant?.error).toBe('Auth error: invalid API key');
  });

  it('tracks fallback activity and model updates from brainstorm events', () => {
    const store = useBrainstormStore.getState();

    store.handleEvent({
      id: 1,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:joined',
      participantId: participantId3,
      agentId: 'agent-3',
      agentName: 'Codex',
      model: 'o3',
    });

    store.handleEvent({
      id: 2,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:activity',
      participantId: participantId3,
      agentId: 'agent-3',
      description:
        'Automatic fallback: switching from o3 to gpt-4o after codex usage limit reached.',
    });

    store.handleEvent({
      id: 3,
      roomId: 'room-1',
      ts: Date.now(),
      type: 'participant:status',
      participantId: participantId3,
      agentId: 'agent-3',
      agentName: 'Codex',
      status: 'thinking',
      model: 'gpt-4o',
      error: null,
    });

    const participant = useBrainstormStore.getState().participants.get(participantId3);
    expect(participant?.activity).toContain('Automatic fallback');
    expect(participant?.model).toBe('gpt-4o');
    expect(participant?.status).toBe('thinking');
  });
});
