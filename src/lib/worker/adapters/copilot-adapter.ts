import type { AgendoEventPayload } from '@/lib/realtime/events';
import {
  mapCopilotJsonToEvents,
  type CopilotEvent,
} from '@/lib/worker/adapters/copilot-event-mapper';
import { CopilotClientHandler } from '@/lib/worker/adapters/copilot-client-handler';
import { AbstractAcpAdapter } from '@/lib/worker/adapters/base-acp-adapter';
import type { SpawnOpts } from '@/lib/worker/adapters/types';

export class CopilotAdapter extends AbstractAcpAdapter<CopilotEvent> {
  protected get binaryName(): string {
    return 'copilot';
  }
  protected get agentLabel(): string {
    return 'Copilot';
  }
  protected get agentPrefix(): string {
    return 'copilot';
  }
  protected get acpModeMap(): Record<string, string> {
    return {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
  }

  protected buildArgs(opts: SpawnOpts, resumeSessionId: string | null): string[] {
    const args = ['--acp', '--no-auto-update', '--disable-builtin-mcps'];

    if (opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'dontAsk') {
      args.push('--yolo');
    } else if (opts.permissionMode === 'plan') {
      args.push('--deny-tool=write', '--deny-tool=shell');
    } else if (opts.permissionMode === 'acceptEdits') {
      args.push('--allow-all-tools', '--allow-all-paths');
    }

    if (opts.model) args.push('--model', opts.model);

    if (opts.sessionId) args.push(`--resume=${opts.sessionId}`);
    else if (resumeSessionId) args.push(`--resume=${resumeSessionId}`);

    if (opts.mcpServers?.length) {
      const config: Record<string, unknown> = {};
      for (const srv of opts.mcpServers) {
        config[srv.name] = {
          command: srv.command,
          args: srv.args,
          env: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
        };
      }
      args.push('--additional-mcp-config', JSON.stringify({ mcpServers: config }));
    }

    args.push(...(opts.extraArgs ?? []));
    return args;
  }

  protected createClientHandler(): CopilotClientHandler {
    return new CopilotClientHandler(
      {
        agentPrefix: 'copilot',
        supportsTerminal: true,
        supportsCommands: true,
        supportsSessionInfo: true,
        supportsUsageCost: true,
      },
      (event: { type: string; [key: string]: unknown }) => this.emitNdjson(event as CopilotEvent),
      () => this.approvalHandler,
      this.activeToolCalls,
    );
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapCopilotJsonToEvents(parsed as CopilotEvent);
  }

  async setModel(model: string): Promise<boolean> {
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    try {
      await (
        conn as unknown as {
          unstable_setSessionModel: (params: {
            sessionId: string;
            modelId: string;
          }) => Promise<void>;
        }
      ).unstable_setSessionModel({ sessionId: this.sessionId, modelId: model });
      return true;
    } catch {
      return false;
    }
  }
}
