/**
 * Brainstorm Orchestrator
 *
 * Manages the lifecycle of a brainstorm room: creates participant sessions,
 * runs waves, collects responses, detects PASS convergence, handles user
 * steering, and emits BrainstormEvents over PG NOTIFY for the frontend SSE stream.
 */

import { createLogger } from '@/lib/logger';
import { subscribe, publish, channelName } from '@/lib/realtime/pg-notify';
import { createSession } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import {
  getBrainstorm,
  updateBrainstormStatus,
  updateBrainstormWave,
  updateParticipantSession,
  updateParticipantStatus,
  addMessage,
  getMessages,
  setBrainstormSynthesis,
} from '@/lib/services/brainstorm-service';
import type {
  BrainstormEvent,
  BrainstormEventPayload,
  AgendoEvent,
} from '@/lib/realtime/event-types';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';

const log = createLogger('brainstorm-orchestrator');

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
}

interface BrainstormControlMessage {
  type: 'steer' | 'end' | 'remove-participant';
  text?: string;
  synthesize?: boolean;
  agentId?: string;
}

// ============================================================================
// BrainstormOrchestrator
// ============================================================================

export class BrainstormOrchestrator {
  private readonly roomId: string;
  private eventSeq = 0;
  private participants: ParticipantState[] = [];
  private currentWave = 0;
  private readonly maxWaves: number;
  private waveTimeoutSec: number;
  private stopped = false;
  private paused = false;
  private pendingSteer: string | null = null;
  private unsubscribers: Array<() => void> = [];
  private waveCompleteResolve: (() => void) | null = null;
  private controlResolve: ((msg: BrainstormControlMessage) => void) | null = null;

  constructor(roomId: string, maxWaves: number, waveTimeoutSec = 120) {
    this.roomId = roomId;
    this.maxWaves = maxWaves;
    this.waveTimeoutSec = waveTimeoutSec;
  }

  /** Main entry point — called by the worker job handler */
  async run(): Promise<void> {
    log.info({ roomId: this.roomId }, 'Brainstorm orchestrator starting');
    try {
      const room = await getBrainstorm(this.roomId);

      // Use config-level wave timeout if specified (overrides constructor arg)
      const configuredTimeout = (room.config as { waveTimeoutSec?: number } | null)?.waveTimeoutSec;
      if (configuredTimeout !== undefined) {
        this.waveTimeoutSec = configuredTimeout;
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
      }));

      // Mark room as active
      await updateBrainstormStatus(this.roomId, 'active');
      await this.emitEvent({ type: 'room:state', status: 'active' });

      // Create sessions for all participants
      await this.createParticipantSessions(room);

      // Subscribe to the room control channel
      await this.subscribeToControl();

