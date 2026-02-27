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
      opts: { withFileTypes: true },
    ) => Array<{ name: string; isDirectory: () => boolean }>
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

const TEAMS_DIR = '/home/testuser/.claude/teams';

function makeInboxPath(teamName: string): string {
  return `${TEAMS_DIR}/${teamName}/inboxes/team-lead.json`;
}

function makeConfigPath(teamName: string): string {
  return `${TEAMS_DIR}/${teamName}/config.json`;
}

function makeRawMessage(
  overrides?: Partial<{
    from: string;
    text: string;
    summary: string;
    timestamp: string;
    color: string;
    read: boolean;
  }>,
) {
  return {
    from: 'mobile-analyst',
    text: '# Analysis complete\nThis is a report.',
    summary: 'Analysis complete',
    timestamp: '2026-02-23T21:09:41.557Z',
    color: 'blue',
    read: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findTeamForSession tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor.findTeamForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when teams directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = TeamInboxMonitor.findTeamForSession('session-123');
    expect(result).toBeNull();
    expect(mockExistsSync).toHaveBeenCalledWith(TEAMS_DIR);
  });

  it('returns null when teams directory is empty', () => {
    mockExistsSync.mockImplementation((p: string) => p === TEAMS_DIR);
    mockReaddirSync.mockReturnValue([]);
    const result = TeamInboxMonitor.findTeamForSession('session-123');
    expect(result).toBeNull();
  });

  it('returns null when no team config matches the sessionId', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEAMS_DIR) return true;
      if (p === makeConfigPath('team-alpha')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'team-alpha', isDirectory: () => true }]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ leadSessionId: 'different-session' }));
    const result = TeamInboxMonitor.findTeamForSession('session-123');
    expect(result).toBeNull();
  });

  it('returns the team name when leadSessionId matches', () => {
    const sessionId = 'abc123-def456';
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEAMS_DIR) return true;
      if (p === makeConfigPath('my-team')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([{ name: 'my-team', isDirectory: () => true }]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ leadSessionId: sessionId, members: [] }));
    const result = TeamInboxMonitor.findTeamForSession(sessionId);
    expect(result).toBe('my-team');
  });

  it('skips non-directory entries', () => {
    const sessionId = 'abc123';
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEAMS_DIR) return true;
      if (p === makeConfigPath('real-team')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: 'some-file.json', isDirectory: () => false },
      { name: 'real-team', isDirectory: () => true },
    ]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ leadSessionId: sessionId }));
    const result = TeamInboxMonitor.findTeamForSession(sessionId);
    expect(result).toBe('real-team');
  });

  it('skips directories with missing config.json', () => {
    const sessionId = 'abc123';
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEAMS_DIR) return true;
      if (p === makeConfigPath('team-with-config')) return true;
      // team-no-config has no config.json
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: 'team-no-config', isDirectory: () => true },
      { name: 'team-with-config', isDirectory: () => true },
    ]);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeConfigPath('team-with-config')) {
        return JSON.stringify({ leadSessionId: sessionId });
      }
      throw new Error('file not found');
    });
    const result = TeamInboxMonitor.findTeamForSession(sessionId);
    expect(result).toBe('team-with-config');
  });

  it('handles malformed config.json gracefully and continues', () => {
    const sessionId = 'abc123';
    mockExistsSync.mockImplementation((p: string) => {
      if (p === TEAMS_DIR) return true;
      if (p === makeConfigPath('bad-team')) return true;
      if (p === makeConfigPath('good-team')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      { name: 'bad-team', isDirectory: () => true },
      { name: 'good-team', isDirectory: () => true },
    ]);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === makeConfigPath('bad-team')) return 'not valid json';
      if (p === makeConfigPath('good-team')) return JSON.stringify({ leadSessionId: sessionId });
      throw new Error('unexpected path');
    });
    const result = TeamInboxMonitor.findTeamForSession(sessionId);
    expect(result).toBe('good-team');
  });

  it('returns first matching team when multiple teams exist', () => {
    const sessionId = 'session-xyz';
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: 'team-a', isDirectory: () => true },
      { name: 'team-b', isDirectory: () => true },
    ]);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes('team-a')) return JSON.stringify({ leadSessionId: sessionId });
      if (p.includes('team-b')) return JSON.stringify({ leadSessionId: sessionId });
      throw new Error('unexpected');
    });
    const result = TeamInboxMonitor.findTeamForSession(sessionId);
    expect(result).toBe('team-a');
  });
});

