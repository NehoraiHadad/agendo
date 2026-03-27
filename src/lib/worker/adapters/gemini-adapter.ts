import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { homedir } from 'node:os';

import type { AgendoEventPayload } from '@/lib/realtime/events';
import { mapGeminiJsonToEvents, type GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import { extractMessage, GeminiClientHandler } from '@/lib/worker/adapters/gemini-client-handler';
import { AbstractAcpAdapter } from '@/lib/worker/adapters/base-acp-adapter';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';
import type { SpawnOpts, SupportsModelSwitch } from '@/lib/worker/adapters/types';

/** Slash command entry returned from TOML scanning. */
interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/**
 * Extract a simple string field value from a TOML file using regex.
 * Only handles `key = "value"` and `key = 'value'` patterns (single-line).
 */
function extractTomlString(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*["']([^"'\\r\\n]*)["']`, 'm'));
  return match?.[1] ?? '';
}

/**
 * Recursively list all `.toml` files under `dir`, returning their paths.
 * Errors (missing dir, permissions, etc.) are silently ignored.
 */
function listTomlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listTomlFiles(fullPath));
      } else if (entry.isFile() && extname(entry.name) === '.toml') {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or is not readable — skip silently
  }
  return results;
}

/**
 * Scan `~/.gemini/commands/` and `<cwd>/.gemini/commands/` for custom TOML commands.
 * Subdirectories create namespaced commands: `git/commit.toml` → `/git:commit`.
 * Returns an array of slash command descriptors, deduplicated by name (cwd takes priority).
 */
function loadGeminiCustomCommands(cwd: string): SlashCommand[] {
  const globalDir = join(homedir(), '.gemini', 'commands');
  const localDir = join(cwd, '.gemini', 'commands');

  const commandsMap = new Map<string, SlashCommand>();

  for (const dir of [globalDir, localDir]) {
    const tomlFiles = listTomlFiles(dir);
    for (const filePath of tomlFiles) {
      try {
        const relPath = relative(dir, filePath);
        const parts = relPath.split('/');
        const stemName = basename(parts[parts.length - 1], '.toml');
        const namespace = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
        const commandName = namespace ? `/${namespace}:${stemName}` : `/${stemName}`;

        const content = readFileSync(filePath, 'utf-8');
        const description = extractTomlString(content, 'description');
        const prompt = extractTomlString(content, 'prompt');
        const argumentHint = prompt ? '<text>' : '';

        commandsMap.set(commandName, { name: commandName, description, argumentHint });
      } catch {
        // Malformed or unreadable file — skip silently
      }
    }
  }

  return Array.from(commandsMap.values());
}

export class GeminiAdapter extends AbstractAcpAdapter<GeminiEvent> implements SupportsModelSwitch {
  /** When true, suppresses exit callbacks during model-switch process restart. */
  private modelSwitching = false;
  /** Cached custom TOML commands for ACP-command merging. */
  private customTomlCommands: SlashCommand[] = [];

  protected get binaryName(): string {
    return 'gemini';
  }
  protected get agentLabel(): string {
    return 'Gemini';
  }
  protected get agentPrefix(): string {
    return 'gemini';
  }
  protected get acpModeMap(): Record<string, string> {
    return {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
  }

  protected buildArgs(opts: SpawnOpts, _resumeSessionId: string | null): string[] {
    const args = ['--experimental-acp'];
    if (opts.model) {
      args.push('-m', opts.model);
    }
    const permMode = opts.permissionMode;
    if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
      args.push('--approval-mode', 'yolo');
    } else if (permMode === 'acceptEdits') {
      args.push('--approval-mode', 'auto_edit');
    } else if (permMode === 'plan') {
      args.push('--approval-mode', 'plan');
    }
    const injectedNames = (opts.mcpServers ?? []).map((s) => s.name);
    if (injectedNames.length > 0) {
      args.push('--allowed-mcp-server-names', ...injectedNames);
    } else {
      args.push('--allowed-mcp-server-names', '__none__');
    }
    if (opts.policyFiles?.length) {
      args.push('--policy', ...opts.policyFiles);
    }
    args.push(...(opts.extraArgs ?? []));
    return args;
  }

  protected createClientHandler(): GeminiClientHandler {
    return new GeminiClientHandler(
      {
        agentPrefix: 'gemini',
        supportsTerminal: true,
        supportsCommands: true,
        supportsSessionInfo: true,
        supportsUsageCost: true,
      },
      (event) => this.emitNdjson(event as GeminiEvent),
      () => this.approvalHandler,
      this.activeToolCalls,
    );
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapGeminiJsonToEvents(parsed as GeminiEvent);
  }

  protected suppressExit(): boolean {
    return this.modelSwitching;
  }

  protected async onAfterInit(opts: SpawnOpts): Promise<void> {
    // Load custom TOML commands and emit them (merged with any future ACP commands)
    this.customTomlCommands = loadGeminiCustomCommands(opts.cwd);
    if (this.customTomlCommands.length > 0) {
      this.emitNdjson({ type: 'gemini:commands', commands: this.customTomlCommands });
    }
  }

  protected transformEvent(event: GeminiEvent): GeminiEvent {
    if (event.type === 'gemini:commands' && this.customTomlCommands.length > 0) {
      // Merge: start with TOML commands, overwrite with ACP commands (ACP takes priority)
      const merged = new Map<string, SlashCommand>();
      for (const cmd of this.customTomlCommands) {
        merged.set(cmd.name, cmd);
      }
      for (const cmd of (event as { type: string; commands: SlashCommand[] }).commands) {
        merged.set(cmd.name, cmd);
      }
      return { type: 'gemini:commands', commands: Array.from(merged.values()) };
    }
    return event;
  }

  async setModel(model: string): Promise<boolean> {
    if (!this.storedOpts || !this.sessionId) return false;

    // Try in-place ACP model switch first (available since Gemini CLI v0.33.0, PR #20991)
    const conn = this.transport.getConnection();
    if (conn) {
      try {
        await (
          conn as unknown as {
            unstable_setSessionModel: (params: {
              sessionId: string;
              modelId: string;
            }) => Promise<void>;
          }
        ).unstable_setSessionModel({ sessionId: this.sessionId, modelId: model });
        this.storedOpts = { ...this.storedOpts, model };
        return true;
      } catch {
        // ACP set_model not supported on this Gemini CLI version — fall back to process restart
      }
    }

    this.modelSwitching = true;
    this.storedOpts = { ...this.storedOpts, model };

    // Kill the old process group and wait for it to exit
    const oldCp = this.childProcess;
    if (oldCp?.pid) {
      const exitPromise = new Promise<void>((resolve) => {
        oldCp.once('exit', () => resolve());
      });
      try {
        process.kill(-oldCp.pid, 'SIGTERM');
      } catch {
        // Already dead
      }
      await exitPromise;
    }

    // Spawn new process with updated model
    const opts = this.storedOpts;
    const geminiArgs = this.buildArgs(opts, null);
    const cp = BaseAgentAdapter.spawnDetached('gemini', geminiArgs, opts);
    this.childProcess = cp;

    // Wire stderr → same dataCallbacks
    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of this.dataCallbacks) cb(chunk.toString('utf-8'));
    });

    // Wire exit → same exitCallbacks (respecting modelSwitching flag, at-most-once guard)
    let exitFired = false;
    cp.on('exit', (code) => {
      if (!exitFired && !this.modelSwitching) {
        exitFired = true;
        for (const cb of this.exitCallbacks) cb(code);
      }
    });

    // Create new ACP connection for the new process
    this.createTransportConnection(cp);

    // Re-initialize ACP and reload session
    try {
      const initResult = await this.transport.initialize();
      this.sessionId = await this.transport.loadOrCreateSession(
        initResult.agentCapabilities,
        { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
        this.sessionId,
      );
    } catch (err) {
      this.modelSwitching = false;
      const message = extractMessage(err);
      this.emitNdjson({ type: 'gemini:turn-error', message: `Model switch failed: ${message}` });
      return false;
    }

    this.modelSwitching = false;
    return true;
  }
}
