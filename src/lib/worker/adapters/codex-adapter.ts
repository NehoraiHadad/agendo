import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import * as tmux from '@/lib/worker/tmux-manager';
import type { AgentAdapter, ManagedProcess, SpawnOpts } from '@/lib/worker/adapters/types';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export class CodexAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private tmuxSessionName = '';
  private requestId = 0;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private buffer = '';

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, false);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.threadId = sessionRef;
    return this.launch(prompt, opts, true);
  }

  extractSessionId(_output: string): string | null {
    return this.threadId;
  }

  sendMessage(message: string): void {
    if (!this.threadId) {
      throw new Error('No active thread. Cannot send message.');
    }
    this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: message }],
    });
  }

  interrupt(): void {
    if (!this.threadId || !this.turnId) return;
    this.sendRequest('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    });
  }

  private launch(prompt: string, opts: SpawnOpts, isResume: boolean): ManagedProcess {
    this.tmuxSessionName = `codex-${opts.executionId}`;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];

    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.childProcess = nodeSpawn('codex', ['app-server'], {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const cp = this.childProcess;

    cp.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.handleJsonRpcMessage(msg, dataCallbacks);
        } catch {
          for (const cb of dataCallbacks) cb(line + '\n');
        }
      }
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of dataCallbacks) cb(text);
    });

    cp.on('exit', (code) => {
      tmux.killSession(this.tmuxSessionName);
      for (const cb of exitCallbacks) cb(code);
    });

    this.initializeAndStart(prompt, opts, isResume);

    return {
      pid: cp.pid ?? 0,
      tmuxSession: this.tmuxSessionName,
      kill: (signal) => this.childProcess?.kill(signal),
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private initializeAndStart(prompt: string, opts: SpawnOpts, isResume: boolean): void {
    this.sendRequest('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'agent-monitor', version: '1.0.0' },
    });
    this.sendNotification('initialized');

    if (isResume && this.threadId) {
      this.sendRequest('thread/resume', { threadId: this.threadId });
    } else {
      this.sendRequest('thread/start', {
        model: 'codex-mini',
        cwd: opts.cwd,
        approvalPolicy: 'auto-edit',
      });
    }

    setTimeout(() => {
      if (this.threadId) {
        this.sendRequest('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: prompt }],
        });
      }
    }, 500);
  }

  private handleJsonRpcMessage(
    msg: Record<string, unknown>,
    dataCallbacks: Array<(chunk: string) => void>,
  ): void {
    if ('id' in msg && 'result' in msg) {
      const result = msg.result as Record<string, unknown>;
      if (result.threadId && typeof result.threadId === 'string') {
        this.threadId = result.threadId;
      }
      if (result.turnId && typeof result.turnId === 'string') {
        this.turnId = result.turnId;
      }
      return;
    }

    if ('method' in msg) {
      const method = msg.method as string;
      const params = (msg.params ?? {}) as Record<string, unknown>;

      switch (method) {
        case 'item/agentMessage/delta': {
          const delta = params.delta as string | undefined;
          if (delta) {
            for (const cb of dataCallbacks) cb(delta);
          }
          break;
        }
        case 'item/commandExecution/outputDelta': {
          const output = params.delta as string | undefined;
          if (output) {
            for (const cb of dataCallbacks) cb(output);
          }
          break;
        }
        case 'turn/completed': {
          this.turnId = null;
          const summary = '[codex] Turn completed\n';
          for (const cb of dataCallbacks) cb(summary);
          break;
        }
        case 'item/commandExecution/requestApproval': {
          const approvalId = params.id as string;
          if (approvalId) {
            this.sendRequest('item/commandExecution/approve', { id: approvalId });
          }
          break;
        }
        default: {
          const text = `[codex:${method}] ${JSON.stringify(params)}\n`;
          for (const cb of dataCallbacks) cb(text);
        }
      }
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>): void {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      params,
    };
    this.writeMessage(request);
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params && { params }),
    };
    this.writeMessage(notification);
  }

  private writeMessage(msg: JsonRpcMessage): void {
    if (!this.childProcess?.stdin?.writable) return;
    this.childProcess.stdin.write(JSON.stringify(msg) + '\n');
  }
}
