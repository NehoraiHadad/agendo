import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAdapter, ApprovalHandler, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

export class CodexAdapter implements AgentAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private threadId: string | null = null;
  private storedOpts: SpawnOpts | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private turnAbortController: AbortController | null = new AbortController();
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ApprovalHandler | null = null;

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

  private launch(prompt: string, opts: SpawnOpts, resumeThreadId: string | null): ManagedProcess {
    // Fresh AbortController for this launch
    this.turnAbortController = new AbortController();

    const dataCallbacks: Array<(chunk: string) => void> = [];
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

    // Stream output via MCP logging notifications
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      const text =
        typeof n.params.data === 'string' ? n.params.data : JSON.stringify(n.params.data);
      for (const cb of dataCallbacks) cb(text + '\n');
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

    // Async init chain — errors propagate via currentTurn rejection
    this.currentTurn = this.connectAndFirstTurn(
      client,
      transport,
      prompt,
      resumeThreadId,
      opts,
    );

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
      onData: (cb) => dataCallbacks.push(cb),
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

    const result = await this.client!.callTool(
      { name: tool, arguments: args },
      undefined,
      {
        timeout: opts.timeoutSec * 1000,
        resetTimeoutOnProgress: true,
        signal: this.turnAbortController?.signal,
      },
    );

    this.thinkingCallback?.(false);

    // Extract threadId from first-turn response content
    if (!this.threadId) {
      const content = result.content as Array<{ type: string; text?: string }>;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          try {
            const parsed = JSON.parse(block.text) as { threadId?: string };
            if (parsed.threadId) this.threadId = parsed.threadId;
          } catch {
            // Not JSON — that's fine
          }
        }
      }
    }
  }

  private async runTurn(message: string): Promise<void> {
    if (!this.client || !this.threadId) {
      throw new Error('No active Codex MCP session');
    }
    await this.runTurnWith('codex-reply', this.threadId, message, this.storedOpts!);
  }
}
