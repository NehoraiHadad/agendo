// ecosystem.config.example.js — PM2 configuration for Agendo
//
// Copy this file to ecosystem.config.js and adjust values for your environment.
// Then start all services: pm2 start ecosystem.config.js
//
// Load environment variables from .env.local so all services share
// the same config source (DATABASE_URL, JWT_SECRET, VAPID keys, etc.).
require('dotenv').config({ path: '.env.local' });

const path = require('path');
const ROOT = __dirname;

const PORT = process.env.PORT || '4100';

module.exports = {
  apps: [
    // ---------------------------------------------------------------
    // Next.js App (port 4100)
    //
    // Serves the web UI, API routes, and SSE endpoints.
    // Also hosts the MCP server — restarting this drops live agent
    // MCP connections. Use ./scripts/safe-restart-agendo.sh to
    // restart safely (waits for active sessions to finish).
    // ---------------------------------------------------------------
    {
      name: 'agendo',
      cwd: ROOT,
      script: 'pnpm',
      // For production use 'start' (requires `pnpm build` first).
      // For development use 'dev' instead.
      args: 'start',
      interpreter: 'none',
      env: {
        PORT,
        NODE_OPTIONS: '--max-old-space-size=1024',
        NODE_ENV: 'production',
      },
      max_restarts: 5,
      restart_delay: 3000,
    },

    // ---------------------------------------------------------------
    // Worker
    //
    // Dequeues pg-boss jobs (run-session, execute-capability),
    // spawns AI CLI subprocesses, and streams AgendoEvents via
    // PG NOTIFY. Always safe to restart — does NOT host MCP.
    //
    //   pm2 restart agendo-worker --update-env
    //
    // Build first: pnpm worker:build
    // ---------------------------------------------------------------
    {
      name: 'agendo-worker',
      cwd: ROOT,
      script: 'node',
      args: 'dist/worker/index.js',
      env: {
        NODE_OPTIONS: '--max-old-space-size=512',
        NODE_ENV: 'production',

        // Database
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/agendo',

        // Auth — must match the Next.js app's JWT_SECRET
        JWT_SECRET: process.env.JWT_SECRET || 'change-me-min-16-characters!!',

        // Worker identity & tuning
        WORKER_ID: process.env.WORKER_ID || 'worker-1',
        WORKER_POLL_INTERVAL_MS: process.env.WORKER_POLL_INTERVAL_MS || '2000',
        WORKER_MAX_CONCURRENT_JOBS: process.env.WORKER_MAX_CONCURRENT_JOBS || '3',

        // Logs directory (created automatically if missing)
        LOG_DIR: process.env.LOG_DIR || './logs',

        // Health / liveness
        STALE_JOB_THRESHOLD_MS: process.env.STALE_JOB_THRESHOLD_MS || '120000',
        HEARTBEAT_INTERVAL_MS: process.env.HEARTBEAT_INTERVAL_MS || '30000',

        // Security — colon-separated list of directories agents may access
        ALLOWED_WORKING_DIRS:
          process.env.ALLOWED_WORKING_DIRS || `${process.env.HOME || '/tmp'}/projects:/tmp`,

        // MCP server bundle path (built via `pnpm build:mcp`)
        MCP_SERVER_PATH: process.env.MCP_SERVER_PATH || path.join(ROOT, 'dist', 'mcp-server.js'),

        // URL the MCP server uses to call back into the Next.js API
        AGENDO_URL: process.env.AGENDO_URL || `http://localhost:${PORT}`,

        // Web Push (VAPID) — optional, push notifications disabled if unset
        VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
        VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
        VAPID_SUBJECT: process.env.VAPID_SUBJECT || '',
      },
      max_restarts: 5,
      restart_delay: 3000,
      kill_timeout: 30000, // wait 30s for graceful shutdown before SIGKILL
    },

    // ---------------------------------------------------------------
    // Terminal Server (port 4101)
    //
    // Provides xterm.js + node-pty backed terminal sessions over
    // socket.io. Safe to restart at any time (drops open terminals).
    // ---------------------------------------------------------------
    {
      name: 'agendo-terminal',
      cwd: ROOT,
      script: 'pnpm',
      args: 'tsx src/terminal/server.ts',
      interpreter: 'none',
      env: {
        NODE_OPTIONS: '--max-old-space-size=256',
        NODE_ENV: 'production',
        TERMINAL_PORT: process.env.TERMINAL_PORT || '4101',
        JWT_SECRET: process.env.JWT_SECRET || 'change-me-min-16-characters!!',
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/agendo',
        NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL || `http://localhost:${PORT}`,
      },
      max_memory_restart: '512M',
      max_restarts: 5,
      restart_delay: 3000,
    },
  ],
};
