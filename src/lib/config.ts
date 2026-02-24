import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  WORKER_ID: z.string().default('worker-1'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  WORKER_MAX_CONCURRENT_JOBS: z.coerce.number().default(3),
  LOG_DIR: z.string().default('/data/agendo/logs'),
  STALE_JOB_THRESHOLD_MS: z.coerce.number().default(120000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(30000),
  ALLOWED_WORKING_DIRS: z.string().default('/home/ubuntu/projects:/tmp'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  TERMINAL_WS_PORT: z.coerce.number().default(4101),
  JWT_SECRET: z.string().min(16),
  MCP_SERVER_PATH: z.string().optional(),
  TERMINAL_JWT_SECRET: z.string().min(16).optional(),
  // Web Push (VAPID) — optional, push notifications disabled if not set
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

/** Parsed ALLOWED_WORKING_DIRS as array of absolute paths */
export const allowedWorkingDirs = config.ALLOWED_WORKING_DIRS.split(':').filter(Boolean);

/** Terminal JWT secret: falls back to JWT_SECRET if TERMINAL_JWT_SECRET not set */
export const terminalJwtSecret = config.TERMINAL_JWT_SECRET ?? config.JWT_SECRET;
