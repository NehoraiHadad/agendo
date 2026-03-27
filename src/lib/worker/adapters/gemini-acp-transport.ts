import { Readable, Writable } from 'node:stream';
import { createLogger } from '@/lib/logger';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type Client,
} from '@agentclientprotocol/sdk';
import type { AcpMcpServer } from '@/lib/worker/adapters/types';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { extractMessage } from '@/lib/utils/error-utils';

const log = createLogger('acp-transport');

/** Timeout for session/prompt ACP requests (10 minutes). */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;
const INIT_TIMEOUT_MS = 30_000;

/** Session creation options passed to loadOrCreateSession. */
export interface SessionOpts {
  cwd: string;
  mcpServers: AcpMcpServer[];
}

/**
 * Encapsulates the ACP connection lifecycle:
 *  - createConnection() — wraps stdin/stdout in a ClientSideConnection
 *  - initialize()       — ACP handshake with 429 retry
 *  - loadOrCreateSession() — 3-path fallback (resume → load → new)
 *  - sendPrompt()       — text + optional image with timeout
 */
export class AcpTransport {
  private connection: ClientSideConnection | null = null;

  /** In-memory accumulator for structural conversation events.
   *  Populated via pushToHistory() from the client handlers.
   *  Used by getHistory() on GeminiAdapter and CopilotAdapter as a
   *  fallback when the Agendo log file is missing or empty. */
  private messageHistory: AgendoEventPayload[] = [];

  /** Append a structural event to the history buffer.
   *  Call for user:message, agent:text, agent:tool-start, agent:tool-end, agent:result.
   *  Do NOT call for agent:text-delta (high-volume streaming) or agent:thinking. */
  pushToHistory(event: AgendoEventPayload): void {
    this.messageHistory.push(event);
  }

  /** Return a shallow copy of all accumulated history events. */
  getMessageHistory(): AgendoEventPayload[] {
    return [...this.messageHistory];
  }

  /** Clear the in-memory history buffer (e.g. on session end or restart). */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /** Create an ACP ClientSideConnection for the given child process stdio. */
  createConnection(
    stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream,
    clientHandler: Client,
  ): ClientSideConnection {
    const stream = ndJsonStream(
      Writable.toWeb(stdin as Writable) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout as Readable) as ReadableStream<Uint8Array>,
    );
    this.connection = new ClientSideConnection((_agent) => clientHandler, stream);
    return this.connection;
  }

  /** Get the current connection (or null if not yet created). */
  getConnection(): ClientSideConnection | null {
    return this.connection;
  }

  /** Replace the internal connection (used during model-switch restart). */
  setConnection(conn: ClientSideConnection): void {
    this.connection = conn;
  }

  /**
   * Send ACP initialize with retry on 429.
   * Timeout: 30s per attempt, max 3 attempts.
   */
  async initialize(attempt = 1): Promise<Awaited<ReturnType<ClientSideConnection['initialize']>>> {
    if (!this.connection) throw new Error('No ACP connection');
    const timeoutMs = INIT_TIMEOUT_MS;
    try {
      return await Promise.race([
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'agendo', version: '1.0.0' },
          clientCapabilities: {
            terminal: true,
            fs: { readTextFile: true, writeTextFile: true },
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`ACP initialize timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      const message = extractMessage(err);
      const isRetryable =
        (message.includes('429') || message.includes('Rate limit exceeded')) && attempt < 3;
      if (isRetryable) {
        const delay = Math.pow(2, attempt) * 2000; // 4s, 8s
        log.warn({ attempt, delay }, 'initialize failed with 429, retrying');
        await new Promise((r) => setTimeout(r, delay));
        return this.initialize(attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Resume or load an existing session, or create a new one.
   *
   * Resolution order for cold-resume:
   *   1. session/resume (unstable) — no history replay, fastest path
   *   2. session/load              — replays full conversation history
   *   3. session/new               — fallback when no prior session exists
   *
   * Returns the session ID.
   */
  async loadOrCreateSession(
    agentCaps: AgentCapabilities | undefined,
    opts: SessionOpts,
    resumeSessionId: string | null,
  ): Promise<string> {
    if (!this.connection) throw new Error('No ACP connection');

    type McpServersParam = Parameters<ClientSideConnection['newSession']>[0]['mcpServers'];
    const mcpServers = (opts.mcpServers ?? []) as McpServersParam;

    if (resumeSessionId) {
      // --- Path 1: session/resume (unstable) ---
      if (agentCaps?.sessionCapabilities?.resume) {
        try {
          await this.connection.unstable_resumeSession({
            sessionId: resumeSessionId,
            cwd: opts.cwd,
            mcpServers: mcpServers as Parameters<
              ClientSideConnection['unstable_resumeSession']
            >[0]['mcpServers'],
          });
          log.info({ resumeSessionId }, 'session/resume succeeded');
          return resumeSessionId;
        } catch (resumeErr) {
          log.warn(
            { err: extractMessage(resumeErr) },
            'session/resume failed, trying session/load',
          );
        }
      }

      // --- Path 2: session/load ---
      if (agentCaps?.loadSession) {
        try {
          await this.connection.loadSession({
            sessionId: resumeSessionId,
            cwd: opts.cwd,
            mcpServers: mcpServers as Parameters<
              ClientSideConnection['loadSession']
            >[0]['mcpServers'],
          });
          log.info({ resumeSessionId }, 'session/load succeeded');
          return resumeSessionId;
        } catch (loadErr) {
          log.warn(
            { err: extractMessage(loadErr) },
            'session/load failed, falling back to session/new',
          );
        }
      }
    }

    // --- Path 3: session/new ---
    const result = await this.connection.newSession({
      cwd: opts.cwd,
      mcpServers,
    });
    return result.sessionId;
  }

  /**
   * Fork an existing session into a new independent session (UNSTABLE).
   * Requires agent to support `sessionCapabilities.fork`.
   * Returns the new forked session ID.
   */
  async forkSession(sessionId: string): Promise<string> {
    if (!this.connection) throw new Error('No ACP connection');
    const conn = this.connection as unknown as {
      unstable_forkSession: (params: { sessionId: string }) => Promise<{ sessionId: string }>;
    };
    const result = await conn.unstable_forkSession({ sessionId });
    return result.sessionId;
  }

  /**
   * Send a prompt (text + optional image) to the active session.
   * Times out after 10 minutes.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<Record<string, unknown>> {
    if (!this.connection) throw new Error('No ACP connection');

    const promptContent: Parameters<ClientSideConnection['prompt']>[0]['prompt'] = [
      { type: 'text', text },
    ];
    for (const image of images ?? []) {
      promptContent.push({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      } as (typeof promptContent)[number]);
    }

    const conn = this.connection;
    const timeoutMs = PROMPT_TIMEOUT_MS;
    const promptResponse = await Promise.race([
      conn.prompt({ sessionId, prompt: promptContent }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ACP session/prompt timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return (promptResponse as Record<string, unknown>) ?? {};
  }
}

/** @deprecated Use AcpTransport instead. */
export { AcpTransport as GeminiAcpTransport };

export { extractMessage };