      // Run the wave loop
      await this.runWaveLoop(room);
    } catch (err) {
      log.error({ err, roomId: this.roomId }, 'Brainstorm orchestrator error');
      await this.emitEvent({
        type: 'room:error',
        message: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      await updateBrainstormStatus(this.roomId, 'ended').catch(() => {});
      await this.emitEvent({ type: 'room:state', status: 'ended' }).catch(() => {});
    } finally {
      this.cleanup();
      log.info({ roomId: this.roomId }, 'Brainstorm orchestrator finished');
    }
  }

  // ============================================================================
  // Session creation
  // ============================================================================

  private async createParticipantSessions(room: BrainstormWithDetails): Promise<void> {
    const allNames = room.participants.map((p) => p.agentName);

    for (const participant of this.participants) {
      // Skip if a session was already assigned (e.g. resuming a room)
      if (participant.sessionId) {
        log.info(
          {
            roomId: this.roomId,
            participantId: participant.participantId,
            sessionId: participant.sessionId,
          },
          'Participant already has a session — reusing',
        );
        await this.subscribeToSession(participant);
        continue;
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
    }

    // Wait for all participants to reach awaiting_input (session is ready for messages)
    await this.waitForAllParticipantsReady();
  }

  /**
   * Wait until all participants have reached awaiting_input at least once.
   * Relies on subscribeToSession() setting waveStatus='done' on first awaiting_input.
   */
  private async waitForAllParticipantsReady(): Promise<void> {
    const timeoutMs = this.waveTimeoutSec * 1000 * 2; // double the wave timeout for startup
    let cancelled = false;

    await Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (cancelled) return;
          const allReady = this.participants.every(
            (p) => p.waveStatus === 'done' || p.waveStatus === 'passed',
          );
          if (allReady) {
            resolve();
          } else {
            setTimeout(check, 500);
          }
        };
        check();
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          cancelled = true;
          reject(new Error(`Participants did not reach ready state within ${timeoutMs}ms`));
        }, timeoutMs),
      ),
    ]);

    // Reset statuses to 'pending' for wave 0
    for (const p of this.participants) {
      p.waveStatus = 'pending';
      p.responseBuffer = [];
    }

    log.info({ roomId: this.roomId }, 'All participant sessions ready');
  }

  // ============================================================================
  // Subscription management
  // ============================================================================

  /** Subscribe to a participant session's event channel */
  private async subscribeToSession(participant: ParticipantState): Promise<void> {
    if (!participant.sessionId) return;
    const sessionId = participant.sessionId;

    const unsub = await subscribe(channelName('agendo_events', sessionId), (rawPayload: string) => {
      let event: AgendoEvent;
      try {
        event = JSON.parse(rawPayload) as AgendoEvent;
      } catch {
        return;
      }
      this.handleSessionEvent(participant, event);
    });

    this.unsubscribers.push(unsub);
  }

  /** Subscribe to the brainstorm control channel for user steering */
  private async subscribeToControl(): Promise<void> {
    const unsub = await subscribe(
      channelName('brainstorm_control', this.roomId),
      (rawPayload: string) => {
        let msg: BrainstormControlMessage;
        try {
          msg = JSON.parse(rawPayload) as BrainstormControlMessage;
        } catch {
          log.warn({ roomId: this.roomId, rawPayload }, 'Invalid control message');
          return;
        }
        this.handleControlMessage(msg);
      },
    );

    this.unsubscribers.push(unsub);
  }

  // ============================================================================
  // Wave loop
  // ============================================================================

  private async runWaveLoop(room: BrainstormWithDetails): Promise<void> {
    // Wave 0 starts with the topic injected into all participants
    let waveContent = room.topic;
    let wave = 0;

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

      // Persist all messages from this wave
      for (const r of responses) {
        await addMessage({
          roomId: this.roomId,
          wave,
          senderType: 'agent',
          senderAgentId: r.agentId,
          content: r.content,
          isPass: r.isPass,
        });
      }

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
          await addMessage({
            roomId: this.roomId,
            wave: wave + 1,
            senderType: 'user',
            content: control.text,
          });
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
          await addMessage({
            roomId: this.roomId,
            wave: wave + 1,
            senderType: 'user',
            content: control.text,
          });
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

      // Check for a pending steer from mid-wave injection
      if (this.pendingSteer !== null) {
        const steerText = this.pendingSteer;
        this.pendingSteer = null;
        await addMessage({
          roomId: this.roomId,
          wave: wave + 1,
          senderType: 'user',
          content: steerText,
        });
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
   * Any participant still in 'thinking' state when the timeout fires
   * is marked as 'timeout' and treated as an implicit PASS.
   */
  private scheduleWaveTimeout(wave: number): void {
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
    }, this.waveTimeoutSec * 1000);
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
        // Collect complete text chunks into the response buffer
        participant.responseBuffer.push(event.text);
        break;

      case 'agent:text-delta':
        // Forward as a real-time streaming delta to the frontend
        if (!event.fromDelta) {
          // Only forward actual deltas, not reconstructed-from-complete events
          void this.emitEvent({
            type: 'message:delta',
            agentId: participant.agentId,
            text: event.text,
          }).catch(() => {});
        }
        break;

      case 'session:state':
        if (event.status === 'awaiting_input') {
          // Turn complete — process the response
          this.onParticipantTurnComplete(participant);
        }
        break;

      default:
        // Other event types (tool use, thinking, etc.) are not forwarded
        break;
    }
  }

  private onParticipantTurnComplete(participant: ParticipantState): void {
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
          // Mid-wave steer — queue for injection at start of next wave
          this.pendingSteer = msg.text;
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

  /** Whether synthesis was requested via the 'end' control message. */
  private synthesisPending = false;

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
      const allMessages = await getMessages(this.roomId);

      // Build transcript
      const transcript = allMessages
        .map((msg) => {
          const sender =
            msg.senderType === 'user'
              ? '[User]'
              : `[${this.participants.find((p) => p.agentId === msg.senderAgentId)?.agentName ?? 'Agent'}]`;
          const passNote = msg.isPass ? ' [PASSED]' : '';
          return `Wave ${msg.wave} — ${sender}${passNote}:\n${msg.content}`;
        })
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

    // Subscribe BEFORE the session is enqueued to avoid missing events.
    const unsub = await subscribe(channelName('agendo_events', sessionId), (rawPayload: string) => {
      let event: AgendoEvent;
      try {
        event = JSON.parse(rawPayload) as AgendoEvent;
      } catch {
        return;
      }

      if (event.type === 'agent:text') {
        buffer.push(event.text);
      } else if (event.type === 'session:state' && event.status === 'awaiting_input') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutHandle);
          resolveFn(buffer.join('').trim());
        }
      }
    });
    this.unsubscribers.push(unsub);

    const timeoutHandle = setTimeout(
      () => {
        if (!resolved) {
          resolved = true;
          rejectFn(new Error(`Synthesis session ${sessionId} timed out`));
        }
      },
      this.waveTimeoutSec * 2 * 1000,
    );

    try {
      return await resultPromise;
    } finally {
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

  /** Inject a message into a session via the session control channel */
  private async injectMessage(sessionId: string, text: string): Promise<void> {
    await publish(channelName('agendo_control', sessionId), {
      type: 'message' as const,
      text,
    });
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
    const othersText =
      otherParticipantNames.length > 0
        ? otherParticipantNames.join(', ')
        : 'no other participants yet';

    return `You are participating in a brainstorm room called "${room.title}".

Other participants: ${othersText}

RULES:
- You are discussing with other AI models and possibly a human moderator.
- Their messages will appear as "[Name]: message".
- This is a DISCUSSION. Think critically. Disagree when you disagree.
  Build on good ideas. Challenge weak ones. Be specific and concise.
- Do NOT be agreeable for the sake of politeness. The value is in genuine
  diverse perspectives and constructive disagreement.
- If you agree with everything said and have NOTHING new to add — no
  disagreement, no new angle, no important nuance — respond with exactly:
  [PASS]
- Keep responses focused. 2-4 paragraphs max unless the topic demands more.
- You have access to MCP tools if you need to look up code, tasks, or
  project context. Use them sparingly — this is primarily a thinking session.
- Do NOT write code unless specifically asked. Focus on ideas and reasoning.

TOPIC: ${room.topic}`;
  }

  /** Emit a BrainstormEvent to the room's PG NOTIFY channel */
  private async emitEvent(payload: BrainstormEventPayload): Promise<void> {
    this.eventSeq++;
    const event = {
      id: this.eventSeq,
      roomId: this.roomId,
      ts: Date.now(),
      ...payload,
    } as BrainstormEvent;
    await publish(channelName('brainstorm_events', this.roomId), event);
  }

  /** Clean up all PG NOTIFY subscriptions */
  private cleanup(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // Best effort
      }
    }
    this.unsubscribers = [];
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
