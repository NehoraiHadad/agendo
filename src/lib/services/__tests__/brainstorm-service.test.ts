/**
 * Tests for brainstorm-service — cross-brainstorm memory (context linking)
 *
 * Tests `getCompletedRoomsForProject()` which returns completed brainstorm rooms
 * with syntheses for a given project.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: drizzle db
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();

// Chain: db.select().from().where().orderBy()
mockSelect.mockReturnValue({ from: mockFrom });
mockFrom.mockReturnValue({ where: mockWhere });
mockWhere.mockReturnValue({ orderBy: mockOrderBy });
mockOrderBy.mockResolvedValue([]);

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  brainstormRooms: {
    id: 'id',
    projectId: 'project_id',
    title: 'title',
    topic: 'topic',
    status: 'status',
    synthesis: 'synthesis',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    currentWave: 'current_wave',
    maxWaves: 'max_waves',
    config: 'config',
    taskId: 'task_id',
    logFilePath: 'log_file_path',
  },
  brainstormParticipants: {
    id: 'id',
    roomId: 'room_id',
    agentId: 'agent_id',
    sessionId: 'session_id',
    model: 'model',
    status: 'status',
    joinedAt: 'joined_at',
  },
  agents: { id: 'id', name: 'name', slug: 'slug' },
  projects: { id: 'id', name: 'name' },
  tasks: { id: 'id', title: 'title' },
}));

vi.mock('@/lib/api-handler', () => ({
  requireFound: vi.fn(),
}));

vi.mock('@/lib/errors', () => ({
  NotFoundError: class extends Error {
    constructor(type: string, id: string) {
      super(`${type} ${id} not found`);
    }
  },
  ConflictError: class extends Error {},
  ValidationError: class extends Error {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  asc: vi.fn((col: unknown) => ({ type: 'asc', col })),
  isNotNull: vi.fn((col: unknown) => ({ type: 'isNotNull', col })),
  getTableColumns: vi.fn(() => ({})),
  count: vi.fn(() => 'count'),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { getCompletedRoomsForProject } = await import('../brainstorm-service');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockResolvedValue([]);
});

describe('getCompletedRoomsForProject', () => {
  it('returns completed rooms with syntheses for a given project', async () => {
    const mockRooms = [
      {
        id: 'room-1',
        title: 'Architecture Discussion',
        synthesis: 'We decided to use microservices...',
        createdAt: new Date('2026-03-10'),
      },
      {
        id: 'room-2',
        title: 'API Design',
        synthesis: 'REST with versioned endpoints...',
        createdAt: new Date('2026-03-12'),
      },
    ];

    mockOrderBy.mockResolvedValue(mockRooms);

    const result = await getCompletedRoomsForProject('project-abc');

    expect(result).toEqual(mockRooms);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('returns empty array when no completed rooms exist', async () => {
    mockOrderBy.mockResolvedValue([]);

    const result = await getCompletedRoomsForProject('project-xyz');

    expect(result).toEqual([]);
  });
});
