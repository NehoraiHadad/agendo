import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTerminalToken, verifyTerminalToken } from '@/terminal/auth';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-jwt';

describe('terminal auth', () => {
  describe('createTerminalToken + verifyTerminalToken', () => {
    it('round-trips a valid token', () => {
      const token = createTerminalToken(
        { sessionName: 'claude-abc', userId: 'user-1' },
        TEST_SECRET,
      );

      const payload = verifyTerminalToken(token, TEST_SECRET);
      expect(payload.sessionName).toBe('claude-abc');
      expect(payload.userId).toBe('user-1');
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('rejects token with wrong secret', () => {
      const token = createTerminalToken({ sessionName: 'test', userId: 'user-1' }, TEST_SECRET);

      expect(() => verifyTerminalToken(token, 'wrong-secret-that-is-long-enough')).toThrow(
        'Invalid token signature',
      );
    });

    it('rejects expired token', () => {
      // Create a token that's already expired by manipulating the payload
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url',
      );
      const expiredPayload = {
        sessionName: 'test',
        userId: 'user-1',
        exp: Math.floor(Date.now() / 1000) - 100, // 100 seconds ago
      };
      const body = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');

      const sig = createHmac('sha256', TEST_SECRET).update(`${header}.${body}`).digest('base64url');

      const token = `${header}.${body}.${sig}`;

      expect(() => verifyTerminalToken(token, TEST_SECRET)).toThrow('Token expired');
    });

    it('rejects malformed token', () => {
      expect(() => verifyTerminalToken('not-a-jwt', TEST_SECRET)).toThrow('Invalid token format');
    });
  });
});
