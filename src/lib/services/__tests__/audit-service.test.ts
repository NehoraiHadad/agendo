import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mock fns (must be inside vi.hoisted for vi.mock factories) ---
const { mockValues, mockInsert } = vi.hoisted(() => {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockValues, mockInsert };
});

vi.mock('@/lib/db', () => ({
  db: {
    insert: mockInsert,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  auditLog: Symbol('auditLog'),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { logAudit, logSessionAudit, logTaskAudit } from '../audit-service';

describe('audit-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockResolvedValue(undefined);
  });

  describe('logAudit', () => {
    it('inserts an audit log entry with all fields', async () => {
      await logAudit('system', 'task.create', 'task', 'some-uuid', { title: 'Test' });

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledWith({
        actor: 'system',
        action: 'task.create',
        resourceType: 'task',
        resourceId: 'some-uuid',
        metadata: { title: 'Test' },
      });
    });

    it('handles null actor', async () => {
      await logAudit(null, 'session.start', 'session');

      expect(mockValues).toHaveBeenCalledWith({
        actor: null,
        action: 'session.start',
        resourceType: 'session',
        resourceId: undefined,
        metadata: undefined,
      });
    });

    it('swallows errors and never throws', async () => {
      mockValues.mockRejectedValue(new Error('DB connection lost'));

      // Should NOT throw
      await expect(logAudit('system', 'task.create', 'task')).resolves.toBeUndefined();
    });

    it('handles missing optional fields', async () => {
      await logAudit('agent', 'brainstorm.start', 'brainstorm');

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'agent',
        action: 'brainstorm.start',
        resourceType: 'brainstorm',
        resourceId: undefined,
        metadata: undefined,
      });
    });
  });

  describe('logSessionAudit', () => {
    it('calls logAudit with actor=system and resourceType=session', async () => {
      await logSessionAudit('session.start', 'session-123', { agentId: 'agent-1' });

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'system',
        action: 'session.start',
        resourceType: 'session',
        resourceId: 'session-123',
        metadata: { agentId: 'agent-1' },
      });
    });

    it('works without metadata', async () => {
      await logSessionAudit('session.end', 'session-456');

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'system',
        action: 'session.end',
        resourceType: 'session',
        resourceId: 'session-456',
        metadata: undefined,
      });
    });
  });

  describe('logTaskAudit', () => {
    it('calls logAudit with resourceType=task and extracts actor from metadata', async () => {
      await logTaskAudit('task.create', 'task-789', { actor: 'claude-code-1', title: 'Test' });

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'claude-code-1',
        action: 'task.create',
        resourceType: 'task',
        resourceId: 'task-789',
        metadata: { actor: 'claude-code-1', title: 'Test' },
      });
    });

    it('defaults to system actor when metadata has no actor', async () => {
      await logTaskAudit('task.update', 'task-abc', { status: 'done' });

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'system',
        action: 'task.update',
        resourceType: 'task',
        resourceId: 'task-abc',
        metadata: { status: 'done' },
      });
    });

    it('defaults to system actor when no metadata', async () => {
      await logTaskAudit('task.delete', 'task-def');

      expect(mockValues).toHaveBeenCalledWith({
        actor: 'system',
        action: 'task.delete',
        resourceType: 'task',
        resourceId: 'task-def',
        metadata: undefined,
      });
    });
  });
});
