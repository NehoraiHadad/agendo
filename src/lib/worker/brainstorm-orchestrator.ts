/**
 * Brainstorm Orchestrator
 *
 * Manages the lifecycle of a brainstorm room: creates participant sessions,
 * runs waves, collects responses, detects PASS convergence, handles user
 * steering, and emits BrainstormEvents over PG NOTIFY for the frontend SSE stream.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolvePlaybook } from '@/lib/brainstorm/playbook';
import {
  computeWaveQuality,
  shouldTriggerReflection,
  REFLECTION_PROMPT,
} from '@/lib/worker/brainstorm-quality';
import type { WaveQualityScore } from '@/lib/worker/brainstorm-quality';
import { DEFAULT_ROLE_INSTRUCTIONS, AUTO_ROLE_ASSIGNMENTS } from '@/lib/brainstorm/role-templates';
import type { BrainstormConfig, BrainstormOutcome } from '@/lib/db/schema';
import { buildTelemetryReport, appendToLocalLog } from '@/lib/brainstorm/telemetry';
import { describeToolActivity } from '@/lib/utils/tool-descriptions';
import {
  STRUCTURED_SYNTHESIS_PROMPT_SUFFIX,
  buildSynthesisPrompt,
  createTasksFromSynthesis,
} from '@/lib/worker/synthesis-decision-log';
import type { DeliverableType } from '@/lib/brainstorm/synthesis-contract';
import { createLogger } from '@/lib/logger';
import { brainstormEventListeners, addSessionEventListener } from '@/lib/worker/worker-sse';
import { liveBrainstormHandlers, liveBrainstormFeedbackHandlers } from '@/lib/worker/worker-http';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { getSessionProc } from '@/lib/worker/session-runner';
import { createSession, getSessionStatus } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import {
  getBrainstorm,
  updateBrainstormStatus,
  updateBrainstormWave,
  updateBrainstormLogPath,
  updateParticipantModel,
  updateParticipantSession,
  updateParticipantStatus,
  updateParticipantRole,
  setBrainstormSynthesis,
  setBrainstormOutcome,
  getCompletedRoomsForProject,
} from '@/lib/services/brainstorm-service';
import { listAgents, getAgentById } from '@/lib/services/agent-service';
import { FileLogWriter, resolveBrainstormLogPath } from '@/lib/worker/log-writer';
import { readBrainstormEventsFromLog } from '@/lib/realtime/event-utils';
import { buildTranscriptFromSessions } from '@/lib/worker/brainstorm-history';
import type {
  BrainstormEvent,
  BrainstormEventPayload,
  AgendoEvent,
  BrainstormParticipantRecovery,
} from '@/lib/realtime/event-types';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';
import { DeltaBuffer } from '@/lib/utils/delta-buffer';
import { getErrorMessage } from '@/lib/utils/error-utils';
import { computeBrainstormOutcome } from '@/lib/worker/brainstorm-outcome';
import {
  buildBrainstormProviderLens,
  inferProviderFromAgentSlug,
} from '@/lib/worker/brainstorm-personas';
import type { Provider } from '@/lib/services/model-service';
import { binaryPathToProvider } from '@/lib/worker/fallback/provider-utils';
import { classifySessionError } from '@/lib/worker/fallback/error-classifier';
import {
  decideFallback,
  type FallbackDecision,
  type FallbackAgentCandidate,
} from '@/lib/worker/fallback/fallback-engine';

const log = createLogger('brainstorm-orchestrator');

/** How long to accumulate text-delta events before flushing to the frontend (ms). */
const DELTA_FLUSH_INTERVAL_MS = 150;

// ============================================================================
// Types
// ============================================================================

type WaveStatus = 'pending' | 'thinking' | 'done' | 'passed' | 'timeout';

/** Feedback signal submitted by a user on behalf of a participant after a wave */
interface WaveFeedback {
  agentId: string;
  participantId: string;
  signal: 'thumbs_up' | 'thumbs_down' | 'focus';
  receivedAt: Date;
}

interface ParticipantState {
  /** DB primary key of the brainstorm_participants row */
  participantId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  agentBinaryPath: string;
  provider: Provider | null;
  sessionId: string | null;
  model?: string;
  modelPinned: boolean;
  role: string | null;
  waveStatus: WaveStatus;
  /** Accumulates agent:text chunks during the current wave turn */
  responseBuffer: string[];
  /** True once this participant has passed in any previous wave (excludes from future waves) */
  hasPassed: boolean;
  /** True once this participant has been explicitly removed — never reset by steer */
  hasLeft: boolean;
  /** Timestamp (ms) when this participant first reached awaiting_input, or null if not yet ready */
  readyAt: number | null;
  /** Batched delta buffer for throttled flush to frontend */
  deltaBuffer: DeltaBuffer;
  /** Number of responses this participant has sent in the current wave (reactive injection tracking) */
  waveResponseCount: number;
  /** Number of consecutive waves this participant timed out without any response */
  consecutiveTimeouts: number;
  /** Last session-level error observed for this participant. */
  lastError: string | null;
  /** Current turn prompt to retry if an in-place fallback succeeds mid-wave. */
  pendingPrompt: string | null;
  /** True while the orchestrator is attempting automatic recovery for this participant. */
  fallbackInFlight: boolean;
  /** Original explicit error that triggered fallback. */
  fallbackTriggerError: string | null;
  /** Candidate model currently being attempted. */
  fallbackTargetModel: string | null;
  /** Previously attempted fallback models for this participant. */
  fallbackAttemptedModels: string[];
  /** Previously attempted replacement agents for this participant slot. */
  fallbackAttemptedAgents: string[];
  /** Structured automatic recovery state surfaced to the room UI. */
  recovery: BrainstormParticipantRecovery | null;
}

function normalizeParticipantError(message: string | null | undefined): string | null {
  const trimmed = message?.trim();
  return trimmed ? trimmed : null;
}

function formatRateLimitError(event: Extract<AgendoEvent, { type: 'system:rate-limit' }>): string {
  const parts = [`Rate limit: ${event.rateLimitType}`];
  if (event.status) parts.push(`status=${event.status}`);
  if (event.overageStatus) parts.push(`overage=${event.overageStatus}`);
  return parts.join(' ');
}

function extractModelFromSystemInfo(message: string): string | null {
  const switchedMatch = message.match(/Model switched to "([^"]+)"/);
  if (switchedMatch?.[1]) return switchedMatch[1];

  const setMatch = message.match(/Model set to ([^.\n]+)/);
  if (setMatch?.[1]) return setMatch[1].trim();

  const reroutedMatch = message.match(/Model rerouted:\s+.+\s+→\s+(.+)/);
  if (reroutedMatch?.[1]) return reroutedMatch[1].trim();

  return null;
}

function isModelSwitchFailureMessage(message: string): boolean {
  return (
    message.startsWith('Failed to switch model') ||
    message === 'Model switching is not supported by this agent.'
  );
}

interface BrainstormControlMessage {
  type: 'steer' | 'end' | 'remove-participant' | 'add-participant' | 'extend' | 'ping';
  text?: string;
  steerId?: string;
  synthesize?: boolean;
  agentId?: string;
  participantId?: string;
  additionalWaves?: number;
}

// ============================================================================
// BrainstormOrchestrator
// ============================================================================

/**
 * Minimum startup timeout for participant sessions (seconds).
 * Participant session initialization involves: MCP resolution, model
 * resolution, SDK handshake (Claude), ACP initialize + session/new
 * (Copilot/Gemini), and the first-turn API round-trip. Under load with
 * multiple concurrent sessions this can exceed 4 minutes. Keep this
 * well above the per-wave timeout so participants aren't evicted before
 * they've had a chance to start.
 */
const MIN_PARTICIPANT_READY_TIMEOUT_SEC = 600; // 10 minutes — global safety net, rarely triggers with per-participant timeouts

/** Per-participant startup timeout. Agents that fail to reach awaiting_input within this window are evicted.
 *  Set to 8 minutes — ACP-based agents (Gemini, Copilot) can take 5-8 minutes for the full ACP
 *  handshake + MCP server registration + initial awaiting_input cycle. 5 minutes was too tight. */
const PER_PARTICIPANT_READY_TIMEOUT_SEC = 480; // 8 minutes

/** Extra time budget for wave 0 (research wave). Agents explore the codebase before responding. */
const WAVE_0_EXTRA_TIMEOUT_SEC = 180; // +3 minutes on top of normal wave timeout

export class BrainstormOrchestrator {
  private readonly roomId: string;
  private eventSeq = 0;
  private room: BrainstormWithDetails | null = null;
  private participants: ParticipantState[] = [];
  private currentWave = 0;
  private maxWaves: number;
  private waveTimeoutSec: number;
  /** Log file writer — opened in run(), closed in finally */
  private logWriter: FileLogWriter | null = null;
  /** Resolved log file path — used by extension resume to read past events */
  private logFilePath: string | null = null;
  /**
   * How long to wait for all participant sessions to reach awaiting_input
   * before the orchestrator gives up. Defaults to 5 minutes (independent
   * of waveTimeoutSec — startup latency is separate from per-wave latency).
   * Can be overridden via room.config.participantReadyTimeoutSec.
   */
  private participantReadyTimeoutSec: number;
  private stopped = false;
  private paused = false;
  /** Extra timeout for wave 0 (research wave), from playbook config */
  private wave0ExtraTimeoutSec: number = WAVE_0_EXTRA_TIMEOUT_SEC;
  /** Convergence mode: 'unanimous' = all must pass; 'majority' = >50% must pass */
  convergenceMode: 'unanimous' | 'majority' = 'unanimous';
  /** Minimum wave number before PASS responses are honored. Default 2. */
  minWavesBeforePass = 2;
  /** @deprecated Not enforced in convergence logic. Kept for backward compat. */
  requiredObjections = 0;
  /** Synthesis mode: 'single' = one agent, 'validated' = synthesize then validate */
  synthesisMode: 'single' | 'validated' = 'single';
  /** Resolved playbook — holds optional fields like language, roles, synthesisAgentId */
  private playbook!: ReturnType<typeof resolvePlaybook>;
  /** Steer messages received mid-wave, applied at the start of the next wave. */
  private pendingSteer: Array<{ text: string; steerId?: string }> = [];
  /** Tracks processed steer IDs for idempotency (prevents duplicate emission on crash-retry). */
  private processedSteerIds = new Set<string>();
  private unsubscribers: Array<() => void> = [];
  private waveCompleteResolve: (() => void) | null = null;
  private waveTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private controlResolve: ((msg: BrainstormControlMessage) => void) | null = null;
  /** Set by the 'end' control message when synthesis was requested. */
  private synthesisPending = false;
  /** Guards against double-subscription when subscribeToSession() is called twice for the same sessionId. */
  private subscribedSessionIds = new Set<string>();
  /**
   * Set to true when startWave() is called; reset to false when waitForWaveComplete() resolves.
   * Prevents checkWaveComplete() from resolving during waitForAllParticipantsReady(),
   * where evicted participants may have waveStatus='done' before any wave has started.
   */
  waveStarted = false;
  /** Enable reactive injection: inject responses into other agents immediately */
  reactiveInjection = false;
  /** Max responses per agent per wave when reactive injection is enabled */
  maxResponsesPerWave = 2;
  /** Count of in-flight reactive injections — wave doesn't complete until this reaches 0 */
  pendingReactiveInjections = 0;
  /** Consecutive timeout count required before a participant is auto-evicted (default 2) */
  evictionThreshold = 2;
  /** Seconds to pause after each wave for user feedback signals (0 = no pause) */
  reviewPauseSec = 0;
  /** Feedback submitted by users per wave: wave → list of feedback entries */
  feedbackMap = new Map<number, WaveFeedback[]>();
  /** Resolve function to unblock waitForFeedback() when all participants respond early */
  private feedbackResolve: (() => void) | null = null;
  /** Current wave being reviewed (used to match incoming feedback to the right window) */
  private reviewingWave: number | null = null;
  /** Whether to automatically inject reflection waves when discussion stalls */
  autoReflection = true;
  /** Minimum waves between consecutive reflection injections */
  reflectionInterval = 3;
  /** Quality scores collected after each wave */
  private waveQualityScores: WaveQualityScore[] = [];
  /** Concatenated non-PASS response text from each prior wave (for repeat detection) */
  private previousWaveTexts: string[] = [];
  /** Wave number of the most recent reflection injection, or undefined if none */
  private lastReflectionWave: number | undefined = undefined;
  private relatedSyntheses:
    | Array<{ title: string; synthesis: string; createdAt: Date }>
    | undefined = undefined;

  // Outcome tracking fields — accumulated during run, computed at end
  private outcomeEndState: BrainstormOutcome['endState'] = 'manual_end';
  private outcomeConvergenceWave: number | null = null;
  private outcomeReflectionWavesTriggered = 0;
  private outcomeTotalTimeoutCount = 0;
  private outcomeSynthesisParseSuccess = false;
  private outcomeTaskCreationCount = 0;
  private outcomeStartTimeMs = 0;

  constructor(roomId: string, maxWaves: number, waveTimeoutSec = 120, config?: BrainstormConfig) {
    this.roomId = roomId;
    this.maxWaves = maxWaves;

    // Resolve full playbook from config (applies defaults for missing fields)
    this.playbook = resolvePlaybook(config);

    // Apply playbook values to instance fields
    this.waveTimeoutSec = config?.waveTimeoutSec ?? waveTimeoutSec;
    this.wave0ExtraTimeoutSec = this.playbook.wave0ExtraTimeoutSec;
    this.convergenceMode = this.playbook.convergenceMode;
    this.minWavesBeforePass = this.playbook.minWavesBeforePass;
    this.requiredObjections = this.playbook.requiredObjections;
    this.synthesisMode = this.playbook.synthesisMode;
    this.reactiveInjection = this.playbook.reactiveInjection;
    this.maxResponsesPerWave = this.playbook.maxResponsesPerWave;
    this.evictionThreshold = this.playbook.evictionThreshold ?? 2;
    this.reviewPauseSec = this.playbook.reviewPauseSec ?? 0;
    this.autoReflection = this.playbook.autoReflection;
    this.reflectionInterval = this.playbook.reflectionInterval;

    // Default startup timeout: at least 10 minutes. Never less than the wave
    // timeout itself (e.g. if waveTimeoutSec was increased significantly).
    this.participantReadyTimeoutSec =
      this.playbook.participantReadyTimeoutSec ??
      Math.max(MIN_PARTICIPANT_READY_TIMEOUT_SEC, this.waveTimeoutSec * 2);
  }

