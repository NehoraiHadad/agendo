import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { config } from '@/lib/config';
import { publish, subscribe, channelName } from '@/lib/realtime/pg-notify';
import { serializeEvent } from '@/lib/realtime/events';
import type {
  AgendoEvent,
  AgendoEventPayload,
  AgendoControl,
  SessionStatus,
} from '@/lib/realtime/events';
import { FileLogWriter } from '@/lib/worker/log-writer';
import { enqueueSession } from '@/lib/worker/queue';
import { sendPushToAll } from '@/lib/services/notification-service';
import { TeamInboxMonitor } from '@/lib/worker/team-inbox-monitor';
import type {
  AgentAdapter,
  SpawnOpts,
  ManagedProcess,
  ImageContent,
  PermissionDecision,
  ApprovalRequest,
  AcpMcpServer,
} from '@/lib/worker/adapters/types';
import type { Session } from '@/lib/types';
import { Future } from '@/lib/utils/future';
import { resetRecoveryCount } from '@/worker/zombie-reconciler';

const SIGKILL_DELAY_MS = 5_000;

/**
 * Derive a log file path for a session.
 * Format: {LOG_DIR}/sessions/{yyyy}/{mm}/{sessionId}.log
 */
function resolveSessionLogPath(sessionId: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return join(config.LOG_DIR, 'sessions', yyyy, mm, `${sessionId}.log`);
}

/**
 * SessionProcess manages the full lifecycle of a single long-running agent
 * process tied to a session row. It handles:
 *   - Atomic session claim to prevent pg-boss double-execution
 *   - Spawning or resuming the underlying agent process via an adapter
 *   - Parsing agent output (Claude stream-json NDJSON) into AgendoEvents
 *   - Publishing events to PG NOTIFY for SSE fan-out
 *   - Writing a structured session log file
 *   - Receiving control messages (send message, cancel, redirect, tool-approval) via PG NOTIFY
 *   - Idle timeout management and graceful shutdown
 *   - Heartbeat updates every 30s for stale-job detection
 *   - Per-tool approval gating with session allowlist persistence
 *   - Synthetic tool-end events on cancellation to prevent forever-spinners
 *   - kill(pid, 0) liveness checks to detect silent crashes
 */
export class SessionProcess {
  private managedProcess: ManagedProcess | null = null;
  private logWriter: FileLogWriter | null = null;
  private unsubscribeControl: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutKilled = false;
  private interruptInProgress = false;
  private interruptKilled = false;
  /** Set by terminate() so onExit transitions to 'idle' (resumable) instead of 'ended'. */
  private terminateKilled = false;
  /** Set by handleCancel() so onExit skips the "unexpected exit" error message. */
  private cancelKilled = false;
  /** Set by handleSetPermissionMode() so onExit re-enqueues for immediate restart. */
  private modeChangeRestart = false;
  /** Set by clearContextRestart (ExitPlanMode option 1): deny tool, kill, restart fresh. */
  private clearContextRestart = false;
  /** Stored cwd for plan file reading during clearContextRestart. */
  private spawnCwd: string | null = null;
  /** SIGKILL escalation timers — tracked so they can be cleared if the process exits early. */
  private sigkillTimers: ReturnType<typeof setTimeout>[] = [];
  /** Periodic MCP health check timer — checks for disconnected MCP servers. */
  private mcpHealthTimer: ReturnType<typeof setInterval> | null = null;
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  private dataBuffer = '';
  private exitFuture = new Future<number | null>();
  /** Resolves when the pg-boss slot should be freed: either on first awaiting_input
   *  transition or on process exit — whichever comes first. */
  private slotReleaseFuture = new Future<void>();
  private exitHandled = false;
  private sessionStartTime = Date.now();
  /**
   * Tools that must always require human approval via the control_request path,
   * regardless of permissionMode.
   *
   * These represent human-interaction gates (plan approval, etc.) rather than
   * dangerous-action permissions.  The Claude Code CLI never auto-approves
   * these even in bypassPermissions mode.
   *
   * Note: AskUserQuestion is NOT listed here because it arrives via the NDJSON
   * tool_use path (not control_request) and is detected generically from
   * is_error:true in Claude's stdout — no hardcoded name needed.
   */
  private static readonly APPROVAL_GATED_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode']);

