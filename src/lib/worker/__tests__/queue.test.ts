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
  enqueueSession,
  registerSessionWorker,
  stopBoss,
  type RunSessionJobData,
} from '../queue';

const MockPgBoss = vi.mocked(PgBoss);

beforeEach(() => {
  vi.clearAllMocks();
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

  it('enqueueSession sends job with correct options', async () => {
    const data: RunSessionJobData = {
      sessionId: 'sess-1',
    };

    const jobId = await enqueueSession(data);

    expect(jobId).toBe('job-id-123');
    expect(mockSend).toHaveBeenCalledWith(
      'run-session',
      data,
      expect.objectContaining({
        retryLimit: 1,
        retryDelay: 10,
      }),
    );
  });

  it('enqueueSession returns job ID', async () => {
    const data: RunSessionJobData = {
      sessionId: 'sess-2',
      resumeRef: 'ref-abc',
    };

    const result = await enqueueSession(data);

    expect(result).toBe('job-id-123');
  });

  it('registerSessionWorker calls boss.work 3 times for concurrent slots', async () => {
    const handler = vi.fn();

    await registerSessionWorker(handler);

    expect(mockWork).toHaveBeenCalledTimes(3);
    expect(mockWork).toHaveBeenCalledWith(
      'run-session',
      expect.objectContaining({
        batchSize: 1,
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