// ---------------------------------------------------------------------------
// readAllMessages tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor.readAllMessages', () => {
  let monitor: TeamInboxMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    monitor = new TeamInboxMonitor('test-team');
  });

  it('returns empty array when inbox file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(monitor.readAllMessages()).toEqual([]);
  });

  it('returns empty array when file contains malformed JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(monitor.readAllMessages()).toEqual([]);
  });

  it('returns empty array when file contains non-array JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ notAnArray: true }));
    expect(monitor.readAllMessages()).toEqual([]);
  });

  it('returns parsed messages with isStructured=false for plain text', () => {
    const raw = makeRawMessage({ text: '# Report\nSome content here.' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify([raw]));

    const msgs = monitor.readAllMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe('mobile-analyst');
    expect(msgs[0].text).toBe('# Report\nSome content here.');
    expect(msgs[0].isStructured).toBe(false);
    expect(msgs[0].structuredPayload).toBeUndefined();
  });

  it('returns messages with isStructured=true for JSON-encoded text', () => {
    const jsonText = JSON.stringify({ type: 'idle_notification', agentName: 'worker-1' });
    const raw = makeRawMessage({ text: jsonText, summary: 'Worker went idle' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify([raw]));

    const msgs = monitor.readAllMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].isStructured).toBe(true);
    expect(msgs[0].structuredPayload).toEqual({ type: 'idle_notification', agentName: 'worker-1' });
  });

  it('preserves all fields from raw message', () => {
    const raw = makeRawMessage({
      from: 'backend-agent',
      summary: 'Done',
      timestamp: '2026-01-01T12:00:00.000Z',
      color: 'green',
      read: true,
    });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify([raw]));

    const msgs = monitor.readAllMessages();
    expect(msgs[0].from).toBe('backend-agent');
    expect(msgs[0].summary).toBe('Done');
    expect(msgs[0].timestamp).toBe('2026-01-01T12:00:00.000Z');
    expect(msgs[0].color).toBe('green');
    expect(msgs[0].read).toBe(true);
  });

  it('handles multiple messages', () => {
    const raws = [makeRawMessage({ from: 'agent-1' }), makeRawMessage({ from: 'agent-2' })];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(raws));
    const msgs = monitor.readAllMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].from).toBe('agent-1');
    expect(msgs[1].from).toBe('agent-2');
  });

  it('reads from the correct inbox path', () => {
    mockExistsSync.mockReturnValue(false);
    monitor.readAllMessages();
    expect(mockExistsSync).toHaveBeenCalledWith(makeInboxPath('test-team'));
  });
});

