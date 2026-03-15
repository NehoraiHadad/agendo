#!/usr/bin/env node
/**
 * Standalone script to query Claude models via the SDK.
 *
 * Must run as a separate process because:
 * 1. The SDK's query() fails inside Next.js Turbopack's module system
 * 2. CLAUDECODE env var must be stripped (Claude CLI refuses to start with it)
 *
 * Outputs JSON array to stdout. Exits with code 1 on failure.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
const cliPath = join(dirname(sdkEntry), 'cli.js');

const q = query({
  prompt: 'hi',
  options: {
    pathToClaudeCodeExecutable: cliPath,
    maxTurns: 1,
    cwd: '/tmp',
    permissionMode: 'default',
  },
});

try {
  const models = await q.supportedModels();
  process.stdout.write(JSON.stringify(models));
} finally {
  q.close();
}
