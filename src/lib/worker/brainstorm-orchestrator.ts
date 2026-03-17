/**
 * Brainstorm Orchestrator
 *
 * Manages the lifecycle of a brainstorm room: creates participant sessions,
 * runs waves, collects responses, detects PASS convergence, handles user
 * steering, and emits BrainstormEvents over PG NOTIFY for the frontend SSE stream.
 */

import { readFileSync, existsSync } from 'node:fs';
import { describeToolActivity } from '@/lib/utils/tool-descriptions';
import { createLogger } from '@/lib/logger';
import { brainstormEventListeners, addSessionEventListener } from '@/lib/worker/worker-sse';
import { liveBrainstormHandlers } from '@/lib/worker/worker-http';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { getSessionProc } from '@/lib/worker/session-runner';
import { createSession, getSessionStatus } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import {
  getBrainstorm,
  updateBrainstormStatus,
  updateBrainstormWave,
  updateBrainstormLogPath,
  updateParticipantSession,
  updateParticipantStatus,
  setBrainstormSynthesis,
} from '@/lib/services/brainstorm-service';
import { FileLogWriter, resolveBrainstormLogPath } from '@/lib/worker/log-writer';
import { readBrainstormEventsFromLog } from '@/lib/realtime/event-utils';
import type {
  BrainstormEvent,
  BrainstormEventPayload,
  AgendoEvent,
} from '@/lib/realtime/event-types';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';

const log = createLogger('brainstorm-orchestrator');

/** How long to accumulate text-delta events before flushing to the frontend (ms). */
const DELTA_FLUSH_INTERVAL_MS = 150;

// ============================================================================
// Types
// ============================================================================

type WaveStatus = 'pending' | 'thinking' | 'done' | 'passed' | 'timeout';

interface ParticipantState {
  /** DB primary key of the brainstorm_participants row */
  participantId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  sessionId: string | null;
  model?: string;
  waveStatus: WaveStatus;
  /** Accumulates agent:text chunks during the current wave turn */
  responseBuffer: string[];
  /** True once this participant has passed in any previous wave (excludes from future waves) */
  hasPassed: boolean;
  /** True once this participant has been explicitly removed — never reset by steer */
  hasLeft: boolean;
  /** Timestamp (ms) when this participant first reached awaiting_input, or null if not yet ready */
  readyAt: number | null;
  /** Accumulated delta text waiting to be flushed to the frontend */
  deltaBuffer: string;
  /** Timer handle for the periodic delta flush */
  deltaFlushTimer: ReturnType<typeof setTimeout> | null;
}

interface BrainstormControlMessage {
  type: 'steer' | 'end' | 'remove-participant' | 'extend';
  text?: string;
  synthesize?: boolean;
  agentId?: string;
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

/** Per-participant startup timeout. Agents that fail to reach awaiting_input within this window are evicted. */
const PER_PARTICIPANT_READY_TIMEOUT_SEC = 300; // 5 minutes — agents may research codebase on first turn

/** Extra time budget for wave 0 (research wave). Agents explore the codebase before responding. */
const WAVE_0_EXTRA_TIMEOUT_SEC = 180; // +3 minutes on top of normal wave timeout

export class BrainstormOrchestrator {
  private readonly roomId: string;
  private eventSeq = 0;
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
  /** Steer messages received mid-wave, applied at the start of the next wave. */
  private pendingSteer: string[] = [];
  private unsubscribers: Array<() => void> = [];
  private waveCompleteResolve: (() => void) | null = null;
  private controlResolve: ((msg: BrainstormControlMessage) => void) | null = null;
  /** Set by the 'end' control message when synthesis was requested. */
  private synthesisPending = false;
  /** Guards against double-subscription when subscribeToSession() is called twice for the same sessionId. */
  private subscribedSessionIds = new Set<string>();

