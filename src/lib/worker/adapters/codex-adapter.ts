import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  LoggingMessageNotificationSchema,
  ElicitRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentAdapter,
  ApprovalHandler,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';

export class CodexAdapter implements AgentAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private threadId: string | null = null;
  private storedOpts: SpawnOpts | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private turnAbortController: AbortController | null = new AbortController();
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private sessionRefCallback: ((ref: string) => void) | null = null;
  private dataCallbacks: Array<(chunk: string) => void> = [];

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    this.storedOpts = opts;
    return this.launch(prompt, opts, null);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.threadId = sessionRef;
    this.storedOpts = opts;
    return this.launch(prompt, opts, sessionRef);
  }

  extractSessionId(_output: string): string | null {
    return this.threadId;
  }

  async sendMessage(message: string): Promise<void> {
    await this.currentTurn;
    this.currentTurn = this.runTurn(message);
    await this.currentTurn;
  }

  async interrupt(): Promise<void> {
    this.turnAbortController?.abort();
    this.turnAbortController = new AbortController();
    // Give it 3s to cleanly abort before closing client
    await new Promise<void>((r) => setTimeout(r, 3000));
    if (this.client) {
      void this.client.close();
    }
  }

  isAlive(): boolean {
    return false;
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

  private launch(prompt: string, opts: SpawnOpts, resumeThreadId: string | null): ManagedProcess {
    // Fresh AbortController for this launch
    this.turnAbortController = new AbortController();

    this.dataCallbacks = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    const transport = new StdioClientTransport({
      command: 'codex',
      args: ['mcp-server', ...(opts.extraArgs ?? [])],
      env: opts.env,
    });
    this.transport = transport;

    const client = new Client(
      { name: 'agendo', version: '1.0.0' },
      { capabilities: { elicitation: {} } },
    );
    this.client = client;

    // Stream output via MCP logging notifications (debug/streaming output from Codex)
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const text =
        typeof n.params.data === 'string' ? n.params.data : JSON.stringify(n.params.data);
      for (const cb of this.dataCallbacks) cb(text + '\n');
    });

    // Relay elicitation (permission) requests to the approval handler
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (!this.approvalHandler) {
        return { action: 'accept' as const, content: {} };
      }
      const approvalId = Math.random().toString(36).slice(2, 15);
      const params = request.params as Record<string, unknown>;
      const toolName = (params.message as string) ?? 'unknown';
      const toolInput = (params.requestedSchema as Record<string, unknown>) ?? {};
      const decision = await this.approvalHandler(approvalId, toolName, toolInput);
      if (decision === 'deny') {
        return { action: 'cancel' as const };
      }
      return { action: 'accept' as const, content: {} };
    });

    transport.onclose = () => {
      for (const cb of exitCallbacks) cb(0);
    };

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    // On failure, fire exitCallbacks(1) so session-process transitions to 'ended'.
    this.currentTurn = this.connectAndFirstTurn(
      client,
      transport,
      prompt,
      resumeThreadId,
      opts,
    ).catch((err: Error) => {
      console.error('[CodexAdapter] init failed:', err.message);
      for (const cb of exitCallbacks) cb(1);
      void client.close();
    });

    return {
      pid: 0, // transport.pid available after connect() resolves
      tmuxSession: '',
      stdin: null,
      kill: (signal) => {
        if (signal === 'SIGKILL' && this.transport?.pid) {
          try {
            process.kill(-this.transport.pid, 'SIGKILL');
          } catch {
            // Process group already dead
          }
        } else {
          void client.close();
        }
      },
      onData: (cb) => this.dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private async connectAndFirstTurn(
    client: Client,
    transport: StdioClientTransport,
    prompt: string,
    resumeThreadId: string | null,
    opts: SpawnOpts,
  ): Promise<void> {
    await client.connect(transport);
    const toolName = resumeThreadId ? 'codex-reply' : 'codex';
    await this.runTurnWith(toolName, resumeThreadId, prompt, opts);
  }

  private async runTurnWith(
    tool: 'codex' | 'codex-reply',
    threadId: string | null,
    prompt: string,
    opts: SpawnOpts,
  ): Promise<void> {
    this.thinkingCallback?.(true);

    const args: Record<string, string> = { prompt };
    if (threadId) {
      args.threadId = threadId;
    } else {
      args.cwd = opts.cwd;
    }

    if (!this.client) throw new Error('No active MCP client');
    const result = await this.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: opts.timeoutSec * 1000,
      resetTimeoutOnProgress: true,
      signal: this.turnAbortController?.signal,
    });

    this.thinkingCallback?.(false);

    // Emit the full response text to dataCallbacks so session-process can display it.
    // Also scan for a JSON-encoded threadId on the first turn.
    const content = result.content as Array<{ type: string; text?: string }>;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        // Try to extract threadId (Codex embeds it as JSON on first turn)
        if (!this.threadId) {
          try {
            const parsed = JSON.parse(block.text) as { threadId?: string; response?: string };
            if (parsed.threadId) {
              this.threadId = parsed.threadId;
              this.sessionRefCallback?.(this.threadId);
            }
            // If the JSON has a separate response field, emit that; otherwise emit the raw text
            const displayText = parsed.response ?? block.text;
            for (const cb of this.dataCallbacks) cb(displayText + '\n');
          } catch {
            // Plain text response — emit as-is
            for (const cb of this.dataCallbacks) cb(block.text + '\n');
          }
        } else {
          for (const cb of this.dataCallbacks) cb(block.text + '\n');
        }
      }
    }
  }

  private async runTurn(message: string): Promise<void> {
    if (!this.client || !this.threadId) {
      throw new Error('No active Codex MCP session');
    }
    if (!this.storedOpts) throw new Error('No stored opts for Codex session');
    await this.runTurnWith('codex-reply', this.threadId, message, this.storedOpts);
  }
}
