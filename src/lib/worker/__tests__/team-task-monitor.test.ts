import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Filesystem mocks — use vi.hoisted() so variables are available inside
// vi.mock() factories (which are hoisted to the top of the file by vitest).
// ---------------------------------------------------------------------------

const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>());
const mockReadFileSync = vi.hoisted(() => vi.fn<(path: string, enc: BufferEncoding) => string>());
const mockReaddirSync = vi.hoisted(() =>
  vi.fn<
    (
      path: string,
      opts?: { withFileTypes?: boolean },
    ) => Array<{ name: string; isDirectory?: () => boolean } | string>
  >(),
);

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/testuser',
}));

import { TeamTaskMonitor } from '../team-task-monitor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASKS_BASE = '/home/testuser/.claude/tasks';

function makeTasksDir(teamName: string): string {
  return `${TASKS_BASE}/${teamName}`;
}

function makeTaskPath(teamName: string, id: string): string {
  return `${TASKS_BASE}/${teamName}/${id}.json`;
}

function makeTask(
  overrides?: Partial<{
    id: string;
    subject: string;
    status: string;
    owner: string;
    blocks: string[];
    blockedBy: string[];
  }>,
) {
  return {
    id: '1',
    subject: 'Complete the feature',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readAllTasks tests
// ---------------------------------------------------------------------------

describe('TeamTaskMonitor.readAllTasks', () => {
  let monitor: TeamTaskMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    monitor = new TeamTaskMonitor('test-team');
  });

  it('returns empty array when tasks directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(monitor.readAllTasks()).toEqual([]);
    expect(mockExistsSync).toHaveBeenCalledWith(makeTasksDir('test-team'));
  });

  it('returns empty array when readdirSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation(() => {
      throw new Error('permission denied');
    });
    expect(monitor.readAllTasks()).toEqual([]);
  });

  it('returns empty array when directory has no JSON files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['README.md', 'notes.txt']);
    expect(monitor.readAllTasks()).toEqual([]);
  });

  it('parses a single valid task file', () => {
    const task = makeTask({ id: '1', subject: 'First task', status: 'pending' });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify(task));

    const tasks = monitor.readAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('1');
    expect(tasks[0].subject).toBe('First task');
    expect(tasks[0].status).toBe('pending');
    expect(tasks[0].blocks).toEqual([]);
    expect(tasks[0].blockedBy).toEqual([]);
  });

  it('skips malformed JSON files gracefully', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json', '2.json']);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeTaskPath('test-team', '1')) return 'not json';
      if (p === makeTaskPath('test-team', '2')) return JSON.stringify(makeTask({ id: '2' }));
      throw new Error('unexpected path');
    });

    const tasks = monitor.readAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('2');
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = { id: '3', subject: 'Minimal task', status: 'in_progress' };
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['3.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify(minimal));

    const tasks = monitor.readAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner).toBeUndefined();
    expect(tasks[0].blocks).toEqual([]);
    expect(tasks[0].blockedBy).toEqual([]);
  });

  it('reads multiple task files', () => {
    const task1 = makeTask({ id: '1', status: 'completed' });
    const task2 = makeTask({ id: '2', status: 'in_progress', owner: 'researcher' });
    const task3 = makeTask({ id: '3', status: 'pending', blocks: ['4', '5'] });

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json', '2.json', '3.json']);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeTaskPath('test-team', '1')) return JSON.stringify(task1);
      if (p === makeTaskPath('test-team', '2')) return JSON.stringify(task2);
      if (p === makeTaskPath('test-team', '3')) return JSON.stringify(task3);
      throw new Error(`unexpected: ${p}`);
    });

    const tasks = monitor.readAllTasks();
    expect(tasks).toHaveLength(3);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
    expect(ids).toContain('3');
  });

  it('preserves blocks and blockedBy arrays', () => {
    const task = makeTask({ id: '4', blocks: ['5', '6'], blockedBy: ['1', '2', '3'] });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['4.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify(task));

    const tasks = monitor.readAllTasks();
    expect(tasks[0].blocks).toEqual(['5', '6']);
    expect(tasks[0].blockedBy).toEqual(['1', '2', '3']);
  });
});

