import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type {
  AgentAdapter,
  ApprovalRequest,
  PermissionDecision,
} from '@/lib/worker/adapters/types';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import type { Session } from '@/lib/types';

type AskUserQuestion = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; markdown?: string }>;
  multiSelect: boolean;
};

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
   * regardless of permissionMode.
   *
   * These represent human-interaction gates (plan approval, etc.) rather than
   * dangerous-action permissions. The Claude Code CLI never auto-approves
   * these even in bypassPermissions mode.
   *
   * Note: AskUserQuestion is NOT listed here because it arrives via the NDJSON
   * tool_use path (not control_request) and is detected generically from
   * is_error:true in Claude's stdout — no hardcoded name needed.
   */
  static readonly APPROVAL_GATED_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode']);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private pendingApprovals = new Map<string, (decision: PermissionDecision) => void>();
  /** Maps toolName → pending approvalId, so a duplicate call auto-denies the old one. */
  private pendingApprovalsByTool = new Map<string, string>();
  /** tool_use IDs for interactive tools awaiting a human response via the UI. */
  private pendingHumanResponseIds = new Set<string>();
  /** Stores AskUserQuestion questions indexed by requestId for use when the answer arrives. */
  private pendingAskUserQuestions = new Map<string, AskUserQuestion[]>();
  /** toolUseIds for APPROVAL_GATED_TOOLS — suppress their agent:tool-start/end events. */
  private suppressedToolUseIds = new Set<string>();

  constructor(
    private readonly session: Session,
    private readonly adapter: Pick<AgentAdapter, 'sendMessage' | 'sendToolResult'>,
    private readonly emitEvent: (payload: AgendoEventPayload) => Promise<AgendoEvent>,
    private readonly transitionTo: (status: SessionStatus) => Promise<void>,
    private readonly resetIdleTimer: () => void,
    private readonly capturePlanFilePath: () => Promise<void>,
    /** Shared reference to SessionProcess.activeToolUseIds — mutations are visible to both. */
    private readonly activeToolUseIds: Set<string>,
  ) {}

  // ---------------------------------------------------------------------------
  // Detection helpers for SessionProcess.onData
  // ---------------------------------------------------------------------------

  /**
   * Inspect user-turn content blocks for is_error tool_results.
   * When found for an active tool, marks the toolUseId as pending a human response.
   * Call this from onData when parsing a `type: 'user'` NDJSON line.
   */
  checkForHumanResponseBlocks(
    content: Array<Record<string, unknown>>,
    activeToolUseIds: Set<string>,
  ): void {
    for (const block of content) {
      if (block.type === 'tool_result' && block.is_error === true) {
        const id = (block.tool_use_id as string | undefined) ?? '';
        if (id && activeToolUseIds.has(id)) {
          this.pendingHumanResponseIds.add(id);
        }
      }
    }
  }

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

  /** True when the given toolUseId is waiting for a human response card. */
  isPendingHumanResponse(toolUseId: string): boolean {
    return this.pendingHumanResponseIds.has(toolUseId);
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

  /**
   * Remove and return the stored AskUserQuestion questions for a requestId.
   * Returns an empty array if not found.
   */
  takeQuestions(requestId: string): AskUserQuestion[] {
    const questions = this.pendingAskUserQuestions.get(requestId) ?? [];
    this.pendingAskUserQuestions.delete(requestId);
    return questions;
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
    const { approvalId, toolName, toolInput, isAskUser } = req;

    // AskUserQuestion is a human-interaction primitive: the agent is asking the
    // user a question, not requesting permission for a dangerous action.
    // Auto-approve the can_use_tool request — the tool will "fail" in pipe mode
    // (error tool_result), then the interactive-tools renderer shows the question
    // card, and pushToolResult routes the human's answer when it arrives.
    if (isAskUser) {
      return 'allow';
    }

    // Check per-session allowlist — no round-trip to the user needed.
    if (this.isToolAllowed(toolName)) {
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
    if (ApprovalHandler.APPROVAL_GATED_TOOLS.has(toolName)) {
      await this.capturePlanFilePath();
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
   * Send a tool_result back to Claude for a pending tool_use (e.g. AskUserQuestion).
   * Only valid when the session is active or awaiting_input.
   */
  async pushToolResult(toolUseId: string, content: string): Promise<void> {
    // AskUserQuestion special path: Claude already consumed an error tool_result
    // automatically (non-interactive mode), so we can't use sendToolResult.
    // Instead: emit agent:tool-end to mark the UI card as answered, then send
    // the user's answer as a regular user message so Claude can act on it.
    if (this.pendingHumanResponseIds.has(toolUseId)) {
      this.pendingHumanResponseIds.delete(toolUseId);
      this.activeToolUseIds.delete(toolUseId);
      // Emit tool-end with full JSON so the UI can display the selected option.
      await this.emitEvent({ type: 'agent:tool-end', toolUseId, content });
      // Extract just the answer values — Claude already has the question in
      // context, so sending {"answers":{"Q":"A"}} is redundant and noisy.
      let messageText = content;
      try {
        const parsed = JSON.parse(content) as { answers?: Record<string, string> };
        if (parsed.answers) {
          const values = Object.values(parsed.answers);
          messageText = values.join(', ');
        }
      } catch {
        // fall back to raw content
      }
      await this.emitEvent({ type: 'user:message', text: messageText });
      await this.transitionTo('active');
      this.resetIdleTimer();
      await this.adapter.sendMessage(messageText);
      return;
    }

    if (!this.adapter.sendToolResult) {
      console.warn(`[approval-handler] adapter does not support sendToolResult`);
      return;
    }
    await this.adapter.sendToolResult(toolUseId, content);
    await this.transitionTo('active');
    this.resetIdleTimer();
  }

  // ---------------------------------------------------------------------------
  // AskUserQuestion (wired to adapter's AskUserQuestion handling if needed)
  // ---------------------------------------------------------------------------

  /**
   * Handle an AskUserQuestion control_request from Claude.
   *
   * Flow:
   * 1. Emit an `agent:ask-user` event so the frontend renders a question card.
   * 2. Wait up to 5 minutes for the user to send an `answer-question` control.
   * 3. Return `{ behavior: 'allow', updatedInput: { questions, answers } }` so
   *    the claude-adapter sends the correct control_response with updatedInput.
   * 4. On timeout, deny the request so the agent can gracefully handle it.
   */
  async handleAskUserQuestion(
    requestId: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const questions = (toolInput.questions as AskUserQuestion[] | undefined) ?? [];

    // Store questions so the onControl answer-question handler can include them in updatedInput.
    this.pendingAskUserQuestions.set(requestId, questions);

    await this.emitEvent({
      type: 'agent:ask-user',
      requestId,
      questions,
    });

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        this.pendingAskUserQuestions.delete(requestId);
        console.warn(
          `[approval-handler] AskUserQuestion requestId=${requestId} timed out after 5 minutes`,
        );
        resolve('deny');
      }, TIMEOUT_MS);

      this.pendingApprovals.set(requestId, (decision) => {
        clearTimeout(timer);
        this.pendingAskUserQuestions.delete(requestId);
        resolve(decision);
      });
    });
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
