/**
 * Plan tools: save_plan
 *
 * Universal plan capture — works for Claude, Codex, and Gemini.
 * Agents call this when their plan is finalized, instead of relying on
 * CLI-native plan mode (ExitPlanMode / Gemini plan files).
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleSavePlan(args: {
  content: string;
  title?: string;
  planId?: string;
  visual_content?: string;
}): Promise<unknown> {
  const sessionId = process.env.AGENDO_SESSION_ID;
  return apiCall('/api/plans/mcp-save', {
    method: 'POST',
    body: {
      content: args.content,
      ...(args.title ? { title: args.title } : {}),
      ...(args.planId ? { planId: args.planId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(args.visual_content ? { visualContent: args.visual_content } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanTools(server: McpServer): void {
  server.tool(
    'save_plan',
    'Save or update an implementation plan. Call this when your plan is finalized and ready for review. The plan will be linked to the current project.',
    {
      content: z.string().describe('Full plan content in markdown'),
      title: z
        .string()
        .max(500)
        .optional()
        .describe('Plan title (auto-extracted from first heading if omitted)'),
      planId: z
        .string()
        .uuid()
        .optional()
        .describe('Existing plan ID to update (omit to create a new plan)'),
      visual_content: z
        .string()
        .optional()
        .describe(
          'Optional self-contained HTML document to attach as a visual artifact alongside the plan (inline CSS/JS only, no external dependencies)',
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleSavePlan(args)),
  );
}
