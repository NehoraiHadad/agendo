import { createLogger } from '@/lib/logger';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import {
  mapOpenCodeJsonToEvents,
  type OpenCodeEvent,
} from '@/lib/worker/adapters/opencode-event-mapper';
import { OpenCodeClientHandler } from '@/lib/worker/adapters/opencode-client-handler';
import { AbstractAcpAdapter } from '@/lib/worker/adapters/base-acp-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

const log = createLogger('opencode-adapter');

/**
 * Build the OPENCODE_CONFIG_CONTENT env var value for permission and MCP configuration.
 *
 * OpenCode reads config from the OPENCODE_CONFIG_CONTENT environment variable before
 * any ACP handshake. This is the primary mechanism for:
 *  - Permission bypass (bypassPermissions / dontAsk / acceptEdits)
 *  - MCP server pre-configuration as defense-in-depth fallback
 *
 * Note: OpenCode has NO --yolo or --approval-mode CLI flag — config injection is required.
 */
function buildOpenCodeConfig(opts: SpawnOpts): Record<string, string> {
  const config: Record<string, unknown> = {};

  // Permission configuration
  if (opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'dontAsk') {
    config.permission = {
      bash: 'allow',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      task: 'allow',
      todowrite: 'allow',
      todoread: 'allow',
    };
  } else if (opts.permissionMode === 'acceptEdits') {
    config.permission = {
      bash: 'ask',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
    };
  }

  // MCP server pre-configuration as defense-in-depth fallback
  if (opts.mcpServers?.length) {
    config.mcp = {};
    for (const srv of opts.mcpServers) {
      (config.mcp as Record<string, unknown>)[srv.name] = {
        type: 'local',
        command: [srv.command, ...srv.args],
        environment: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
      };
    }
  }

  if (Object.keys(config).length === 0) return {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

export class OpenCodeAdapter extends AbstractAcpAdapter<OpenCodeEvent> {
  protected get binaryName(): string {
    return 'opencode';
  }
  protected get agentLabel(): string {
    return 'OpenCode';
  }
  protected get agentPrefix(): string {
    return 'opencode';
  }
  protected get acpModeMap(): Record<string, string> {
    return {
      default: 'general',
      plan: 'plan',
    };
  }

  protected prepareOpts(opts: SpawnOpts): SpawnOpts {
    const openCodeEnv = buildOpenCodeConfig(opts);
    return {
      ...opts,
      env: { ...opts.env, ...openCodeEnv },
    };
  }

  protected buildArgs(opts: SpawnOpts, resumeSessionId: string | null): string[] {
    // 'acp' is a SUBCOMMAND, not a flag
    const args = ['acp'];

    // OpenCode requires --cwd as an explicit flag (not just process cwd)
    if (opts.cwd) {
      args.push('--cwd', opts.cwd);
    }

    // Model in provider/model format (e.g. "anthropic/claude-sonnet-4-5")
    if (opts.model) {
      if (!opts.model.includes('/')) {
        log.warn(
          { model: opts.model },
          'OpenCode model should be in provider/model format (e.g. "anthropic/claude-sonnet-4-5")',
        );
      }
      args.push('-m', opts.model);
    }

    // Session resume via -s flag
    if (opts.sessionId) {
      args.push('-s', opts.sessionId);
    } else if (resumeSessionId) {
      args.push('-s', resumeSessionId);
    }

    args.push(...(opts.extraArgs ?? []));
    return args;
  }

  protected createClientHandler(): OpenCodeClientHandler {
    return new OpenCodeClientHandler(
      {
        agentPrefix: 'opencode',
        supportsTerminal: false,
        supportsCommands: false,
        supportsSessionInfo: false,
        supportsUsageCost: false,
      },
      (event) => this.emitNdjson(event as OpenCodeEvent),
      () => this.approvalHandler,
      this.activeToolCalls,
    );
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapOpenCodeJsonToEvents(parsed as OpenCodeEvent);
  }

  async setModel(model: string): Promise<boolean> {
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    try {
      await (
        conn as unknown as {
          setSessionModel: (params: { sessionId: string; modelId: string }) => Promise<void>;
        }
      ).setSessionModel({ sessionId: this.sessionId, modelId: model });
      return true;
    } catch {
      return false;
    }
  }
}
