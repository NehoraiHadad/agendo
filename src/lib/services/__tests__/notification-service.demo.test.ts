import { describe, it, expect } from 'vitest';
import { sendPushToAll } from '../notification-service.demo';

describe('notification-service.demo', () => {
  it('sendPushToAll does not throw and returns void', async () => {
    await expect(
      sendPushToAll({ title: 'Test', body: 'Demo notification' }),
    ).resolves.toBeUndefined();
  });

  it('sendPushToAll accepts optional url field', async () => {
    await expect(
      sendPushToAll({ title: 'Task done', body: 'Task completed', url: '/tasks/123' }),
    ).resolves.toBeUndefined();
  });
});
