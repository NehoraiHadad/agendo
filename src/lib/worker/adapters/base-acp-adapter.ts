import { createLogger } from '@/lib/logger';
import { existsSync, readFileSync } from 'node:fs';
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AttachmentRef } from '@/lib/attachments';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { extractMessage, AcpTransport } from '@/lib/worker/adapters/gemini-acp-transport';
import { readEventsFromLog } from '@/lib/realtime/event-utils';
import type { Client } from '@agentclientprotocol/sdk';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';
import {
  buildMessageWithAttachments,
  readNativeImageContents,
} from '@/lib/worker/attachment-utils';

const log = createLogger('acp-adapter');

/**
 * Abstract base class for ACP-based agent adapters (Gemini, Copilot, OpenCode).
 *
 * Generic over TEvent — the agent-specific NDJSON event union type
 * (GeminiEvent | CopilotEvent | OpenCodeEvent).
 *
 * Subclasses provide:
 *  - Binary/label/prefix identity via abstract getters
 *  - CLI arg construction via buildArgs()
 *  - Client handler creation via createClientHandler()
 *  - Event mapping via mapJsonToEvents()
 *
 * Optional hooks allow subclass-specific behavior without duplicating the
 * full launch/init/sendPrompt pipeline.
 */
export abstract class AbstractAcpAdapter<TEvent extends { type: string }>
  extends BaseAgentAdapter
  implements AgentAdapter
{
  protected childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  protected transport = new AcpTransport();
  protected clientHandler: (Client & { releaseAllTerminals(): void }) | null = null;
  protected sessionId: string | null = null;
  protected currentTurn: Promise<void> = Promise.resolve();
  protected lock = new AsyncLock();
  protected dataCallbacks: Array<(chunk: string) => void> = [];
  protected exitCallbacks: Array<(code: number | null) => void> = [];
  protected storedOpts: SpawnOpts | null = null;
  protected activeToolCalls = new Set<string>();

  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

  // ---------------------------------------------------------------------------
  // Abstract getters — subclasses must implement
  // ---------------------------------------------------------------------------

  /** CLI binary name (e.g. 'gemini', 'copilot', 'opencode'). */
  protected abstract get binaryName(): string;
  /** Human-readable agent label (e.g. 'Gemini', 'Copilot', 'OpenCode'). */
  protected abstract get agentLabel(): string;
  /** Event type prefix (e.g. 'gemini', 'copilot', 'opencode'). */
  protected abstract get agentPrefix(): string;
  /** Maps Agendo permission modes → ACP mode IDs for setPermissionMode(). */
  protected abstract get acpModeMap(): Record<string, string>;

  // ---------------------------------------------------------------------------
  // Abstract methods — subclasses must implement
  // ---------------------------------------------------------------------------

  protected abstract buildArgs(opts: SpawnOpts, resumeSessionId: string | null): string[];
  protected abstract createClientHandler(): Client & { releaseAllTerminals(): void };
  abstract mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[];

  // ---------------------------------------------------------------------------
  // Overridable hooks — default implementations in base
  // ---------------------------------------------------------------------------

  /** Transform opts before launch (e.g. inject env vars). */
  protected prepareOpts(opts: SpawnOpts): SpawnOpts {
    return opts;
  }

  /** Called after ACP init completes, before first prompt (e.g. load TOML commands). */
  protected async onAfterInit(_opts: SpawnOpts): Promise<void> {}

  /** Return true to suppress exit callbacks (e.g. during model-switch restart). */
  protected suppressExit(): boolean {
    return false;
  }

  /** Transform an event before emitting (e.g. merge TOML commands). */
  protected transformEvent(event: TEvent): TEvent {
    return event;
  }

  /** Accumulate structural events for getHistory() fallback. */
  protected accumulateHistory(event: TEvent): void {
    // Handle text-delta events by merging them into a single agent:text entry.
    // ACP agents (Gemini, Copilot) only emit `${prefix}:text-delta`, never a
    // complete `${prefix}:text` event, so without this the history would contain
    // no text content — forcing an SSE catchup from the log file instead of the
    // richer in-memory history.
    const textDeltaType = `${this.agentPrefix}:text-delta`;
    if (event.type === textDeltaType) {
      const text = (event as unknown as { text: string }).text ?? '';
      const history = this.transport.getMessageHistory();
      const last = history.at(-1);
      if (last?.type === 'agent:text') {
        // Append to the existing in-progress text entry
        (last as { type: 'agent:text'; text: string }).text += text;
      } else {
        // Start a new text entry
        this.transport.pushToHistory({ type: 'agent:text', text });
      }
      return;
    }

    const historyTypes = new Set([
      `${this.agentPrefix}:text`,
      `${this.agentPrefix}:tool-start`,
      `${this.agentPrefix}:tool-end`,
      `${this.agentPrefix}:turn-complete`,
      `${this.agentPrefix}:turn-error`,
    ]);
    if (!historyTypes.has(event.type)) return;
    const payloads = this.mapJsonToEvents(event as unknown as Record<string, unknown>);
    for (const payload of payloads) {
      if (
        payload.type === 'agent:text' ||
        payload.type === 'agent:tool-start' ||
        payload.type === 'agent:tool-end' ||
        payload.type === 'agent:result'
      ) {
        this.transport.pushToHistory(payload);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // AgentAdapter interface — shared concrete implementations
  // ---------------------------------------------------------------------------

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, this.prepareOpts(opts), null);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.sessionId = sessionRef;
    return this.launch(prompt, this.prepareOpts(opts), sessionRef);
  }

  extractSessionId(_output: string): string | null {
    return this.sessionId;
  }

  async sendMessage(
    message: string,
    attachments?: AttachmentRef[],
    _priority?: import('@/lib/realtime/events').MessagePriority,
  ): Promise<void> {
    if (!this.sessionId) throw new Error(`No active ${this.agentLabel} ACP session`);
    await this.currentTurn;
    this.currentTurn = this.lock.acquire(() => this.sendPrompt(message, attachments));
    await this.currentTurn;
  }

  async interrupt(): Promise<void> {
    // Step 1: Send ACP session/cancel notification
    const conn = this.transport.getConnection();
    if (this.sessionId && conn) {
      conn.cancel({ sessionId: this.sessionId }).catch(() => {
        // Ignore errors — process may already be exiting
      });
    }

    // Step 2: Wait 2s, then SIGINT
    await new Promise<void>((r) => setTimeout(r, 2000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGINT');
      } catch {
        // Process group already dead
      }
    }

    // Step 3: Wait 2s, then SIGTERM (escalation)
    await new Promise<void>((r) => setTimeout(r, 2000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGTERM');
      } catch {
        // Process group already dead
      }
    }

    // Step 4: Wait 5s, then SIGKILL (final escalation)
    await new Promise<void>((r) => setTimeout(r, 5000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGKILL');
      } catch {
        // Process group already dead
      }
    }
  }

  isAlive(): boolean {
    return this.childProcess?.stdin?.writable ?? false;
  }

  async setPermissionMode(mode: string): Promise<boolean> {
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    const acpMode = this.acpModeMap[mode];
    if (!acpMode) return false;
    await conn.setSessionMode({ sessionId: this.sessionId, modeId: acpMode });
    return true;
  }

  async getHistory(
    _sessionRef: string,
    _cwd?: string,
    logFilePath?: string,
  ): Promise<AgendoEventPayload[] | null> {
    // Fast path: in-memory history accumulated by accumulateHistory() during the session.
    const history = this.transport.getMessageHistory();
    if (history.length > 0) return history;

    // Fallback: parse Agendo session log file.
    // Fires after a worker restart when in-memory state is empty but the log
    // file on disk still contains the full conversation history.
    if (!logFilePath || !existsSync(logFilePath)) return null;

    try {
      const logContent = readFileSync(logFilePath, 'utf-8');
      // afterSeq=0: read ALL events from this log file (full history reconstruction).
      const allEvents = readEventsFromLog(logContent, 0);
      // Keep only renderable conversation events; strip ephemeral streaming fragments
      // and low-level system/state events that are not meaningful to replay.
      const renderable = allEvents.filter(
        (e) =>
          e.type === 'agent:text' ||
          e.type === 'agent:tool-start' ||
          e.type === 'agent:tool-end' ||
          e.type === 'agent:result' ||
          e.type === 'user:message' ||
          e.type === 'system:info' ||
          e.type === 'session:init',
      );
      if (renderable.length === 0) return null;
      log.info(
        { logFilePath, eventCount: renderable.length, agentLabel: this.agentLabel },
        'ACP history reconstructed from log file (worker restart fallback)',
      );
      // Return as AgendoEventPayload[] by stripping the id/sessionId/ts envelope fields.
      // worker-sse.ts re-assigns sequential IDs when emitting these as SSE events.
      return renderable.map(
        ({ id: _id, sessionId: _sid, ts: _ts, ...payload }) => payload as AgendoEventPayload,
      );
    } catch (err) {
      log.debug({ err, logFilePath }, 'ACP log file history fallback failed');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared internal methods
  // ---------------------------------------------------------------------------

  /** Create an ACP connection for the given child process via the transport. */
  protected createTransportConnection(cp: ReturnType<typeof BaseAgentAdapter.spawnDetached>): void {
    if (!cp.stdin || !cp.stdout) throw new Error('Child process has no stdio');
    if (!this.clientHandler) throw new Error('clientHandler not initialized');
    this.transport.createConnection(
      cp.stdin as NodeJS.WritableStream,
      cp.stdout as NodeJS.ReadableStream,
      this.clientHandler,
    );
  }

  protected launch(
    prompt: string,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): ManagedProcess {
    this.storedOpts = opts;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];
    this.dataCallbacks = dataCallbacks;
    this.exitCallbacks = exitCallbacks;

    // Set up the client handler (shared across model-switch restarts via this.clientHandler)
    this.activeToolCalls = new Set<string>();
    this.clientHandler = this.createClientHandler();

    const args = this.buildArgs(opts, resumeSessionId);
    const cp = BaseAgentAdapter.spawnDetached(this.binaryName, args, opts);
    this.childProcess = cp;

    // Create ACP connection via transport
    this.createTransportConnection(cp);

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of dataCallbacks) cb(chunk.toString('utf-8'));
    });

    let exitFired = false;
    cp.on('exit', (code) => {
      if (!exitFired && !this.suppressExit()) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(code);
      }
    });

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId).catch((err: Error) => {
      log.error({ err }, 'init failed');
      if (!exitFired) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(0);
      }
      // Kill the entire process group
      if (cp.pid) {
        try {
          process.kill(-cp.pid, 'SIGTERM');
        } catch {
          try {
            cp.kill('SIGTERM');
          } catch {
            /* already dead */
          }
        }
        const pid = cp.pid;
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }, 2000);
      } else {
        cp.kill('SIGKILL');
      }
    });

    return {
      pid: cp.pid ?? null,
      tmuxSession: '',
      stdin: null,
      kill: BaseAgentAdapter.buildKill(() => this.childProcess),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  protected async initAndRun(
    prompt: string,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    try {
      const initResult = await this.transport.initialize();
      this.sessionId = await this.transport.loadOrCreateSession(
        initResult.agentCapabilities,
        { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
        resumeSessionId,
      );
      if (!resumeSessionId && this.sessionId) {
        this.sessionRefCallback?.(this.sessionId);
      }
    } catch (err) {
      const message = extractMessage(err);
      this.emitNdjson({
        type: `${this.agentPrefix}:turn-error`,
        message: `Init failed: ${message}`,
      } as unknown as TEvent);
      throw err;
    }

    if (this.sessionId && opts.model) {
      this.emitNdjson({
        type: `${this.agentPrefix}:init`,
        model: opts.model,
        sessionId: this.sessionId,
      } as unknown as TEvent);
    }

    await this.onAfterInit(opts);
    await this.sendPrompt(prompt, opts.initialAttachments);
  }

  protected async sendPrompt(text: string, attachments?: AttachmentRef[]): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    this.thinkingCallback?.(true);

    try {
      const promptResponse = await this.transport.sendPrompt(
        this.sessionId,
        buildMessageWithAttachments(text, attachments),
        readNativeImageContents(attachments).map(({ attachment, data }) => ({
          data,
          mimeType: attachment.mimeType,
        })),
      );
      this.emitNdjson({
        type: `${this.agentPrefix}:turn-complete`,
        result: promptResponse,
      } as unknown as TEvent);
    } catch (err) {
      const message = extractMessage(err);
      // Don't emit error for process exit — onExit handles that
      if (
        !message.includes(`${this.agentLabel} process exited`) &&
        !message.includes('Connection closed')
      ) {
        this.emitNdjson({ type: `${this.agentPrefix}:turn-error`, message } as unknown as TEvent);
      }
      throw err;
    } finally {
      this.thinkingCallback?.(false);
    }
  }

  /**
   * Emit a synthetic NDJSON line to all dataCallbacks. session-process.ts
   * parses these through the standard NDJSON pipeline and delegates to
   * mapJsonToEvents.
   */
  protected emitNdjson(event: TEvent): void {
    const finalEvent = this.transformEvent(event);
    const line = JSON.stringify(finalEvent) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
    this.accumulateHistory(finalEvent);
  }
}

export { extractMessage };
