import { beforeEach, describe, expect, it } from 'vitest';
import { useBrainstormStore, messageKey } from '../brainstorm-store';
import type { BrainstormEvent } from '@/lib/realtime/event-types';

// ============================================================================
// Helpers
// ============================================================================

function makeMessage(
  overrides: Partial<BrainstormEvent & { type: 'message' }> = {},
): BrainstormEvent {
  return {
    id: 1,
    roomId: 'room-1',
    ts: Date.now(),
    type: 'message',
    wave: 0,
    senderType: 'agent',
    agentId: 'agent-1',
    agentName: 'Claude',
    content: 'Hello world',
    isPass: false,
    ...overrides,
  } as BrainstormEvent;
}

function makeParticipantJoined(
  participantId: string,
  agentId: string,
  agentName: string,
): BrainstormEvent {
  return {
    id: 0,
    roomId: 'room-1',
    ts: Date.now(),
    type: 'participant:joined',
    participantId,
    agentId,
    agentName,
  } as BrainstormEvent;
}

function makeParticipantStatus(
  participantId: string,
  agentId: string,
  agentName: string,
  status: 'thinking' | 'done' | 'passed' | 'timeout' | 'evicted',
  extra: Record<string, unknown> = {},
): BrainstormEvent {
  return {
    id: 0,
    roomId: 'room-1',
    ts: Date.now(),
    type: 'participant:status',
    participantId,
    agentId,
    agentName,
    status,
    ...extra,
  } as BrainstormEvent;
}

// ============================================================================
// Tests
// ============================================================================

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

// ============================================================================
// messageKey
// ============================================================================

