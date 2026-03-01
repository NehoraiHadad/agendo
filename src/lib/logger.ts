/**
 * Minimal structured logger interface.
 *
 * Wraps console with a named prefix so log lines are easy to grep.
 * Drop-in compatible with pino's basic API — swap to pino later if needed.
 */

type LogArgs = [string, ...unknown[]];

interface Logger {
  info(...args: LogArgs): void;
  warn(...args: LogArgs): void;
  error(...args: LogArgs): void;
  debug(...args: LogArgs): void;
}

function makeLogger(prefix: string): Logger {
  return {
    info(msg, ...args) {
      console.log(`[${prefix}]`, msg, ...args);
    },
    warn(msg, ...args) {
      console.warn(`[${prefix}]`, msg, ...args);
    },
    error(msg, ...args) {
      console.error(`[${prefix}]`, msg, ...args);
    },
    debug(msg, ...args) {
      console.debug(`[${prefix}]`, msg, ...args);
    },
  };
}

export function createLogger(prefix: string): Logger {
  return makeLogger(prefix);
}

export const logger = makeLogger('agendo');
