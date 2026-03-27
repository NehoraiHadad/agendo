import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('approval-handler');
import type {
  AgentAdapter,
  SupportsToolResult,
  ApprovalRequest,
  PermissionDecision,
} from '@/lib/worker/adapters/types';
import { supportsToolResult } from '@/lib/worker/adapters/types';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import type { Session } from '@/lib/types';
import { savePlanFromSession } from '@/lib/worker/session-plan-utils';

/**
 * ApprovalHandler manages all state and logic related to per-tool approval gates,
 * interactive tool responses (AskUserQuestion), and suppressed tool tracking.
 *
 * Extracted from SessionProcess to keep session-process.ts focused on lifecycle
 * and event routing rather than approval bookkeeping.
 */
export class ApprovalHandler {
  /**
   * Tools that must always require human approval via the control_request path,
   * regardless of permissionMode. These represent human-interaction gates.
   *
   * - ExitPlanMode / exit_plan_mode: plan approval gate
   * - AskUserQuestion: must block until user selects answers; the answers are
   *   returned in updatedInput of the control_response so Claude's call()
   *   receives them and produces a proper tool result (instead of empty answers).
   *
   * NOTE: AskUserQuestion sends `can_use_tool` like every other tool. We must
   * NOT auto-approve it — blocking here keeps Claude waiting while the UI card
   * collects the user's selections.
   */
  static readonly APPROVAL_GATED_TOOLS = new Set([
    'ExitPlanMode',
    'exit_plan_mode',
    'AskUserQuestion',
  ]);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private pendingApprovals = new Map<string, (decision: PermissionDecision) => void>();
  /** Maps toolName → pending approvalId, so a duplicate call auto-denies the old one. */
  private pendingApprovalsByTool = new Map<string, string>();
  /** toolUseIds for APPROVAL_GATED_TOOLS — suppress their agent:tool-start/end events. */
  private suppressedToolUseIds = new Set<string>();
  constructor(
    private readonly session: Session,
    private readonly adapter: Pick<AgentAdapter, 'sendMessage'> & Partial<SupportsToolResult>,
    private readonly emitEvent: (payload: AgendoEventPayload) => Promise<AgendoEvent>,
    private readonly transitionTo: (status: SessionStatus) => Promise<void>,
    private readonly resetIdleTimer: () => void,
    private readonly capturePlanFilePath: () => Promise<void>,
    /** Shared reference to SessionProcess.activeToolUseIds — mutations are visible to both. */
    private readonly activeToolUseIds: Set<string>,
  ) {}

  // ---------------------------------------------------------------------------
  // Suppression helpers for SessionProcess.onData
  // ---------------------------------------------------------------------------

  /** Mark a tool-start as suppressed (used for APPROVAL_GATED_TOOLS in onData). */
  suppressToolStart(toolUseId: string): void {
    this.suppressedToolUseIds.add(toolUseId);
  }

  /**
   * Check if a tool-end is suppressed. If so, removes from both suppressedToolUseIds
   * and activeToolUseIds and returns true. The caller should skip emitting the event.
   */
  isSuppressedToolEnd(toolUseId: string, activeToolUseIds: Set<string>): boolean {
    if (!this.suppressedToolUseIds.has(toolUseId)) return false;
    activeToolUseIds.delete(toolUseId);
    this.suppressedToolUseIds.delete(toolUseId);
    return true;
  }