describe('messageKey', () => {
  it('produces unique keys for different messages', () => {
    const a = messageKey({
      wave: 0,
      senderType: 'agent',
      agentId: 'a1',
      content: 'hi',
      isPass: false,
    });
    const b = messageKey({
      wave: 0,
      senderType: 'agent',
      agentId: 'a2',
      content: 'hi',
      isPass: false,
    });
    const c = messageKey({
      wave: 1,
      senderType: 'agent',
      agentId: 'a1',
      content: 'hi',
      isPass: false,
    });
    const d = messageKey({
      wave: 0,
      senderType: 'agent',
      agentId: 'a1',
      content: 'hi',
      isPass: true,
    });

    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('produces the same key for identical messages', () => {
    const a = messageKey({
      wave: 0,
      senderType: 'agent',
      agentId: 'a1',
      content: 'hello',
      isPass: false,
    });
    const b = messageKey({
      wave: 0,
      senderType: 'agent',
      agentId: 'a1',
      content: 'hello',
      isPass: false,
    });
    expect(a).toBe(b);
  });

  it('handles missing agentId', () => {
    const a = messageKey({ wave: 0, senderType: 'user', content: 'steer', isPass: false });
    const b = messageKey({ wave: 0, senderType: 'user', content: 'steer', isPass: false });
    expect(a).toBe(b);
  });
});

// ============================================================================
// handleEventBatch
// ============================================================================

describe('handleEventBatch', () => {
  beforeEach(() => {
    useBrainstormStore.getState().reset();
  });

  it('processes multiple events in a single batch', () => {
    const events: BrainstormEvent[] = [
      makeParticipantJoined('p1', 'agent-1', 'Claude'),
      makeParticipantJoined('p2', 'agent-2', 'Gemini'),
      {
        id: 1,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:start',
        wave: 0,
      } as BrainstormEvent,
      makeParticipantStatus('p1', 'agent-1', 'Claude', 'thinking'),
      makeParticipantStatus('p2', 'agent-2', 'Gemini', 'thinking'),
      makeMessage({
        id: 2,
        wave: 0,
        agentId: 'agent-1',
        agentName: 'Claude',
        participantId: 'p1',
        content: 'Response 1',
      }),
      makeMessage({
        id: 3,
        wave: 0,
        agentId: 'agent-2',
        agentName: 'Gemini',
        participantId: 'p2',
        content: 'Response 2',
      }),
      makeParticipantStatus('p1', 'agent-1', 'Claude', 'done'),
      makeParticipantStatus('p2', 'agent-2', 'Gemini', 'done'),
      {
        id: 4,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:complete',
        wave: 0,
      } as BrainstormEvent,
    ];

    useBrainstormStore.getState().handleEventBatch(events);

    const state = useBrainstormStore.getState();
    expect(state.participants.size).toBe(2);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toBe('Response 1');
    expect(state.messages[1].content).toBe('Response 2');
    expect(state.currentWave).toBe(0);
    expect(state.streamingText.size).toBe(0);
  });

  it('deduplicates messages with O(1) Set lookup', () => {
    const msg = makeMessage({ id: 1, content: 'Duplicate test' });

    useBrainstormStore.getState().handleEventBatch([msg, msg, msg]);

    expect(useBrainstormStore.getState().messages).toHaveLength(1);
  });

  it('deduplicates across sequential batches', () => {
    const msg = makeMessage({ id: 1, content: 'Same message' });

    useBrainstormStore.getState().handleEventBatch([msg]);
    useBrainstormStore.getState().handleEventBatch([msg]);

    expect(useBrainstormStore.getState().messages).toHaveLength(1);
  });

  it('produces identical state to sequential handleEvent calls', () => {
    const events: BrainstormEvent[] = [
      makeParticipantJoined('p1', 'agent-1', 'Claude'),
      makeParticipantJoined('p2', 'agent-2', 'Gemini'),
      {
        id: 1,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'room:state',
        status: 'active',
      } as BrainstormEvent,
      {
        id: 2,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:start',
        wave: 0,
      } as BrainstormEvent,
      makeMessage({
        id: 3,
        wave: 0,
        agentId: 'agent-1',
        agentName: 'Claude',
        participantId: 'p1',
        content: 'Msg A',
      }),
      makeMessage({
        id: 4,
        wave: 0,
        agentId: 'agent-2',
        agentName: 'Gemini',
        participantId: 'p2',
        content: 'Msg B',
      }),
      {
        id: 5,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:complete',
        wave: 0,
      } as BrainstormEvent,
      {
        id: 6,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:start',
        wave: 1,
      } as BrainstormEvent,
      makeMessage({
        id: 7,
        wave: 1,
        agentId: 'agent-1',
        agentName: 'Claude',
        participantId: 'p1',
        content: 'Msg C',
      }),
      {
        id: 8,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:quality',
        wave: 0,
        score: {
          wave: 0,
          newIdeasCount: 5,
          avgResponseLength: 100,
          repeatRatio: 0.1,
          passCount: 0,
          agreementRatio: 0.3,
        },
      } as BrainstormEvent,
      {
        id: 9,
        roomId: 'room-1',
        ts: Date.now(),
        type: 'wave:reflection',
        wave: 1,
      } as BrainstormEvent,
    ];

    // Process sequentially
    for (const event of events) {
      useBrainstormStore.getState().handleEvent(event);
    }
    const seqState = useBrainstormStore.getState();
    const seqSnapshot = {
      status: seqState.status,
      currentWave: seqState.currentWave,
      messages: seqState.messages.map((m) => ({ wave: m.wave, content: m.content })),
      participantCount: seqState.participants.size,
      qualityScoreCount: seqState.waveQualityScores.size,
      reflectionWaveCount: seqState.reflectionWaves.size,
    };

    // Reset and process as batch
    useBrainstormStore.getState().reset();
    useBrainstormStore.getState().handleEventBatch(events);
    const batchState = useBrainstormStore.getState();
    const batchSnapshot = {
      status: batchState.status,
      currentWave: batchState.currentWave,
      messages: batchState.messages.map((m) => ({ wave: m.wave, content: m.content })),
      participantCount: batchState.participants.size,
      qualityScoreCount: batchState.waveQualityScores.size,
      reflectionWaveCount: batchState.reflectionWaves.size,
    };

    expect(batchSnapshot).toEqual(seqSnapshot);
  });

  it('handles empty batch without errors', () => {
    const stateBefore = useBrainstormStore.getState().status;
    useBrainstormStore.getState().handleEventBatch([]);
    expect(useBrainstormStore.getState().status).toBe(stateBefore);
  });

  it('single-event batch delegates to handleEvent', () => {
    const msg = makeMessage({ id: 1, content: 'Single event' });
    useBrainstormStore.getState().handleEventBatch([msg]);
    expect(useBrainstormStore.getState().messages).toHaveLength(1);
  });

  it('handles room:converged and room:max-waves in batch', () => {
    useBrainstormStore
      .getState()
      .handleEventBatch([
        { id: 1, roomId: 'r', ts: Date.now(), type: 'room:converged', wave: 3 } as BrainstormEvent,
      ]);
    expect(useBrainstormStore.getState().converged).toBe(true);
    expect(useBrainstormStore.getState().status).toBe('paused');

    useBrainstormStore.getState().reset();
    useBrainstormStore
      .getState()
      .handleEventBatch([
        { id: 1, roomId: 'r', ts: Date.now(), type: 'room:max-waves', wave: 5 } as BrainstormEvent,
      ]);
    expect(useBrainstormStore.getState().maxWavesReached).toBe(true);
  });

  it('handles synthesis in batch', () => {
    useBrainstormStore
      .getState()
      .handleEventBatch([
        {
          id: 1,
          roomId: 'r',
          ts: Date.now(),
          type: 'room:synthesis',
          synthesis: '## Summary\nDone',
        } as BrainstormEvent,
      ]);
    expect(useBrainstormStore.getState().synthesis).toBe('## Summary\nDone');
  });

  it('handles message:delta accumulation in batch', () => {
    useBrainstormStore
      .getState()
      .handleEventBatch([
        makeParticipantJoined('p1', 'agent-1', 'Claude'),
        {
          id: 1,
          roomId: 'r',
          ts: Date.now(),
          type: 'message:delta',
          participantId: 'p1',
          agentId: 'agent-1',
          text: 'Hello ',
        } as BrainstormEvent,
        {
          id: 2,
          roomId: 'r',
          ts: Date.now(),
          type: 'message:delta',
          participantId: 'p1',
          agentId: 'agent-1',
          text: 'world',
        } as BrainstormEvent,
      ]);
    expect(useBrainstormStore.getState().streamingText.get('p1')).toBe('Hello world');
  });

  it('clears streaming text when final message arrives in same batch', () => {
    useBrainstormStore
      .getState()
      .handleEventBatch([
        makeParticipantJoined('p1', 'agent-1', 'Claude'),
        {
          id: 1,
          roomId: 'r',
          ts: Date.now(),
          type: 'message:delta',
          participantId: 'p1',
          agentId: 'agent-1',
          text: 'Draft...',
        } as BrainstormEvent,
        makeMessage({
          id: 2,
          wave: 0,
          participantId: 'p1',
          agentId: 'agent-1',
          agentName: 'Claude',
          content: 'Final message',
        }),
      ]);
    const state = useBrainstormStore.getState();
    expect(state.streamingText.has('p1')).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('Final message');
  });
});

// ============================================================================
// handleEvent O(1) dedup (regression tests)
// ============================================================================

describe('handleEvent O(1) dedup', () => {
  beforeEach(() => {
    useBrainstormStore.getState().reset();
  });

  it('rejects duplicate messages via Set-based dedup', () => {
    const msg = makeMessage({ id: 1, content: 'No duplicates' });
    useBrainstormStore.getState().handleEvent(msg);
    useBrainstormStore.getState().handleEvent(msg);
    expect(useBrainstormStore.getState().messages).toHaveLength(1);
  });

  it('allows different messages with same wave but different content', () => {
    useBrainstormStore
      .getState()
      .handleEvent(makeMessage({ id: 1, wave: 0, agentId: 'a1', content: 'Msg 1' }));
    useBrainstormStore
      .getState()
      .handleEvent(makeMessage({ id: 2, wave: 0, agentId: 'a1', content: 'Msg 2' }));
    expect(useBrainstormStore.getState().messages).toHaveLength(2);
  });

  it('allows same content from different agents', () => {
    useBrainstormStore
      .getState()
      .handleEvent(makeMessage({ id: 1, wave: 0, agentId: 'a1', content: 'Same text' }));
    useBrainstormStore
      .getState()
      .handleEvent(makeMessage({ id: 2, wave: 0, agentId: 'a2', content: 'Same text' }));
    expect(useBrainstormStore.getState().messages).toHaveLength(2);
  });

  it('dedup survives across handleEvent and handleEventBatch', () => {
    const msg = makeMessage({ id: 1, content: 'Cross-method dedup' });
    useBrainstormStore.getState().handleEvent(msg);
    useBrainstormStore.getState().handleEventBatch([msg]);
    expect(useBrainstormStore.getState().messages).toHaveLength(1);
  });
});

// ============================================================================
// Performance benchmark (informational, not a hard assertion)
// ============================================================================

describe('performance: handleEventBatch vs sequential handleEvent', () => {
  beforeEach(() => {
    useBrainstormStore.getState().reset();
  });

  it('batch is faster than sequential for 200 messages', () => {
    const N = 200;

    // Build a realistic event sequence
    const events: BrainstormEvent[] = [
      makeParticipantJoined('p1', 'agent-1', 'Claude'),
      makeParticipantJoined('p2', 'agent-2', 'Gemini'),
    ];
    for (let i = 0; i < N; i++) {
      const wave = Math.floor(i / 4);
      if (i % 4 === 0) {
        events.push({
          id: events.length,
          roomId: 'r',
          ts: Date.now(),
          type: 'wave:start',
          wave,
        } as BrainstormEvent);
      }
      events.push(
        makeMessage({
          id: events.length,
          wave,
          agentId: i % 2 === 0 ? 'agent-1' : 'agent-2',
          agentName: i % 2 === 0 ? 'Claude' : 'Gemini',
          participantId: i % 2 === 0 ? 'p1' : 'p2',
          content: `Message ${i}: ${'x'.repeat(100)}`,
        }),
      );
    }

    // Measure sequential
    useBrainstormStore.getState().reset();
    const seqStart = performance.now();
    for (const event of events) {
      useBrainstormStore.getState().handleEvent(event);
    }
    const seqTime = performance.now() - seqStart;
    const seqMsgCount = useBrainstormStore.getState().messages.length;

    // Measure batch
    useBrainstormStore.getState().reset();
    const batchStart = performance.now();
    useBrainstormStore.getState().handleEventBatch(events);
    const batchTime = performance.now() - batchStart;
    const batchMsgCount = useBrainstormStore.getState().messages.length;

    // Both should produce the same number of messages
    expect(batchMsgCount).toBe(seqMsgCount);
    expect(batchMsgCount).toBe(N);

    // Log timing for informational purposes
    console.log(
      `Sequential: ${seqTime.toFixed(2)}ms, Batch: ${batchTime.toFixed(2)}ms, Speedup: ${(seqTime / batchTime).toFixed(1)}x`,
    );

    // Batch should generally be faster (not a hard requirement in CI)
    // The main win is fewer set() calls = fewer React re-renders
  });
});
