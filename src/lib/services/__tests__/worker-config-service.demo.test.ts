import { describe, it, expect } from 'vitest';
import { getWorkerConfigNumber } from '../worker-config-service.demo';

describe('worker-config-service.demo', () => {
  it('returns the default value for known keys', async () => {
    await expect(getWorkerConfigNumber('max_spawn_depth')).resolves.toBe(3);
    await expect(getWorkerConfigNumber('max_concurrent_ai_agents')).resolves.toBe(3);
    await expect(getWorkerConfigNumber('max_tasks_per_agent_per_minute')).resolves.toBe(10);
    await expect(getWorkerConfigNumber('log_retention_days')).resolves.toBe(30);
  });

  it('returns the explicit fallback when provided', async () => {
    await expect(getWorkerConfigNumber('unknown_key', 42)).resolves.toBe(42);
  });

  it('returns 0 for an unknown key with no fallback', async () => {
    await expect(getWorkerConfigNumber('completely_unknown')).resolves.toBe(0);
  });

  it('fallback overrides the built-in default', async () => {
    await expect(getWorkerConfigNumber('max_spawn_depth', 99)).resolves.toBe(99);
  });
});
