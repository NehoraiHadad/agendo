import { describe, it, expect } from 'vitest';
import { logAudit, logSessionAudit, logTaskAudit } from '../audit-service.demo';

describe('audit-service.demo', () => {
  it('logAudit does not throw and returns void', async () => {
    await expect(
      logAudit('system', 'task.create', 'task', 'some-uuid', { title: 'Test' }),
    ).resolves.toBeUndefined();
  });

  it('logAudit accepts null actor', async () => {
    await expect(logAudit(null, 'session.start', 'session')).resolves.toBeUndefined();
  });

  it('logSessionAudit does not throw and returns void', async () => {
    await expect(
      logSessionAudit('session.start', '77777777-7777-4777-a777-777777777777'),
    ).resolves.toBeUndefined();
  });

  it('logTaskAudit does not throw and returns void', async () => {
    await expect(
      logTaskAudit('task.update', '11111111-1111-4111-a111-111111111111', { status: 'done' }),
    ).resolves.toBeUndefined();
  });
});
