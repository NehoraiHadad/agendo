import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AsyncLock } from '@/lib/utils/async-lock';
import type {
  AgentAdapter,
  ApprovalHandler,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface AcpMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class GeminiAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private sessionId: string | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private lock = new AsyncLock();
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private sessionRefCallback: ((ref: string) => void) | null = null;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, null);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.sessionId = sessionRef;
    return this.launch(prompt, opts, sessionRef);
  }

  extractSessionId(_output: string): string | null {
    return this.sessionId;
  }

  async sendMessage(message: string, _image?: ImageContent): Promise<void> {
    if (!this.sessionId) throw new Error('No active Gemini ACP session');
    await this.currentTurn;
    this.currentTurn = this.lock.acquire(() => this.sendPrompt(message));
    await this.currentTurn;
  }

  async interrupt(): Promise<void> {
    for (const [id] of this.pendingRequests) {
      this.writeJson({ jsonrpc: '2.0', method: 'cancelRequest', params: { id } });
    }
    await new Promise<void>((r) => setTimeout(r, 2000));
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGINT');
      } catch {
        // Process group already dead
      }
    }
  }

  isAlive(): boolean {
    return this.childProcess?.stdin?.writable ?? false;
  }

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  onSessionRef(cb: (ref: string) => void): void {
    this.sessionRefCallback = cb;
  }

  private launch(prompt: string, opts: SpawnOpts, resumeSessionId: string | null): ManagedProcess {
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    const cp = nodeSpawn('gemini', ['--experimental-acp', ...(opts.extraArgs ?? [])], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    this.childProcess = cp;
    cp.unref();

    // Parse ndJSON from stdout line by line
    const rl = createInterface({ input: cp.stdout ?? process.stdin });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      try {
        const msg = JSON.parse(trimmed) as AcpMessage;
        this.handleAcpMessage(msg, dataCallbacks);
      } catch {
        // Skip non-JSON lines (Gemini debug output)
      }
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of dataCallbacks) cb(chunk.toString('utf-8'));
    });

    cp.on('exit', (code) => {
      // Reject all pending requests so awaiting callers unblock
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Gemini process exited'));
      }
      this.pendingRequests.clear();
      for (const cb of exitCallbacks) cb(code);
    });

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    // On failure, fire exitCallbacks(1) so session-process transitions to 'ended'.
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId).catch((err: Error) => {
      console.error('[GeminiAdapter] init failed:', err.message);
      for (const cb of exitCallbacks) cb(1);
      cp.kill();
    });

    return {
      pid: cp.pid ?? 0,
      tmuxSession: '',
      stdin: null,
      kill: (signal) => {
        const p = this.childProcess;
        if (!p?.pid) return;
        try {
          process.kill(-p.pid, signal);
        } catch {
          // Process group already dead
        }
      },
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private handleAcpMessage(msg: AcpMessage, dataCallbacks: Array<(chunk: string) => void>): void {
    // Response to one of our requests (has id + result or error, no method)
    if (msg.id !== undefined && !msg.method && ('result' in msg || 'error' in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server request (has id + method → needs a response)
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'session/request_permission') {
        // ACP v0.20 schema: params = { sessionId, toolCall, options: [{ kind, name, optionId }] }
        // "allow_once" kind → first option with kind=allow_once, "reject_once" → reject
        const params = msg.params ?? {};
        const toolCall = params.toolCall as Record<string, unknown> | undefined;
        const options =
          (params.options as Array<{ kind: string; optionId: string; name: string }>) ?? [];

        const toolName = (toolCall?.title as string | undefined) ?? 'unknown';
        const toolInput = (toolCall?.rawInput as Record<string, unknown>) ?? {};

        if (!this.approvalHandler) {
          // Auto-allow: pick the first allow_once option
          const allowOption = options.find((o) => o.kind === 'allow_once') ?? options[0];
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: 'selected', optionId: allowOption?.optionId ?? 'allow_once' },
          });
          return;
        }

        const approvalId = String(msg.id);
        void this.approvalHandler(approvalId, toolName, toolInput).then((decision) => {
          const chosenOption =
            decision === 'deny'
              ? (options.find((o) => o.kind === 'reject_once') ?? options[options.length - 1])
              : (options.find((o) => o.kind === 'allow_once') ?? options[0]);
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: 'selected', optionId: chosenOption?.optionId ?? 'allow_once' },
          });
        });
      }
      // Handle fs/read_text_file and fs/write_text_file client requests from Gemini
      else if (msg.method === 'fs/read_text_file') {
        const {
          path: filePath,
          line,
          limit,
        } = msg.params as { path: string; line?: number; limit?: number };
        try {
          let content = readFileSync(filePath, 'utf-8');
          if (line !== undefined && line !== null) {
            const lines = content.split('\n');
            const start = Math.max(0, line - 1);
            const end = limit ? start + limit : lines.length;
            content = lines.slice(start, end).join('\n');
          }
          this.writeJson({ jsonrpc: '2.0', id: msg.id, result: { content } });
        } catch {
          this.writeJson({ jsonrpc: '2.0', id: msg.id, result: { content: '' } });
        }
      } else if (msg.method === 'fs/write_text_file') {
        const { path: filePath, content } = msg.params as { path: string; content: string };
        try {
          writeFileSync(filePath, content, 'utf-8');
        } catch {
          /* ignore write errors */
        }
        this.writeJson({ jsonrpc: '2.0', id: msg.id, result: null });
      }
      return;
    }

    // Notification (no id, has method)
    // ACP v0.20: session/update params = { sessionId, update: { sessionUpdate, content, ... } }
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'session/update') {
        const update = msg.params?.update as Record<string, unknown> | undefined;
        const sessionUpdate = update?.sessionUpdate as string | undefined;
        if (sessionUpdate === 'agent_message_chunk') {
          const content = update?.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            for (const cb of dataCallbacks) cb(content.text);
          }
        } else if (sessionUpdate === 'agent_thought_chunk') {
          // Thinking output — emit as-is so session-process can display it
          const content = update?.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            for (const cb of dataCallbacks) cb(content.text);
          }
        }
      }
    }
  }

  private async initAndRun(
    prompt: string,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    // 1. Handshake — ACP v0.20+ requires clientCapabilities.fs
    await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    // 2. Create session or reuse existing
    // Note: ACP v0.20 renamed newSession → session/new and requires mcpServers:[].
    // loadSession (resume) is only supported when agentCapabilities.loadSession=true.
    if (!resumeSessionId) {
      const result = await this.sendRequest<{ sessionId: string }>('session/new', {
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
      });
      this.sessionId = result.sessionId;
      this.sessionRefCallback?.(this.sessionId);
    }

    // 3. First prompt
    await this.sendPrompt(prompt);
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    this.thinkingCallback?.(true);
    // ACP v0.20 renamed prompt → session/prompt
    await this.sendRequest('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
    this.thinkingCallback?.(false);
  }

  private sendRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.writeJson({ jsonrpc: '2.0', id, method, params });
    });
  }

  private writeJson(msg: Record<string, unknown>): void {
    if (!this.childProcess?.stdin?.writable) return;
    this.childProcess.stdin.write(JSON.stringify(msg) + '\n');
  }
}
