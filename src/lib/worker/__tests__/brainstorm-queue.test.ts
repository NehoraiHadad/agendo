import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing brainstorm-queue
vi.mock('../../config', () => ({
  config: {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
    WORKER_MAX_CONCURRENT_JOBS: 3,
    WORKER_POLL_INTERVAL_MS: 2000,
  },
}));

const mockSend = vi.fn().mockResolvedValue('job-id-456');
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);

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

import {
  BRAINSTORM_QUEUE_NAME,
  enqueueBrainstorm,
  registerBrainstormWorker,
} from '../brainstorm-queue';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BRAINSTORM_QUEUE_NAME', () => {
  it('should be run-brainstorm', () => {
    expect(BRAINSTORM_QUEUE_NAME).toBe('run-brainstorm');
  });
});

describe('enqueueBrainstorm', () => {
  it('sends a job to the brainstorm queue with singletonKey', async () => {
    const roomId = 'room-abc-123';
    const result = await enqueueBrainstorm({ roomId });

    expect(mockSend).toHaveBeenCalledWith(
      BRAINSTORM_QUEUE_NAME,
      { roomId },
      expect.objectContaining({
        singletonKey: roomId,
      }),
    );
    expect(result).toBe('job-id-456');
  });

  it('creates the queue before sending', async () => {
    await enqueueBrainstorm({ roomId: 'room-xyz' });
    expect(mockCreateQueue).toHaveBeenCalledWith(BRAINSTORM_QUEUE_NAME);
  });
});

describe('registerBrainstormWorker', () => {
  it('registers a worker with batchSize of 3 to allow concurrent brainstorm rooms', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    await registerBrainstormWorker(handler);

    expect(mockWork).toHaveBeenCalledWith(
      BRAINSTORM_QUEUE_NAME,
      { batchSize: 3 },
      expect.any(Function),
    );
  });

  it('creates the queue before registering the worker', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await registerBrainstormWorker(handler);
    expect(mockCreateQueue).toHaveBeenCalledWith(BRAINSTORM_QUEUE_NAME);
  });

  it('calls the handler for each job in the batch', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);

    await registerBrainstormWorker(handler);

    // Extract the batch handler that was passed to boss.work()
    const [, , batchHandler] = mockWork.mock.calls[0] as [
      string,
      { batchSize: number },
      (jobs: Array<{ data: { roomId: string } }>) => Promise<void>,
    ];

    const jobs = [
      { data: { roomId: 'room-1' } },
      { data: { roomId: 'room-2' } },
      { data: { roomId: 'room-3' } },
    ];

    await batchHandler(jobs as Parameters<typeof batchHandler>[0]);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledWith(jobs[0]);
    expect(handler).toHaveBeenCalledWith(jobs[1]);
    expect(handler).toHaveBeenCalledWith(jobs[2]);
  });
});
