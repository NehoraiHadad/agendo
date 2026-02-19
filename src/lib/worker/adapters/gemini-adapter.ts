import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
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
    const rl = createInterface({ input: cp.stdout! });
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

    // Async init chain
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId);

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

  private handleAcpMessage(
    msg: AcpMessage,
    dataCallbacks: Array<(chunk: string) => void>,
  ): void {
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
        if (!this.approvalHandler) {
          // Auto-allow if no handler configured
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: 'selected', optionId: 'proceed_once' },
          });
          return;
        }
        // Async: relay to approval handler
        const approvalId = String(msg.id);
        const params = msg.params ?? {};
        const toolName =
          (params.toolName as string) ?? (params.tool as string) ?? 'unknown';
        const toolInput = (params.input as Record<string, unknown>) ?? {};
        void this.approvalHandler(approvalId, toolName, toolInput).then((decision) => {
          const optionId = decision === 'deny' ? 'decline' : 'proceed_once';
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: 'selected', optionId },
          });
        });
      }
      return;
    }

    // Notification (no id, has method)
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'session/update') {
        const messages =
          (msg.params?.messages as Array<{ role: string; content: string }>) ?? [];
        for (const m of messages) {
          if (m.role === 'assistant' && m.content) {
            for (const cb of dataCallbacks) cb(m.content);
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
    // 1. Handshake
    await this.sendRequest('initialize', { protocolVersion: 1 });

    // 2. Create session or reuse existing
    if (!resumeSessionId) {
      const result = await this.sendRequest<{ sessionId: string }>('newSession', {
        cwd: opts.cwd,
      });
      this.sessionId = result.sessionId;
    }

    // 3. First prompt
    await this.sendPrompt(prompt);
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    this.thinkingCallback?.(true);
    await this.sendRequest('prompt', {
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