  /** Clear all suppressed tool IDs (called from handleCancel / handleInterrupt). */
  clearSuppressed(): void {
    this.suppressedToolUseIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Resolver access (for onControl in SessionProcess)
  // ---------------------------------------------------------------------------

  /**
   * Remove and return the approval resolver for a given approvalId (or requestId).
   * Returns undefined if not found.
   */
  takeResolver(approvalId: string): ((decision: PermissionDecision) => void) | undefined {
    const resolver = this.pendingApprovals.get(approvalId);
    if (resolver) {
      this.pendingApprovals.delete(approvalId);
    }
    return resolver;
  }

  // ---------------------------------------------------------------------------
  // Drain (called on cancel, terminate, onExit)
  // ---------------------------------------------------------------------------

  /**
   * Resolve all pending tool approval promises with the given decision so that
   * any adapter blocked on `handleApprovalRequest` unblocks immediately. Called
   * on cancel, terminate, and idle-timeout to prevent the process from hanging
   * forever waiting for a human who will never respond.
   */
  drain(decision: 'allow' | 'deny' | 'allow-session'): void {
    for (const [, resolver] of this.pendingApprovals) {
      resolver(decision);
    }
    this.pendingApprovals.clear();
    this.pendingApprovalsByTool.clear();
  }

  // ---------------------------------------------------------------------------
  // Main approval request (wired to adapter.setApprovalHandler)
  // ---------------------------------------------------------------------------

  /**
   * Handle a per-tool approval request from the adapter.
   * If the tool is already on the session allowlist, returns 'allow' immediately.
   * Otherwise, emits an agent:tool-approval event to the frontend and blocks
   * until the user responds via the control channel.
   */
  async handleApprovalRequest(req: ApprovalRequest): Promise<PermissionDecision> {
    const { approvalId, toolName, toolInput } = req;

    // Check per-session allowlist — no round-trip to the user needed.
    if (this.isToolAllowed(toolName)) {
      return 'allow';
    }

    // Integration sessions run fully autonomously — auto-approve all tool requests,
    // including ExitPlanMode (so the planner can proceed to implementation without
    // waiting for a human to click through the approval card).
    if (this.session.kind === 'integration') {
      return 'allow';
    }

    // Auto-deny any previous pending approval for the same tool to prevent duplicate cards.
    const existingApprovalId = this.pendingApprovalsByTool.get(toolName);
    if (existingApprovalId) {
      const existingResolver = this.pendingApprovals.get(existingApprovalId);
      if (existingResolver) {
        existingResolver('deny');
        this.pendingApprovals.delete(existingApprovalId);
      }
      this.pendingApprovalsByTool.delete(toolName);
    }
    this.pendingApprovalsByTool.set(toolName, approvalId);

    // When ExitPlanMode fires, eagerly capture the plan content and persist it
    // so clearContextRestart works even if the session goes idle before the user
    // clicks. The plan file is in ~/.claude/plans/ with a random hash name;
    // we grab the most recently modified one while the session is still active.
    // (AskUserQuestion does not need plan capture — only ExitPlanMode does.)
    if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
      await this.capturePlanFilePath();

      // In plan-page sessions (plan mode + no task), auto-deny ExitPlanMode so
      // the agent stays in plan mode. The plan file was captured above — save its
      // content to the DB so the editor auto-refreshes. No approval card is shown.
      // Task sessions in plan mode show the approval card so the user can decide.
      if (this.session.kind === 'plan') {
        savePlanFromSession(this.session).catch((err: unknown) => {
          log.warn({ err }, 'Failed to auto-save plan');
        });
        await this.emitEvent({
          type: 'system:info',
          message: 'Plan saved — content synced to the editor.',
        });
        this.pendingApprovalsByTool.delete(toolName);
        return 'deny';
      }
    }

    // Emit approval request event to frontend and block until user responds.
    await this.emitEvent({
      type: 'agent:tool-approval',
      approvalId,
      toolName,
      toolInput,
      dangerLevel: 0,
    });

    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, (decision) => {
        this.pendingApprovalsByTool.delete(toolName);
        resolve(decision);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // pushToolResult (wired from onControl tool-result)
  // ---------------------------------------------------------------------------

  /**
   * Send a tool_result back to the agent for a pending tool_use.
   * Only valid when the session is active or awaiting_input.
   */
  async pushToolResult(toolUseId: string, content: string): Promise<void> {
    if (!supportsToolResult(this.adapter as AgentAdapter)) {
      log.warn('adapter does not support sendToolResult');
      return;
    }
    await (this.adapter as AgentAdapter & SupportsToolResult).sendToolResult(toolUseId, content);
    await this.transitionTo('active');
    this.resetIdleTimer();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a tool name is already on the session's persistent allowlist.
   * Supports exact match and prefix-match patterns (e.g. "Bash(npm test)" pattern
   * matches the tool name "Bash").
   */
  private isToolAllowed(toolName: string): boolean {
    const allowed = this.session.allowedTools;
    if (!allowed?.length) return false;
    return allowed.some((pattern) => {
      return toolName === pattern || toolName.startsWith(pattern.split('(')[0]);
    });
  }

  /**
   * Append a tool name to the session's allowedTools list and persist it to DB.
   * Called when the user approves a tool with 'allow-session'.
   */
  async persistAllowedTool(toolName: string): Promise<void> {
    const allowed = this.session.allowedTools ?? [];
    if (!allowed.includes(toolName)) {
      const updated = [...allowed, toolName];
      this.session.allowedTools = updated;
      await db
        .update(sessions)
        .set({ allowedTools: updated })
        .where(eq(sessions.id, this.session.id));
    }
  }
}