  constructor(roomId: string, maxWaves: number, waveTimeoutSec = 120) {
    this.roomId = roomId;
    this.maxWaves = maxWaves;
    this.waveTimeoutSec = waveTimeoutSec;
    // Default startup timeout: at least 5 minutes. Never less than the wave
    // timeout itself (e.g. if waveTimeoutSec was increased significantly).
    this.participantReadyTimeoutSec = Math.max(
      MIN_PARTICIPANT_READY_TIMEOUT_SEC,
      waveTimeoutSec * 2,
    );
  }

  /** Main entry point — called by the worker job handler */
  async run(): Promise<void> {
    log.info({ roomId: this.roomId }, 'Brainstorm orchestrator starting');

    // Resolve and open the log file for this room. All events emitted via
    // emitEvent() are written here for SSE reconnect replay.
    this.logFilePath = resolveBrainstormLogPath(this.roomId);
    this.logWriter = new FileLogWriter(this.logFilePath);
    this.logWriter.open();

    try {
      const room = await getBrainstorm(this.roomId);

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
      }

      // Use config-level wave timeout if specified (overrides constructor arg)
      const roomConfig = room.config as {
        waveTimeoutSec?: number;
        participantReadyTimeoutSec?: number;
      } | null;
      if (roomConfig?.waveTimeoutSec !== undefined) {
        this.waveTimeoutSec = roomConfig.waveTimeoutSec;
        // Re-compute the default ready timeout based on the (potentially updated) wave timeout.
        this.participantReadyTimeoutSec = Math.max(
          MIN_PARTICIPANT_READY_TIMEOUT_SEC,
          this.waveTimeoutSec * 2,
        );
      }
      // Explicit override wins over the derived default.
      if (roomConfig?.participantReadyTimeoutSec !== undefined) {
        this.participantReadyTimeoutSec = roomConfig.participantReadyTimeoutSec;
      }

      // Build participant state from DB records
      this.participants = room.participants.map((p) => ({
        participantId: p.id,
        agentId: p.agentId,
        agentName: p.agentName,
        agentSlug: p.agentSlug,
        sessionId: p.sessionId ?? null,
        model: p.model ?? undefined,
        waveStatus: 'pending' as WaveStatus,
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        readyAt: null,
        deltaBuffer: '',
        deltaFlushTimer: null,
      }));

      // Mark room as active
      await updateBrainstormStatus(this.roomId, 'active');
      await this.emitEvent({ type: 'room:state', status: 'active' });

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
      await this.emitEvent({
        type: 'room:error',
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      // Use 'paused' so the steer route can re-enqueue and recover the room.
      // 'ended' is reserved for intentional user-initiated stops.
      await updateBrainstormStatus(this.roomId, 'paused').catch(() => {});
      await this.emitEvent({ type: 'room:state', status: 'paused' }).catch(() => {});
    } finally {
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
        const preamble = this.buildPreamble(room, otherNames);

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
        await this.emitEvent({
          type: 'participant:joined',
          agentId: participant.agentId,
          agentName: participant.agentName,
        });

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

            await this.emitEvent({
              type: 'room:error',
              message: `Agent ${p.agentName} failed to start within 3 minutes — removing from brainstorm`,
            }).catch(() => {});

            p.hasLeft = true;
            p.hasPassed = true;
            p.waveStatus = 'done';

            await updateParticipantStatus(p.participantId, 'left').catch(() => {});

            await this.emitEvent({
              type: 'participant:left',
              agentId: p.agentId,
              agentName: p.agentName,
            }).catch(() => {});
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
      p.deltaBuffer = '';
      if (p.deltaFlushTimer) {
        clearTimeout(p.deltaFlushTimer);
        p.deltaFlushTimer = null;
      }
    }

    const activeCount = this.participants.filter((p) => !p.hasLeft).length;
    log.info({ roomId: this.roomId, activeCount }, 'All participant sessions ready');
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
        log.info({ roomId: this.roomId, wave }, 'Found pending user steer from log, resuming');
        await this.resetPassedParticipants();
        await this.emitEvent({
          type: 'message',
          wave,
          senderType: 'user',
          content: userSteer.content,
          isPass: false,
        });
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

      // Collect responses from this wave
      const responses = this.participants
        .filter((p) => !p.hasPassed && p.waveStatus !== 'timeout')
        .map((p) => ({
          agentName: p.agentName,
          agentId: p.agentId,
          content: p.responseBuffer.join('').trim(),
          isPass: p.waveStatus === 'passed',
        }));

      // Update hasPassed for participants who passed this wave
      for (const p of this.participants) {
        if (p.waveStatus === 'passed') {
          p.hasPassed = true;
          await updateParticipantStatus(p.participantId, 'passed');
        }
      }

      // Emit wave:complete
      await this.emitEvent({ type: 'wave:complete', wave });

      // Detect convergence: all participants passed
      const activeResponses = responses.filter((r) => !r.isPass);
      const allPassed = activeResponses.length === 0;

      if (allPassed) {
        log.info({ roomId: this.roomId, wave }, 'All participants passed — converged');
        if (this.stopped) break;
        await updateBrainstormStatus(this.roomId, 'paused');
        await this.emitEvent({ type: 'room:converged', wave });
        await this.emitEvent({ type: 'room:state', status: 'paused' });
        this.paused = true;

        // Wait for a steer or end control message
        const control = await this.waitForControl();
        if (this.stopped) break;

        if (control.type === 'steer' && control.text) {
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
        if (this.stopped) break;
        await updateBrainstormStatus(this.roomId, 'paused');
        await this.emitEvent({ type: 'room:max-waves', wave });
        await this.emitEvent({ type: 'room:state', status: 'paused' });
        this.paused = true;

        // Wait for a steer or end control message
        const control = await this.waitForControl();
        if (this.stopped) break;

        if (control.type === 'steer' && control.text) {
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
        const steerText = this.pendingSteer.join('\n\n');
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

      // Normal continuation — broadcast this wave's responses to everyone
      waveContent = this.formatWaveBroadcast(responses);
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

  private async startWave(wave: number, content: string): Promise<void> {
    this.currentWave = wave;
    await updateBrainstormWave(this.roomId, wave);

    log.info({ roomId: this.roomId, wave }, 'Starting wave');
    await this.emitEvent({ type: 'wave:start', wave });

    // Reset buffers and statuses for active participants
    for (const p of this.participants) {
      if (p.hasPassed) continue;
      p.waveStatus = 'thinking';
      p.responseBuffer = [];
      // Clear any leftover delta state from the previous wave
      p.deltaBuffer = '';
      if (p.deltaFlushTimer) {
        clearTimeout(p.deltaFlushTimer);
        p.deltaFlushTimer = null;
      }
      await this.emitEvent({
        type: 'participant:status',
        agentId: p.agentId,
        agentName: p.agentName,
        status: 'thinking',
      });
    }

    // Inject the content into each active participant's session
    const injectionPromises = this.participants
      .filter(
        (p): p is ParticipantState & { sessionId: string } => !p.hasPassed && p.sessionId !== null,
      )
      .map((p) => this.injectMessage(p.sessionId, content));

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
    const extraSec = wave === 0 ? WAVE_0_EXTRA_TIMEOUT_SEC : 0;
    const timeoutSec = this.waveTimeoutSec + extraSec;
    log.info({ roomId: this.roomId, wave, timeoutSec }, 'Wave timeout scheduled');
    setTimeout(() => {
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
          void this.emitEvent({
            type: 'participant:status',
            agentId: p.agentId,
            agentName: p.agentName,
            status: 'timeout',
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
   */
  private waitForWaveComplete(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waveCompleteResolve = resolve;
      // Check immediately in case all participants were already done
      this.checkWaveComplete();
    });
  }

  /** Called whenever a participant's waveStatus changes to a terminal state. */
  private checkWaveComplete(): void {
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
          // Accumulate into delta buffer; a timer batches rapid bursts into a
          // single PG NOTIFY publish to avoid flooding the channel.
          participant.deltaBuffer += event.text;
          if (!participant.deltaFlushTimer) {
            participant.deltaFlushTimer = setTimeout(() => {
              this.flushParticipantDelta(participant);
            }, DELTA_FLUSH_INTERVAL_MS);
          }
        }
        break;

      case 'session:state':
        if (event.status === 'awaiting_input') {
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

      case 'agent:tool-start': {
        // Forward tool activity so the UI can show what the agent is doing
        // (e.g. "Reading orchestrator.ts" instead of just "thinking...")
        const toolName = event.toolName ?? '';
        const input = event.input as Record<string, unknown> | undefined;
        const description = describeToolActivity(toolName, input);
        if (description) {
          void this.emitEvent({
            type: 'participant:activity',
            agentId: participant.agentId,
            description,
          }).catch(() => {});
        }
        break;
      }

      case 'agent:subagent-progress': {
        // Forward subagent progress descriptions
        const desc = event.description;
        if (desc) {
          void this.emitEvent({
            type: 'participant:activity',
            agentId: participant.agentId,
            description: desc,
          }).catch(() => {});
        }
        break;
      }

      default:
        // Other event types (thinking, etc.) are not forwarded
        break;
    }
  }

  /**
   * Flush accumulated delta text to the frontend as a single batched event.
   * Resets the buffer and clears the timer handle so the next delta starts fresh.
   */
  private flushParticipantDelta(participant: ParticipantState): void {
    participant.deltaFlushTimer = null;
    if (participant.deltaBuffer.length === 0) return;
    const text = participant.deltaBuffer;
    participant.deltaBuffer = '';
    void this.emitEvent({
      type: 'message:delta',
      agentId: participant.agentId,
      text,
    }).catch(() => {});
  }

  private onParticipantTurnComplete(participant: ParticipantState): void {
    // Flush any remaining buffered deltas before emitting the final complete message
    if (participant.deltaFlushTimer) {
      clearTimeout(participant.deltaFlushTimer);
      participant.deltaFlushTimer = null;
    }
    if (participant.deltaBuffer.length > 0) {
      void this.emitEvent({
        type: 'message:delta',
        agentId: participant.agentId,
        text: participant.deltaBuffer,
      }).catch(() => {});
      participant.deltaBuffer = '';
    }

    const rawResponse = participant.responseBuffer.join('').trim();
    const isPass = rawResponse.toLowerCase().startsWith('[pass]');

    participant.waveStatus = isPass ? 'passed' : 'done';

    void (async () => {
      try {
        // Emit the complete message event
        await this.emitEvent({
          type: 'message',
          wave: this.currentWave,
          senderType: 'agent',
          agentId: participant.agentId,
          agentName: participant.agentName,
          content: rawResponse,
          isPass,
        });

        // Emit participant status update
        await this.emitEvent({
          type: 'participant:status',
          agentId: participant.agentId,
          agentName: participant.agentName,
          status: isPass ? 'passed' : 'done',
        });
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

  // ============================================================================
  // Control message handling
  // ============================================================================

  private handleControlMessage(msg: BrainstormControlMessage): void {
    log.info({ roomId: this.roomId, type: msg.type }, 'Control message received');

    switch (msg.type) {
      case 'steer':
        if (!msg.text) return;

        if (this.paused) {
          // Room is paused (converged or max-waves) — resolve the waitForControl promise
          const resolve = this.controlResolve;
          this.controlResolve = null;
          resolve?.(msg);
        } else {
          // Mid-wave steer — queue for injection at start of next wave.
          // Multiple steers are joined; none are silently dropped.
          this.pendingSteer.push(msg.text);
          log.info({ roomId: this.roomId }, 'Steer queued for next wave');
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
        }
        // If not paused, waveLoop will check this.stopped after wave completes
        break;

      case 'extend': {
        const extra = msg.additionalWaves ?? 5;
        this.maxWaves += extra;
        log.info({ roomId: this.roomId, extra, maxWaves: this.maxWaves }, 'Max waves extended');

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
        if (!msg.agentId) return;
        const target = this.participants.find((p) => p.agentId === msg.agentId);
        if (!target) return;

        target.hasPassed = true; // Exclude from future waves
        target.hasLeft = true; // Permanently removed — not reset by steer
        target.waveStatus = 'done'; // Unblock any in-progress wave wait

        void updateParticipantStatus(target.participantId, 'left').catch(() => {});
        void this.emitEvent({
          type: 'participant:left',
          agentId: target.agentId,
          agentName: target.agentName,
        }).catch(() => {});

        // If this was the last active participant, complete the wave
        this.checkWaveComplete();
        break;
      }
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
      // Build transcript from log file events.
      const allEvents =
        this.logFilePath && existsSync(this.logFilePath)
          ? readBrainstormEventsFromLog(readFileSync(this.logFilePath, 'utf-8'), 0)
          : [];

      const messageEvents = allEvents.filter((e) => e.type === 'message');

      const transcript = messageEvents
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

      const synthesisPrompt = `You are synthesizing a brainstorm discussion.

TOPIC: ${room.topic}

DISCUSSION TRANSCRIPT:
${transcript}

Your task: Write a clear, structured synthesis of the key insights, agreements, disagreements, and action items from this brainstorm. Be concise but comprehensive. Use sections and bullet points where helpful.`;

      // Determine synthesis agent: prefer config.synthesisAgentId, then first participant
      const synthesisAgentId =
        (room.config as { synthesisAgentId?: string } | null)?.synthesisAgentId ??
        this.participants[0]?.agentId;

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

      // Wait for synthesis session to complete and collect the response
      const synthesisText = await synthesisTextPromise;

      await setBrainstormSynthesis(this.roomId, synthesisText);
      await this.emitEvent({ type: 'room:synthesis', synthesis: synthesisText });

      log.info({ roomId: this.roomId }, 'Synthesis complete');
    } catch (err) {
      log.error({ err, roomId: this.roomId }, 'Synthesis failed');
      await this.emitEvent({
        type: 'room:error',
        message: `Synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    await updateBrainstormStatus(this.roomId, 'ended');
    await this.emitEvent({ type: 'room:state', status: 'ended' });
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
   * Format wave broadcast: concatenate non-PASS responses for the next wave injection.
   */
  private formatWaveBroadcast(
    messages: Array<{ agentName: string; content: string; isPass: boolean }>,
  ): string {
    const nonPass = messages.filter((m) => !m.isPass);
    if (nonPass.length === 0) return '';
    return nonPass.map((m) => `[${m.agentName}]:\n${m.content}`).join('\n\n---\n\n');
  }

  /**
   * Format user steering + previous responses for the next wave.
   */
  private formatUserSteer(
    userText: string,
    previousResponses: Array<{ agentName: string; content: string; isPass: boolean }>,
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
   * Build the initial preamble for a participant session.
   */
  private buildPreamble(room: BrainstormWithDetails, otherParticipantNames: string[]): string {
    const waveTimeoutDisplay = Math.round(this.waveTimeoutSec / 60);
    const wave0TimeoutDisplay = Math.round((this.waveTimeoutSec + WAVE_0_EXTRA_TIMEOUT_SEC) / 60);

    return `You are participating in a brainstorm room called "${room.title}".

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
- You

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

TOPIC: ${room.topic}`;
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

    // Deregister the control handler from the Worker HTTP dispatch map.
    liveBrainstormHandlers.delete(this.roomId);

    // Cancel any pending delta flush timers to avoid fire-after-cleanup emissions
    for (const p of this.participants) {
      if (p.deltaFlushTimer) {
        clearTimeout(p.deltaFlushTimer);
        p.deltaFlushTimer = null;
      }
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
  const config = room.config as { waveTimeoutSec?: number } | null;
  const waveTimeoutSec = config?.waveTimeoutSec ?? 120;

  const orchestrator = new BrainstormOrchestrator(room.id, room.maxWaves, waveTimeoutSec);
  await orchestrator.run();
}
