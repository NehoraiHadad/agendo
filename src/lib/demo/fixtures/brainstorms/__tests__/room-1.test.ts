/**
 * Tests for the brainstorm room-1 fixture arc.
 * Verifies event ordering, shape, wave bracketing, and synthesis presence.
 */

import { describe, it, expect } from 'vitest';

import { room1Events } from '../room-1';
import { DEMO_BRAINSTORM_ROOMS } from '../index';
import type { BrainstormReplayableEvent } from '../room-1';
import {
  DEMO_BRAINSTORM_ROOM_ID,
  DEMO_PARTICIPANT_CLAUDE_ID,
  DEMO_PARTICIPANT_CODEX_ID,
  DEMO_PARTICIPANT_GEMINI_ID,
} from '@/lib/services/brainstorm-service.demo';

const ROOM_ID = DEMO_BRAINSTORM_ROOM_ID;

describe('brainstorm fixture: room-1 (Design session reconnect strategy)', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(room1Events)).toBe(true);
    expect(room1Events.length).toBeGreaterThan(0);
  });

  it('events are in chronological (atMs) order', () => {
    for (let i = 1; i < room1Events.length; i++) {
      expect(room1Events[i].atMs).toBeGreaterThanOrEqual(room1Events[i - 1].atMs);
    }
  });

  it('all events reference the correct roomId', () => {
    for (const ev of room1Events) {
      expect(ev.roomId).toBe(ROOM_ID);
    }
  });

  it('all atMs values are non-negative', () => {
    for (const ev of room1Events) {
      expect(ev.atMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('total arc is ~60 seconds (last event <= 65000ms)', () => {
    const lastMs = room1Events[room1Events.length - 1].atMs;
    expect(lastMs).toBeLessThanOrEqual(65000);
  });

  it('event count is in the 80-150 range', () => {
    expect(room1Events.length).toBeGreaterThanOrEqual(80);
    expect(room1Events.length).toBeLessThanOrEqual(150);
  });

  it('starts with room:state active', () => {
    const first = room1Events[0];
    expect(first.type).toBe('room:state');
    expect((first.payload as { status: string }).status).toBe('active');
  });

  it('has wave:start events for waves 1, 2, and 3', () => {
    const waveStarts = room1Events.filter((e) => e.type === 'wave:start');
    const waves = waveStarts.map((e) => (e.payload as { wave: number }).wave);
    expect(waves).toContain(1);
    expect(waves).toContain(2);
    expect(waves).toContain(3);
  });

  it('has wave:complete events for waves 1, 2, and 3', () => {
    const waveCompletes = room1Events.filter((e) => e.type === 'wave:complete');
    const waves = waveCompletes.map((e) => (e.payload as { wave: number }).wave);
    expect(waves).toContain(1);
    expect(waves).toContain(2);
    expect(waves).toContain(3);
  });

  it('wave:start precedes wave:complete for each wave', () => {
    for (const waveNum of [1, 2, 3]) {
      const start = room1Events.find(
        (e) => e.type === 'wave:start' && (e.payload as { wave: number }).wave === waveNum,
      );
      const end = room1Events.find(
        (e) => e.type === 'wave:complete' && (e.payload as { wave: number }).wave === waveNum,
      );
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      expect(start!.atMs).toBeLessThan(end!.atMs);
    }
  });

  it('has message events for all three participants in each wave', () => {
    const participantIds = [
      DEMO_PARTICIPANT_CLAUDE_ID,
      DEMO_PARTICIPANT_CODEX_ID,
      DEMO_PARTICIPANT_GEMINI_ID,
    ];

    for (const waveNum of [1, 2, 3]) {
      const waveMsgs = room1Events.filter(
        (e) => e.type === 'message' && (e.payload as { wave?: number }).wave === waveNum,
      );
      const presentParticipants = new Set(
        waveMsgs.map((e) => (e.payload as { participantId?: string }).participantId),
      );
      for (const pid of participantIds) {
        // Wave 3 is synthesis-only so participants may not all send messages;
        // just verify wave 1 and 2 have all participants.
        if (waveNum < 3) {
          expect(presentParticipants.has(pid)).toBe(true);
        }
      }
    }
  });

  it('has message:delta streaming events', () => {
    const deltas = room1Events.filter((e) => e.type === 'message:delta');
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('has a room:synthesis event with the synthesis text', () => {
    const synthEvents = room1Events.filter((e) => e.type === 'room:synthesis');
    expect(synthEvents.length).toBe(1);
    const synthesis = (synthEvents[0].payload as { synthesis: string }).synthesis;
    expect(typeof synthesis).toBe('string');
    expect(synthesis.length).toBeGreaterThan(50);
    // Must contain the hybrid approach key terms
    expect(synthesis.toLowerCase()).toContain('hybrid');
  });

  it('ends with room:state ended', () => {
    const last = room1Events[room1Events.length - 1];
    expect(last.type).toBe('room:state');
    expect((last.payload as { status: string }).status).toBe('ended');
  });

  it('has participant:joined events for all three participants', () => {
    const joined = room1Events.filter((e) => e.type === 'participant:joined');
    const joinedIds = joined.map((e) => (e.payload as { participantId: string }).participantId);
    expect(joinedIds).toContain(DEMO_PARTICIPANT_CLAUDE_ID);
    expect(joinedIds).toContain(DEMO_PARTICIPANT_CODEX_ID);
    expect(joinedIds).toContain(DEMO_PARTICIPANT_GEMINI_ID);
  });

  it('BrainstormReplayableEvent type: each event has atMs, roomId, type, payload', () => {
    for (const ev of room1Events) {
      expect(typeof ev.atMs).toBe('number');
      expect(typeof ev.roomId).toBe('string');
      expect(typeof ev.type).toBe('string');
      expect(ev.payload).toBeDefined();
    }
  });
});

describe('DEMO_BRAINSTORM_ROOMS map', () => {
  it('contains an entry for the demo room ID', () => {
    expect(DEMO_BRAINSTORM_ROOMS[ROOM_ID]).toBeDefined();
  });

  it('maps to the room1Events array', () => {
    expect(DEMO_BRAINSTORM_ROOMS[ROOM_ID]).toBe(room1Events);
  });
});

// Type-level test: BrainstormReplayableEvent is importable
const _typeCheck: BrainstormReplayableEvent = room1Events[0];
void _typeCheck;