// ---------------------------------------------------------------------------
// Polling tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor polling', () => {
  let monitor: TeamInboxMonitor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    monitor = new TeamInboxMonitor('poll-team');
  });

  afterEach(() => {
    monitor.stopPolling();
    vi.useRealTimers();
  });

  it('initializes lastCount to current message count on startPolling', () => {
    // 2 existing messages before polling starts
    const existing = [makeRawMessage({ from: 'old-1' }), makeRawMessage({ from: 'old-2' })];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(existing));

    const onMessage = vi.fn();
    monitor.startPolling(1000, onMessage);

    // Advance timer — should NOT fire for old messages
    vi.advanceTimersByTime(1000);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('calls callback for new messages added after polling started', () => {
    const existing = [makeRawMessage({ from: 'old-msg' })];
    const newMsg = makeRawMessage({ from: 'new-agent', text: 'Hello team!' });

    mockExistsSync.mockReturnValue(true);
    // First call: existing only; second call: existing + new
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(existing)) // startPolling init
      .mockReturnValueOnce(JSON.stringify(existing)) // first poll (no change)
      .mockReturnValue(JSON.stringify([...existing, newMsg])); // second poll (new message)

    const onMessage = vi.fn();
    monitor.startPolling(500, onMessage);

    vi.advanceTimersByTime(500);
    expect(onMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'new-agent', text: 'Hello team!' }),
    );
  });

  it('calls callback for each new message when multiple arrive at once', () => {
    const existing: ReturnType<typeof makeRawMessage>[] = [];
    const newMsgs = [makeRawMessage({ from: 'agent-a' }), makeRawMessage({ from: 'agent-b' })];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(existing)) // init
      .mockReturnValue(JSON.stringify(newMsgs)); // poll

    const onMessage = vi.fn();
    monitor.startPolling(1000, onMessage);

    vi.advanceTimersByTime(1000);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: 'agent-a' }));
    expect(onMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ from: 'agent-b' }));
  });

  it('does not fire duplicate callbacks for the same message across multiple polls', () => {
    const existing = [makeRawMessage({ from: 'stable' })];
    const withNew = [...existing, makeRawMessage({ from: 'newcomer' })];

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(existing)) // init
      .mockReturnValueOnce(JSON.stringify(withNew)) // poll 1 — fires callback
      .mockReturnValue(JSON.stringify(withNew)); // poll 2 — no new messages

    const onMessage = vi.fn();
    monitor.startPolling(1000, onMessage);

    vi.advanceTimersByTime(1000);
    expect(onMessage).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(onMessage).toHaveBeenCalledTimes(1); // still 1
  });

  it('stopPolling stops the interval', () => {
    const msgs = [makeRawMessage()];
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValueOnce(JSON.stringify([]));

    const onMessage = vi.fn();
    monitor.startPolling(1000, onMessage);

    monitor.stopPolling();

    // After stop, no messages are added and interval should not fire
    mockReadFileSync.mockReturnValue(JSON.stringify(msgs));
    vi.advanceTimersByTime(5000);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stopPolling is safe to call multiple times', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('[]');

    monitor.startPolling(1000, vi.fn());
    expect(() => {
      monitor.stopPolling();
      monitor.stopPolling();
    }).not.toThrow();
  });

  it('does not start a second interval if startPolling is called twice', () => {
    mockExistsSync.mockReturnValue(true);
    const existing = [makeRawMessage()];
    const withNew = [...existing, makeRawMessage({ from: 'extra' })];

    // Second startPolling is a no-op (pollTimer guard), so it never calls
    // readAllMessages(). Only two readFileSync calls happen:
    //   1. First startPolling init → existing (1 msg) → lastCount=1
    //   2. Poll tick → withNew (2 msgs) → fires callback once
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(existing)) // startPolling init
      .mockReturnValue(JSON.stringify(withNew)); // poll tick

    const onMessage = vi.fn();
    monitor.startPolling(1000, onMessage);
    monitor.startPolling(1000, onMessage); // second call should be no-op

    vi.advanceTimersByTime(1000);
    // Exactly one new message found, callback called once
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ from: 'extra' }));
  });

  it('passes isStructured messages correctly from polling', () => {
    const jsonText = JSON.stringify({ type: 'task_assignment', taskId: 'task-abc' });
    const newMsg = makeRawMessage({ from: 'worker', text: jsonText });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify([])) // init
      .mockReturnValue(JSON.stringify([newMsg])); // poll

    const onMessage = vi.fn();
    monitor.startPolling(500, onMessage);

    vi.advanceTimersByTime(500);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        isStructured: true,
        structuredPayload: { type: 'task_assignment', taskId: 'task-abc' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// isTeamDisbanded tests
// ---------------------------------------------------------------------------

describe('TeamInboxMonitor.isTeamDisbanded', () => {
  let monitor: TeamInboxMonitor;
  const teamName = 'disband-team';
  const configPath = makeConfigPath(teamName);
  const inboxPath = makeInboxPath(teamName);

  beforeEach(() => {
    vi.clearAllMocks();
    monitor = new TeamInboxMonitor(teamName);
  });

  it('returns true when config file does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => p !== configPath);
    expect(monitor.isTeamDisbanded()).toBe(true);
  });

  it('returns false when there are no non-leader members (no teammates yet)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) return JSON.stringify({ members: [{ name: 'team-lead' }] });
      if (p === inboxPath) return '[]';
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns false when members is empty array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) return JSON.stringify({ members: [] });
      if (p === inboxPath) return '[]';
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns false when no shutdown_approved messages exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) {
        return JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'researcher' }, { name: 'coder' }],
        });
      }
      if (p === inboxPath) {
        return JSON.stringify([makeRawMessage({ from: 'researcher', text: 'Still working' })]);
      }
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns false when only some members sent shutdown_approved', () => {
    const shutdownMsg = JSON.stringify({ type: 'shutdown_approved' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) {
        return JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'researcher' }, { name: 'coder' }],
        });
      }
      if (p === inboxPath) {
        return JSON.stringify([
          makeRawMessage({ from: 'researcher', text: shutdownMsg }),
          // coder has NOT sent shutdown_approved
        ]);
      }
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns true when all non-leader members sent shutdown_approved', () => {
    const shutdownMsg = JSON.stringify({ type: 'shutdown_approved' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) {
        return JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'researcher' }, { name: 'coder' }],
        });
      }
      if (p === inboxPath) {
        return JSON.stringify([
          makeRawMessage({ from: 'researcher', text: shutdownMsg }),
          makeRawMessage({ from: 'coder', text: shutdownMsg }),
        ]);
      }
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(true);
  });

  it('returns true with single non-leader member who sent shutdown_approved', () => {
    const shutdownMsg = JSON.stringify({ type: 'shutdown_approved' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) {
        return JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'solo-worker' }],
        });
      }
      if (p === inboxPath) {
        return JSON.stringify([makeRawMessage({ from: 'solo-worker', text: shutdownMsg })]);
      }
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(true);
  });

  it('ignores non-shutdown_approved structured messages', () => {
    const shutdownMsg = JSON.stringify({ type: 'shutdown_approved' });
    const idleMsg = JSON.stringify({ type: 'idle_notification' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) {
        return JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'researcher' }, { name: 'coder' }],
        });
      }
      if (p === inboxPath) {
        return JSON.stringify([
          makeRawMessage({ from: 'researcher', text: shutdownMsg }),
          makeRawMessage({ from: 'coder', text: idleMsg }), // idle, not shutdown
        ]);
      }
      throw new Error(`unexpected path: ${p}`);
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns false when config is malformed JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) return 'not valid json';
      return '[]';
    });
    expect(monitor.isTeamDisbanded()).toBe(false);
  });

  it('returns false when members field is missing from config', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p: string) => {
      if (p === configPath) return JSON.stringify({ leadSessionId: 'abc' });
      if (p === inboxPath) return '[]';
      throw new Error(`unexpected path: ${p}`);
    });
    // members defaults to [] → nonLeaderMembers.length === 0 → false
    expect(monitor.isTeamDisbanded()).toBe(false);
  });
});
