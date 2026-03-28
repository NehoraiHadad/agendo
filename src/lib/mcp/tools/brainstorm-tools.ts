/**
 * Brainstorm signal tools: brainstorm_signal, brainstorm_get_state
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleBrainstormSignal(args: {
  signal: 'done' | 'pass' | 'block';
  reason?: string;
}): Promise<unknown> {
  const sessionId = process.env.AGENDO_SESSION_ID;
  if (!sessionId) {
    throw new Error('AGENDO_SESSION_ID not set — cannot send brainstorm signal outside a session');
  }

  // Require reason for pass and block
  if ((args.signal === 'pass' || args.signal === 'block') && !args.reason) {
    throw new Error(`A reason is required when signaling '${args.signal}'`);
  }

  return apiCall('/api/brainstorms/signal', {
    method: 'POST',
    body: {
      sessionId,
      signal: args.signal,
      reason: args.reason,
    },
  });
}

export async function handleBrainstormGetState(): Promise<unknown> {
  const sessionId = process.env.AGENDO_SESSION_ID;
  if (!sessionId) {
    throw new Error('AGENDO_SESSION_ID not set — cannot get brainstorm state outside a session');
  }

  return apiCall(`/api/brainstorms/state?sessionId=${encodeURIComponent(sessionId)}`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBrainstormTools(server: McpServer): void {
  server.tool(
    'brainstorm_signal',
    'Signal your brainstorm turn state. Use instead of text-based [PASS]. Call with done when your response is complete, pass when you agree and have nothing to add (reason required), or block for a critical objection (reason required).',
    {
      signal: z
        .enum(['done', 'pass', 'block'])
        .describe(
          'done = response complete, pass = agree/nothing to add, block = critical objection',
        ),
      reason: z.string().optional().describe('Brief reason (required for pass and block signals)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleBrainstormSignal(args)),
  );

  server.tool(
    'brainstorm_get_state',
    'Get current brainstorm room state: wave number, participants, who has responded, your role, and whether you are the leader.',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    () => wrapToolCall(() => handleBrainstormGetState()),
  );
}
