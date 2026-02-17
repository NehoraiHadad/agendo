import { describe, it, expect, beforeEach } from 'vitest';
import { useExecutionStore, type ExecutionEntry } from '../execution-store';

function makeEntry(
  overrides: Partial<ExecutionEntry> & { id: string; taskId: string },
): ExecutionEntry {
  return {
    status: 'running',
    ...overrides,
  };
}

describe('execution-store', () => {
  beforeEach(() => {
    useExecutionStore.setState({ entries: {} });
  });

  describe('updateExecution', () => {
    it('adds a new entry when id does not exist', () => {
      const store = useExecutionStore.getState();
      const entry = makeEntry({ id: 'exec-1', taskId: 'task-1', status: 'running' });

      store.updateExecution(entry);

      const state = useExecutionStore.getState();
      expect(state.entries['exec-1']).toEqual(entry);
    });

    it('updates an existing entry when id already exists', () => {
      const store = useExecutionStore.getState();
      const entry = makeEntry({ id: 'exec-1', taskId: 'task-1', status: 'running' });
      store.updateExecution(entry);

      useExecutionStore.getState().updateExecution({
        ...entry,
        status: 'succeeded',
      });

      const state = useExecutionStore.getState();
      expect(state.entries['exec-1'].status).toBe('succeeded');
    });

    it('can store multiple entries with different ids', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-1', taskId: 'task-1', status: 'running' }));
      store.updateExecution(makeEntry({ id: 'exec-2', taskId: 'task-2', status: 'queued' }));

      const state = useExecutionStore.getState();
      expect(Object.keys(state.entries)).toHaveLength(2);
      expect(state.entries['exec-1'].taskId).toBe('task-1');
      expect(state.entries['exec-2'].taskId).toBe('task-2');
    });
  });

  describe('getActiveExecution', () => {
    it('returns running execution for the given taskId', () => {
      const store = useExecutionStore.getState();
      const entry = makeEntry({ id: 'exec-1', taskId: 'task-1', status: 'running' });
      store.updateExecution(entry);

      const result = useExecutionStore.getState().getActiveExecution('task-1');
      expect(result).toEqual(entry);
    });

    it('returns queued execution as active', () => {
      const store = useExecutionStore.getState();
      const entry = makeEntry({ id: 'exec-2', taskId: 'task-2', status: 'queued' });
      store.updateExecution(entry);

      const result = useExecutionStore.getState().getActiveExecution('task-2');
      expect(result).toEqual(entry);
    });

    it('returns cancelling execution as active', () => {
      const store = useExecutionStore.getState();
      const entry = makeEntry({ id: 'exec-3', taskId: 'task-3', status: 'cancelling' });
      store.updateExecution(entry);

      const result = useExecutionStore.getState().getActiveExecution('task-3');
      expect(result).toEqual(entry);
    });

    it('returns null when no entry exists for taskId', () => {
      const result = useExecutionStore.getState().getActiveExecution('non-existent-task');
      expect(result).toBeNull();
    });

    it('returns null when execution has terminal status: succeeded', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-4', taskId: 'task-4', status: 'succeeded' }));

      const result = useExecutionStore.getState().getActiveExecution('task-4');
      expect(result).toBeNull();
    });

    it('returns null when execution has terminal status: failed', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-5', taskId: 'task-5', status: 'failed' }));

      const result = useExecutionStore.getState().getActiveExecution('task-5');
      expect(result).toBeNull();
    });

    it('returns null when execution has terminal status: cancelled', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-6', taskId: 'task-6', status: 'cancelled' }));

      const result = useExecutionStore.getState().getActiveExecution('task-6');
      expect(result).toBeNull();
    });

    it('returns null when execution has terminal status: timed_out', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-7', taskId: 'task-7', status: 'timed_out' }));

      const result = useExecutionStore.getState().getActiveExecution('task-7');
      expect(result).toBeNull();
    });

    it('returns null when taskId does not match any entry (other tasks exist)', () => {
      const store = useExecutionStore.getState();
      store.updateExecution(makeEntry({ id: 'exec-8', taskId: 'task-8', status: 'running' }));

      const result = useExecutionStore.getState().getActiveExecution('task-9');
      expect(result).toBeNull();
    });
  });
});
