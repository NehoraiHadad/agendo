/**
 * Structured logger using pino.
 *
 * - In production: JSON output (fast, machine-readable)
 * - In development: pino-pretty (human-readable)
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info({ sessionId }, 'Session started');
 *
 *   // Per-module child logger:
 *   const log = logger.child({ module: 'session-runner' });
 *   log.error({ err }, 'Session failed');
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'HH:MM:ss',
      },
    }
  : undefined;

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
    base: { service: 'agendo' },
  },
  transport ? pino.transport(transport) : undefined,
);

/**
 * Create a child logger with a fixed module label.
 * Use this at the top of each module file.
 *
 * @example
 * const log = createLogger('session-runner');
 * log.info({ sessionId }, 'Session started');
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module });
}
