import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need dynamic imports because config.ts eagerly evaluates process.env on import.
// vi.resetModules() clears the module cache so each test gets a fresh parse.

const VALID_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'test-secret-at-least-16-chars',
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('parses valid full config successfully', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);

    const { config } = await import('../config');

    expect(config.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(config.JWT_SECRET).toBe(VALID_ENV.JWT_SECRET);
  });

  it('fails when DATABASE_URL is missing', async () => {
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);
    // Ensure DATABASE_URL is not set
    delete process.env.DATABASE_URL;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(import('../config')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('fails when JWT_SECRET is shorter than 16 chars', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', 'short');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(import('../config')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('applies default values for optional fields', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);

    const { config } = await import('../config');

    expect(config.WORKER_ID).toBe('worker-1');
    expect(config.PORT).toBe(4100);
    expect(config.NODE_ENV).toBe('test'); // vitest sets NODE_ENV=test
    expect(config.TERMINAL_WS_PORT).toBe(4101);
    expect(config.LOG_DIR).toBe('/data/agendo/logs');
    expect(config.WORKER_POLL_INTERVAL_MS).toBe(2000);
    expect(config.WORKER_MAX_CONCURRENT_JOBS).toBe(3);
    expect(config.STALE_JOB_THRESHOLD_MS).toBe(120000);
    expect(config.HEARTBEAT_INTERVAL_MS).toBe(30000);
  });

  it('coerces string numbers to actual numbers', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);
    vi.stubEnv('PORT', '9000');
    vi.stubEnv('WORKER_POLL_INTERVAL_MS', '5000');

    const { config } = await import('../config');

    expect(config.PORT).toBe(9000);
    expect(config.WORKER_POLL_INTERVAL_MS).toBe(5000);
  });

  it('splits ALLOWED_WORKING_DIRS on colons', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);
    vi.stubEnv('ALLOWED_WORKING_DIRS', '/home/user/projects:/tmp:/opt');

    const { allowedWorkingDirs } = await import('../config');

    expect(allowedWorkingDirs).toEqual(['/home/user/projects', '/tmp', '/opt']);
  });

  it('filters empty segments from ALLOWED_WORKING_DIRS', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);
    vi.stubEnv('ALLOWED_WORKING_DIRS', '/home/user::/tmp:');

    const { allowedWorkingDirs } = await import('../config');

    expect(allowedWorkingDirs).toEqual(['/home/user', '/tmp']);
  });

  it('fails on invalid NODE_ENV value', async () => {
    vi.stubEnv('DATABASE_URL', VALID_ENV.DATABASE_URL);
    vi.stubEnv('JWT_SECRET', VALID_ENV.JWT_SECRET);
    vi.stubEnv('NODE_ENV', 'staging');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    await expect(import('../config')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
