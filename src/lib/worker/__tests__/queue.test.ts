import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing queue
vi.mock('../../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
    WORKER_MAX_CONCURRENT_JOBS: 3,
    WORKER_POLL_INTERVAL_MS: 2000,
  },
}));

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue('job-id-123');
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockCreateQueue = vi.fn().mockResolvedValue(undefined);

vi.mock('pg-boss', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      start: mockStart,
      send: mockSend,
      work: mockWork,
      stop: mockStop,
      createQueue: mockCreateQueue,
    })),
  };
});

import PgBoss from 'pg-boss';
import {
  getBoss,
  enqueueExecution,
  registerWorker,
  stopBoss,
  type ExecuteCapabilityJobData,
} from '../queue';

const MockPgBoss = vi.mocked(PgBoss);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the singleton by calling stopBoss (which sets bossInstance = null)
  // We need to do this carefully since stopBoss checks bossInstance
});

// Since the module has internal singleton state, we need a helper
// to reset it between tests
async function resetSingleton() {
  await stopBoss();
  mockStop.mockClear();
}

describe('queue', () => {
  beforeEach(async () => {
    await resetSingleton();
  });

  it('getBoss returns a PgBoss instance', async () => {
    const boss = await getBoss();

    expect(boss).toBeDefined();
    expect(MockPgBoss).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://user:pass@localhost:5432/testdb',
        schema: 'pgboss',
      }),
    );
    expect(mockStart).toHaveBeenCalled();
  });

  it('getBoss returns singleton (same instance on 2nd call)', async () => {
    const boss1 = await getBoss();
    const boss2 = await getBoss();

    expect(boss1).toBe(boss2);
    // PgBoss constructor called only once
    expect(MockPgBoss).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('enqueueExecution sends job with correct options', async () => {
    const data: ExecuteCapabilityJobData = {
      executionId: 'exec-1',
      capabilityId: 'cap-1',
      agentId: 'agent-1',
      args: { prompt: 'test' },
    };

    const jobId = await enqueueExecution(data);

    expect(jobId).toBe('job-id-123');
    expect(mockSend).toHaveBeenCalledWith(
      'execute-capability',
      data,
      expect.objectContaining({
        expireInMinutes: 45,
        retryLimit: 2,
        retryDelay: 30,
      }),
    );
  });

  it('enqueueExecution returns job ID', async () => {
    const data: ExecuteCapabilityJobData = {
      executionId: 'exec-2',
      capabilityId: 'cap-2',
      agentId: 'agent-2',
      args: {},
    };

    const result = await enqueueExecution(data);

    expect(result).toBe('job-id-123');
  });

  it('registerWorker calls boss.work with config values', async () => {
    const handler = vi.fn();

    await registerWorker(handler);

    expect(mockWork).toHaveBeenCalledWith(
      'execute-capability',
      expect.objectContaining({
        batchSize: 3,
        pollingIntervalSeconds: 2, // Math.ceil(2000 / 1000)
      }),
      expect.any(Function),
    );
  });

  it('stopBoss calls boss.stop with graceful + timeout', async () => {
    await getBoss(); // ensure instance exists
    mockStop.mockClear();

    await stopBoss();

    expect(mockStop).toHaveBeenCalledWith({ graceful: true, timeout: 10000 });
  });

  it('stopBoss is idempotent (no-op when no instance)', async () => {
    // Singleton is already null from resetSingleton
    mockStop.mockClear();

    await stopBoss(); // should not throw

    expect(mockStop).not.toHaveBeenCalled();
  });

  it('stopBoss clears singleton (next getBoss creates new)', async () => {
    await getBoss();
    MockPgBoss.mockClear();
    mockStart.mockClear();

    await stopBoss();

    // Now getBoss should create a new instance
    await getBoss();
    expect(MockPgBoss).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
