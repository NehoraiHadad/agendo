/**
 * Event routing logic extracted from SessionProcess.onData().
 *
 * Processes a parsed NDJSON object into AgendoEvents: maps JSON to events via
 * the adapter, handles tool suppression for approval-gated and interactive tools,
 * tracks in-flight tool calls, detects team lifecycle events, persists session
 * metadata (sessionRef, model), and triggers state transitions on agent results.
 */

import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import type { AgentAdapter } from '@/lib/worker/adapters/types';
import { ApprovalHandler } from '@/lib/worker/approval-handler';
import type { ActivityTracker } from '@/lib/worker/activity-tracker';
import type { SessionTeamManager } from '@/lib/worker/session-team-manager';
import { mapClaudeJsonToEvents } from '@/lib/worker/adapters/claude-event-mapper';

export interface EventRouterCtx {
  sessionId: string;
  adapter: AgentAdapter;
  approvalHandler: ApprovalHandler;
  activityTracker: ActivityTracker;
  teamManager: SessionTeamManager;
  activeToolUseIds: Set<string>;
  interruptInProgress: boolean;

  emitEvent(payload: AgendoEventPayload): Promise<AgendoEvent>;
  transitionTo(status: SessionStatus): Promise<void>;
  setSessionRef(ref: string): void;
}

/**
 * Route a parsed NDJSON object through the event pipeline: detect interactive
 * tool responses, map JSON to AgendoEvents, filter suppressed tools, track
 * tool lifecycle, and trigger state transitions.
 *
 * @param parsed - The parsed JSON object from the agent's stdout
 * @param trimmed - The original trimmed line (for error logging)
 * @param ctx - The routing context providing access to session state and callbacks
 */
export async function routeParsedEvent(
  parsed: Record<string, unknown>,
  trimmed: string,
  ctx: EventRouterCtx,
): Promise<void> {
  // Generic interactive tool detection: when Claude's own NDJSON output
  // contains a type:'user' block with is_error:true tool_results, it means
  // the CLI tried to handle an interactive tool (AskUserQuestion, ExitPlanMode,
  // or any future tool) natively but failed in pipe mode. We detect this
  // from the raw parsed object BEFORE emitting events, so the suppression
  // check below can immediately catch the resulting agent:tool-end partial.
  //
  // This is fully generic — no hardcoded tool name list needed for the
  // NDJSON path. The is_error flag in Claude's own output is the signal.
  if (parsed.type === 'user') {
    const msg = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
    ctx.approvalHandler.checkForHumanResponseBlocks(msg?.content ?? [], ctx.activeToolUseIds);
  }

  let partials: AgendoEventPayload[];
  try {
    partials = ctx.adapter.mapJsonToEvents
      ? ctx.adapter.mapJsonToEvents(parsed)
      : mapClaudeJsonToEvents(parsed, {
          clearDeltaBuffers: () => ctx.activityTracker.clearDeltaBuffers(),
          appendDelta: (text) => ctx.activityTracker.appendDelta(text),
          appendThinkingDelta: (text) => ctx.activityTracker.appendThinkingDelta(text),
          onResultStats: (costUsd, turns) => {
            void db
              .update(sessions)
              .set({
                ...(costUsd !== null && { totalCostUsd: String(costUsd) }),
                ...(turns !== null && { totalTurns: turns }),
              })
              .where(eq(sessions.id, ctx.sessionId))
              .catch((err: unknown) => {
                console.error(
                  `[session-process] cost stats update failed for session ${ctx.sessionId}:`,
                  err,
                );
              });
          },
        });
  } catch (mapErr) {
    console.warn(
      `[session-process] mapJsonToEvents error for session ${ctx.sessionId}:`,
      mapErr,
      'line:',
      trimmed.slice(0, 200),
    );
    return;
  }

  for (const partial of partials) {
    // Suppress tool-start/tool-end for approval-gated tools (ExitPlanMode, …).
    // These appear only as control_request approval cards — not as ToolCard widgets.
    if (
      partial.type === 'agent:tool-start' &&
      ApprovalHandler.APPROVAL_GATED_TOOLS.has(partial.toolName)
    ) {
      ctx.activeToolUseIds.add(partial.toolUseId); // keep for cleanup
      ctx.approvalHandler.suppressToolStart(partial.toolUseId);
      continue;
    }
    if (
      partial.type === 'agent:tool-end' &&
      ctx.approvalHandler.isSuppressedToolEnd(partial.toolUseId, ctx.activeToolUseIds)
    ) {
      continue;
    }

    // Suppress the error tool-end for any interactive tool: the UI card
    // stays live and pushToolResult routes the human's answer when it arrives.
    if (
      partial.type === 'agent:tool-end' &&
      ctx.approvalHandler.isPendingHumanResponse(partial.toolUseId)
    ) {
      continue; // suppress — keep in activeToolUseIds until human responds
    }

    const event = await ctx.emitEvent(partial);

    // Track in-flight tool calls to enable synthetic cleanup on cancel.
    if (event.type === 'agent:tool-start') {
      ctx.activeToolUseIds.add(event.toolUseId);
    }
    if (event.type === 'agent:tool-end') {
      ctx.activeToolUseIds.delete(event.toolUseId);
    }

    // Detect TeamCreate / TeamDelete tool events for team lifecycle.
    if (event.type === 'agent:tool-start' || event.type === 'agent:tool-end') {
      ctx.teamManager.onToolEvent(event);
    }

    // Persist sessionRef and model once the agent announces its session ID.
    if (event.type === 'session:init') {
      const updates: Record<string, string> = {};
      if (event.sessionRef) {
        ctx.setSessionRef(event.sessionRef);
        updates.sessionRef = event.sessionRef;
      }
      if (event.model) {
        updates.model = event.model;
      }
      if (Object.keys(updates).length > 0) {
        await db.update(sessions).set(updates).where(eq(sessions.id, ctx.sessionId));
      }
    }

    // After the agent finishes a result, transition to awaiting_input.
    // Skip during an interrupt — handleInterrupt() manages the transition
    // based on whether the process survived (warm vs cold resume).
    if (event.type === 'agent:result' && !ctx.interruptInProgress) {
      await ctx.transitionTo('awaiting_input');
      ctx.activityTracker.recordActivity();
    }
  }
}
