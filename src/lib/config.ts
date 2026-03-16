import { z } from 'zod';
import { createLogger } from './logger';

const log = createLogger('config');

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  WORKER_ID: z.string().default('worker-1'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  WORKER_MAX_CONCURRENT_JOBS: z.coerce.number().default(3),
  LOG_DIR: z.string().default('./logs'),
  STALE_JOB_THRESHOLD_MS: z.coerce.number().default(120000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(30000),
  ALLOWED_WORKING_DIRS: z.string().default(`${process.env.HOME ?? '/tmp'}/projects:/tmp`),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  TERMINAL_WS_PORT: z.coerce.number().default(4101),
  WORKER_HTTP_PORT: z.coerce.number().default(4102),
  JWT_SECRET: z.string().min(16),
  MCP_SERVER_PATH: z.string().optional(),
  TERMINAL_JWT_SECRET: z.string().min(16).optional(),
  // Web Push (VAPID) — optional, push notifications disabled if not set
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  // Summarization provider for agent switching context transfer (all use CLI/OAuth)
  SUMMARIZATION_PROVIDER: z.enum(['gemini', 'claude', 'codex', 'auto']).default('auto'),
  // Override model for summarization (e.g. "gemini-2.5-flash", "haiku", "o4-mini")
  // If not set, uses fast defaults: gemini→Flash, claude→Haiku, codex→o4-mini
  SUMMARIZATION_MODEL: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    log.error(
      { err: result.error, issues: result.error.format() },
      'Invalid environment configuration',
    );
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

/** Parsed ALLOWED_WORKING_DIRS as array of absolute paths */
export const allowedWorkingDirs = config.ALLOWED_WORKING_DIRS.split(':').filter(Boolean);

/** Terminal JWT secret: falls back to JWT_SECRET if TERMINAL_JWT_SECRET not set */
export const terminalJwtSecret = config.TERMINAL_JWT_SECRET ?? config.JWT_SECRET;
