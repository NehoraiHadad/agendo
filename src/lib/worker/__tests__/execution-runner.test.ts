import { describe, it, vi, beforeEach } from 'vitest';

const { mockExecution, mockAgent, mockCapability, mockManagedProcess } = vi.hoisted(() => {
  const mockExecution = {
    id: 'exec-1',
    agentId: 'agent-1',
    capabilityId: 'cap-1',
    mode: 'template' as const,
    args: {},
    parentExecutionId: null,
    sessionRef: null,
    status: 'queued' as const,
  };

  const mockAgent = {
    id: 'agent-1',
    name: 'Test Agent',
    binaryPath: '/usr/bin/test',
    workingDir: '/tmp',
    envAllowlist: [],
  };

  const mockCapability = {
    id: 'cap-1',
    interactionMode: 'template' as const,
    commandTokens: ['test', 'run'],
    promptTemplate: null,
    argsSchema: null,
    timeoutSec: 10,
    maxOutputBytes: 1024,
  };

  // onExit calls callback synchronously when registered
  const mockManagedProcess = {
    pid: 12345,
    tmuxSession: 'test-session',
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (code: number | null) => void) => {
      // Call immediately to resolve the exit promise
      Promise.resolve().then(() => cb(0));
    }),
  };

  return { mockExecution, mockAgent, mockCapability, mockManagedProcess };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockExecution]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  executions: { id: 'id', status: 'status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@/lib/services/agent-service', () => ({
  getAgentById: vi.fn().mockResolvedValue(mockAgent),
}));

vi.mock('@/lib/services/capability-service', () => ({
  getCapabilityById: vi.fn().mockResolvedValue(mockCapability),
}));

vi.mock('@/lib/worker/safety', () => ({
  validateWorkingDir: vi.fn((dir: string) => dir),
  buildChildEnv: vi.fn(() => ({ PATH: '/usr/bin', TERM: 'xterm-256color' })),
  buildCommandArgs: vi.fn((tokens: string[]) => tokens),
  validateArgs: vi.fn(),
  validateBinary: vi.fn(),
}));

vi.mock('@/lib/worker/log-writer', () => ({
  FileLogWriter: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    writeSystem: vi.fn(),
    close: vi.fn().mockResolvedValue({ byteSize: 100, lineCount: 5 }),
    stats: { byteSize: 100, lineCount: 5 },
  })),
  resolveLogPath: vi.fn(() => '/tmp/test.log'),
}));

vi.mock('@/lib/worker/heartbeat', () => ({
  ExecutionHeartbeat: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('@/lib/worker/adapters/adapter-factory', () => ({
  selectAdapter: vi.fn(() => ({
    spawn: vi.fn(() => mockManagedProcess),
    resume: vi.fn(() => mockManagedProcess),
    extractSessionId: vi.fn(() => null),
  })),
}));

import { runExecution } from '@/lib/worker/execution-runner';

describe('runExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes execution with exit code 0', async () => {
    await runExecution({ executionId: 'exec-1', workerId: 'w-1' });
    // Should complete without throwing
  });
});
