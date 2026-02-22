import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type {
  AgentAdapter,
  ManagedProcess,
  SpawnOpts,
  ImageContent,
  ApprovalHandler,
  PermissionDecision,
} from '@/lib/worker/adapters/types';
import { AsyncLock } from '@/lib/utils/async-lock';

export class ClaudeAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';
  private sessionId: string | null = null;
  private lock = new AsyncLock();
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private hasEmittedThinking = false;
  private approvalHandler: ApprovalHandler | null = null;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, []);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, ['--resume', sessionRef]);
  }

  extractSessionId(output: string): string | null {
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          return parsed.session_id;
        }
      } catch {
        // Not valid JSON
      }
    }
    return null;
  }

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  // Claude Code built-in slash commands that must be written as raw text to stdin
  // so the readline layer intercepts them as CLI commands (not NDJSON user messages).
  // Source: `claude --help` and Claude Code docs.
  private static readonly KNOWN_SLASH_COMMANDS = new Set([
    'compact',
    'clear',
    'cost',
    'memory',
    'mcp',
    'permissions',
    'status',
    'doctor',
    'model',
    'review',
    'init',
    'bug',
    'help',
    'vim',
    'terminal',
    'login',
    'logout',
    'release-notes',
    'pr_comments',
    'exit',
  ]);

  async sendMessage(message: string, image?: ImageContent): Promise<void> {
    return this.lock.acquire(async () => {
      if (!this.childProcess?.stdin?.writable) {
        throw new Error('Claude process stdin is not writable');
      }

      // Reset thinking state so the next data chunk triggers thinking=true
      this.hasEmittedThinking = false;

      // Slash commands: only route KNOWN Claude Code commands as raw readline text.
      // Unknown /something is sent as a regular NDJSON message so Claude treats it as text.
      if (!image && message?.startsWith('/')) {
        const cmd = message.trim().split(/\s+/)[0].slice(1); // e.g. "clear" from "/clear foo"
        if (ClaudeAdapter.KNOWN_SLASH_COMMANDS.has(cmd)) {
          this.childProcess.stdin.write(message.trim() + '\n');
          return;
        }
      }

      // Regular messages and image attachments use the NDJSON stream-json protocol.
      const content: unknown[] = [];
      if (message.trim()) {
        content.push({ type: 'text', text: message });
      }
      if (image) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType, data: image.data },
        });
      }
      const ndjsonMessage = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: content.length === 1 && !image ? message : content,
        },
        session_id: this.sessionId ?? 'default',
        parent_tool_use_id: null,
      });
      this.childProcess.stdin.write(ndjsonMessage + '\n');
    });
  }

  async interrupt(): Promise<void> {
    const stdin = this.childProcess?.stdin;
    if (stdin?.writable) {
      const requestId = Math.random().toString(36).slice(2, 15);
      stdin.write(
        JSON.stringify({
          request_id: requestId,
          type: 'control_request',
          request: { subtype: 'interrupt' },
        }) + '\n',
      );

      const acked = await Promise.race([
        this.waitForResult(),
        new Promise<false>((r) => setTimeout(() => r(false), 3000)),
      ]);

      if (acked) return;
    }

    if (this.childProcess?.pid) {
      let sent = false;
      try {
        process.kill(-this.childProcess.pid, 'SIGTERM');
        sent = true;
      } catch {
        /* dead */
      }
      // Only wait for the process to die if SIGTERM was actually delivered.
      if (sent) {
        await new Promise<void>((r) => setTimeout(r, 3000));
      }
    }
  }

  isAlive(): boolean {
    return this.childProcess?.stdin?.writable ?? false;
  }

  private waitForResult(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        this.childProcess?.stdout?.off('data', onData);
        resolve(result);
      };
      const onData = (chunk: string) => {
        for (const line of chunk.split('\n')) {
          try {
            const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
            if (parsed.type === 'result') finish(true);
          } catch {
            /* skip */
          }
        }
      };
      this.childProcess?.stdout?.on('data', onData);
      // Resolve false on exit so interrupt() knows the process died rather than
      // gracefully acking the interrupt (prevents "stdin not writable" ghost sessions).
      this.childProcess?.once('exit', () => finish(false));
    });
  }

  private async handleToolApprovalRequest(msg: Record<string, unknown>): Promise<void> {
    const requestId = msg.request_id as string;
    const req = msg.request as Record<string, unknown>;
    const toolName = req.tool_name as string;
    const toolInput = (req.input as Record<string, unknown>) ?? {};

    let decision: PermissionDecision = 'allow';
    if (this.approvalHandler) {
      decision = await this.approvalHandler(requestId, toolName, toolInput);
    }

    const outcome = decision === 'deny' ? 'deny' : 'allow';
    const stdin = this.childProcess?.stdin;
    if (stdin?.writable) {
      stdin.write(
        JSON.stringify({
          request_id: requestId,
          type: 'control_response',
          response: { subtype: outcome },
        }) + '\n',
      );
    }
  }

  private launch(prompt: string, opts: SpawnOpts, extraFlags: string[]): ManagedProcess {
    this.tmuxSessionName = `claude-${opts.executionId}`;
    this.sessionId = null;
    this.hasEmittedThinking = false;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    const claudeArgs = [
      // -p (print mode) exits after one response; omit it for persistent sessions
      // so the process stays alive and can receive follow-up messages via stdin.
      ...(opts.persistentSession ? [] : ['-p']),
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? 'default',
      ...extraFlags,
      ...(opts.extraArgs ?? []),
    ];

    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.childProcess = nodeSpawn('claude', claudeArgs, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    const cp = this.childProcess;
    cp.unref();

    const initialMessage = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: 'default',
      parent_tool_use_id: null,
    });
    cp.stdin?.write(initialMessage + '\n');

    cp.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');

      // Emit thinking=true on first data byte after a turn starts
      if (!this.hasEmittedThinking) {
        this.hasEmittedThinking = true;
        this.thinkingCallback?.(true);
      }

      if (!this.sessionId) {
        this.sessionId = this.extractSessionId(text);
      }

      // Scan each line for result (thinking=false) and tool approval requests
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;

          if (msg.type === 'result') {
            this.thinkingCallback?.(false);
            this.hasEmittedThinking = false; // reset for next turn
          }

          if (
            msg.type === 'control_request' &&
            (msg.request as Record<string, unknown>)?.subtype === 'can_use_tool'
          ) {
            void this.handleToolApprovalRequest(msg);
          }
        } catch {
          /* skip non-JSON lines */
        }
      }

      for (const cb of dataCallbacks) cb(text);
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    cp.on('exit', (code) => {
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    return {
      pid: cp.pid ?? 0,
      tmuxSession: this.tmuxSessionName,
      stdin: cp.stdin,
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
}
