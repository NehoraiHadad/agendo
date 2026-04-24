/**
 * Demo-mode shadow for task-event-service.ts.
 *
 * All exported functions mirror the real service's signatures exactly, but
 * operate entirely on in-memory fixtures — no database access.
 *
 * `createTaskEvent` returns a plausible stub row with a fresh numeric ID.
 *
 * Imported only via dynamic `await import('./task-event-service.demo')` in demo
 * mode so it is tree-shaken from production bundles.
 */

import type { TaskEvent } from '@/lib/types';
import type { CreateEventInput } from '@/lib/services/task-event-service';

// ============================================================================
// Canonical shared IDs (must match across all Phase-1 agents)
// ============================================================================

const AGENT_CLAUDE = '11111111-1111-4111-a111-111111111111';
const AGENT_CODEX = '22222222-2222-4222-a222-222222222222';
const AGENT_GEMINI = '33333333-3333-4333-a333-333333333333';

// Task IDs — Agent A's range
const T01 = 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa';
const T02 = 'aaaaaaaa-aaaa-4002-a002-aaaaaaaaaaaa';
const T03 = 'aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa';
const T04 = 'aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa';
const T05 = 'aaaaaaaa-aaaa-4005-a005-aaaaaaaaaaaa';

// Fixed reference point for deterministic timestamps
const NOW = new Date('2026-04-23T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// ============================================================================
// Fixture data — 10 events spanning the last 72 hours
// id: bigint mode 'number' (numeric, not UUID)
// ============================================================================

export const DEMO_TASK_EVENTS: readonly TaskEvent[] = [
  {
    id: 1,
    taskId: T01,
    actorType: 'system',
    actorId: null,
    eventType: 'created',
    payload: { initialStatus: 'todo' },
    createdAt: hoursAgo(72),
  },
  {
    id: 2,
    taskId: T01,
    actorType: 'agent',
    actorId: AGENT_CLAUDE,
    eventType: 'status_changed',
    payload: { from: 'todo', to: 'in_progress' },
    createdAt: hoursAgo(70),
  },
  {
    id: 3,
    taskId: T01,
    actorType: 'agent',
    actorId: AGENT_CLAUDE,
    eventType: 'status_changed',
    payload: { from: 'in_progress', to: 'done' },
    createdAt: hoursAgo(60),
  },
  {
    id: 4,
    taskId: T02,
    actorType: 'system',
    actorId: null,
    eventType: 'created',
    payload: { initialStatus: 'todo' },
    createdAt: hoursAgo(68),
  },
  {
    id: 5,
    taskId: T02,
    actorType: 'agent',
    actorId: AGENT_CLAUDE,
    eventType: 'status_changed',
    payload: { from: 'todo', to: 'in_progress' },
    createdAt: hoursAgo(50),
  },
  {
    id: 6,
    taskId: T02,
    actorType: 'agent',
    actorId: AGENT_CODEX,
    eventType: 'status_changed',
    payload: { from: 'in_progress', to: 'done' },
    createdAt: hoursAgo(40),
  },
  {
    id: 7,
    taskId: T03,
    actorType: 'agent',
    actorId: AGENT_CODEX,
    eventType: 'status_changed',
    payload: { from: 'todo', to: 'in_progress' },
    createdAt: hoursAgo(48),
  },
  {
    id: 8,
    taskId: T03,
    actorType: 'agent',
    actorId: AGENT_CODEX,
    eventType: 'status_changed',
    payload: { from: 'in_progress', to: 'done' },
    createdAt: hoursAgo(30),
  },
  {
    id: 9,
    taskId: T04,
    actorType: 'agent',
    actorId: AGENT_GEMINI,
    eventType: 'status_changed',
    payload: { from: 'todo', to: 'in_progress' },
    createdAt: hoursAgo(24),
  },
  {
    id: 10,
    taskId: T05,
    actorType: 'agent',
    actorId: AGENT_CLAUDE,
    eventType: 'status_changed',
    payload: { from: 'todo', to: 'in_progress' },
    createdAt: hoursAgo(12),
  },
] satisfies readonly TaskEvent[];

// Counter for synthetic event IDs in mutations
let _nextId = DEMO_TASK_EVENTS.length + 1;

// ============================================================================
// Shadow exports — must match task-event-service.ts signatures exactly
// ============================================================================

export async function createTaskEvent(input: CreateEventInput): Promise<TaskEvent> {
  const id = _nextId++;
  return {
    id,
    taskId: input.taskId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    payload: input.payload ?? {},
    createdAt: new Date(),
  };
}

/**
 * List events for a task, newest first.
 */
export async function listTaskEvents(taskId: string, limit = 100): Promise<TaskEvent[]> {
  return DEMO_TASK_EVENTS.filter((e) => e.taskId === taskId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}