  private activeToolUseIds = new Set<string>();
  /** tool_use IDs for interactive tools awaiting a human response via the UI. */
  private pendingHumanResponseIds = new Set<string>();
  /** toolUseIds for APPROVAL_GATED_TOOLS — suppress their agent:tool-start/end events. */
  private suppressedToolUseIds = new Set<string>();
  private pendingApprovals = new Map<string, (decision: PermissionDecision) => void>();
  /** Maps toolName → pending approvalId, so a duplicate call auto-denies the old one. */
  private pendingApprovalsByTool = new Map<string, string>();
  /** Stores AskUserQuestion questions indexed by requestId for use when the answer arrives. */
  private pendingAskUserQuestions = new Map<
    string,
    Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string; markdown?: string }>;
      multiSelect: boolean;
    }>
  >();
  /** Buffer for batching text deltas from stream_event messages (200ms flush interval). */
  private deltaBuffer = '';
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Buffer for batching thinking deltas (same interval as text deltas). */
  private thinkingDeltaBuffer = '';
  private thinkingDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DELTA_FLUSH_MS = 200;
  /** Team inbox monitor — non-null only when this session is a team leader. */
  private teamInboxMonitor: TeamInboxMonitor | null = null;

  constructor(
    private session: Session,
    private adapter: AgentAdapter,
    private workerId: string,
  ) {}

  /**
   * Claim the session row atomically, set up log writer, subscribe to the
   * control channel, and spawn (or resume) the agent process.
   *
   * @param prompt - The initial prompt to pass to the agent
   * @param resumeRef - If provided, the adapter resumes an existing session
   * @param spawnCwd - Working directory for the spawned process
   * @param envOverrides - Additional env vars to merge into the child environment
   * @param mcpConfigPath - Optional path to a pre-generated MCP JSON config file.
   *   When provided, `--mcp-config <path>` is appended to the agent spawn args.
   * @param mcpServers - Optional MCP server list for ACP session/new (Gemini).
   * @param initialImage - Optional image attachment for cold resume.
   * @param displayText - Optional override for the user:message event text. When
   *   provided (e.g. on cold resume), only this text is shown in the chat view
   *   instead of the full prompt (which may contain system context preambles).
   */
  async start(
    prompt: string,
    resumeRef?: string,
    spawnCwd?: string,
    envOverrides?: Record<string, string>,
    mcpConfigPath?: string,
    mcpServers?: AcpMcpServer[],
    initialImage?: ImageContent,
    displayText?: string,
  ): Promise<void> {
    // Atomic claim: prevent double-execution on pg-boss retry.
    // Only claim from 'idle' or 'ended' — never from 'active'. The zombie
    // reconciler always resets orphaned 'active' sessions back to 'idle' before
    // re-enqueueing, so a legitimate resume always starts from 'idle'. Allowing
    // 'active' here caused a double-claim race: the retried old job and the
    // reconciler's new job both claimed the same session concurrently.
    const [claimed] = await db
      .update(sessions)
      .set({
        status: 'active',
        workerId: this.workerId,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(and(eq(sessions.id, this.session.id), inArray(sessions.status, ['idle', 'ended'])))
      .returning({ id: sessions.id, eventSeq: sessions.eventSeq });

    if (!claimed) {
      console.log(`[session-process] Session ${this.session.id} already claimed — skipping`);
      // Resolve futures so callers don't hang indefinitely.
      this.slotReleaseFuture.resolve();
      this.exitFuture.resolve(null);
      return;
    }

    console.log(`[session-process] claimed session ${this.session.id} workerId=${this.workerId}`);

    // Continue seq from wherever the previous session run left off so that
    // event IDs remain monotonically increasing across resumes and the SSE
    // client never sees duplicate IDs.
    this.eventSeq = claimed.eventSeq;

    // Set up log writer. Pass null for executionId since sessions track their own
    // stats independently (no byte/line flush to the executions table).
    const logPath = resolveSessionLogPath(this.session.id);
    this.logWriter = new FileLogWriter(null, logPath);
    this.logWriter.open();

    // Persist the log file path so the frontend can fetch it later.
    await db.update(sessions).set({ logFilePath: logPath }).where(eq(sessions.id, this.session.id));

    // Subscribe to control channel for inbound messages (send, cancel, redirect, tool-approval).
    this.unsubscribeControl = await subscribe(
      channelName('agendo_control', this.session.id),
      (payload) => {
        this.onControl(payload).catch((err: unknown) => {
          console.error(
            `[session-process] Control handler error for session ${this.session.id}:`,
            err,
          );
        });
      },
    );

    // Build child env: start from the worker's own env, then strip vars that
    // would prevent claude from starting (e.g. CLAUDECODE causes a nested-session
    // guard error; CLAUDE_CODE_ENTRYPOINT is also stripped for safety).
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CLAUDECODE' && key !== 'CLAUDE_CODE_ENTRYPOINT') {
        childEnv[key] = value;
      }
    }
    // Apply project/task env overrides on top of the base env.
    if (envOverrides) {
      for (const [k, v] of Object.entries(envOverrides)) {
        childEnv[k] = v;
      }
    }

    // Session identity vars — available to hooks and sub-processes via env.
    // These are already baked into the MCP config file; setting them in the
    // child env as well lets hooks (pre/post tool) read them without parsing JSON.
    childEnv['AGENDO_SESSION_ID'] = this.session.id;
    childEnv['AGENDO_AGENT_ID'] = this.session.agentId;
    if (this.session.taskId) {
      childEnv['AGENDO_TASK_ID'] = this.session.taskId;
    }

    this.spawnCwd = spawnCwd ?? '/tmp';
    const spawnOpts: SpawnOpts = {
      cwd: this.spawnCwd,
      env: childEnv,
      executionId: this.session.id,
      timeoutSec: this.session.idleTimeoutSec,
      maxOutputBytes: 10 * 1024 * 1024,
      persistentSession: true, // keep process alive after result for multi-turn
      permissionMode: this.session.permissionMode ?? 'default',
      allowedTools: this.session.allowedTools ?? [],
      ...(mcpConfigPath ? { extraArgs: ['--mcp-config', mcpConfigPath] } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(initialImage ? { initialImage } : {}),
      // Sync Claude's session ID with agendo's DB session ID
      sessionId: this.session.id,
      // Only use our MCP servers when an MCP config is provided
      strictMcpConfig: !!mcpConfigPath,
      // Forward model if set on the session (e.g. from DB or API)
      ...(this.session.model ? { model: this.session.model } : {}),
      // TODO: wire maxBudgetUsd and fallbackModel when session config supports them
    };

    // Wire approval handler so adapter can request per-tool approval
    this.adapter.setApprovalHandler((req) => this.handleApprovalRequest(req));

    // Wire sessionRef callback so Codex/Gemini can persist their ref to DB
    // (Claude handles this via the session:init NDJSON event)
    this.adapter.onSessionRef?.((ref) => {
      this.sessionRef = ref;
      db.update(sessions)
        .set({ sessionRef: ref })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          console.error(
            `[session-process] Failed to persist sessionRef for session ${this.session.id}:`,
            err,
          );
        });
    });

    // Wire thinking callback for agent:activity events
    this.adapter.onThinkingChange((thinking) => {
      void this.emitEvent({ type: 'agent:activity', thinking });
      // When thinking stops, transition to awaiting_input (works for all adapters:
      // Claude handles it via agent:result; for Codex/Gemini this is the only signal).
      if (!thinking && !this.interruptInProgress) {
        void this.transitionTo('awaiting_input').then(() => this.resetIdleTimer());
      }
    });

    if (resumeRef) {
      // Emit the user's prompt as a user:message event so it appears in the
      // session log and is replayed after a page refresh (cold-resume path).
      // Use displayText if provided so system preambles (e.g. [Previous Work Summary])
      // are not shown in the chat view.
      await this.emitEvent({ type: 'user:message', text: displayText ?? prompt });
      this.managedProcess = this.adapter.resume(resumeRef, prompt, spawnOpts);
    } else {
      this.managedProcess = this.adapter.spawn(prompt, spawnOpts);
    }

    // Persist PID for SIGTERM/SIGKILL from other paths (e.g. API cancel endpoint).
    await db
      .update(sessions)
      .set({ pid: this.managedProcess.pid })
      .where(eq(sessions.id, this.session.id));

    // Wire process output and exit handlers.
    this.managedProcess.onData((chunk) => void this.onData(chunk));
    this.managedProcess.onExit((code) => void this.onExit(code));

    this.startHeartbeat();
    this.startMcpHealthCheck();

    // If this session is a team leader, start monitoring the team inbox for
    // incoming agent messages and surface them as team:message events.
    const teamName = TeamInboxMonitor.findTeamForSession(this.session.id);
    if (teamName) {
      this.teamInboxMonitor = new TeamInboxMonitor(teamName);
      // Backfill: emit all messages that already existed in the inbox so they
      // appear in the chat view on reconnect / cold-resume.
      const existing = this.teamInboxMonitor.readAllMessages();
      for (const msg of existing) {
        await this.emitEvent({
          type: 'team:message',
          fromAgent: msg.from,
          text: msg.text,
          summary: msg.summary,
          color: msg.color,
          sourceTimestamp: msg.timestamp,
          isStructured: msg.isStructured,
          structuredPayload: msg.structuredPayload,
        });
      }
      // Poll for new messages every 4 seconds.
      this.teamInboxMonitor.startPolling(4000, (msg) => {
        void this.emitEvent({
          type: 'team:message',
          fromAgent: msg.from,
          text: msg.text,
          summary: msg.summary,
          color: msg.color,
          sourceTimestamp: msg.timestamp,
          isStructured: msg.isStructured,
          structuredPayload: msg.structuredPayload,
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: process output handling
  // ---------------------------------------------------------------------------

  private async onData(chunk: string): Promise<void> {
    // Write raw chunk to the session log file under the 'stdout' stream prefix.
    this.logWriter?.write(chunk, 'stdout');

    // Buffer partial lines: NDJSON lines from large tool results can span multiple
    // data chunks. Splitting only on '\n' without buffering would emit the tail of
    // a split line as agent:text, showing raw JSON fragments in the UI.
    const combined = this.dataBuffer + chunk;
    const lines = combined.split('\n');
    this.dataBuffer = lines.pop() ?? ''; // last element is incomplete (no trailing \n yet)

    // Parse each NDJSON line and map to a structured AgendoEvent.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        await this.emitEvent({ type: 'agent:text', text: trimmed });
        continue;
      }

      // Separate try-catch for JSON parsing vs event emission so that a
      // transient emit failure (DB error, etc.) never causes raw JSON to leak
      // into the chat as a system:info message.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Line is not JSON — treat as plain text info (shell output, etc.)
        await this.emitEvent({ type: 'system:info', message: trimmed });
        continue;
      }

      try {
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
          for (const block of msg?.content ?? []) {
            if (block.type === 'tool_result' && block.is_error === true) {
              const id = (block.tool_use_id as string | undefined) ?? '';
              if (id && this.activeToolUseIds.has(id)) {
                this.pendingHumanResponseIds.add(id);
              }
            }
          }
        }

        let partials: AgendoEventPayload[];
        try {
          partials = this.adapter.mapJsonToEvents
            ? this.adapter.mapJsonToEvents(parsed)
            : this.mapClaudeJsonToEvents(parsed);
        } catch (mapErr) {
          console.warn(
            `[session-process] mapJsonToEvents error for session ${this.session.id}:`,
            mapErr,
            'line:',
            trimmed.slice(0, 200),
          );
          continue;
        }

        for (const partial of partials) {
          // Suppress tool-start/tool-end for approval-gated tools (ExitPlanMode, …).
          // These appear only as control_request approval cards — not as ToolCard widgets.
          if (
            partial.type === 'agent:tool-start' &&
            SessionProcess.APPROVAL_GATED_TOOLS.has(partial.toolName)
          ) {
            this.activeToolUseIds.add(partial.toolUseId); // keep for cleanup
            this.suppressedToolUseIds.add(partial.toolUseId);
            continue;
          }
          if (
            partial.type === 'agent:tool-end' &&
            this.suppressedToolUseIds.has(partial.toolUseId)
          ) {
            this.activeToolUseIds.delete(partial.toolUseId);
            this.suppressedToolUseIds.delete(partial.toolUseId);
            continue;
          }

          // Suppress the error tool-end for any interactive tool: the UI card
          // stays live and pushToolResult routes the human's answer when it arrives.
          if (
            partial.type === 'agent:tool-end' &&
            this.pendingHumanResponseIds.has(partial.toolUseId)
          ) {
            continue; // suppress — keep in activeToolUseIds until human responds
          }

          const event = await this.emitEvent(partial);

          // Track in-flight tool calls to enable synthetic cleanup on cancel.
          if (event.type === 'agent:tool-start') {
            this.activeToolUseIds.add(event.toolUseId);
          }
          if (event.type === 'agent:tool-end') {
            this.activeToolUseIds.delete(event.toolUseId);
          }

          // Persist sessionRef and model once the agent announces its session ID.
          if (event.type === 'session:init') {
            const updates: Record<string, string> = {};
            if (event.sessionRef) {
              this.sessionRef = event.sessionRef;
              updates.sessionRef = event.sessionRef;
            }
            if (event.model) {
              updates.model = event.model;
            }
            if (Object.keys(updates).length > 0) {
              await db.update(sessions).set(updates).where(eq(sessions.id, this.session.id));
            }
          }

          // After the agent finishes a result, transition to awaiting_input.
          // Skip during an interrupt — handleInterrupt() manages the transition
          // based on whether the process survived (warm vs cold resume).
          if (event.type === 'agent:result' && !this.interruptInProgress) {
            await this.transitionTo('awaiting_input');
            this.resetIdleTimer();
          }
        }
      } catch (err) {
        // Event emission failed (transient DB/publish error). Log but don't
        // surface raw JSON to the user — it would appear as a broken UI element.
        console.error(
          `[session-process] Failed to emit event for session ${this.session.id}:`,
          err,
        );
      }
    }
  }

  /**
   * Map a parsed Claude stream-json object to zero or more AgendoEvent partials.
   *
   * Claude's --output-format stream-json emits NDJSON where tool_use and
   * tool_result blocks are nested inside message.content arrays, NOT as
   * top-level types. Each call may return multiple events (e.g. one assistant
   * message containing both a text block and a tool_use block).
   */
  private mapClaudeJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    const type = parsed.type as string | undefined;

    // Claude CLI system/init — announces the session ID and available slash commands
    if (type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      const slashCommands = Array.isArray(parsed.slash_commands)
        ? (parsed.slash_commands as string[])
        : [];
      const mcpServers = Array.isArray(parsed.mcp_servers)
        ? (parsed.mcp_servers as Array<{ name: string; status?: string; tools?: string[] }>)
        : [];
      const model = typeof parsed.model === 'string' ? parsed.model : undefined;
      const apiKeySource =
        typeof parsed.apiKeySource === 'string' ? parsed.apiKeySource : undefined;
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;
      const tools = Array.isArray(parsed.tools) ? (parsed.tools as string[]) : undefined;
      const permissionMode =
        typeof parsed.permissionMode === 'string' ? parsed.permissionMode : undefined;
      return [
        {
          type: 'session:init',
          sessionRef: parsed.session_id as string,
          slashCommands,
          mcpServers,
          model,
          apiKeySource,
          cwd,
          tools,
          permissionMode,
        },
      ];
    }

    // Assistant turn: content is an array of blocks (text, tool_use, thinking, etc.)
    // Clear any pending delta buffer — the complete text is the source of truth.
    if (type === 'assistant') {
      if (this.deltaFlushTimer) {
        clearTimeout(this.deltaFlushTimer);
        this.deltaFlushTimer = null;
      }
      this.deltaBuffer = '';
      if (this.thinkingDeltaFlushTimer) {
        clearTimeout(this.thinkingDeltaFlushTimer);
        this.thinkingDeltaFlushTimer = null;
      }
      this.thinkingDeltaBuffer = '';
      const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
      const events: AgendoEventPayload[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          events.push({ type: 'agent:text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          events.push({ type: 'agent:thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'agent:tool-start',
            toolUseId: (block.id as string | undefined) ?? '',
            toolName: (block.name as string | undefined) ?? '',
            input: (block.input as Record<string, unknown> | undefined) ?? {},
          });
        }
      }
      return events;
    }

    // User turn: content is an array of blocks (tool_result, etc.)
    if (type === 'user') {
      const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
      const toolUseResult = parsed.tool_use_result as Record<string, unknown> | undefined;
      const events: AgendoEventPayload[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'agent:tool-end',
            toolUseId: (block.tool_use_id as string | undefined) ?? '',
            content: block.content ?? null,
            durationMs: toolUseResult?.durationMs as number | undefined,
            numFiles: toolUseResult?.numFiles as number | undefined,
            truncated: toolUseResult?.truncated as boolean | undefined,
          });
        }
      }
      return events;
    }

    // Agent thinking output (top-level, extended thinking mode)
    if (type === 'thinking') {
      return [{ type: 'agent:thinking', text: (parsed.thinking as string | undefined) ?? '' }];
    }

    // Final result with cost/duration stats
    if (type === 'result') {
      const costUsd = (parsed.total_cost_usd as number | null | undefined) ?? null;
      const turns = (parsed.num_turns as number | null | undefined) ?? null;
      const durationMs = (parsed.duration_ms as number | null | undefined) ?? null;
      const durationApiMs = (parsed.duration_api_ms as number | null | undefined) ?? null;
      const isError = parsed.is_error === true;
      const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined;
      const rawErrors = Array.isArray(parsed.errors)
        ? (parsed.errors as string[]).filter((e) => typeof e === 'string')
        : undefined;
      const errors = rawErrors && rawErrors.length > 0 ? rawErrors : undefined;

      // Per-model usage breakdown
      const rawModelUsage = parsed.modelUsage as
        | Record<string, Record<string, unknown>>
        | undefined;
      const modelUsage = rawModelUsage
        ? Object.fromEntries(
            Object.entries(rawModelUsage).map(([m, u]) => [
              m,
              {
                inputTokens: (u.inputTokens as number) ?? 0,
                outputTokens: (u.outputTokens as number) ?? 0,
                cacheReadInputTokens: u.cacheReadInputTokens as number | undefined,
                cacheCreationInputTokens: u.cacheCreationInputTokens as number | undefined,
                costUSD: (u.costUSD as number) ?? 0,
                contextWindow: u.contextWindow as number | undefined,
                maxOutputTokens: u.maxOutputTokens as number | undefined,
              },
            ]),
          )
        : undefined;

      // Permission denials
      const rawDenials = Array.isArray(parsed.permission_denials)
        ? (parsed.permission_denials as Array<Record<string, unknown>>)
        : undefined;
      const permissionDenials = rawDenials?.map((d) => ({
        toolName: (d.tool_name as string) ?? '',
        toolUseId: (d.tool_use_id as string) ?? '',
        toolInput: d.tool_input as Record<string, unknown> | undefined,
      }));

      // Service tier and inference geo
      const rawUsage = parsed.usage as Record<string, unknown> | undefined;
      const serviceTier =
        typeof rawUsage?.service_tier === 'string' ? rawUsage.service_tier : undefined;
      const inferenceGeo =
        typeof rawUsage?.inference_geo === 'string' && rawUsage.inference_geo !== ''
          ? rawUsage.inference_geo
          : undefined;

      // Server-side tool usage (web search, fetch)
      const rawServerToolUse = rawUsage?.server_tool_use as Record<string, unknown> | undefined;
      const serverToolUse = rawServerToolUse
        ? {
            webSearchRequests: rawServerToolUse.web_search_requests as number | undefined,
            webFetchRequests: rawServerToolUse.web_fetch_requests as number | undefined,
          }
        : undefined;

      // Persist cumulative cost/turn stats to the session row.
      void db
        .update(sessions)
        .set({
          ...(costUsd !== null && { totalCostUsd: String(costUsd) }),
          ...(turns !== null && { totalTurns: turns }),
        })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          console.error(
            `[session-process] cost stats update failed for session ${this.session.id}:`,
            err,
          );
        });

      const events: AgendoEventPayload[] = [
        {
          type: 'agent:result',
          costUsd,
          turns,
          durationMs,
          durationApiMs,
          isError,
          subtype,
          errors,
          modelUsage,
          serviceTier,
          inferenceGeo,
          permissionDenials,
          serverToolUse,
        },
      ];

      // Emit a system:error so error results appear as red pills in the chat
      if (isError && errors && errors.length > 0) {
        events.push({ type: 'system:error', message: errors.join('; ') });
      }

      return events;
    }

    // compact_boundary — conversation compaction with metadata (new protocol)
    if (type === 'system' && parsed.subtype === 'compact_boundary') {
      const compactMeta = parsed.compact_metadata as
        | { trigger?: string; pre_tokens?: number }
        | undefined;
      const trigger = compactMeta?.trigger === 'manual' ? ('manual' as const) : ('auto' as const);
      const preTokens = typeof compactMeta?.pre_tokens === 'number' ? compactMeta.pre_tokens : 0;
      return [
        {
          type: 'system:info',
          message: `Conversation compacted (${trigger}, ${preTokens.toLocaleString()} tokens)`,
          compactMeta: { trigger, preTokens },
        },
      ];
    }

    // Claude emits a 'compact' message when it compacts the conversation history (legacy).
    if (type === 'compact') {
      return [{ type: 'system:info', message: 'Conversation history compacted' }];
    }

    // rate_limit_event — account rate limit status from Claude Code
    if (type === 'rate_limit_event') {
      const info = parsed.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        return [
          {
            type: 'system:rate-limit',
            status: (info.status as string) ?? 'unknown',
            rateLimitType: (info.rateLimitType as string) ?? 'unknown',
            resetsAt: (info.resetsAt as number) ?? 0,
            isUsingOverage: (info.isUsingOverage as boolean) ?? false,
            overageStatus: info.overageStatus as string | undefined,
          },
        ];
      }
      return [];
    }

    // stream_event — token-level streaming from --include-partial-messages.
    // Batch text_delta and thinking_delta events to limit PG NOTIFY throughput (~5 events/sec).
    if (type === 'stream_event') {
      const event = parsed.event as Record<string, unknown> | undefined;
      if (event?.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.deltaBuffer += delta.text;
          if (!this.deltaFlushTimer) {
            this.deltaFlushTimer = setTimeout(() => {
              void this.flushDeltaBuffer();
            }, SessionProcess.DELTA_FLUSH_MS);
          }
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.thinkingDeltaBuffer += delta.thinking;
          if (!this.thinkingDeltaFlushTimer) {
            this.thinkingDeltaFlushTimer = setTimeout(() => {
              void this.flushThinkingDeltaBuffer();
            }, SessionProcess.DELTA_FLUSH_MS);
          }
        }
      }
      // All other stream_event subtypes (message_start, content_block_start/stop,
      // message_delta, message_stop) are ignored — the complete messages provide
      // the same data in a more reliable form.
      return [];
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Private: text delta batching (token-level streaming)
  // ---------------------------------------------------------------------------

  /**
   * Flush accumulated text deltas as a single agent:text-delta event.
   * Called on a 200ms timer to limit PG NOTIFY throughput to ~5 events/sec
   * instead of the raw 20-50 events/sec from content_block_delta.
   *
   * Text-delta events are NOT persisted to the log file (the complete
   * agent:text event from the `assistant` message is the source of truth).
   */
  private async flushDeltaBuffer(): Promise<void> {
    this.deltaFlushTimer = null;
    const text = this.deltaBuffer;
    if (!text) return;
    this.deltaBuffer = '';

    const event: AgendoEvent = {
      id: ++this.eventSeq,
      sessionId: this.session.id,
      ts: Date.now(),
      type: 'agent:text-delta',
      text,
    };

    // Publish directly to PG NOTIFY without writing to log file.
    // Deltas are redundant with the complete agent:text event.
    await publish(channelName('agendo_events', this.session.id), event);
  }

  /** Flush accumulated thinking deltas as a single agent:thinking-delta event. */
  private async flushThinkingDeltaBuffer(): Promise<void> {
    this.thinkingDeltaFlushTimer = null;
    const text = this.thinkingDeltaBuffer;
    if (!text) return;
    this.thinkingDeltaBuffer = '';

    const event: AgendoEvent = {
      id: ++this.eventSeq,
      sessionId: this.session.id,
      ts: Date.now(),
      type: 'agent:thinking-delta',
      text,
    };

    await publish(channelName('agendo_events', this.session.id), event);
  }

  // ---------------------------------------------------------------------------
  // Private: control channel handling
  // ---------------------------------------------------------------------------

  private async onControl(payload: string): Promise<void> {
    let control: AgendoControl;
    try {
      control = JSON.parse(payload) as AgendoControl;
    } catch {
      console.warn(`[session-process] Malformed control payload for session ${this.session.id}`);
      return;
    }

    if (control.type === 'cancel') {
      await this.handleCancel();
    } else if (control.type === 'interrupt') {
      await this.handleInterrupt();
    } else if (control.type === 'message') {
      let image: ImageContent | undefined;
      if (control.imageRef) {
        try {
          const data = readFileSync(control.imageRef.path).toString('base64');
          image = { mimeType: control.imageRef.mimeType, data };
          // Clean up the temp file (best-effort)
          try {
            unlinkSync(control.imageRef.path);
          } catch {
            /* ignore */
          }
        } catch (err) {
          console.warn(
            `[session-process] Failed to read image file ${control.imageRef.path}:`,
            err,
          );
        }
      }
      await this.pushMessage(control.text, image);
    } else if (control.type === 'redirect') {
      await this.pushMessage(control.newPrompt);
    } else if (control.type === 'tool-approval') {
      const resolver = this.pendingApprovals.get(control.approvalId);
      if (resolver) {
        this.pendingApprovals.delete(control.approvalId);

        // ---------------------------------------------------------------
        // ExitPlanMode Option 1: clear context + restart fresh
        // Identical to the CLI TUI behavior: deny the tool, read plan
        // content, kill process, restart with plan as initialPrompt.
        // ---------------------------------------------------------------
        if (control.clearContextRestart) {
          resolver('deny');

          // Read plan content from the stored plan_file_path in DB
          const planContent = await this.readPlanFromFile();
          const newMode = control.postApprovalMode ?? 'acceptEdits';
          const initialPrompt = planContent
            ? `Implement the following plan:\n\n${planContent}`
            : 'Continue implementing the plan from the previous conversation.';

          // Update DB: clear sessionRef so re-enqueue spawns fresh (not resume),
          // set new initialPrompt and permissionMode.
          await db
            .update(sessions)
            .set({
              sessionRef: null,
              initialPrompt,
              permissionMode: newMode,
            })
            .where(eq(sessions.id, this.session.id));

          await this.emitEvent({
            type: 'system:info',
            message: `Plan approved — clearing context and restarting with ${newMode === 'acceptEdits' ? 'auto-accept edits' : 'manual approval'} mode.`,
          });

          // Kill process → onExit will re-enqueue without resumeRef.
          this.clearContextRestart = true;
          this.terminateKilled = true;
          this.drainPendingApprovals('deny');
          this.managedProcess?.kill('SIGTERM');
          const t = setTimeout(() => {
            this.managedProcess?.kill('SIGKILL');
          }, SIGKILL_DELAY_MS);
          this.sigkillTimers.push(t);
          return;
        }

        // If the user edited the tool input before approving, pass through updatedInput.
        const decision: PermissionDecision =
          control.decision === 'allow' && control.updatedInput
            ? { behavior: 'allow', updatedInput: control.updatedInput }
            : control.decision;
        resolver(decision);

        if (control.decision === 'allow-session') {
          await this.persistAllowedTool(control.toolName);
        }

        // ExitPlanMode side-effects: apply AFTER resolving the approval so the
        // control_response reaches Claude first (otherwise set_permission_mode
        // control_request times out while Claude waits for the tool response).
        if (control.decision === 'allow') {
          if (control.postApprovalMode) {
            // Small delay to let the allow response reach Claude before sending
            // the set_permission_mode control_request on the same stdin pipe.
            setTimeout(() => {
              this.handleSetPermissionMode(
                control.postApprovalMode as 'default' | 'acceptEdits',
              ).catch((err: unknown) => {
                console.warn('[session-process] post-approval mode change failed:', err);
              });
            }, 500);
          }
          if (control.postApprovalCompact) {
            // Compact after a delay to let both the allow response and mode change settle.
            setTimeout(
              () => {
                this.pushMessage('/compact').catch((err: unknown) => {
                  console.warn('[session-process] post-approval compact failed:', err);
                });
              },
              control.postApprovalMode ? 2000 : 500,
            );
          }
        }
      }
    } else if (control.type === 'tool-result') {
      await this.pushToolResult(control.toolUseId, control.content);
    } else if (control.type === 'answer-question') {
      const resolver = this.pendingApprovals.get(control.requestId);
      if (resolver) {
        this.pendingApprovals.delete(control.requestId);
        const questions = this.pendingAskUserQuestions.get(control.requestId) ?? [];
        resolver({ behavior: 'allow', updatedInput: { questions, answers: control.answers } });
      } else {
        console.warn(
          `[session-process] answer-question for unknown requestId=${control.requestId}`,
        );
      }
    } else if (control.type === 'set-permission-mode') {
      await this.handleSetPermissionMode(control.mode);
    } else if (control.type === 'set-model') {
      await this.handleSetModel(control.model);
    }
  }

  // ---------------------------------------------------------------------------
  // Public: send a message to the running agent
  // ---------------------------------------------------------------------------

  /**
   * Push a user message to the running agent process.
   * Only valid when the session is active or awaiting_input.
   */
  async pushMessage(text: string, image?: ImageContent): Promise<void> {
    if (!['active', 'awaiting_input'].includes(this.status)) {
      console.warn(
        `[session-process] pushMessage ignored — session ${this.session.id} is ${this.status}`,
      );
      return;
    }
    // Emit user message and transition to 'active' BEFORE calling sendMessage.
    // This is critical for the Gemini ACP adapter, whose sendMessage() blocks
    // until the full ACP roundtrip completes. If we transitioned after, the
    // thinkingCallback(false) that fires inside sendMessage would see status
    // still as 'awaiting_input' and the transitionTo('awaiting_input') would
    // be a no-op — leaving the session stuck in 'active' forever.
    await this.emitEvent({ type: 'user:message', text, hasImage: !!image });
    await this.transitionTo('active');
    this.resetIdleTimer();
    await this.adapter.sendMessage(text, image);
  }

  /**
   * Send a tool_result back to Claude for a pending tool_use (e.g. AskUserQuestion).
   * Only valid when the session is active or awaiting_input.
   */
  async pushToolResult(toolUseId: string, content: string): Promise<void> {
    if (!['active', 'awaiting_input'].includes(this.status)) {
      console.warn(
        `[session-process] pushToolResult ignored — session ${this.session.id} is ${this.status}`,
      );
      return;
    }

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
      console.warn(`[session-process] adapter does not support sendToolResult`);
      return;
    }
    await this.adapter.sendToolResult(toolUseId, content);
    await this.transitionTo('active');
    this.resetIdleTimer();
  }

  // ---------------------------------------------------------------------------
  // Private: cancellation
  // ---------------------------------------------------------------------------

  private async handleCancel(): Promise<void> {
    // Set flag BEFORE sending the interrupt so onExit doesn't emit "Session ended
    // unexpectedly" — a user-initiated cancel is not a crash.
    this.cancelKilled = true;
    await this.emitEvent({ type: 'system:info', message: 'Cancellation requested' });
    // Emit synthetic tool-end for every in-flight tool call to prevent forever-spinners
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({
        type: 'agent:tool-end',
        toolUseId,
        content: '[Interrupted by user]',
      });
    }
    this.activeToolUseIds.clear();
    this.suppressedToolUseIds.clear();
    // Drain pending tool approvals so any adapter blocked on handleApprovalRequest unblocks.
    this.drainPendingApprovals('deny');
    await this.adapter.interrupt();
    // Allow graceful shutdown; escalate to SIGKILL after grace period.
    const t = setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    this.sigkillTimers.push(t);
  }

  // ---------------------------------------------------------------------------
  // Private: permission mode change (graceful restart with new mode)
  // ---------------------------------------------------------------------------

  /** Human-readable labels for permission modes. */
  private static readonly MODE_LABELS: Record<string, string> = {
    plan: 'Plan — agent presents a plan before executing',
    default: 'Approve — each tool requires your approval',
    acceptEdits: 'Edit Only — file edits auto-approved, bash needs approval',
    bypassPermissions: 'Auto — all tools auto-approved',
    dontAsk: 'Auto — all tools auto-approved',
  };

  /**
   * Handle a set-permission-mode control: update in-memory session state and DB,
   * emit a system:info event visible in the chat. If the adapter supports
   * in-place mode switching, use it (no restart). Otherwise fall back to
   * killing and cold-resuming with the new flags.
   */
  private async handleSetPermissionMode(
    mode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk',
  ): Promise<void> {
    this.session.permissionMode = mode;
    const label = SessionProcess.MODE_LABELS[mode] ?? mode;

    // Try in-place mode change via control_request (no process restart).
    if (this.adapter.setPermissionMode) {
      try {
        const success = await this.adapter.setPermissionMode(mode);
        if (success) {
          await db
            .update(sessions)
            .set({ permissionMode: mode })
            .where(eq(sessions.id, this.session.id));
          await this.emitEvent({
            type: 'system:info',
            message: `Permission mode \u2192 ${label}.`,
          });
          return;
        }
      } catch (err) {
        console.warn(
          `[session-process] In-place setPermissionMode failed for session ${this.session.id}, falling back to restart:`,
          err,
        );
      }
    }

    // Fallback: kill and restart with new mode.
    await this.emitEvent({
      type: 'system:info',
      message: `Permission mode \u2192 ${label}. Session will restart automatically.`,
    });
    this.modeChangeRestart = true;
    // terminateKilled=true ensures onExit transitions to 'idle' (not 'ended').
    this.terminateKilled = true;
    this.drainPendingApprovals('deny');
    this.managedProcess?.kill('SIGTERM');
    const t = setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    this.sigkillTimers.push(t);
  }

  private async handleSetModel(model: string): Promise<void> {
    if (!this.adapter.setModel) {
      await this.emitEvent({
        type: 'system:error',
        message: 'Model switching is not supported by this agent.',
      });
      return;
    }

    try {
      const success = await this.adapter.setModel(model);
      if (success) {
        await db.update(sessions).set({ model }).where(eq(sessions.id, this.session.id));
        // Emit session:init so the frontend info panel updates the displayed model.
        await this.emitEvent({
          type: 'session:init',
          sessionRef: '',
          slashCommands: [],
          mcpServers: [],
          model,
        });
        await this.emitEvent({
          type: 'system:info',
          message: `Model switched to "${model}".`,
        });
      } else {
        await this.emitEvent({
          type: 'system:error',
          message: `Failed to switch model to "${model}" — CLI did not respond.`,
        });
      }
    } catch (err) {
      await this.emitEvent({
        type: 'system:error',
        message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: plan file path capture for clearContextRestart
  // ---------------------------------------------------------------------------

  /**
   * Eagerly find the plan file in ~/.claude/plans/ (most recently modified .md)
   * and persist its path to the DB. Called when ExitPlanMode fires (session is
   * still active) so the plan path is available even if the session goes idle
   * before the user clicks "clear context".
   */
  private async capturePlanFilePath(): Promise<void> {
    const homePlansDir = join(process.env.HOME ?? '/home/ubuntu', '.claude', 'plans');
    try {
      const files = readdirSync(homePlansDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ name: f, mtime: statSync(join(homePlansDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) return;
      const planFilePath = join(homePlansDir, files[0].name);
      await db.update(sessions).set({ planFilePath }).where(eq(sessions.id, this.session.id));
      console.log(
        `[session-process] Stored plan_file_path for session ${this.session.id}: ${planFilePath}`,
      );
    } catch (err) {
      console.warn(`[session-process] Failed to capture plan file path:`, err);
    }
  }

  /**
   * Read plan content from the stored plan_file_path in the DB.
   */
  private async readPlanFromFile(): Promise<string | null> {
    try {
      const [row] = await db
        .select({ planFilePath: sessions.planFilePath })
        .from(sessions)
        .where(eq(sessions.id, this.session.id));
      if (!row?.planFilePath) return null;
      const content = readFileSync(row.planFilePath, 'utf-8').trim();
      if (!content) return null;
      console.log(`[session-process] Read plan from ${row.planFilePath} (${content.length} chars)`);
      return content;
    } catch (err) {
      console.warn(`[session-process] Failed to read plan from DB path:`, err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: soft interrupt (Stop — process stays alive)
  // ---------------------------------------------------------------------------

  private async handleInterrupt(): Promise<void> {
    this.interruptInProgress = true;
    // Pre-set interruptKilled so that if the process dies during the interrupt,
    // onExit transitions to 'idle' (resumable) instead of 'ended'.
    this.interruptKilled = true;

    await this.emitEvent({ type: 'system:info', message: 'Stopping...' });
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted]' });
    }
    this.activeToolUseIds.clear();
    this.suppressedToolUseIds.clear();

    // Ask the adapter to send an interrupt signal. For Claude this writes a
    // control_request{subtype:'interrupt'} to stdin and waits up to 3s for a
    // 'result' event. If Claude handles it gracefully the process stays alive;
    // if it dies or times out, adapter.isAlive() will be false afterwards.
    await this.adapter.interrupt();

    this.interruptInProgress = false;

    if (this.adapter.isAlive()) {
      // Claude stopped the current action but is still running — warm session,
      // user can send another message immediately without a cold resume.
      this.interruptKilled = false; // process survived, clear the pre-set flag
      await this.transitionTo('awaiting_input');
      this.resetIdleTimer();
    }
    // else: process died during interrupt — interruptKilled=true so onExit will
    // transition to 'idle' (not 'ended'), keeping the session cold-resumable.
  }

  /**
   * Externally interrupt the session (e.g. from the API cancel route).
   * Emits synthetic tool-end events for in-flight tools, sends SIGINT via the
   * adapter, then escalates to SIGKILL after grace period.
   */
  async interrupt(): Promise<void> {
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted by user]' });
    }
    this.activeToolUseIds.clear();
    this.suppressedToolUseIds.clear();
    this.drainPendingApprovals('deny');
    await this.adapter.interrupt();
    const t = setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    this.sigkillTimers.push(t);
  }

  // ---------------------------------------------------------------------------
  // Private: state transitions
  // ---------------------------------------------------------------------------

  private async transitionTo(status: SessionStatus): Promise<void> {
    if (this.status === status) return; // already in this state, skip duplicate transition
    this.status = status;

    // Flush any remaining text in the data buffer before entering awaiting_input.
    // Gemini's ACP adapter may not emit a trailing newline after the last text chunk,
    // leaving partial text stuck in the buffer. Without this flush, the user would
    // never see the final text fragment.
    if (status === 'awaiting_input' && this.dataBuffer.trim()) {
      await this.emitEvent({ type: 'agent:text', text: this.dataBuffer.trim() });
      this.dataBuffer = '';
    }

    await db
      .update(sessions)
      .set({ status, lastActiveAt: new Date() })
      .where(eq(sessions.id, this.session.id));
    await this.emitEvent({ type: 'session:state', status });

    if (status === 'awaiting_input') {
      const elapsedSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
      console.log(
        `[session-process] awaiting_input session ${this.session.id} elapsed=${elapsedSec}s — slot released`,
      );
      // Session completed a turn — reset the zombie recovery counter so it
      // doesn't count previous restarts against future auto-recovery attempts.
      resetRecoveryCount(this.session.id);
      // Resolve the slot future so the pg-boss slot frees while the process
      // stays alive in-memory awaiting the next user message.
      this.slotReleaseFuture.resolve();
      // Notify subscribed browsers that the agent is ready for input
      void sendPushToAll({
        title: 'Agent finished',
        body: 'Your agent is ready for the next message',
        url: `/sessions/${this.session.id}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: idle timeout
  // ---------------------------------------------------------------------------

  /**
   * Reset (or start) the idle timeout countdown.
   * If the agent hasn't received a message within idleTimeoutSec after
   * entering awaiting_input, the session is forcefully terminated.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleTimer = setTimeout(() => {
      if (this.status !== 'awaiting_input') return;
      this.emitEvent({
        type: 'system:info',
        message: `Idle timeout after ${this.session.idleTimeoutSec}s. Suspending session.`,
      })
        .then(() => {
          this.idleTimeoutKilled = true;
          this.managedProcess?.kill('SIGTERM');
          const t = setTimeout(() => {
            this.managedProcess?.kill('SIGKILL');
          }, SIGKILL_DELAY_MS);
          this.sigkillTimers.push(t);
        })
        .catch((err: unknown) => {
          console.error(
            `[session-process] Failed to emit idle timeout event for session ${this.session.id}:`,
            err,
          );
          // Still kill the process even if event emission fails.
          this.idleTimeoutKilled = true;
          this.managedProcess?.kill('SIGTERM');
          const t = setTimeout(() => {
            this.managedProcess?.kill('SIGKILL');
          }, SIGKILL_DELAY_MS);
          this.sigkillTimers.push(t);
        });
    }, this.session.idleTimeoutSec * 1_000);
  }

  // ---------------------------------------------------------------------------
  // Private: process exit
  // ---------------------------------------------------------------------------

  private async onExit(exitCode: number | null): Promise<void> {
    // Guard against double-invocation: the heartbeat liveness check and the
    // real process exit handler can both call onExit. The second call must be
    // a no-op to prevent double-releasing the PG pool client.
    if (this.exitHandled) return;
    this.exitHandled = true;

    const totalSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
    console.log(
      `[session-process] exited session ${this.session.id} code=${exitCode ?? 'null'} status=${this.status} total=${totalSec}s`,
    );
    // Resolve the slot future in case the process exits before ever reaching
    // awaiting_input (e.g. error, cancellation). Safe to call if already resolved.
    this.slotReleaseFuture.resolve();

    this.stopHeartbeat();
    this.stopMcpHealthCheck();
    // Flush any pending deltas before teardown.
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = null;
    }
    this.deltaBuffer = '';
    if (this.thinkingDeltaFlushTimer) {
      clearTimeout(this.thinkingDeltaFlushTimer);
      this.thinkingDeltaFlushTimer = null;
    }
    this.thinkingDeltaBuffer = '';
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Clear any pending SIGKILL escalation timers — the process has already exited.
    for (const t of this.sigkillTimers) {
      clearTimeout(t);
    }
    this.sigkillTimers = [];
    // Drain any approval promises so blocked adapters unblock immediately.
    this.drainPendingApprovals('deny');
    // Stop team inbox polling if active.
    this.teamInboxMonitor?.stopPolling();
    this.teamInboxMonitor = null;
    // Unsubscribe from the control channel to release the pg pool connection.
    // Null it out immediately to prevent any subsequent re-entry from releasing twice.
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;

    // Determine final session status based on exit code.
    // cancelKilled = user pressed Stop → already ended by the cancel route, no error.
    // Clean exit (0) = agent finished normally → idle (resumable).
    // terminateKilled = graceful worker shutdown → idle (auto-resumable on next message).
    // interruptKilled / idleTimeoutKilled → idle (resumable).
    // Anything else → ended (crash / unsupported command).
    if (this.status === 'active' || this.status === 'awaiting_input') {
      if (this.cancelKilled) {
        // Cancel route may have already set status='ended' in DB, but if the process
        // died before the cancel route could update, status may still be 'active'.
        // Explicitly transition to 'ended' to cover both cases.
        await this.transitionTo('ended');
        spawnSync('tmux', ['kill-session', '-t', `shell-${this.session.id}`], { stdio: 'ignore' });
      } else if (
        exitCode === 0 ||
        this.idleTimeoutKilled ||
        this.interruptKilled ||
        this.terminateKilled
      ) {
        await this.transitionTo('idle');
      } else {
        await this.emitEvent({
          type: 'system:error',
          message:
            `Session ended unexpectedly (exit code ${exitCode ?? 'null'}). ` +
            `This may be caused by an unsupported slash command (/mcp, /permissions) or a Claude CLI crash.`,
        });
        await this.transitionTo('ended');
        // Kill the companion terminal tmux session — session is no longer resumable.
        spawnSync('tmux', ['kill-session', '-t', `shell-${this.session.id}`], { stdio: 'ignore' });
      }
    }

    if (this.status === 'ended') {
      await db
        .update(sessions)
        .set({ endedAt: new Date() })
        .where(eq(sessions.id, this.session.id));
    }

    // Mode-change restart: re-enqueue immediately so the session cold-resumes
    // with the updated permissionMode (already written to DB by the PATCH endpoint).
    // The session status is now 'idle', so the next session-runner job can claim it.
    if (this.modeChangeRestart && this.sessionRef) {
      enqueueSession({ sessionId: this.session.id, resumeRef: this.sessionRef }).catch(
        (err: unknown) => {
          console.error(
            `[session-process] Failed to re-enqueue session ${this.session.id} after mode change:`,
            err,
          );
        },
      );
    }

    // Clear-context restart (ExitPlanMode option 1): re-enqueue WITHOUT resumeRef
    // so the session-runner calls adapter.spawn() (not resume) → fresh conversation.
    // DB was already updated (sessionRef=null, new initialPrompt, new permissionMode)
    // in the tool-approval handler before killing the process.
    if (this.clearContextRestart) {
      enqueueSession({ sessionId: this.session.id }).catch((err: unknown) => {
        console.error(
          `[session-process] Failed to re-enqueue session ${this.session.id} after clear-context restart:`,
          err,
        );
      });
    }

    if (this.logWriter) {
      await this.logWriter.close();
      this.logWriter = null;
    }

    this.exitFuture.resolve(exitCode);
  }

  // ---------------------------------------------------------------------------
  // Private: event emission
  // ---------------------------------------------------------------------------

  /**
   * Assign a monotonic sequence number, persist it to the sessions row,
   * publish the event to PG NOTIFY, and write it to the session log file.
   *
   * Returns the fully constructed AgendoEvent for downstream use.
   */
  private async emitEvent(partial: AgendoEventPayload): Promise<AgendoEvent> {
    const seq = ++this.eventSeq;

    // Keep eventSeq in sync on the session row so SSE reconnects know
    // how many events have been emitted without reading the log file.
    await db.update(sessions).set({ eventSeq: seq }).where(eq(sessions.id, this.session.id));

    const event = {
      id: seq,
      sessionId: this.session.id,
      ts: Date.now(),
      ...partial,
    } as AgendoEvent;

    // Publish to the per-session PG NOTIFY channel. The SSE route listens
    // here and forwards events to connected browser clients.
    await publish(channelName('agendo_events', this.session.id), event);

    // Write the structured event line to the session log file for replay.
    if (this.logWriter) {
      this.logWriter.write(serializeEvent(event), 'system');
    }

    return event;
  }

  // ---------------------------------------------------------------------------
  // Private: heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await db
          .update(sessions)
          .set({ heartbeatAt: new Date() })
          .where(eq(sessions.id, this.session.id));
        // Liveness check: kill(pid, 0) throws ESRCH if the process is already dead.
        // This catches silent crashes where the exit handler never fired.
        if (this.managedProcess?.pid) {
          try {
            process.kill(this.managedProcess.pid, 0);
          } catch {
            console.warn(
              `[session-process] Session ${this.session.id}: process ${this.managedProcess.pid} died silently, recovering`,
            );
            void this.onExit(-1);
          }
        }
      } catch (err) {
        console.error(`[session-process] Heartbeat failed for session ${this.session.id}:`, err);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: MCP health check
  // ---------------------------------------------------------------------------

  private startMcpHealthCheck(): void {
    const getMcpStatus = this.adapter.getMcpStatus?.bind(this.adapter);
    if (!getMcpStatus) return;
    this.mcpHealthTimer = setInterval(async () => {
      try {
        const resp = await getMcpStatus();
        if (!resp) return; // timeout or process dead — skip silently
        const servers = Array.isArray(resp.servers)
          ? (resp.servers as Array<{ name: string; status: string }>)
          : [];
        const disconnected = servers.filter(
          (s) => s.status && s.status !== 'connected' && s.status !== 'ready',
        );
        if (disconnected.length > 0) {
          await this.emitEvent({
            type: 'system:mcp-status',
            servers: disconnected,
          });
        }
      } catch (err) {
        console.warn(
          `[session-process] MCP health check failed for session ${this.session.id}:`,
          err,
        );
      }
    }, 60_000);
  }

  private stopMcpHealthCheck(): void {
    if (this.mcpHealthTimer !== null) {
      clearInterval(this.mcpHealthTimer);
      this.mcpHealthTimer = null;
    }
  }

  /**
   * Resolve all pending tool approval promises with the given decision so that
   * any adapter blocked on `handleApprovalRequest` unblocks immediately. Called
   * on cancel, terminate, and idle-timeout to prevent the process from hanging
   * forever waiting for a human who will never respond.
   */
  private drainPendingApprovals(decision: 'allow' | 'deny' | 'allow-session'): void {
    for (const [, resolver] of this.pendingApprovals) {
      resolver(decision);
    }
    this.pendingApprovals.clear();
    this.pendingApprovalsByTool.clear();
  }

  // ---------------------------------------------------------------------------
  // Private: tool approval
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
      // exact match or prefix match (e.g. "Bash(npm test)" matches "Bash")
      return toolName === pattern || toolName.startsWith(pattern.split('(')[0]);
    });
  }

  /**
   * Append a tool name to the session's allowedTools list and persist it to DB.
   * Called when the user approves a tool with 'allow-session'.
   */
  private async persistAllowedTool(toolName: string): Promise<void> {
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

  /**
   * Handle a per-tool approval request from the adapter.
   * If the tool is already on the session allowlist, returns 'allow' immediately.
   * Otherwise, emits an agent:tool-approval event to the frontend and blocks
   * until the user responds via the control channel.
   */
  private async handleApprovalRequest(req: ApprovalRequest): Promise<PermissionDecision> {
    const { approvalId, toolName, toolInput, isAskUser } = req;

    // AskUserQuestion is a human-interaction primitive: the agent is asking the
    // user a question, not requesting permission for a dangerous action.
    // Auto-approve the can_use_tool request — the tool will "fail" in pipe mode
    // (error tool_result), then the interactive-tools renderer shows the question
    // card, and pushToolResult routes the human's answer when it arrives.
    if (isAskUser) {
      return 'allow';
    }

    // Interactive tools always require human input regardless of permissionMode.
    // permissionMode bypasses safety prompts for dangerous tools (Bash, Write…),
    // but ExitPlanMode is a human-interaction primitive —
    // the agent is asking the human something, not requesting permission for a
    // risky action. The Claude Code CLI itself never auto-approves these even in
    // bypassPermissions mode, and we must match that behaviour.
    if (
      this.session.permissionMode !== 'default' &&
      !SessionProcess.APPROVAL_GATED_TOOLS.has(toolName)
    ) {
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
    if (SessionProcess.APPROVAL_GATED_TOOLS.has(toolName)) {
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
  private async handleAskUserQuestion(
    requestId: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const questions =
      (toolInput.questions as
        | Array<{
            question: string;
            header: string;
            options: Array<{ label: string; description: string; markdown?: string }>;
            multiSelect: boolean;
          }>
        | undefined) ?? [];

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
          `[session-process] AskUserQuestion requestId=${requestId} timed out after 5 minutes`,
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
  // Public: wait for process completion
  // ---------------------------------------------------------------------------

  /**
   * Returns a promise that resolves with the process exit code once the
   * session terminates. Useful for the worker to await job completion.
   */
  waitForExit(): Promise<number | null> {
    return this.exitFuture.promise;
  }

  /**
   * Returns a promise that resolves when the pg-boss slot should be freed.
   * Resolves on the first `awaiting_input` transition (process stays alive in
   * memory) or on process exit — whichever comes first.
   *
   * The session-runner uses this instead of waitForExit() so that the pg-boss
   * slot is released immediately once the agent is idle, preventing slot drain
   * from sessions stuck in awaiting_input.
   */
  waitForSlotRelease(): Promise<void> {
    return this.slotReleaseFuture.promise;
  }

  /**
   * Send SIGTERM to the underlying agent process for graceful shutdown.
   * Used during worker shutdown to terminate live sessions that are awaiting input.
   */
  terminate(): void {
    // Set flag BEFORE sending SIGTERM so onExit transitions to 'idle' (resumable)
    // instead of 'ended'. This allows cold-resume after a graceful worker restart.
    this.terminateKilled = true;
    this.managedProcess?.kill('SIGTERM');
  }

  /**
   * Mark this session as intentionally terminated by the worker, WITHOUT
   * sending a signal. Used at the very start of shutdown() — synchronously,
   * before any await — to ensure terminateKilled is true before onExit fires.
   *
   * Needed because SIGINT (Ctrl-C / pm2 restart) is delivered to the whole
   * process group: Claude exits concurrently with our shutdown handler, so
   * we must set the flag before the I/O event loop tick that fires onExit.
   */
  markTerminating(): void {
    this.terminateKilled = true;
  }
}