  /** Main entry point — called by the worker job handler */
  async run(): Promise<void> {
    log.info({ roomId: this.roomId }, 'Brainstorm orchestrator starting');
    this.outcomeStartTimeMs = Date.now();

    // Resolve and open the log file for this room. All events emitted via
    // emitEvent() are written here for SSE reconnect replay.
    this.logFilePath = resolveBrainstormLogPath(this.roomId);
    this.logWriter = new FileLogWriter(this.logFilePath);
    this.logWriter.open();

    try {
      const room = await getBrainstorm(this.roomId);
      this.room = room;

      // Persist the log file path so the SSE endpoint can locate it on reconnect.
      // Use the room's existing logFilePath if already set (extension resume).
      if (!room.logFilePath) {
        await updateBrainstormLogPath(this.roomId, this.logFilePath);
      } else {
        // Existing path — reopen the log writer against the persisted path so
        // all events from all runs land in the same file.
        this.logWriter.close().catch(() => {});
        this.logFilePath = room.logFilePath;
        this.logWriter = new FileLogWriter(this.logFilePath);
        this.logWriter.open();

        // Continue event IDs from the last event in the log file to prevent
        // ID resets across orchestrator lifecycles. Without this, each new
        // orchestrator starts at eventSeq=0, producing overlapping IDs that
        // can confuse SSE reconnect catchup filtering.
        try {
          const logContent = readFileSync(this.logFilePath, 'utf-8');
          const lines = logContent.trimEnd().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const match = lines[i].match(/^\[(\d+)\|/);
            if (match) {
              this.eventSeq = parseInt(match[1], 10);
              log.info(
                { roomId: this.roomId, resumeFromEventSeq: this.eventSeq },
                'Resuming event sequence from log file',
              );
              break;
            }
          }
        } catch {
          // Log file unreadable — start from 0 (safe fallback)
        }
      }

      // Re-resolve playbook from DB config (authoritative — may differ from
      // what was passed to the constructor if the room was edited between
      // creation and start).
      const roomConfig = room.config as BrainstormConfig | null;
      this.playbook = resolvePlaybook(roomConfig);
      this.waveTimeoutSec = this.playbook.waveTimeoutSec;
      this.wave0ExtraTimeoutSec = this.playbook.wave0ExtraTimeoutSec;
      this.convergenceMode = this.playbook.convergenceMode;
      this.minWavesBeforePass = this.playbook.minWavesBeforePass;
      this.requiredObjections = this.playbook.requiredObjections;
      this.synthesisMode = this.playbook.synthesisMode;
      this.reactiveInjection = this.playbook.reactiveInjection;
      this.maxResponsesPerWave = this.playbook.maxResponsesPerWave;
      this.evictionThreshold = this.playbook.evictionThreshold ?? 2;
      this.reviewPauseSec = this.playbook.reviewPauseSec ?? 0;
      this.autoReflection = this.playbook.autoReflection;
      this.reflectionInterval = this.playbook.reflectionInterval;
      this.participantReadyTimeoutSec =
        this.playbook.participantReadyTimeoutSec ??
        Math.max(MIN_PARTICIPANT_READY_TIMEOUT_SEC, this.waveTimeoutSec * 2);

      // Build participant state from DB records
      this.participants = room.participants.map((p) => ({
        participantId: p.id,
        agentId: p.agentId,
        agentName: p.agentName,
        agentSlug: p.agentSlug,
        agentBinaryPath: p.agentBinaryPath,
        provider: binaryPathToProvider(p.agentBinaryPath),
        sessionId: p.sessionId ?? null,
        model: p.model ?? undefined,
        modelPinned: p.model !== null,
        role: p.role ?? null,
        waveStatus: 'pending' as WaveStatus,
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        readyAt: null,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- initialized in loop below
        deltaBuffer: undefined!,
        waveResponseCount: 0,
        consecutiveTimeouts: 0,
        lastError: null,
        pendingPrompt: null,
        fallbackInFlight: false,
        fallbackTriggerError: null,
        fallbackTargetModel: null,
        fallbackAttemptedModels: [],
        fallbackAttemptedAgents: [],
        recovery: null,
      }));

      // Initialize DeltaBuffers after participants are created (needs `this` for emitEvent)
      for (const p of this.participants) {
        p.deltaBuffer = this.createParticipantDeltaBuffer(p);
      }

      // Mark room as active
      await updateBrainstormStatus(this.roomId, 'active');
      await this.emitEvent({ type: 'room:state', status: 'active' });
      // Emit the current maxWaves so the UI stays in sync (especially on resume
      // after extensions — the store's maxWaves may be stale from initial page load).
      await this.emitEvent({ type: 'room:config', maxWaves: this.maxWaves });

      // Register the control handler BEFORE creating sessions so that any steer
      // sent by the user during the (potentially 10+ min) startup window is
      // queued in this.pendingSteer rather than silently dropped.
      this.subscribeToControl();

      // Create sessions for all participants
      await this.createParticipantSessions(room);

      // Run the wave loop
      await this.runWaveLoop(room);
    } catch (err) {
      log.error({ err, roomId: this.roomId }, 'Brainstorm orchestrator error');
      this.outcomeEndState = 'error';
      await this.emitEvent({
        type: 'room:error',
        message: getErrorMessage(err),
      }).catch(() => {});
      // Use 'paused' so the steer route can re-enqueue and recover the room.
      // 'ended' is reserved for intentional user-initiated stops.
      await updateBrainstormStatus(this.roomId, 'paused').catch(() => {});
      await this.emitEvent({ type: 'room:state', status: 'paused' }).catch(() => {});
    } finally {
      // Compute and persist structured outcome for post-hoc analysis
      try {
        const roomConfig = this.room?.config as BrainstormConfig | undefined;
        const outcome = computeBrainstormOutcome({
          endState: this.outcomeEndState,
          totalWaves: this.currentWave + 1,
          participants: this.participants.map((p) => ({
            hasPassed: p.hasPassed,
            hasLeft: p.hasLeft,
          })),
          startTimeMs: this.outcomeStartTimeMs,
          endTimeMs: Date.now(),
          convergenceWave: this.outcomeConvergenceWave,
          reflectionWavesTriggered: this.outcomeReflectionWavesTriggered,
          synthesisParseSuccess: this.outcomeSynthesisParseSuccess,
          taskCreationCount: this.outcomeTaskCreationCount,
          deliverableType: roomConfig?.deliverableType ?? null,
          totalTimeoutCount: this.outcomeTotalTimeoutCount,
        });
        await setBrainstormOutcome(this.roomId, outcome);
        await this.emitEvent({ type: 'brainstorm:outcome', outcome });
        log.info({ roomId: this.roomId, outcome }, 'Brainstorm outcome recorded');

        // Telemetry: build anonymous report and write to local JSONL
        this.recordTelemetry(outcome, roomConfig);
      } catch (outcomeErr) {
        log.error({ err: outcomeErr, roomId: this.roomId }, 'Failed to record brainstorm outcome');
      }

      // Always cancel participant sessions — whether clean exit or crash.
      // Leaving them in awaiting_input wastes worker slots for up to 1 hour
      // (idle timeout). When the room resumes, createParticipantSessions()
      // will re-enqueue them fresh.
      await this.terminateParticipantSessions().catch(() => {});
      this.cleanup();
      // Close the log writer after all events have been flushed.
      if (this.logWriter) {
        await this.logWriter.close().catch(() => {});
        this.logWriter = null;
      }
      log.info({ roomId: this.roomId }, 'Brainstorm orchestrator finished');
    }
  }

  // ============================================================================
  // Session creation
  // ============================================================================

  private async createParticipantSessions(room: BrainstormWithDetails): Promise<void> {
    const allNames = room.participants.map((p) => p.agentName);

    // Fetch related brainstorm syntheses if relatedRoomIds are configured
    const roomConfig = room.config as BrainstormConfig;
    let relatedSyntheses: Array<{ title: string; synthesis: string; createdAt: Date }> | undefined;
    if (roomConfig.relatedRoomIds && roomConfig.relatedRoomIds.length > 0) {
      try {
        const completedRooms = await getCompletedRoomsForProject(room.projectId);
        const relatedIds = new Set(roomConfig.relatedRoomIds.slice(0, 3));
        relatedSyntheses = completedRooms.filter((r) => relatedIds.has(r.id));
        if (relatedSyntheses.length > 0) {
          log.info(
            { roomId: this.roomId, relatedCount: relatedSyntheses.length },
            'Injecting context from related brainstorms',
          );
        }
      } catch (err) {
        log.warn({ roomId: this.roomId, err }, 'Failed to fetch related brainstorm syntheses');
      }
    }

    // Auto-assign roles when none are explicitly configured.
    // Uses AUTO_ROLE_ASSIGNMENTS to map role labels to participant slugs based
    // on active participant count. The assignment is stored on this.playbook so
    // buildPreamble() can inject personalized instructions per participant.
    if (!roomConfig.roles || Object.keys(roomConfig.roles).length === 0) {
      const activeParticipants = this.participants.filter((p) => !p.hasLeft);
      const autoRoles = AUTO_ROLE_ASSIGNMENTS[activeParticipants.length];
      if (autoRoles) {
        const autoRolesMap: Record<string, string> = {};
        autoRoles.forEach((role, i) => {
          if (activeParticipants[i]) {
            autoRolesMap[role] = activeParticipants[i].agentSlug;
          }
        });
        this.playbook = { ...this.playbook, roles: autoRolesMap };
        log.info(
          { roomId: this.roomId, roles: autoRolesMap },
          'Auto-assigned roles based on participant count',
        );
        // Save roles to the database
        for (const role in autoRolesMap) {
          const agentSlug = autoRolesMap[role];
          const participant = this.participants.find((p) => p.agentSlug === agentSlug);
          if (participant) {
            await updateParticipantRole(participant.participantId, role);
          }
        }
      }
    }

    // Create/resume all participant sessions in parallel — each is independent.
    // Parallelizing means Codex, Claude, and Copilot all start their ACP/SDK
    // handshakes at the same time instead of waiting for each other.
    await Promise.all(
      this.participants.map(async (participant) => {
        // Skip if a session was already assigned (e.g. resuming after extension)
        if (participant.sessionId) {
          const sessionId = participant.sessionId;
          const sessionInfo = await getSessionStatus(sessionId);
          const sessionStatus = sessionInfo?.status ?? 'idle';

          // Subscribe before potentially triggering the session to avoid missing events
          this.subscribeToSession(participant);

          if (sessionStatus === 'awaiting_input') {
            // Session is still alive and ready — mark it done immediately so
            // waitForAllParticipantsReady() doesn't time out waiting for an event
            // that already fired before we subscribed.
            participant.waveStatus = 'done';
            log.info(
              { roomId: this.roomId, sessionId, sessionStatus },
              'Participant session already awaiting_input — marked ready directly',
            );
          } else {
            // Session is idle / ended — re-enqueue it.
            // session-runner uses session.sessionRef from DB to --resume the conversation.
            // singletonKey prevents duplicate jobs if somehow already queued.
            await enqueueSession({ sessionId });
            log.info(
              { roomId: this.roomId, sessionId, sessionStatus },
              'Re-enqueued participant session for room extension',
            );
          }
          return;
        }

        const otherNames = allNames.filter((n) => n !== participant.agentName);
        const preamble = this.buildPreamble(
          room,
          otherNames,
          participant.agentSlug,
          relatedSyntheses,
          participant.provider,
        );

        log.info(
          { roomId: this.roomId, agentId: participant.agentId, agentName: participant.agentName },
          'Creating participant session',
        );

        const session = await createSession({
          agentId: participant.agentId,
          projectId: room.projectId,
          taskId: room.taskId ?? undefined,
          initialPrompt: preamble,
          permissionMode: 'bypassPermissions',
          kind: 'conversation',
          // Brainstorm sessions must stay alive while the orchestrator waits for
          // ALL participants to start. Slow agents (Copilot ACP, Codex app-server)
          // can take 5-8 minutes to initialize. With the default 10-min idle timeout,
          // fast agents would idle-timeout before slow ones even start.
          idleTimeoutSec: 3600, // 1 hour
        });

        participant.sessionId = session.id;
        await updateParticipantSession(participant.participantId, session.id);
        await updateParticipantStatus(participant.participantId, 'active');

        // Subscribe before enqueuing to avoid missing the first awaiting_input event
        await this.subscribeToSession(participant);

        // Enqueue the session into pg-boss — the worker will start it
        await enqueueSession({ sessionId: session.id });

        // Emit joined event
        const role = Object.entries(this.playbook.roles || {}).find(
          ([, slug]) => slug === participant.agentSlug,
        )?.[0];
        participant.role = role ?? null;
        await this.emitParticipantJoined(participant);

        log.info(
          { roomId: this.roomId, sessionId: session.id, agentName: participant.agentName },
          'Participant session created',
        );
      }),
    );

    // Wait for all participants to reach awaiting_input (session is ready for messages)
    await this.waitForAllParticipantsReady();
  }

