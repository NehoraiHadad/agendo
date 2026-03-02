/**
 * Tests for new methods added to TeamInboxMonitor:
 * - readConfig()
 * - listTeammateInboxPaths()
 * - startOutboxPolling() / stopOutboxPolling()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Filesystem mocks
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

import { TeamInboxMonitor } from '../team-inbox-monitor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAMS_BASE = '/home/testuser/.claude/teams';

function makeConfigPath(teamName: string): string {
  return `${TEAMS_BASE}/${teamName}/config.json`;
}

function makeInboxPath(teamName: string, memberName: string): string {
  return `${TEAMS_BASE}/${teamName}/inboxes/${memberName}.json`;
}

function makeInboxesDir(teamName: string): string {
  return `${TEAMS_BASE}/${teamName}/inboxes`;
}

function makeMember(
  overrides?: Partial<{
    name: string;
    agentId: string;
    agentType: string;
    model: string;
    color: string;
    planModeRequired: boolean;
    joinedAt: number;
    tmuxPaneId: string;
    backendType: string;
  }>,
) {
  return {
    name: 'researcher',
    agentId: 'researcher@test-team',
    agentType: 'general-purpose',
    model: 'claude-opus-4-6',
    joinedAt: 1770503214956,
    tmuxPaneId: 'in-process',
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<{
    name: string;
    leadSessionId: string;
    members: ReturnType<typeof makeMember>[];
  }>,
) {
  return {
    name: 'test-team',
    leadSessionId: 'session-abc123',
    members: [
      { ...makeMember({ name: 'team-lead', agentId: 'team-lead@test-team', tmuxPaneId: '' }) },
      makeMember(),
    ],
    ...overrides,
  };
}

function makeMessage(
  overrides?: Partial<{
    from: string;
    text: string;
    timestamp: string;
    color: string;
  }>,
) {
  return {
    from: 'team-lead',
    text: 'Here is your task assignment.',
    timestamp: '2026-02-23T21:09:41.557Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readConfig tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor.readConfig', () => {
  let monitor: TeamInboxMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    monitor = new TeamInboxMonitor('test-team');
  });

  it('returns null when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(monitor.readConfig()).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith(makeConfigPath('test-team'));
  });

  it('returns null when config file contains malformed JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(monitor.readConfig()).toBeNull();
  });

  it('returns config with members array', () => {
    const config = makeConfig();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const result = monitor.readConfig();
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-team');
    expect(result!.leadSessionId).toBe('session-abc123');
    expect(result!.members).toHaveLength(2);
    expect(result!.members[0].name).toBe('team-lead');
    expect(result!.members[1].name).toBe('researcher');
  });

  it('preserves all member fields including optional ones', () => {
    const config = makeConfig({
      members: [
        makeMember({
          name: 'analyst',
          agentId: 'analyst@test-team',
          color: 'blue',
          planModeRequired: true,
          backendType: 'in-process',
        }),
      ],
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const result = monitor.readConfig();
    const analyst = result!.members[0];
    expect(analyst.color).toBe('blue');
    expect(analyst.planModeRequired).toBe(true);
    expect(analyst.backendType).toBe('in-process');
  });

  it('handles config with empty members array', () => {
    const config = makeConfig({ members: [] });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(config));

    const result = monitor.readConfig();
    expect(result!.members).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listTeammateInboxPaths tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor.listTeammateInboxPaths', () => {
  let monitor: TeamInboxMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    monitor = new TeamInboxMonitor('test-team');
  });

  it('returns empty array when inboxes directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(monitor.listTeammateInboxPaths()).toEqual([]);
  });

  it('returns empty array when inboxes directory is empty', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    expect(monitor.listTeammateInboxPaths()).toEqual([]);
  });

  it('excludes team-lead.json (monitored separately)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['team-lead.json', 'researcher.json', 'coder.json']);

    const paths = monitor.listTeammateInboxPaths();
    expect(paths).not.toContainEqual(expect.objectContaining({ memberName: 'team-lead' }));
  });

  it('returns correct paths for all non-lead teammates', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['team-lead.json', 'researcher.json', 'coder.json']);

    const paths = monitor.listTeammateInboxPaths();
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual({
      memberName: 'researcher',
      inboxPath: makeInboxPath('test-team', 'researcher'),
    });
    expect(paths).toContainEqual({
      memberName: 'coder',
      inboxPath: makeInboxPath('test-team', 'coder'),
    });
  });

  it('skips non-.json files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['researcher.json', 'README.md', 'notes.txt']);

    const paths = monitor.listTeammateInboxPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0].memberName).toBe('researcher');
  });

  it('reads from the correct inboxes directory', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    monitor.listTeammateInboxPaths();
    expect(mockExistsSync).toHaveBeenCalledWith(makeInboxesDir('test-team'));
  });
});

// ---------------------------------------------------------------------------
// startOutboxPolling / stopOutboxPolling tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor outbox polling', () => {
  let monitor: TeamInboxMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    monitor = new TeamInboxMonitor('outbox-team');
  });

  afterEach(() => {
    monitor.stopOutboxPolling();
    vi.useRealTimers();
  });

  it('does not fire callback when no teammate inboxes exist', () => {
    mockExistsSync.mockReturnValue(false);
    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);
    vi.advanceTimersByTime(1000);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('fires callback for new messages in a teammate inbox', () => {
    const msg = makeMessage({ from: 'team-lead', text: 'Task assigned to you' });

    mockExistsSync.mockImplementation((p: string) => {
      if (p === makeInboxesDir('outbox-team')) return true;
      if (p === makeInboxPath('outbox-team', 'researcher')) return true;
      return false;
    });

    mockReaddirSync.mockImplementation(() => {
      return ['researcher.json'];
    });

    let readCount = 0;
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeInboxPath('outbox-team', 'researcher')) {
        readCount++;
        // First two reads: empty; third read: new message
        if (readCount <= 2) return '[]';
        return JSON.stringify([msg]);
      }
      throw new Error(`unexpected: ${p}`);
    });

    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);

    vi.advanceTimersByTime(500); // first poll — no change
    expect(onMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500); // second poll — new message
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      'researcher',
      expect.objectContaining({ from: 'team-lead', text: 'Task assigned to you' }),
    );
  });

  it('fires callback for each new message in multiple teammate inboxes', () => {
    const msgToResearcher = makeMessage({ from: 'team-lead', text: 'Research task' });
    const msgToCoder = makeMessage({ from: 'team-lead', text: 'Coding task' });

    mockExistsSync.mockImplementation((p: string) => {
      if (p === makeInboxesDir('outbox-team')) return true;
      if (p === makeInboxPath('outbox-team', 'researcher')) return true;
      if (p === makeInboxPath('outbox-team', 'coder')) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue(['researcher.json', 'coder.json']);

    let researcherReadCount = 0;
    let coderReadCount = 0;
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeInboxPath('outbox-team', 'researcher')) {
        researcherReadCount++;
        return researcherReadCount <= 1 ? '[]' : JSON.stringify([msgToResearcher]);
      }
      if (p === makeInboxPath('outbox-team', 'coder')) {
        coderReadCount++;
        return coderReadCount <= 1 ? '[]' : JSON.stringify([msgToCoder]);
      }
      throw new Error(`unexpected: ${p}`);
    });

    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);

    vi.advanceTimersByTime(500);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith(
      'researcher',
      expect.objectContaining({ text: 'Research task' }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'coder',
      expect.objectContaining({ text: 'Coding task' }),
    );
  });

  it('does not fire duplicates for messages already seen', () => {
    const msg = makeMessage({ from: 'team-lead', text: 'First message' });

    mockExistsSync.mockImplementation((p: string) => {
      if (p === makeInboxesDir('outbox-team')) return true;
      if (p === makeInboxPath('outbox-team', 'analyst')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(['analyst.json']);

    let readCount = 0;
    mockReadFileSync.mockImplementation(() => {
      readCount++;
      // Always return the same one message after the first read
      return readCount <= 1 ? '[]' : JSON.stringify([msg]);
    });

    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);

    vi.advanceTimersByTime(500); // fires once
    vi.advanceTimersByTime(500); // no new messages
    vi.advanceTimersByTime(500); // no new messages

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('stopOutboxPolling stops the interval', () => {
    mockExistsSync.mockImplementation((p: string) => p === makeInboxesDir('outbox-team'));
    mockReaddirSync.mockReturnValue([]);

    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);
    monitor.stopOutboxPolling();

    vi.advanceTimersByTime(5000);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stopOutboxPolling is safe to call when not polling', () => {
    expect(() => monitor.stopOutboxPolling()).not.toThrow();
  });

  it('passes isStructured=true for JSON-encoded messages', () => {
    const structuredText = JSON.stringify({ type: 'task_assignment', taskId: '3' });
    const msg = makeMessage({ from: 'team-lead', text: structuredText });

    mockExistsSync.mockImplementation((p: string) => {
      if (p === makeInboxesDir('outbox-team')) return true;
      if (p === makeInboxPath('outbox-team', 'implementer')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue(['implementer.json']);

    let readCount = 0;
    mockReadFileSync.mockImplementation(() => {
      readCount++;
      return readCount <= 1 ? '[]' : JSON.stringify([msg]);
    });

    const onMessage = vi.fn();
    monitor.startOutboxPolling(500, onMessage);

    vi.advanceTimersByTime(500);
    expect(onMessage).toHaveBeenCalledWith(
      'implementer',
      expect.objectContaining({
        isStructured: true,
        structuredPayload: { type: 'task_assignment', taskId: '3' },
      }),
    );
  });
});