// ---------------------------------------------------------------------------
// startPolling / stopPolling tests
// ---------------------------------------------------------------------------

describe('TeamTaskMonitor polling', () => {
  let monitor: TeamTaskMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    monitor = new TeamTaskMonitor('poll-team');
  });

  afterEach(() => {
    monitor.stopPolling();
    vi.useRealTimers();
  });

  it('does not fire callback on initial poll if tasks have not changed', () => {
    const task = makeTask({ id: '1' });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify(task));

    const onUpdate = vi.fn();
    monitor.startPolling(1000, onUpdate);

    vi.advanceTimersByTime(1000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('fires callback when a new task is added', () => {
    const task1 = makeTask({ id: '1', status: 'pending' });
    const task2 = makeTask({ id: '2', status: 'in_progress' });

    mockExistsSync.mockReturnValue(true);

    // Initial snapshot: only task1
    mockReaddirSync
      .mockReturnValueOnce(['1.json']) // startPolling init
      .mockReturnValueOnce(['1.json']) // first poll (no change)
      .mockReturnValue(['1.json', '2.json']); // second poll (new task)
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('1.json')) return JSON.stringify(task1);
      if (p.includes('2.json')) return JSON.stringify(task2);
      throw new Error(`unexpected: ${p}`);
    });

    const onUpdate = vi.fn();
    monitor.startPolling(500, onUpdate);

    vi.advanceTimersByTime(500);
    expect(onUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const tasks: ReturnType<typeof monitor.readAllTasks> = onUpdate.mock.calls[0][0];
    expect(tasks).toHaveLength(2);
  });

  it('fires callback when a task status changes', () => {
    const taskBefore = makeTask({ id: '1', status: 'pending' });
    const taskAfter = makeTask({ id: '1', status: 'in_progress', owner: 'researcher' });

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json']);

    let callCount = 0;
    mockReadFileSync.mockImplementation(() => {
      callCount++;
      // First call: init snapshot
      // Second call: first poll (same)
      // Third call: second poll (changed)
      if (callCount <= 2) return JSON.stringify(taskBefore);
      return JSON.stringify(taskAfter);
    });

    const onUpdate = vi.fn();
    monitor.startPolling(500, onUpdate);

    vi.advanceTimersByTime(500);
    expect(onUpdate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire if tasks snapshot is unchanged', () => {
    const task = makeTask({ id: '1', status: 'pending' });
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['1.json']);
    mockReadFileSync.mockReturnValue(JSON.stringify(task));

    const onUpdate = vi.fn();
    monitor.startPolling(500, onUpdate);

    // Advance many ticks — no changes
    vi.advanceTimersByTime(3000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('stopPolling stops the interval', () => {
    const task1 = makeTask({ id: '1' });
    const task2 = makeTask({ id: '2' });

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync
      .mockReturnValueOnce(['1.json']) // init
      .mockReturnValue(['1.json', '2.json']); // would change after stop
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('1.json')) return JSON.stringify(task1);
      return JSON.stringify(task2);
    });

    const onUpdate = vi.fn();
    monitor.startPolling(500, onUpdate);
    monitor.stopPolling();

    vi.advanceTimersByTime(5000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('is safe to call stopPolling when not polling', () => {
    expect(() => monitor.stopPolling()).not.toThrow();
  });

  it('passes full tasks array to callback', () => {
    const task1 = makeTask({ id: '1', status: 'completed' });
    const task2 = makeTask({ id: '2', status: 'in_progress', owner: 'coder' });

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync
      .mockReturnValueOnce([]) // init: empty
      .mockReturnValue(['1.json', '2.json']); // poll: two tasks
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('1.json')) return JSON.stringify(task1);
      if (p.includes('2.json')) return JSON.stringify(task2);
      throw new Error(`unexpected: ${p}`);
    });

    const onUpdate = vi.fn();
    monitor.startPolling(500, onUpdate);

    vi.advanceTimersByTime(500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const tasks: Array<{ id: string; status: string; owner?: string }> = onUpdate.mock.calls[0][0];
    expect(tasks.find((t) => t.id === '1')?.status).toBe('completed');
    expect(tasks.find((t) => t.id === '2')?.owner).toBe('coder');
  });
});