  /**
   * Wait until all participants have reached awaiting_input at least once.
   * Relies on subscribeToSession() setting waveStatus='done' on first awaiting_input.
   *
   * Per-participant timeout: if any individual agent fails to start within
   * PER_PARTICIPANT_READY_TIMEOUT_SEC (3 minutes), it is evicted from the room
   * and the brainstorm continues with the remaining participants. If ALL participants
   * fail to start, the brainstorm rejects so the room can be marked as paused.
   *
   * A global safety-net timeout (participantReadyTimeoutSec, default 10 min) still
   * applies as a backstop but should rarely trigger now.
   */
  private async waitForAllParticipantsReady(): Promise<void> {
    const globalTimeoutMs = this.participantReadyTimeoutSec * 1000;
    const perParticipantTimeoutMs = PER_PARTICIPANT_READY_TIMEOUT_SEC * 1000;
    // Record when we entered this method — all participant timers start here because
    // createParticipantSessions() launches all sessions in parallel before calling us.
    const startedAt = Date.now();
    let cancelled = false;
    let pollCount = 0;

    log.info(
      {
        roomId: this.roomId,
        globalTimeoutSec: this.participantReadyTimeoutSec,
        perParticipantTimeoutSec: PER_PARTICIPANT_READY_TIMEOUT_SEC,
        count: this.participants.length,
      },
      'Waiting for participant sessions to reach awaiting_input',
    );

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const check = async () => {
          if (cancelled) return;

          // If end was requested during startup, resolve immediately so
          // the wave loop's this.stopped check terminates the orchestrator.
          if (this.stopped) {
            log.info({ roomId: this.roomId }, 'End received during startup — aborting wait');
            resolve();
            return;
          }

          const elapsed = Date.now() - startedAt;

          // Check per-participant timeouts for participants still pending/thinking.
          for (const p of this.participants) {
            if (p.hasLeft || p.waveStatus === 'done' || p.waveStatus === 'passed') continue;
            if (elapsed < perParticipantTimeoutMs) continue;

            // This participant has exceeded its per-participant startup window.
            log.warn(
              {
                roomId: this.roomId,
                agentName: p.agentName,
                elapsedSec: Math.round(elapsed / 1000),
              },
              'Participant failed to start within per-participant timeout — evicting',
            );

            const failureReason =
              p.lastError ??
              `Session did not become ready within ${Math.round(perParticipantTimeoutMs / 1000)} seconds`;

            await this.emitEvent({
              type: 'room:error',
              message: `Agent ${p.agentName} failed to start: ${failureReason}`,
            }).catch(() => {});

            p.hasLeft = true;
            p.hasPassed = true;
            p.waveStatus = 'done';
            p.lastError = failureReason;

            await updateParticipantStatus(p.participantId, 'left').catch(() => {});

            await this.emitParticipantLeft(p, failureReason).catch(() => {});
          }

          // Check if all remaining (non-evicted) participants are ready.
          const remaining = this.participants.filter((p) => !p.hasLeft);
          if (remaining.length === 0) {
            reject(
              new Error('All participants failed to start within the per-participant timeout'),
            );
            return;
          }

          const allReady = remaining.every(
            (p) => p.waveStatus === 'done' || p.waveStatus === 'passed',
          );
          if (allReady) {
            resolve();
            return;
          }

          // Every 10 iterations (~5 seconds), poll DB for participants that may
          // have reached awaiting_input without us receiving the PG NOTIFY event
          // (e.g., event fired before subscription was established, or notification dropped).
          pollCount++;
          if (pollCount % 10 === 0) {
            for (const p of this.participants) {
              if (p.hasLeft || p.waveStatus === 'done' || p.waveStatus === 'passed' || !p.sessionId)
                continue;
              try {
                const info = await getSessionStatus(p.sessionId);
                if (info?.status === 'awaiting_input') {
                  log.info(
                    { roomId: this.roomId, sessionId: p.sessionId, agentName: p.agentName },
                    'Participant detected as ready via DB poll (PG NOTIFY may have been missed)',
                  );
                  p.waveStatus = 'done';
                }
              } catch {
                // Ignore DB errors during polling
              }
            }
          }

          setTimeout(check, 500);
        };
        void check();
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          cancelled = true;
          const notReady = this.participants
            .filter((p) => !p.hasLeft && p.waveStatus !== 'done' && p.waveStatus !== 'passed')
            .map((p) => p.agentName);
          reject(
            new Error(
              `Participants did not reach ready state within ${globalTimeoutMs}ms (global safety net). ` +
                `Still pending: ${notReady.join(', ')}`,
            ),
          );
        }, globalTimeoutMs),
      ),
    ]);

    // Reset statuses to 'pending' for wave 0 (only for participants still in the room).
    for (const p of this.participants) {
      if (p.hasLeft) continue;
      p.waveStatus = 'pending';
      p.responseBuffer = [];
      p.deltaBuffer.clear();
    }

    const activeCount = this.participants.filter((p) => !p.hasLeft).length;
    log.info({ roomId: this.roomId, activeCount }, 'All participant sessions ready');
  }

  // ============================================================================
  // Hot-add participant (mid-brainstorm)
  // ============================================================================

  /**
   * Add a new participant to a running brainstorm. Creates their session,
   * waits for it to reach awaiting_input, and integrates them into future waves.
   * The DB row is already created by the API route before this is called.
   */
  private async hotAddParticipant(
    agentId: string,
    model?: string,
    participantId?: string,
  ): Promise<void> {
    // Check if this exact participant slot is already tracked
    if (participantId) {
      const existing = this.participants.find((p) => p.participantId === participantId);
      if (existing) {
        log.warn({ roomId: this.roomId, participantId }, 'Participant already tracked');
        return;
      }
    }

    // Fetch agent details
    const agent = await getAgentById(agentId);

    // Refresh room to get the new participant's DB record.
    // Use participantId for exact match (critical for duplicate agents).
    const room = await getBrainstorm(this.roomId);
    const dbParticipant = participantId
      ? room.participants.find((p) => p.id === participantId)
      : room.participants.find((p) => p.agentId === agentId && p.status !== 'left');
    if (!dbParticipant) {
      log.error({ roomId: this.roomId, agentId, participantId }, 'New participant not found in DB');
      return;
    }

    // Build the participant state
    const participant: ParticipantState = {
      participantId: dbParticipant.id,
      agentId,
      agentName: agent.name,
      agentSlug: agent.slug,
      agentBinaryPath: agent.binaryPath,
      provider: binaryPathToProvider(agent.binaryPath),
      sessionId: null,
      model: model ?? dbParticipant.model ?? undefined,
      modelPinned:
        (model ?? dbParticipant.model) !== null && (model ?? dbParticipant.model) !== undefined,
      role: null,
      waveStatus: 'pending',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: null,
      deltaBuffer: this.createParticipantDeltaBuffer({} as ParticipantState), // temp, replaced below
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
      lastError: null,
      pendingPrompt: null,
      fallbackInFlight: false,
      fallbackTriggerError: null,
      fallbackTargetModel: null,
      fallbackAttemptedModels: [],
      fallbackAttemptedAgents: [],
      recovery: null,
    };
    // Create a proper delta buffer bound to this participant
    participant.deltaBuffer = this.createParticipantDeltaBuffer(participant);

    this.participants.push(participant);

    // Build preamble with current participants
    const otherNames = this.participants
      .filter((p) => !p.hasLeft && p.agentId !== agentId)
      .map((p) => p.agentName);
    const preamble = this.buildPreamble(
      room,
      otherNames,
      agent.slug,
      undefined,
      binaryPathToProvider(agent.binaryPath),
    );

    log.info(
      { roomId: this.roomId, agentId, agentName: agent.name, wave: this.currentWave },
      'Hot-adding participant to running brainstorm',
    );

    // Create the session
    const session = await createSession({
      agentId,
      projectId: room.projectId,
      taskId: room.taskId ?? undefined,
      initialPrompt: preamble,
      permissionMode: 'bypassPermissions',
      kind: 'conversation',
      idleTimeoutSec: 3600,
    });

    participant.sessionId = session.id;
    await updateParticipantSession(participant.participantId, session.id);
    await updateParticipantStatus(participant.participantId, 'active');
    await this.subscribeToSession(participant);
    await enqueueSession({ sessionId: session.id });
    await this.emitParticipantJoined(participant);

    // Wait for the new participant to reach awaiting_input (with timeout)
    const timeoutMs = PER_PARTICIPANT_READY_TIMEOUT_SEC * 1000;
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (participant.waveStatus === 'done' || participant.hasLeft) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          log.warn(
            { roomId: this.roomId, agentId, agentName: agent.name },
            'Hot-added participant timed out waiting for ready state',
          );
          participant.hasLeft = true;
          void updateParticipantStatus(participant.participantId, 'left').catch(() => {});
          void this.emitParticipantLeft(participant).catch(() => {});
          resolve();
          return;
        }
        setTimeout(check, 2000);
      };
      check();
    });

    if (!participant.hasLeft) {
      // Reset to pending so they participate in the next wave
      participant.waveStatus = 'pending';
      participant.responseBuffer = [];
      participant.deltaBuffer.clear();
      log.info(
        { roomId: this.roomId, agentId, agentName: agent.name },
        'Hot-added participant is ready and will join next wave',
      );
    }
  }

  // ============================================================================
  // Subscription management
  // ============================================================================

  /** Subscribe to a participant session's event channel via in-memory listener. */
  private subscribeToSession(participant: ParticipantState): void {
    if (!participant.sessionId) return;
    const sessionId = participant.sessionId;

    // Guard against double-subscription (e.g. extension resume calling subscribeToSession
    // for a participant that already has a live subscription from a prior call).
    if (this.subscribedSessionIds.has(sessionId)) {
      log.info(
        { roomId: this.roomId, sessionId },
        'Session already subscribed — skipping duplicate',
      );
      return;
    }
    this.subscribedSessionIds.add(sessionId);

    const unsub = addSessionEventListener(sessionId, (event: AgendoEvent) => {
      this.handleSessionEvent(participant, event);
    });

    this.unsubscribers.push(unsub);
  }

  // ============================================================================
  // Feedback signals
  // ============================================================================

  /**
   * Store a user feedback signal for the given wave.
   * If all active participants have now submitted feedback during an active review
   * window, resolve the waitForFeedback() promise early.
   */
  receiveFeedback(
    wave: number,
    agentId: string,
    signal: 'thumbs_up' | 'thumbs_down' | 'focus',
    participantId?: string,
  ): void {
    // Resolve participantId: if not provided, look up from agentId (backward compat).
    // For duplicate agents this may match the wrong slot, but feedback is best-effort.
    const resolvedParticipantId =
      participantId ??
      this.participants.find((p) => p.agentId === agentId && !p.hasLeft)?.participantId ??
      agentId;

    const entry: WaveFeedback = {
      agentId,
      participantId: resolvedParticipantId,
      signal,
      receivedAt: new Date(),
    };
    const existing = this.feedbackMap.get(wave) ?? [];
    existing.push(entry);
    this.feedbackMap.set(wave, existing);

    log.info(
      { roomId: this.roomId, wave, agentId, participantId: resolvedParticipantId, signal },
      'Feedback received',
    );

    // Early resolution: if we are currently waiting for feedback on this wave,
    // check whether all active participants have now submitted.
    // Key by participantId to correctly handle duplicate agents.
    if (this.reviewingWave === wave && this.feedbackResolve) {
      const activeParticipants = this.participants.filter((p) => !p.hasLeft && !p.hasPassed);
      const activeIds = new Set(activeParticipants.map((p) => p.participantId));
      const respondedIds = new Set(existing.map((f) => f.participantId));
      const allResponded = [...activeIds].every((id) => respondedIds.has(id));

      if (allResponded) {
        log.info({ roomId: this.roomId, wave }, 'All participants responded — ending review early');
        const resolve = this.feedbackResolve;
        this.feedbackResolve = null;
        this.reviewingWave = null;
        resolve();
      }
    }
  }

  /**
   * Wait for user feedback signals, resolving after `timeoutMs` or when all
   * active participants have submitted feedback (whichever comes first).
   * Resolves immediately when timeoutMs is 0.
   */
  waitForFeedback(timeoutMs: number, _participantCount: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.feedbackResolve = resolve;

      const timer = setTimeout(() => {
        if (this.feedbackResolve === resolve) {
          this.feedbackResolve = null;
          this.reviewingWave = null;
          resolve();
        }
      }, timeoutMs);

      // If already all responded (race: feedback arrived before this method was called),
      // resolve immediately and cancel the timer.
      const activeParticipants = this.participants.filter((p) => !p.hasLeft && !p.hasPassed);
      if (activeParticipants.length > 0 && this.reviewingWave !== null) {
        const existing = this.feedbackMap.get(this.reviewingWave) ?? [];
        const respondedIds = new Set(existing.map((f) => f.participantId));
        const allResponded = activeParticipants.every((p) => respondedIds.has(p.participantId));
        if (allResponded) {
          clearTimeout(timer);
          this.feedbackResolve = null;
          this.reviewingWave = null;
          resolve();
        }
      }
    });
  }

  /**
   * Format accumulated feedback for wave N as a moderator note to inject into
   * the next wave broadcast. Returns null if no feedback was received.
   */
  formatFeedbackNote(wave: number): string | null {
    const feedback = this.feedbackMap.get(wave);
    if (!feedback || feedback.length === 0) return null;

    const agentNameMap = new Map(this.participants.map((p) => [p.agentId, p.agentName]));

    const lines = feedback.map((f) => {
      const name = agentNameMap.get(f.agentId) ?? f.agentId;
      switch (f.signal) {
        case 'thumbs_up':
          return `- ${name}: 👍 (on track)`;
        case 'thumbs_down':
          return `- ${name}: 👎 (off topic)`;
        case 'focus':
          return `- ${name}: 🎯 Focus (dig deeper here)`;
      }
    });

    return `## Moderator Feedback (Wave ${wave})\n${lines.join('\n')}`;
  }

  /**
   * Build a bounded metadata section for the synthesis prompt.
   * Includes wave quality scores, pass history, user feedback signals,
   * and a short discussion arc summary.
   * Capped at ~500 tokens to avoid bloating the synthesis context.
   */
  private buildSynthesisMetadata(): string {
    const sections: string[] = [];

    // --- Discussion overview ---
    const totalWaves = this.currentWave + 1;
    const activeCount = this.participants.filter((p) => !p.hasLeft).length;
    const passedCount = this.participants.filter((p) => p.hasPassed && !p.hasLeft).length;
    sections.push(
      `DISCUSSION METADATA:\n- Total waves: ${totalWaves}\n- Participants: ${activeCount} (${passedCount} passed/converged)`,
    );

    // --- Wave quality scores (compact, last 10 waves max) ---
    if (this.waveQualityScores.length > 0) {
      const scores = this.waveQualityScores.slice(-10);
      const scoreLines = scores.map(
        (s) =>
          `  Wave ${s.wave}: novelty=${s.newIdeasCount}, repeat=${(s.repeatRatio * 100).toFixed(0)}%, passes=${s.passCount}, agreement=${(s.agreementRatio * 100).toFixed(0)}%`,
      );
      sections.push(`Wave Quality:\n${scoreLines.join('\n')}`);
    }

    // --- Pass history ---
    const passHistory: string[] = [];
    for (const p of this.participants) {
      if (p.hasPassed && !p.hasLeft) {
        passHistory.push(`  ${p.agentName}: passed`);
      } else if (p.hasLeft) {
        passHistory.push(`  ${p.agentName}: left/evicted`);
      }
    }
    if (passHistory.length > 0) {
      sections.push(`Participant Status:\n${passHistory.join('\n')}`);
    }

    // --- User feedback signals ---
    const feedbackEntries: string[] = [];
    for (const [wave, entries] of this.feedbackMap) {
      const agentNameMap = new Map(this.participants.map((p) => [p.agentId, p.agentName]));
      for (const f of entries) {
        const name = agentNameMap.get(f.agentId) ?? 'User';
        const signalLabel =
          f.signal === 'thumbs_up' ? 'positive' : f.signal === 'thumbs_down' ? 'negative' : 'focus';
        feedbackEntries.push(`  Wave ${wave}: ${name} → ${signalLabel}`);
      }
    }
    if (feedbackEntries.length > 0) {
      // Cap to last 15 entries
      const capped = feedbackEntries.slice(-15);
      sections.push(`User Feedback Signals:\n${capped.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Record anonymous telemetry for this brainstorm session.
   * Always writes to local JSONL. Emits SSE event for opt-in GitHub reporting.
   */
  private recordTelemetry(
    outcome: BrainstormOutcome,
    _roomConfig: BrainstormConfig | undefined,
  ): void {
    try {
      const report = buildTelemetryReport({
        outcome,
        waveQualityScores: this.waveQualityScores,
        feedbackMap: this.feedbackMap,
        participants: this.participants.map((p) => ({
          agentSlug: p.agentSlug,
          agentId: p.agentId,
        })),
        config: {
          convergenceMode: this.convergenceMode,
          synthesisMode: this.synthesisMode,
          waveTimeoutSec: this.waveTimeoutSec,
          minWavesBeforePass: this.minWavesBeforePass,
          reactiveInjection: this.reactiveInjection,
          autoReflection: this.playbook.autoReflection,
          reviewPauseSec: this.reviewPauseSec,
        },
        maxWaves: this.maxWaves,
        presetId: null, // Not tracked at orchestrator level
      });

      // Always write to local log
      const logDir = process.env.LOG_DIR ?? './logs';
      appendToLocalLog(report, logDir);

      // Emit SSE event so frontend can show confirmation dialog for GitHub opt-in
      void this.emitEvent({ type: 'room:telemetry', report }).catch(() => {});

      log.info({ roomId: this.roomId }, 'Telemetry report generated');
    } catch (err) {
      log.warn({ err, roomId: this.roomId }, 'Failed to generate telemetry report');
    }
  }

  /** Register the control message handler in the Worker HTTP dispatch map. */
  private subscribeToControl(): void {
    const handler = (rawPayload: string) => {
      let msg: BrainstormControlMessage;
      try {
        msg = JSON.parse(rawPayload) as BrainstormControlMessage;
      } catch {
        log.warn({ roomId: this.roomId, rawPayload }, 'Invalid control message');
        return;
      }
      this.handleControlMessage(msg);
    };

    liveBrainstormHandlers.set(this.roomId, handler);
  }

  // ============================================================================
  // Wave loop
  // ============================================================================

  private async runWaveLoop(room: BrainstormWithDetails): Promise<void> {
    // For fresh rooms: start from wave 0 with the topic.
    // For extended rooms (currentWave > 0): resume from the next wave,
    // seeding it with the last wave's collected responses from the log file.
    let wave = room.currentWave > 0 ? room.currentWave + 1 : 0;
    let waveContent: string;

    if (wave === 0) {
      waveContent = room.topic;
    } else {
      // Resuming after convergence/pause. Read historical events from the log
      // file to find a pending user steer and the last wave's agent messages.
      const allEvents =
        this.logFilePath && existsSync(this.logFilePath)
          ? readBrainstormEventsFromLog(readFileSync(this.logFilePath, 'utf-8'), 0)
          : [];

      // Check for a pending user steer written by the steer API route while
      // the orchestrator wasn't running (paused room scenario).
      const userSteerEvent = allEvents.find(
        (e) => e.type === 'message' && e.wave === wave && e.senderType === 'user',
      );
      const userSteer =
        userSteerEvent?.type === 'message' && userSteerEvent.senderType === 'user'
          ? userSteerEvent
          : null;

      // Fetch the last completed wave's agent messages to seed the next wave.
      const agentMap = new Map(this.participants.map((p) => [p.agentId, p.agentName]));
      const agentMessages = allEvents
        .filter(
          (e) =>
            e.type === 'message' &&
            e.wave === room.currentWave &&
            e.senderType === 'agent' &&
            !e.isPass,
        )
        .map((e) => ({
          agentName: e.type === 'message' ? (agentMap.get(e.agentId ?? '') ?? 'Agent') : 'Agent',
          content: e.type === 'message' ? e.content : '',
          isPass: false,
        }));

      if (userSteer) {
        // User sent a steer while paused — resume with their message.
        // The steer event was already written to the log by the steer route;
        // re-emit it here so live subscribers see the resume without duplication.
        const steerId = (userSteer as unknown as { steerId?: string }).steerId;
        if (steerId && this.processedSteerIds.has(steerId)) {
          log.info({ roomId: this.roomId, wave, steerId }, 'Duplicate steer from log skipped');
        } else {
          if (steerId) this.processedSteerIds.add(steerId);
          log.info(
            { roomId: this.roomId, wave, steerId },
            'Found pending user steer from log, resuming',
          );
          await this.resetPassedParticipants();
          await this.emitEvent({
            type: 'message',
            wave,
            senderType: 'user',
            content: userSteer.content,
            isPass: false,
          });
        }
        waveContent = this.formatUserSteer(userSteer.content, agentMessages);
      } else {
        waveContent =
          agentMessages.length > 0
            ? this.formatWaveBroadcast(agentMessages)
            : `[Continuing from wave ${room.currentWave}. Please share your next thoughts on the topic.]`;
      }
    }

    while (!this.stopped) {
      // Start the wave
      await this.startWave(wave, waveContent);

      // Wait for all active participants to finish (or timeout)
      await this.waitForWaveComplete();

      // Collect responses from this wave.
      // Include timed-out participants (isTimeout=true) so convergence counts them
      // against the total — timeout attrition must not be mistaken for genuine PASS agreement.
      // Exclude only hasPassed (permanent pass from a previous wave) and hasLeft (evicted).
      const responses = this.participants
        .filter((p) => !p.hasPassed && !p.hasLeft)
        .map((p) => ({
          agentName: p.agentName,
          agentId: p.agentId,
          content: p.responseBuffer.join('').trim(),
          isPass: p.waveStatus === 'passed',
          isTimeout: p.waveStatus === 'timeout',
        }));

      // Track total timeout count for outcome instrumentation
      this.outcomeTotalTimeoutCount += responses.filter((r) => r.isTimeout).length;

      // Update hasPassed for participants who passed this wave
      for (const p of this.participants) {
        if (p.waveStatus === 'passed') {
          p.hasPassed = true;
          await updateParticipantStatus(p.participantId, 'passed');
        }
      }

      // Track consecutive timeouts and auto-evict dead participants
      await this.trackConsecutiveTimeouts();

      // Emit wave:complete
      await this.emitEvent({ type: 'wave:complete', wave });

      // Compute wave quality and emit wave:quality event
      const qualityScore = computeWaveQuality(wave, responses, this.previousWaveTexts);
      this.waveQualityScores.push(qualityScore);
      await this.emitEvent({ type: 'wave:quality', wave, score: qualityScore });

      // Accumulate this wave's non-PASS response texts for future repeat detection
      const currentWaveText = responses
        .filter((r) => !r.isPass && !r.isTimeout && r.content)
        .map((r) => r.content)
        .join(' ');
      if (currentWaveText) {
        this.previousWaveTexts.push(currentWaveText);
      }

      // Review pause: if configured, emit wave:review and wait for feedback
      if (this.reviewPauseSec > 0 && !this.stopped) {
        this.reviewingWave = wave;
        await this.emitEvent({ type: 'wave:review', wave, timeoutSec: this.reviewPauseSec });
        // Register feedback handler so the Worker HTTP endpoint can deliver signals
        liveBrainstormFeedbackHandlers.set(this.roomId, (w, agentId, signal, participantId) => {
          this.receiveFeedback(w, agentId, signal, participantId);
        });
        const activeCount = this.participants.filter((p) => !p.hasLeft && !p.hasPassed).length;
        await this.waitForFeedback(this.reviewPauseSec * 1000, activeCount);
        liveBrainstormFeedbackHandlers.delete(this.roomId);
      }

      // Stalled room: all non-evicted, non-passed participants timed out — nobody is
      // actively participating. Emit room:stalled instead of converging.
      const passedCount = responses.filter((r) => r.isPass).length;
      const timedOutCount = responses.filter((r) => r.isTimeout).length;
      const totalParticipants = responses.length;
      const allTimedOut = timedOutCount > 0 && timedOutCount === totalParticipants - passedCount;

      if (allTimedOut && passedCount === 0) {
        log.warn(
          { roomId: this.roomId, wave, timedOutCount },
          'All participants timed out — room stalled',
        );
        this.outcomeEndState = 'stalled';
        await this.emitEvent({ type: 'room:stalled', wave });
        break;
      }

      // Soft convergence hint: if all non-PASS, non-timeout responses are agreement-only,
      // emit a hint event. This does NOT pause or stop — just informs the user.
      if (this.detectSoftConvergence(responses)) {
        log.info(
          { roomId: this.roomId, wave },
          'Soft convergence detected — all responses are agreement-only',
        );
        await this.emitEvent({ type: 'room:soft-converged', wave });
      }

      // Detect convergence: unanimity (all passed, no timeouts) or majority (≥2/3 passed
      // counting timeouts in the denominator).
      const unanimousConverged = passedCount === totalParticipants && timedOutCount === 0;
      const hasConverged = unanimousConverged || this.hasMajorityConverged(responses);

      if (hasConverged) {
        log.info(
          { roomId: this.roomId, wave, mode: this.convergenceMode, unanimousConverged },
          'Convergence detected',
        );
        this.outcomeEndState = 'converged';
        this.outcomeConvergenceWave = wave;
        if (this.stopped) break;
        await updateBrainstormStatus(this.roomId, 'paused');
        await this.emitEvent({ type: 'room:converged', wave });
        await this.emitEvent({ type: 'room:state', status: 'paused' });
        this.paused = true;

        // Wait for a steer or end control message
        const control = await this.waitForControl();
        if (this.stopped) break;

        if (control.type === 'steer' && control.text) {
          // Mark as processed for idempotency
          if (control.steerId) this.processedSteerIds.add(control.steerId);
          // Resume: reset all passes, inject user message as next wave content
          await this.resetPassedParticipants();
          // Emit the user steer as a message event — emitEvent() writes it to the log file.
          await this.emitEvent({
            type: 'message',
            wave: wave + 1,
            senderType: 'user',
            content: control.text,
            isPass: false,
          });
          await updateBrainstormStatus(this.roomId, 'active');
          await this.emitEvent({ type: 'room:state', status: 'active' });
          this.paused = false;
          // Format user steering + previous messages for next wave
          waveContent = this.formatUserSteer(control.text, responses);
          wave++;
          continue;
        }

        break; // 'end' or stopped
      }

      // Check max waves
      if (wave >= this.maxWaves - 1) {
        log.info({ roomId: this.roomId, wave }, 'Max waves reached');
        this.outcomeEndState = 'max_waves';
        if (this.stopped) break;
        await updateBrainstormStatus(this.roomId, 'paused');
        await this.emitEvent({ type: 'room:max-waves', wave });
        await this.emitEvent({ type: 'room:state', status: 'paused' });
        this.paused = true;

        // Wait for a steer or end control message
        const control = await this.waitForControl();
        if (this.stopped) break;

        if (control.type === 'steer' && control.text) {
          // Mark as processed for idempotency
          if (control.steerId) this.processedSteerIds.add(control.steerId);
          await this.resetPassedParticipants();
          // Emit the user steer as a message event — emitEvent() writes it to the log file.
          await this.emitEvent({
            type: 'message',
            wave: wave + 1,
            senderType: 'user',
            content: control.text,
            isPass: false,
          });
          await updateBrainstormStatus(this.roomId, 'active');
          await this.emitEvent({ type: 'room:state', status: 'active' });
          this.paused = false;
          waveContent = this.formatUserSteer(control.text, responses);
          wave++;
          continue;
        }

        break; // 'end' or stopped
      }

      // Check for pending steers from mid-wave injection (may be multiple)
      if (this.pendingSteer.length > 0) {
        // Mark all as processed for idempotency
        for (const s of this.pendingSteer) {
          if (s.steerId) this.processedSteerIds.add(s.steerId);
        }
        const steerText = this.pendingSteer.map((s) => s.text).join('\n\n');
        this.pendingSteer = [];
        await this.emitEvent({
          type: 'message',
          wave: wave + 1,
          senderType: 'user',
          content: steerText,
          isPass: false,
        });
        // Combine user steer with agent responses for the next wave
        waveContent = this.formatUserSteer(steerText, responses);
        await this.resetPassedParticipants();
        wave++;
        continue;
      }

      // Check for automatic reflection injection (stall detection)
      if (
        shouldTriggerReflection(this.waveQualityScores, {
          autoReflection: this.autoReflection,
          reflectionInterval: this.reflectionInterval,
          lastReflectionWave: this.lastReflectionWave,
        })
      ) {
        log.info(
          { roomId: this.roomId, wave, reflectionInterval: this.reflectionInterval },
          'Stall detected — injecting reflection wave',
        );
        this.lastReflectionWave = wave + 1;
        this.outcomeReflectionWavesTriggered++;
        await this.emitEvent({ type: 'wave:reflection', wave: wave + 1 });
        waveContent = REFLECTION_PROMPT;
        await this.resetPassedParticipants();
        wave++;
        continue;
      }

      // Normal continuation — broadcast this wave's responses to everyone
      waveContent = this.formatWaveBroadcast(responses);
      // Prepend moderator feedback note if any signals were received this wave
      const feedbackNote = this.formatFeedbackNote(wave);
      if (feedbackNote) {
        waveContent = feedbackNote + '\n\n---\n\n' + waveContent;
      }
      await this.resetPassedParticipants();
      wave++;
    }

    if (this.synthesisPending) {
      await this.runSynthesis(room);
    } else {
      await updateBrainstormStatus(this.roomId, 'ended');
      await this.emitEvent({ type: 'room:state', status: 'ended' });
    }
  }

  // ============================================================================
  // Wave mechanics
  // ============================================================================

  /**
   * Update consecutive timeout counters after each wave and auto-evict participants
   * that have timed out consecutively for `evictionThreshold` or more waves.
   *
   * Called once per wave, after all participants' waveStatus values are final.
   */
  async trackConsecutiveTimeouts(): Promise<void> {
    for (const p of this.participants) {
      if (p.hasLeft) continue;
      if (p.waveStatus === 'timeout') {
        p.consecutiveTimeouts++;
        if (p.consecutiveTimeouts >= this.evictionThreshold) {
          log.warn(
            {
              roomId: this.roomId,
              agentName: p.agentName,
              consecutiveTimeouts: p.consecutiveTimeouts,
            },
            'Auto-evicting participant after consecutive timeouts',
          );
          p.hasLeft = true;
          p.hasPassed = true;
          await this.emitParticipantStatus(p, 'evicted', {
            error: p.lastError,
            model: p.model ?? null,
          });
          await updateParticipantStatus(p.participantId, 'left');
        }
      } else if (p.waveStatus === 'done' || p.waveStatus === 'passed') {
        p.consecutiveTimeouts = 0; // Reset on successful response
      }
    }
  }

  private async startWave(wave: number, content: string): Promise<void> {
    this.currentWave = wave;
    this.waveStarted = true;
    await updateBrainstormWave(this.roomId, wave);

    log.info({ roomId: this.roomId, wave }, 'Starting wave');
    await this.emitEvent({ type: 'wave:start', wave });

    // Reset reactive injection counter for the new wave
    this.pendingReactiveInjections = 0;

    // Inject the content into each active participant's session.
    // Prepend a wave status header so agents know which wave they're in.
    const waveHeader = this.buildWaveStatusHeader(null);
    const contentWithHeader = content ? `${waveHeader}\n\n${content}` : waveHeader;

    // Reset buffers and statuses for active participants
    for (const p of this.participants) {
      if (p.hasPassed) continue;
      p.waveStatus = 'thinking';
      p.responseBuffer = [];
      p.waveResponseCount = 0;
      p.lastError = null;
      p.pendingPrompt = contentWithHeader;
      // Clear any leftover delta state from the previous wave
      p.deltaBuffer.clear();
      await this.emitParticipantStatus(p, 'thinking', {
        error: null,
        model: p.model ?? null,
      });
    }

    const injectionPromises = this.participants
      .filter(
        (p): p is ParticipantState & { sessionId: string } => !p.hasPassed && p.sessionId !== null,
      )
      .map((p) => this.injectMessage(p.sessionId, contentWithHeader));

    await Promise.allSettled(injectionPromises);

    // Start the wave timeout
    this.scheduleWaveTimeout(wave);
  }

  /**
   * Schedule a timeout for the current wave.
   * Wave 0 gets extra time (WAVE_0_EXTRA_TIMEOUT_SEC) because agents typically
   * explore the codebase before sharing their first perspective.
   * Any participant still in 'thinking' state when the timeout fires
   * is marked as 'timeout' and treated as an implicit PASS.
   */
  private scheduleWaveTimeout(wave: number): void {
    const extraSec = wave === 0 ? this.wave0ExtraTimeoutSec : 0;
    const timeoutSec = this.waveTimeoutSec + extraSec;
    log.info({ roomId: this.roomId, wave, timeoutSec }, 'Wave timeout scheduled');
    this.waveTimeoutHandle = setTimeout(() => {
      this.waveTimeoutHandle = null;
      if (this.currentWave !== wave) return; // Wave already moved on
      let timeoutFired = false;
      for (const p of this.participants) {
        if (p.waveStatus === 'thinking') {
          log.warn(
            { roomId: this.roomId, wave, agentName: p.agentName },
            'Wave timeout — marking participant as timeout',
          );
          p.waveStatus = 'timeout';
          timeoutFired = true;
          void this.emitParticipantStatus(p, 'timeout', {
            error: p.lastError,
            model: p.model ?? null,
          });
        }
      }
      if (timeoutFired) {
        this.checkWaveComplete();
      }
    }, timeoutSec * 1000);
  }

  /**
   * Wait until all active (non-hasPassed) participants have a terminal wave status.
   * Resets waveStarted to false once the wave is complete, so that
   * checkWaveComplete() won't fire between waves.
   */
  waitForWaveComplete(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waveCompleteResolve = () => {
        if (this.waveTimeoutHandle) {
          clearTimeout(this.waveTimeoutHandle);
          this.waveTimeoutHandle = null;
        }
        this.waveStarted = false;
        resolve();
      };
      // Check immediately in case all participants were already done
      this.checkWaveComplete();
    });
  }

  /** Called whenever a participant's waveStatus changes to a terminal state. */
  checkWaveComplete(): void {
    // Guard: only resolve if a wave has actually been started via startWave().
    // During waitForAllParticipantsReady(), evicted participants may have
    // waveStatus='done' which would otherwise trigger premature resolution.
    if (!this.waveStarted) return;

    // When reactive injection is enabled, don't complete the wave while
    // there are still in-flight injections (agents may be re-activated).
    if (this.reactiveInjection && this.pendingReactiveInjections > 0) return;

    const activeParts = this.participants.filter((p) => !p.hasPassed);
    const allTerminal = activeParts.every(
      (p) => p.waveStatus === 'done' || p.waveStatus === 'passed' || p.waveStatus === 'timeout',
    );
    if (allTerminal && this.waveCompleteResolve) {
      const resolve = this.waveCompleteResolve;
      this.waveCompleteResolve = null;
      resolve();
    }
  }

  /** Wait for a control message (steer or end) while paused */
  private waitForControl(): Promise<BrainstormControlMessage> {
    return new Promise<BrainstormControlMessage>((resolve) => {
      this.controlResolve = resolve;
    });
  }

  // ============================================================================
  // Event handling from participant sessions
  // ============================================================================

  private handleSessionEvent(participant: ParticipantState, event: AgendoEvent): void {
    switch (event.type) {
      case 'agent:text':
        // Complete text from the agent. If we already accumulated content
        // from text-delta events, replace it with the authoritative complete
        // text (deltas may have gaps or ordering issues). If no deltas
        // arrived (adapter doesn't stream), use this as the sole source.
        participant.responseBuffer.length = 0;
        participant.responseBuffer.push(event.text);
        break;

      case 'agent:text-delta':
        // Accumulate streaming deltas into the response buffer.
        // ACP-based agents (Copilot, Gemini) only emit text-delta,
        // never agent:text — without this their responseBuffer stays
        // empty and the wave records a blank message.
        if (!event.fromDelta) {
          participant.responseBuffer.push(event.text);
          // Only emit streaming deltas to the UI once a wave has actually started.
          // Before waveStarted, this is the preamble ack ("I'm ready to participate…")
          // which should be suppressed — onParticipantTurnComplete already guards
          // the final message, but without this check the deltas leak to the UI.
          if (this.waveStarted) {
            participant.deltaBuffer.append(event.text);
          }
        }
        break;

      case 'session:state':
        if (event.status === 'awaiting_input') {
          // Guard: if the participant was actively thinking on a wave but the
          // responseBuffer is empty, this is a contentless turn (e.g. Codex
          // context compaction). Skip turn-complete so we don't record a 0-word
          // message and prematurely advance the wave.
          if (
            participant.waveStatus === 'thinking' &&
            participant.responseBuffer.join('').trim().length === 0
          ) {
            log.warn(
              {
                roomId: this.roomId,
                agentName: participant.agentName,
                sessionId: participant.sessionId,
              },
              'Ignoring contentless awaiting_input (likely compaction turn)',
            );
            break;
          }
          // Turn complete — process the response
          this.onParticipantTurnComplete(participant);
        } else if (event.status === 'idle' || event.status === 'ended') {
          // Session was killed (stale reaper, OOM, crash) — auto-resume it.
          // This commonly happens when the Claude SDK adapter silently fails
          // to spawn, causing the heartbeat to stall and the stale reaper to
          // transition the session to idle.
          if (participant.sessionId && !this.stopped && !this.paused) {
            log.warn(
              {
                roomId: this.roomId,
                sessionId: participant.sessionId,
                agentName: participant.agentName,
                status: event.status,
                waveStatus: participant.waveStatus,
              },
              'Participant session went idle/ended — auto-resuming',
            );
            void enqueueSession({ sessionId: participant.sessionId }).catch((err: unknown) => {
              log.error(
                { err, roomId: this.roomId, sessionId: participant.sessionId },
                'Failed to re-enqueue idle participant session',
              );
            });
          }
        }
        break;

      case 'session:init':
        participant.model = event.model ?? participant.model;
        break;

      case 'agent:result':
        if (event.isError) {
          participant.lastError = normalizeParticipantError(event.errors?.join('; '));
          void this.maybeTriggerParticipantFallback(participant);
        }
        break;

      case 'system:info': {
        const infoModel = extractModelFromSystemInfo(event.message);
        if (infoModel) {
          participant.model = infoModel;
        }
        if (
          participant.fallbackInFlight &&
          participant.fallbackTargetModel &&
          infoModel === participant.fallbackTargetModel
        ) {
          void this.onParticipantFallbackSucceeded(participant, infoModel);
        }
        break;
      }

      case 'system:error':
        if (participant.fallbackInFlight && isModelSwitchFailureMessage(event.message)) {
          void this.onParticipantFallbackSwitchFailed(participant, event.message);
          break;
        }
        participant.lastError = normalizeParticipantError(event.message);
        void this.maybeTriggerParticipantFallback(participant);
        break;

      case 'system:rate-limit':
        participant.lastError = formatRateLimitError(event);
        void this.maybeTriggerParticipantFallback(participant);
        break;

      case 'agent:tool-start': {
        // Forward tool activity so the UI can show what the agent is doing
        // (e.g. "Reading orchestrator.ts" instead of just "thinking...")
        const toolName = event.toolName ?? '';
        const input = event.input as Record<string, unknown> | undefined;
        const description = describeToolActivity(toolName, input);
        if (description) {
          void this.emitParticipantActivity(participant, description).catch(() => {});
        }
        break;
      }

      case 'agent:subagent-progress': {
        // Forward subagent progress descriptions
        const desc = event.description;
        if (desc) {
          void this.emitParticipantActivity(participant, desc).catch(() => {});
        }
        break;
      }

      default:
        // Other event types (thinking, etc.) are not forwarded
        break;
    }
  }

  /** Create a DeltaBuffer for a participant that flushes to the SSE stream. */
  private createParticipantDeltaBuffer(participant: ParticipantState): DeltaBuffer {
    return new DeltaBuffer(DELTA_FLUSH_INTERVAL_MS, (text) => {
      void this.emitEvent({
        type: 'message:delta',
        participantId: participant.participantId,
        agentId: participant.agentId,
        text,
      }).catch(() => {});
    });
  }

  private getRoomConfig(): BrainstormConfig {
    return (this.room?.config as BrainstormConfig | undefined) ?? this.playbook;
  }

  private async listFallbackAgentCandidates(
    participant: ParticipantState,
  ): Promise<FallbackAgentCandidate[]> {
    const agents = await listAgents();
    return agents
      .filter((candidate) => candidate.id !== participant.agentId && candidate.isActive)
      .map((candidate) => ({
        agentId: candidate.id,
        agentName: candidate.name,
        agentSlug: candidate.slug,
        provider: binaryPathToProvider(candidate.binaryPath),
      }));
  }

  private supportsParticipantModelSwitch(participant: ParticipantState): boolean {
    return participant.provider !== null;
  }

  private buildParticipantRecovery(
    participant: ParticipantState,
    input: Omit<BrainstormParticipantRecovery, 'attemptedModels' | 'attemptedAgents'>,
  ): BrainstormParticipantRecovery {
    return {
      ...input,
      attemptedModels:
        participant.fallbackAttemptedModels.length > 0
          ? [...participant.fallbackAttemptedModels]
          : undefined,
      attemptedAgents:
        participant.fallbackAttemptedAgents.length > 0
          ? [...participant.fallbackAttemptedAgents]
          : undefined,
    };
  }

  private async decideParticipantFallback(
    participant: ParticipantState,
    errorMessage: string | null | undefined,
  ): Promise<FallbackDecision | null> {
    const error = classifySessionError(errorMessage);
    if (!error) {
      return null;
    }

    return decideFallback({
      policy: this.getRoomConfig().fallback,
      error,
      participant: {
        agentId: participant.agentId,
        agentName: participant.agentName,
        agentSlug: participant.agentSlug,
        provider: participant.provider,
        model: participant.model ?? null,
        modelPinned: participant.modelPinned,
        supportsModelSwitch: this.supportsParticipantModelSwitch(participant),
      },
      attemptedModels: participant.fallbackAttemptedModels,
      attemptedAgents: participant.fallbackAttemptedAgents,
      availableAgents: await this.listFallbackAgentCandidates(participant),
    });
  }

  private async emitParticipantStatus(
    participant: ParticipantState,
    status: 'thinking' | 'done' | 'passed' | 'timeout' | 'evicted',
    options?: {
      error?: string | null;
      model?: string | null;
      recovery?: BrainstormParticipantRecovery | null;
    },
  ): Promise<void> {
    await this.emitEvent({
      type: 'participant:status',
      participantId: participant.participantId,
      agentId: participant.agentId,
      agentName: participant.agentName,
      agentSlug: participant.agentSlug,
      status,
      error: options?.error,
      model: options?.model ?? participant.model ?? null,
      recovery: options?.recovery === undefined ? participant.recovery : options.recovery,
    });
  }

  private async emitParticipantActivity(
    participant: ParticipantState,
    description: string,
    recovery: BrainstormParticipantRecovery | null | undefined = participant.recovery,
  ): Promise<void> {
    await this.emitEvent({
      type: 'participant:activity',
      participantId: participant.participantId,
      agentId: participant.agentId,
      description,
      recovery,
    });
  }

  private async emitParticipantJoined(participant: ParticipantState): Promise<void> {
    await this.emitEvent({
      type: 'participant:joined',
      participantId: participant.participantId,
      agentId: participant.agentId,
      agentName: participant.agentName,
      agentSlug: participant.agentSlug,
      role: participant.role ?? undefined,
      model: participant.model ?? null,
      recovery: participant.recovery,
    });
  }

  private async emitParticipantLeft(
    participant: ParticipantState,
    error?: string | null,
    recovery: BrainstormParticipantRecovery | null | undefined = participant.recovery,
  ): Promise<void> {
    await this.emitEvent({
      type: 'participant:left',
      participantId: participant.participantId,
      agentId: participant.agentId,
      agentName: participant.agentName,
      agentSlug: participant.agentSlug,
      error,
      recovery,
    });
  }

  onParticipantTurnComplete(participant: ParticipantState): void {
    // Guard: if no wave has started yet, this is a pre-wave preamble acknowledgment.
    // Suppress message emission — just mark the participant as ready so that
    // waitForAllParticipantsReady() sees them as done and proceeds to wave 0.
    if (!this.waveStarted) {
      participant.waveStatus = 'done';
      participant.responseBuffer = [];
      participant.lastError = null;
      participant.pendingPrompt = null;
      return;
    }

    // Flush any remaining buffered deltas before emitting the final complete message
    participant.deltaBuffer.flush();

    const rawResponse = participant.responseBuffer.join('').trim();
    const looksLikePass = rawResponse.toLowerCase().startsWith('[pass]');
    // Enforce minWavesBeforePass: ignore PASS responses before the threshold wave
    const isPass = looksLikePass && this.currentWave >= this.minWavesBeforePass;

    if (looksLikePass && !isPass) {
      log.info(
        {
          roomId: this.roomId,
          wave: this.currentWave,
          minWavesBeforePass: this.minWavesBeforePass,
          agentName: participant.agentName,
        },
        'Ignoring early PASS — wave < minWavesBeforePass',
      );
    }

    participant.waveStatus = isPass ? 'passed' : 'done';
    participant.waveResponseCount++;
    participant.lastError = null;
    participant.pendingPrompt = null;

    void (async () => {
      try {
        // Emit the complete message event
        await this.emitEvent({
          type: 'message',
          wave: this.currentWave,
          senderType: 'agent',
          participantId: participant.participantId,
          agentId: participant.agentId,
          agentName: participant.agentName,
          content: rawResponse,
          isPass,
        });

        // Emit participant status update
        await this.emitParticipantStatus(participant, isPass ? 'passed' : 'done', {
          error: null,
          model: participant.model ?? null,
        });

        // Reactive injection: inject this agent's response into other participants
        if (this.reactiveInjection && !isPass && rawResponse.length > 0) {
          await this.reactivelyInject(participant, rawResponse);
        }
      } catch (err) {
        log.warn(
          { err, roomId: this.roomId, agentName: participant.agentName },
          'Failed to emit message event',
        );
      }

      // Check if the wave is now complete
      this.checkWaveComplete();
    })();
  }

  /**
   * Reactive injection: inject a completed agent's response into other participants.
   *
   * For agents still in 'thinking' state: inject immediately (they'll incorporate it).
   * For agents in 'done' state with budget remaining: re-activate them by setting
   * waveStatus back to 'thinking' and injecting the new content.
   * Agents that have 'passed', 'hasLeft', or exhausted their response budget are skipped.
   */
  private async reactivelyInject(sender: ParticipantState, senderResponse: string): Promise<void> {
    const formattedSenderResponse = `[${sender.agentName}]:\n${senderResponse}`;

    const targets = this.participants.filter((p) => {
      // Skip the sender itself
      if (p.agentId === sender.agentId) return false;
      // Skip passed, left, or no-session participants
      if (p.hasPassed || p.hasLeft || !p.sessionId) return false;
      // Skip timed-out participants
      if (p.waveStatus === 'timeout') return false;

      if (p.waveStatus === 'thinking') {
        // Already thinking — inject directly, no budget check needed
        return true;
      }

      if (p.waveStatus === 'done') {
        // Re-activate if budget allows
        return p.waveResponseCount < this.maxResponsesPerWave;
      }

      return false;
    });

    if (targets.length === 0) return;

    log.info(
      {
        roomId: this.roomId,
        sender: sender.agentName,
        targetCount: targets.length,
        targets: targets.map((t) => t.agentName),
      },
      'Reactive injection: injecting response into other participants',
    );

    // Track in-flight injections so checkWaveComplete doesn't resolve prematurely
    this.pendingReactiveInjections += targets.length;

    const injectionPromises = targets.map(async (target) => {
      try {
        // Re-activate 'done' agents
        if (target.waveStatus === 'done') {
          target.waveStatus = 'thinking';
          target.responseBuffer = [];
          target.deltaBuffer.clear();

          await this.emitParticipantStatus(target, 'thinking', {
            model: target.model ?? null,
          });
        }

        // sessionId is guaranteed non-null by the filter above (p.sessionId check)
        const targetSessionId = target.sessionId;
        if (targetSessionId) {
          // Build a per-target status header (response count is specific to each recipient)
          const statusHeader = this.buildWaveStatusHeader(target.agentId);
          const messageWithHeader = `${statusHeader}\n\n${formattedSenderResponse}`;
          target.pendingPrompt = messageWithHeader;
          await this.injectMessage(targetSessionId, messageWithHeader);
        }
      } catch (err) {
        log.warn(
          {
            err,
            roomId: this.roomId,
            sender: sender.agentName,
            target: target.agentName,
          },
          'Reactive injection failed for target',
        );
      } finally {
        this.pendingReactiveInjections--;
        // Re-check wave completion after each injection settles
        this.checkWaveComplete();
      }
    });

    await Promise.allSettled(injectionPromises);
  }

  private async maybeTriggerParticipantFallback(participant: ParticipantState): Promise<void> {
    if (participant.hasLeft || participant.fallbackInFlight) return;

    const error = participant.lastError;
    const decision = await this.decideParticipantFallback(participant, error);
    if (!decision || !error || decision.type === 'none') return;

    if (decision.reason === 'auth_error') {
      await this.finalizeParticipantFallbackFailure(
        participant,
        `${decision.summary}. Automatic fallback is unavailable for authentication failures.`,
        this.buildParticipantRecovery(participant, {
          state: 'fallback_failed',
          reason: decision.reason,
          summary: decision.summary,
          triggerError: decision.triggerError,
        }),
      );
      return;
    }

    if (decision.type === 'terminal') {
      await this.finalizeParticipantFallbackFailure(
        participant,
        decision.message,
        this.buildParticipantRecovery(participant, {
          state: 'fallback_failed',
          reason: decision.reason,
          summary: decision.summary,
          triggerError: decision.triggerError,
          targetModel: participant.fallbackTargetModel,
        }),
      );
      return;
    }

    if (decision.type === 'switch_agent') {
      await this.finalizeParticipantFallbackFailure(
        participant,
        `${decision.summary}. Automatic agent fallback selected ${decision.agent.agentName}, but brainstorm participant replacement is not supported yet.`,
        this.buildParticipantRecovery(participant, {
          state: 'fallback_failed',
          reason: decision.reason,
          summary: decision.summary,
          triggerError: decision.triggerError,
          targetAgentId: decision.agent.agentId,
          targetAgentName: decision.agent.agentName,
        }),
      );
      return;
    }

    if (!participant.sessionId) {
      await this.finalizeParticipantFallbackFailure(
        participant,
        `${decision.summary}. Automatic fallback could not continue because the participant session was unavailable.`,
        this.buildParticipantRecovery(participant, {
          state: 'fallback_failed',
          reason: decision.reason,
          summary: decision.summary,
          triggerError: decision.triggerError,
          targetModel: decision.model,
        }),
      );
      return;
    }

    await this.attemptParticipantModelFallback(
      participant,
      decision.model,
      decision.summary,
      decision.triggerError,
      decision.reason,
    );
  }

  private async attemptParticipantModelFallback(
    participant: ParticipantState,
    model: string,
    summary: string,
    triggerError: string,
    reason: BrainstormParticipantRecovery['reason'],
  ): Promise<void> {
    if (!participant.sessionId || participant.fallbackInFlight) return;

    participant.fallbackInFlight = true;
    participant.fallbackTriggerError = triggerError;
    participant.fallbackTargetModel = model;
    participant.fallbackAttemptedModels.push(model);
    participant.recovery = this.buildParticipantRecovery(participant, {
      state: 'attempting_model_fallback',
      reason,
      summary,
      triggerError,
      targetModel: model,
    });

    const fromModel = participant.model ?? 'default model';
    await this.emitParticipantActivity(
      participant,
      `Automatic fallback: switching from ${fromModel} to ${model} after ${summary.toLowerCase()}.`,
      participant.recovery,
    ).catch(() => {});

    try {
      await sendSessionControl(participant.sessionId, { type: 'set-model', model });
    } catch (err) {
      await this.onParticipantFallbackSwitchFailed(
        participant,
        `Failed to dispatch automatic model fallback to "${model}": ${getErrorMessage(err)}`,
      );
    }
  }

  private async onParticipantFallbackSucceeded(
    participant: ParticipantState,
    model: string,
  ): Promise<void> {
    if (!participant.fallbackInFlight) return;

    const previousRecovery = participant.recovery;
    const previousTriggerError = participant.fallbackTriggerError;
    participant.fallbackInFlight = false;
    participant.fallbackTargetModel = null;
    participant.fallbackTriggerError = null;
    participant.model = model;
    participant.lastError = null;
    participant.recovery = this.buildParticipantRecovery(participant, {
      state: 'model_fallback_succeeded',
      reason:
        classifySessionError(previousTriggerError ?? previousRecovery?.triggerError)?.category ??
        previousRecovery?.reason ??
        'provider_unavailable',
      summary: `Automatic fallback switched to ${model}`,
      triggerError:
        previousTriggerError ?? previousRecovery?.triggerError ?? `Automatic fallback to ${model}`,
      targetModel: model,
    });

    await updateParticipantModel(participant.participantId, model).catch(() => {});
    await this.emitParticipantActivity(
      participant,
      `Automatic fallback succeeded: now using ${model}. Retrying the turn.`,
      participant.recovery,
    ).catch(() => {});

    if (!this.waveStarted || participant.waveStatus !== 'thinking') {
      return;
    }

    await this.emitParticipantStatus(participant, 'thinking', {
      error: null,
      model,
      recovery: participant.recovery,
    }).catch(() => {});

    if (!participant.pendingPrompt) {
      return;
    }

    if (!participant.sessionId) {
      await this.finalizeParticipantFallbackFailure(
        participant,
        'Automatic fallback succeeded, but the participant session was no longer available for retry.',
      );
      return;
    }

    try {
      await this.injectMessage(participant.sessionId, participant.pendingPrompt);
    } catch (err) {
      await this.finalizeParticipantFallbackFailure(
        participant,
        `Automatic fallback switched to ${model}, but retrying the turn failed: ${getErrorMessage(err)}`,
      );
    }
  }

  private async onParticipantFallbackSwitchFailed(
    participant: ParticipantState,
    message: string,
  ): Promise<void> {
    const triggerError = participant.fallbackTriggerError ?? participant.lastError;

    participant.fallbackInFlight = false;
    participant.fallbackTargetModel = null;

    const decision = await this.decideParticipantFallback(participant, triggerError ?? message);
    if (!decision || decision.type === 'none') {
      await this.finalizeParticipantFallbackFailure(participant, message);
      return;
    }

    if (decision.type === 'switch_model') {
      await this.emitParticipantActivity(
        participant,
        `Automatic fallback could not switch models (${message}). Trying ${decision.model}.`,
        participant.recovery,
      ).catch(() => {});
      await this.attemptParticipantModelFallback(
        participant,
        decision.model,
        decision.summary,
        triggerError ?? message,
        decision.reason,
      );
      return;
    }

    if (decision.type === 'switch_agent') {
      await this.finalizeParticipantFallbackFailure(
        participant,
        `${decision.summary}. Automatic agent fallback selected ${decision.agent.agentName}, but brainstorm participant replacement is not supported yet.`,
        this.buildParticipantRecovery(participant, {
          state: 'fallback_failed',
          reason: decision.reason,
          summary: decision.summary,
          triggerError: decision.triggerError,
          targetAgentId: decision.agent.agentId,
          targetAgentName: decision.agent.agentName,
        }),
      );
      return;
    }

    await this.finalizeParticipantFallbackFailure(
      participant,
      `${decision.summary}. Automatic model fallback failed: ${message}`,
      this.buildParticipantRecovery(participant, {
        state: 'fallback_failed',
        reason: decision.reason,
        summary: decision.summary,
        triggerError: decision.triggerError,
      }),
    );
  }

  private async finalizeParticipantFallbackFailure(
    participant: ParticipantState,
    message: string,
    recovery?: BrainstormParticipantRecovery | null,
  ): Promise<void> {
    const failureMessage = normalizeParticipantError(message) ?? 'Automatic fallback failed.';
    const fallbackError =
      classifySessionError(
        participant.fallbackTriggerError ?? participant.lastError ?? failureMessage,
      ) ?? classifySessionError(failureMessage);
    participant.fallbackInFlight = false;
    participant.fallbackTargetModel = null;
    participant.fallbackTriggerError = null;
    participant.pendingPrompt = null;
    participant.lastError = failureMessage;
    participant.hasLeft = true;
    participant.hasPassed = true;
    participant.waveStatus = 'done';
    participant.recovery =
      recovery ??
      this.buildParticipantRecovery(participant, {
        state: 'fallback_failed',
        reason: fallbackError?.category ?? 'provider_unavailable',
        summary: fallbackError?.summary ?? failureMessage,
        triggerError: fallbackError?.rawMessage ?? failureMessage,
      });

    await this.emitParticipantActivity(participant, failureMessage, participant.recovery).catch(
      () => {},
    );
    await updateParticipantStatus(participant.participantId, 'left').catch(() => {});
    await this.emitParticipantLeft(participant, failureMessage, participant.recovery).catch(
      () => {},
    );

    this.checkWaveComplete();
  }

  // ============================================================================
  // Control message handling
  // ============================================================================

  private handleControlMessage(msg: BrainstormControlMessage): void {
    log.info({ roomId: this.roomId, type: msg.type }, 'Control message received');

    switch (msg.type) {
      case 'steer':
        if (!msg.text) return;

        if (msg.steerId && this.processedSteerIds.has(msg.steerId)) {
          log.info({ roomId: this.roomId, steerId: msg.steerId }, 'Duplicate steer skipped');
          return;
        }

        if (this.paused) {
          // Room is paused (converged or max-waves) — resolve the waitForControl promise
          const resolve = this.controlResolve;
          this.controlResolve = null;
          resolve?.(msg);
        } else {
          // Mid-wave steer — queue for injection at start of next wave.
          // Multiple steers are joined; none are silently dropped.
          this.pendingSteer.push({ text: msg.text, steerId: msg.steerId });
          log.info({ roomId: this.roomId, steerId: msg.steerId }, 'Steer queued for next wave');
        }
        break;

      case 'end':
        this.stopped = true;
        if (msg.synthesize) {
          this.synthesisPending = true;
        }

        if (this.paused) {
          // Resolve waitForControl so the wave loop exits
          const resolve = this.controlResolve;
          this.controlResolve = null;
          resolve?.(msg);
        } else if (this.waveCompleteResolve) {
          // Mid-wave: force-resolve the wave wait so the loop exits immediately
          // instead of waiting for all participants to finish naturally.
          // The finally block in run() will terminate all sessions.
          log.info({ roomId: this.roomId }, 'End received mid-wave — force-completing wave');
          const resolve = this.waveCompleteResolve;
          this.waveCompleteResolve = null;
          resolve();
        }
        break;

      case 'extend': {
        const extra = msg.additionalWaves ?? 5;
        this.maxWaves += extra;
        log.info({ roomId: this.roomId, extra, maxWaves: this.maxWaves }, 'Max waves extended');
        // Fire-and-forget — handleControlMessage is synchronous (PG NOTIFY callback)
        void this.emitEvent({ type: 'room:config', maxWaves: this.maxWaves });

        if (this.paused) {
          // Resume the wave loop — treat like a steer with no text so it
          // continues with the previous wave's broadcast content.
          const resolve = this.controlResolve;
          this.controlResolve = null;
          resolve?.({ type: 'steer', text: 'Continue the brainstorm with the additional rounds.' });
        }
        break;
      }

      case 'remove-participant': {
        // Prefer participantId (targets exact slot for duplicate agents),
        // fall back to agentId for backward compatibility.
        const target = msg.participantId
          ? this.participants.find((p) => p.participantId === msg.participantId)
          : this.participants.find((p) => p.agentId === msg.agentId);
        if (!target) return;

        target.hasPassed = true; // Exclude from future waves
        target.hasLeft = true; // Permanently removed — not reset by steer
        target.waveStatus = 'done'; // Unblock any in-progress wave wait

        void updateParticipantStatus(target.participantId, 'left').catch(() => {});
        void this.emitParticipantLeft(target).catch(() => {});

        // If this was the last active participant, complete the wave
        this.checkWaveComplete();
        break;
      }

      case 'add-participant': {
        if (!msg.agentId) return;
        // Hot-add: spin up the new participant in the background.
        // The orchestrator will integrate them into the next wave.
        void this.hotAddParticipant(msg.agentId, msg.text, msg.participantId).catch((err) => {
          log.error(
            { roomId: this.roomId, agentId: msg.agentId, participantId: msg.participantId, err },
            'Failed to hot-add participant',
          );
        });
        break;
      }

      case 'ping':
        break;
    }
  }

  // ============================================================================
  // Synthesis
  // ============================================================================

  /**
   * Run synthesis: collect all messages, send to a synthesis agent, store result.
   */
  private async runSynthesis(room: BrainstormWithDetails): Promise<void> {
    log.info({ roomId: this.roomId }, 'Running synthesis');
    await updateBrainstormStatus(this.roomId, 'synthesizing');
    await this.emitEvent({ type: 'room:state', status: 'synthesizing' });

    try {
      // Build transcript: participant session getHistory() (primary) → log file (fallback).
      //
      // getHistory() gives us the authoritative agent responses directly from the
      // CLI's native storage (Claude JSONL, Codex thread/read). The log file is the
      // fallback for agents without getHistory() support (Gemini, Copilot) or ended
      // sessions where the process has already exited.
      let transcript = await buildTranscriptFromSessions(room);

      if (transcript === null) {
        log.info(
          { roomId: this.roomId },
          'No session history available, falling back to log file for synthesis transcript',
        );
        const allEvents =
          this.logFilePath && existsSync(this.logFilePath)
            ? readBrainstormEventsFromLog(readFileSync(this.logFilePath, 'utf-8'), 0)
            : [];

        const messageEvents = allEvents.filter((e) => e.type === 'message');

        transcript = messageEvents
          .map((e) => {
            if (e.type !== 'message') return '';
            const sender =
              e.senderType === 'user'
                ? '[User]'
                : `[${this.participants.find((p) => p.agentId === e.agentId)?.agentName ?? 'Agent'}]`;
            const passNote = e.isPass ? ' [PASSED]' : '';
            return `Wave ${e.wave} — ${sender}${passNote}:\n${e.content}`;
          })
          .filter(Boolean)
          .join('\n\n---\n\n');
      } else {
        log.info(
          { roomId: this.roomId },
          'Synthesis transcript built from participant session histories',
        );
      }

      const roomConfig = room.config as BrainstormConfig | undefined;
      const deliverableType = roomConfig?.deliverableType as DeliverableType | undefined;
      const synthesisTemplate = buildSynthesisPrompt(deliverableType);

      const synthesisMetadata = this.buildSynthesisMetadata();

      const synthesisPrompt = `You are synthesizing a brainstorm discussion.

TOPIC: ${room.topic}

${synthesisMetadata}

DISCUSSION TRANSCRIPT:
${transcript}

Your task: Write a clear, structured synthesis of this brainstorm. Be concise but comprehensive.

${synthesisTemplate}

${STRUCTURED_SYNTHESIS_PROMPT_SUFFIX}`;

      // Determine synthesis agent: prefer playbook.synthesisAgentId, then first participant
      const synthesisAgentId = this.playbook.synthesisAgentId ?? this.participants[0]?.agentId;

      if (!synthesisAgentId) {
        throw new Error('No synthesis agent available');
      }

      // Create a one-off session for synthesis
      const synthSession = await createSession({
        agentId: synthesisAgentId,
        projectId: room.projectId,
        initialPrompt: synthesisPrompt,
        permissionMode: 'bypassPermissions',
        kind: 'conversation',
        idleTimeoutSec: 3600,
      });

      // Subscribe BEFORE enqueue to avoid race where session completes before
      // the subscription is established (same pattern as participant sessions).
      const synthesisTextPromise = this.collectSingleTurnResponse(synthSession.id);
      await enqueueSession({ sessionId: synthSession.id });

      // Wait for synthesis session to complete and collect the draft response
      const draftSynthesis = await synthesisTextPromise;

      // Check if validated synthesis mode is enabled
      let synthesisText: string;
      if (this.synthesisMode === 'validated') {
        // Phase 2: Validation wave — send draft to all active participants for review
        synthesisText = await this.runValidationWave(synthSession.id, draftSynthesis);
      } else {
        // Single mode — store the draft as-is
        synthesisText = draftSynthesis;
      }

      await setBrainstormSynthesis(this.roomId, synthesisText);
      await this.emitEvent({ type: 'room:synthesis', synthesis: synthesisText });
      this.outcomeSynthesisParseSuccess = true;

      // Auto-create tasks from "Next Steps" if the brainstorm is linked to a task
      if (room.taskId) {
        try {
          const taskIds = await createTasksFromSynthesis(synthesisText, {
            parentTaskId: room.taskId,
            projectId: room.projectId ?? undefined,
            deliverableType,
          });
          this.outcomeTaskCreationCount = taskIds.length;
          if (taskIds.length > 0) {
            log.info(
              { roomId: this.roomId, taskCount: taskIds.length },
              'Created tasks from synthesis next steps',
            );
          }
        } catch (err) {
          log.error({ err, roomId: this.roomId }, 'Failed to create tasks from synthesis');
        }
      }

      log.info({ roomId: this.roomId }, 'Synthesis complete');
    } catch (err) {
      log.error({ err, roomId: this.roomId }, 'Synthesis failed');
      await this.emitEvent({
        type: 'room:error',
        message: `Synthesis failed: ${getErrorMessage(err)}`,
      });
    }

    await updateBrainstormStatus(this.roomId, 'ended');
    await this.emitEvent({ type: 'room:state', status: 'ended' });
  }

  /**
   * Run validated synthesis phase 2: send draft to participants for review,
   * collect corrections, then ask the synthesis agent to produce the final version.
   */
  private async runValidationWave(synthSessionId: string, draftSynthesis: string): Promise<string> {
    log.info({ roomId: this.roomId }, 'Running validation wave');

    const validationPrompt = `Review this brainstorm synthesis draft. Does it accurately represent your positions? Correct anything that's wrong or missing. If it's accurate, say so briefly.

DRAFT SYNTHESIS:
${draftSynthesis}`;

    // Send draft to all active participants with sessions for review
    const eligibleParticipants = this.participants.filter(
      (p): p is ParticipantState & { sessionId: string } => !p.hasPassed && p.sessionId !== null,
    );

    // Inject validation prompt and collect responses in parallel
    const validationResponses: Array<{ agentName: string; response: string }> = [];

    if (eligibleParticipants.length > 0) {
      const validationPromises = eligibleParticipants.map(async (p) => {
        await this.injectMessage(p.sessionId, validationPrompt);
        const response = await this.collectSingleTurnResponse(p.sessionId);
        return { agentName: p.agentName, response };
      });

      const results = await Promise.allSettled(validationPromises);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          validationResponses.push(result.value);
        }
      }
    }

    // Format corrections and send to synthesis agent for final version
    const correctionsText =
      validationResponses.length > 0
        ? validationResponses.map((r) => `[${r.agentName}]:\n${r.response}`).join('\n\n---\n\n')
        : 'No corrections were provided by participants.';

    const finalPrompt = `Here are corrections/feedback from participants on your synthesis draft. Write the final synthesis incorporating any valid corrections.

PARTICIPANT FEEDBACK:
${correctionsText}`;

    await this.injectMessage(synthSessionId, finalPrompt);
    const finalSynthesis = await this.collectSingleTurnResponse(synthSessionId);

    log.info({ roomId: this.roomId }, 'Validation wave complete');
    return finalSynthesis;
  }

  /**
   * Subscribe to a session and collect its text until awaiting_input.
   * Returns the full response text.
   */
  private async collectSingleTurnResponse(sessionId: string): Promise<string> {
    const buffer: string[] = [];
    let resolved = false;

    // Create the Promise FIRST so resolveFn/rejectFn are assigned before
    // any PG NOTIFY callback can fire (avoids undefined reference crash).
    let resolveFn!: (value: string) => void;
    let rejectFn!: (reason: Error) => void;
    const resultPromise = new Promise<string>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    // Use a mutable ref object so the subscribe callback can safely reference the
    // timeout handle even if an event fires synchronously (before the setTimeout
    // assignment below executes), avoiding the temporal dead zone of a plain `let`.
    const timeoutRef: { handle: ReturnType<typeof setTimeout> | undefined } = { handle: undefined };

    // Subscribe BEFORE the session is enqueued to avoid missing events.
    const unsub = addSessionEventListener(sessionId, (event: AgendoEvent) => {
      if (event.type === 'agent:text') {
        // Authoritative complete text — replace any accumulated deltas
        buffer.length = 0;
        buffer.push(event.text);
      } else if (event.type === 'agent:text-delta' && !event.fromDelta) {
        // Streaming delta — accumulate (ACP agents only emit text-delta, never agent:text)
        buffer.push(event.text);
      } else if (event.type === 'session:state' && event.status === 'awaiting_input') {
        // Turn complete — resolve with accumulated text
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutRef.handle);
          resolveFn(buffer.join('').trim());
        }
      }
    });
    this.unsubscribers.push(unsub);

    timeoutRef.handle = setTimeout(
      () => {
        if (!resolved) {
          resolved = true;
          rejectFn(new Error(`Synthesis session ${sessionId} timed out`));
        }
      },
      // Synthesis session needs the same startup budget as a participant (ACP/SDK
      // handshake) PLUS time to generate the response — so participant ready timeout + wave timeout.
      (this.participantReadyTimeoutSec + this.waveTimeoutSec) * 1000,
    );

    try {
      return await resultPromise;
    } finally {
      clearTimeout(timeoutRef.handle);
      unsub();
      // Remove from unsubscribers since we already cleaned up
      const idx = this.unsubscribers.indexOf(unsub);
      if (idx >= 0) this.unsubscribers.splice(idx, 1);
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Reset hasPassed for all participants so they join the next wave.
   * Called when a user steer resumes a converged room.
   */
  private async resetPassedParticipants(): Promise<void> {
    for (const p of this.participants) {
      if (p.hasPassed && !p.hasLeft) {
        p.hasPassed = false;
        p.waveStatus = 'pending';
        await updateParticipantStatus(p.participantId, 'active').catch(() => {});
      }
    }
  }

  /**
   * Check if majority convergence threshold is met: ≥2/3 of responses are PASS.
   * Only applies when convergenceMode is 'majority'. Returns false otherwise.
   *
   * Timed-out participants (isTimeout=true) count against the total — they are
   * non-passing participants and must not silently inflate the PASS ratio.
   */
  hasMajorityConverged(responses: Array<{ isPass: boolean; isTimeout?: boolean }>): boolean {
    if (this.convergenceMode !== 'majority') return false;
    if (responses.length === 0) return false;
    const passCount = responses.filter((r) => r.isPass).length;
    return passCount / responses.length >= 2 / 3;
  }

  /**
   * Detect "soft convergence": all non-PASS, non-timeout responses are agreement-only
   * (short, start with agreement markers, no substantive new content).
   * Returns true as a hint that synthesis may be appropriate.
   *
   * Timed-out participants are excluded — they produce no content and must not
   * satisfy the "all remaining responses are agreement-only" predicate.
   */
  detectSoftConvergence(
    responses: Array<{ content: string; isPass: boolean; isTimeout?: boolean }>,
  ): boolean {
    const nonPass = responses.filter((r) => !r.isPass && !r.isTimeout);
    // Need at least one non-PASS, non-timeout response to detect soft convergence
    if (nonPass.length === 0) return false;

    /** Agreement markers (case-insensitive) */
    const AGREEMENT_PATTERNS = [
      /^i agree/i,
      /^agreed/i,
      /^looks good/i,
      /^sounds good/i,
      /^that works/i,
      /^makes sense/i,
      /^good point/i,
      /^exactly/i,
      /^right/i,
      /^yes/i,
      /^מסכים/,
      /^נכון/,
      /^בסדר/,
    ];

    /** Max word count for a response to be considered "agreement-only" */
    const MAX_AGREEMENT_WORDS = 40;

    return nonPass.every((r) => {
      const trimmed = r.content.trim();
      const wordCount = trimmed.split(/\s+/).length;
      if (wordCount > MAX_AGREEMENT_WORDS) return false;
      return AGREEMENT_PATTERNS.some((pat) => pat.test(trimmed));
    });
  }

  /** Inject a message into a session via direct in-process delivery or PG NOTIFY fallback.
   *
   * Delivery priority:
   * 1. Direct `pushMessage()` on the live SessionProcess (same worker, no PG NOTIFY
   *    round-trip, guaranteed delivery even if the LISTEN connection is dead).
   * 2. Cold-resume via enqueueSession() if the session is idle/ended.
   * 3. PG NOTIFY fallback for sessions running in a different worker (future
   *    multi-worker deployments) or for sessions not yet registered in allSessionProcs.
   */
  private async injectMessage(sessionId: string, text: string): Promise<void> {
    // Fast path: session is alive in this worker — deliver directly, bypassing PG NOTIFY.
    const proc = getSessionProc(sessionId);
    if (proc) {
      log.info(
        { roomId: this.roomId, sessionId },
        'injectMessage: direct delivery via SessionProcess.pushMessage()',
      );
      await proc.pushMessage(text);
      return;
    }

    // Session not in this worker — check DB status before deciding how to deliver.
    const info = await getSessionStatus(sessionId);
    if (info?.status === 'idle' || info?.status === 'ended') {
      log.info(
        { roomId: this.roomId, sessionId, status: info.status },
        'Participant session is idle — cold-resuming with wave message',
      );
      await enqueueSession({ sessionId, resumePrompt: text });
      return;
    }

    // Fallback: session is active but running in another worker (or not yet in map).
    // Use Worker HTTP control channel for delivery.
    log.info(
      { roomId: this.roomId, sessionId, status: info?.status },
      'injectMessage: fallback to Worker HTTP delivery',
    );
    await sendSessionControl(sessionId, { type: 'message' as const, text });
  }

  /**
   * Build a one-line status header to prepend to injected messages.
   * Format: [Wave N/M · responded/total responded · Name, Name pending]
   *
   * @param forParticipantId - When set (reactive injection), show response/pending counts.
   *   When null (wave start), omit pending list (everyone is starting).
   */
  private buildWaveStatusHeader(forParticipantId: string | null): string {
    const wave1 = this.currentWave + 1;
    const activeParticipants = this.participants.filter((p) => !p.hasPassed && !p.hasLeft);
    const totalActive = activeParticipants.length;

    if (forParticipantId === null) {
      return `[Wave ${wave1}/${this.maxWaves} · ${totalActive} participants]`;
    }

    const respondedCount = activeParticipants.filter(
      (p) => p.waveStatus === 'done' || p.waveStatus === 'passed',
    ).length;

    const pendingParticipants = activeParticipants.filter(
      (p) => p.waveStatus === 'thinking' && p.agentId !== forParticipantId,
    );
    const pendingNames = pendingParticipants.map((p) => p.agentSlug).join(', ');

    const recipient = activeParticipants.find((p) => p.agentId === forParticipantId);
    const myResponseCount = recipient?.waveResponseCount ?? 0;

    const parts = [`Wave ${wave1}/${this.maxWaves}`, `${respondedCount}/${totalActive} responded`];
    if (pendingNames) parts.push(`${pendingNames} pending`);
    parts.push(`you: ${myResponseCount}/${this.maxResponsesPerWave}`);
    return `[${parts.join(' · ')}]`;
  }

  /**
   * Format wave broadcast: concatenate non-PASS, non-timeout responses for the next
   * wave injection. Timed-out participants produce no content and are excluded.
   */
  private formatWaveBroadcast(
    messages: Array<{ agentName: string; content: string; isPass: boolean; isTimeout?: boolean }>,
  ): string {
    const active = messages.filter((m) => !m.isPass && !m.isTimeout);
    if (active.length === 0) return '';
    return active.map((m) => `[${m.agentName}]:\n${m.content}`).join('\n\n---\n\n');
  }

  /**
   * Format user steering + previous responses for the next wave.
   */
  private formatUserSteer(
    userText: string,
    previousResponses: Array<{
      agentName: string;
      content: string;
      isPass: boolean;
      isTimeout?: boolean;
    }>,
  ): string {
    const broadcast = this.formatWaveBroadcast(previousResponses);
    const parts: string[] = [];
    if (broadcast) {
      parts.push(broadcast);
    }
    parts.push(`[User]:\n${userText}`);
    return parts.join('\n\n---\n\n');
  }

  /**
   * Truncate text to approximately `maxWords` words, appending "..." if truncated.
   */
  private static truncateToWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
  }

  /**
   * Build the initial preamble for a participant session.
   * Optionally includes context from related brainstorm syntheses.
   */
  private buildPreamble(
    room: BrainstormWithDetails,
    otherParticipantNames: string[],
    currentParticipantSlug: string,
    relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
    currentParticipantProvider?: Provider | null,
  ): string {
    const waveTimeoutDisplay = Math.round(this.waveTimeoutSec / 60);
    const wave0TimeoutDisplay = Math.round((this.waveTimeoutSec + this.wave0ExtraTimeoutSec) / 60);

    const sections: string[] = [];

    sections.push(`You are participating in a brainstorm room called "${room.title}".

## How This Works
You are in a multi-agent discussion with other AI models and possibly a human moderator.
The discussion runs in **waves** (rounds). In each wave, every participant responds to
what was said in the previous wave. Their messages will appear as "[Name]: message".

**Wave 0 (first round):** This is your chance to explore the topic, research the codebase
if relevant, and form your initial perspective. You have ~${wave0TimeoutDisplay} minutes for this first wave.
Use tools (Read, Grep, Glob, etc.) to ground your response in actual code and data.

**Subsequent waves:** You'll see what the other participants said and respond.
These waves have a ~${waveTimeoutDisplay}-minute time limit, so keep responses focused.

**Convergence:** When all participants agree and have nothing new to add, the discussion
ends naturally. The moderator may also steer or end the discussion at any time.

## Participants
${otherParticipantNames.map((name) => `- ${name}`).join('\n')}
- You`);

    // Inject language instruction from playbook
    if (this.playbook.language) {
      sections.push(
        `\n## Language\nRespond in **${this.playbook.language}**. All your responses must be written in this language.`,
      );
    }

    let myRole: string | null = null;

    // Inject role assignments from playbook
    if (this.playbook.roles && Object.keys(this.playbook.roles).length > 0) {
      const roleLines = Object.entries(this.playbook.roles).map(([role, agentSlug]) => {
        const participant = room.participants.find((p) => p.agentSlug === agentSlug);
        const name = participant ? participant.agentName : agentSlug;
        return `- **${role}**: ${name}`;
      });
      sections.push(`\n## Assigned Roles\n${roleLines.join('\n')}`);

      // Inject personalized role instructions for this participant
      const roleInstructions = (room.config as BrainstormConfig)?.roleInstructions;
      myRole =
        Object.entries(this.playbook.roles).find(
          ([, slug]) => slug === currentParticipantSlug,
        )?.[0] ?? null;

      if (myRole) {
        const instructions =
          roleInstructions?.[myRole] ??
          DEFAULT_ROLE_INSTRUCTIONS[myRole] ??
          `Your assigned role is: ${myRole}`;
        sections.push(`\n## Your Role\n${instructions}`);
      }
    }

    const resolvedProvider =
      currentParticipantProvider ??
      this.participants.find((participant) => participant.agentSlug === currentParticipantSlug)
        ?.provider ??
      inferProviderFromAgentSlug(currentParticipantSlug);
    const providerLens = buildBrainstormProviderLens(resolvedProvider, myRole);
    if (providerLens) {
      sections.push(`\n## Your Provider Lens\n${providerLens}`);
    }

    // Inject setup context if configured
    const cfg = room.config as BrainstormConfig | undefined;
    if (cfg?.goal || cfg?.deliverableType || cfg?.constraints?.length || cfg?.targetAudience) {
      const DELIVERABLE_LABELS: Record<string, string> = {
        decision: 'Make a clear decision with rationale',
        options_list: 'Produce a ranked list of options with pros/cons',
        action_plan: 'Produce a prioritized action plan with owners',
        risk_assessment: 'Produce a risk matrix with mitigations',
        exploration: 'Explore the space, document findings and open questions',
      };
      const briefLines: string[] = [];
      if (cfg.goal) briefLines.push(`**Goal:** ${cfg.goal}`);
      if (cfg.deliverableType && DELIVERABLE_LABELS[cfg.deliverableType]) {
        briefLines.push(`**Expected Output:** ${DELIVERABLE_LABELS[cfg.deliverableType]}`);
      }
      if (cfg.constraints?.length) {
        briefLines.push(`**Constraints:**\n${cfg.constraints.map((c) => `- ${c}`).join('\n')}`);
      }
      if (cfg.targetAudience) briefLines.push(`**Target Audience:** ${cfg.targetAudience}`);
      sections.push(`\n## Discussion Brief\n${briefLines.join('\n')}`);
    }

    // Inject context from related brainstorm syntheses (max 3)
    if (relatedSyntheses && relatedSyntheses.length > 0) {
      const limited = relatedSyntheses.slice(0, 3);
      const contextLines = limited.map((rs) => {
        const dateStr = rs.createdAt.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
        const truncated = BrainstormOrchestrator.truncateToWords(rs.synthesis, 500);
        return `### ${rs.title} (${dateStr})\n${truncated}`;
      });
      sections.push(
        `\n## Context from Previous Discussions\nThe following syntheses are from earlier brainstorm sessions on this project. Use them as context — build on these decisions rather than re-debating settled points.\n\n${contextLines.join('\n\n')}`,
      );
    }

    sections.push(`
## Discussion Rules
1. **Think critically.** Disagree when you disagree. Build on good ideas. Challenge weak ones.
   The value is in genuine diverse perspectives and constructive disagreement.
2. **Do NOT be agreeable for the sake of politeness.** "I agree with everything" is not helpful.
   If you agree, explain WHY and add a new angle, nuance, or concrete detail.
3. **Be specific.** Reference file paths, function names, line numbers when discussing code.
   "Consider simplifying" is useless — "Reuse the existing \`formatWaveBroadcast\` at
   orchestrator.ts:1255 instead of building a new formatter" is valuable.
4. **[PASS]:** If you genuinely agree with everything said AND have nothing new to add —
   no disagreement, no new angle, no important nuance — respond with exactly: [PASS]
   Do not PASS just to be polite. Only PASS when you truly have nothing to contribute.
5. **Keep responses focused.** 2-4 paragraphs max unless the topic demands more depth.
6. **Do NOT write code** unless specifically asked. Focus on ideas and reasoning.

You will receive the discussion topic in your first wave message. Wait for it before responding.`);

    return sections.join('\n');
  }

  /** Emit a BrainstormEvent to the room's PG NOTIFY channel and write to the log file. */
  private async emitEvent(payload: BrainstormEventPayload): Promise<void> {
    this.eventSeq++;
    const event = {
      id: this.eventSeq,
      roomId: this.roomId,
      ts: Date.now(),
      ...payload,
    } as BrainstormEvent;

    // Persist to log file for SSE replay on reconnect.
    // Double-cast through unknown: BrainstormEvent is a discriminated union without an index
    // signature, but at runtime the shape satisfies what writeEvent expects.
    this.logWriter?.writeEvent(
      event as unknown as { id: number; type: string; [key: string]: unknown },
    );

    // Notify all in-memory SSE listeners (browser tabs connected to Worker SSE).
    const listeners = brainstormEventListeners.get(this.roomId);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch {
          // Individual listener error — don't break others
        }
      }
    }
  }

  /**
   * Send a `cancel` control signal to every participant session so they exit
   * immediately instead of sitting idle for up to idleTimeoutSec (1 hour).
   * Called from `finally` — runs on both clean exit and crash.
   */
  private async terminateParticipantSessions(): Promise<void> {
    const sessionIds = this.participants
      .map((p) => p.sessionId)
      .filter((id): id is string => id != null);

    if (sessionIds.length === 0) return;

    log.info(
      { roomId: this.roomId, sessionCount: sessionIds.length },
      'Cancelling participant sessions after brainstorm end',
    );

    await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        const proc = getSessionProc(sessionId);
        if (proc) {
          await proc.onControl(JSON.stringify({ type: 'cancel' }));
        } else {
          // Session not on this worker — deliver via Worker HTTP.
          await sendSessionControl(sessionId, { type: 'cancel' });
        }
      }),
    );
  }

  /** Clean up all PG NOTIFY subscriptions, Worker HTTP handlers, and pending timers */
  private cleanup(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // Best effort
      }
    }
    this.unsubscribers = [];
    this.subscribedSessionIds.clear();

    // Deregister the control and feedback handlers from the Worker HTTP dispatch map.
    liveBrainstormHandlers.delete(this.roomId);
    liveBrainstormFeedbackHandlers.delete(this.roomId);

    // Cancel the wave timeout to avoid stale timer fire after cleanup
    if (this.waveTimeoutHandle) {
      clearTimeout(this.waveTimeoutHandle);
      this.waveTimeoutHandle = null;
    }

    // Cancel any pending delta flush timers to avoid fire-after-cleanup emissions
    for (const p of this.participants) {
      p.deltaBuffer.destroy();
    }
  }
}

// ============================================================================
// Top-level job entry point
// ============================================================================

/**
 * Load the room and run the orchestrator.
 * Called by the worker's brainstorm job handler.
 */
export async function runBrainstorm(roomId: string): Promise<void> {
  const room = await getBrainstorm(roomId);
  const roomConfig = (room.config ?? {}) as BrainstormConfig;

  const orchestrator = new BrainstormOrchestrator(room.id, room.maxWaves, undefined, roomConfig);
  await orchestrator.run();
}
