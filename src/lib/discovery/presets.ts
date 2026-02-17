import type { AgentSessionConfig, AgentMetadata } from '../types';

export interface AIToolPreset {
  binaryName: string;
  displayName: string;
  kind: 'builtin';
  toolType: 'ai-agent';
  discoveryMethod: 'preset';
  envAllowlist: string[];
  maxConcurrent: number;
  mcpEnabled: boolean;
  sessionConfig: AgentSessionConfig;
  metadata: AgentMetadata;
  defaultCapabilities: PresetCapability[];
}

export interface PresetCapability {
  key: string;
  label: string;
  description: string;
  interactionMode: 'prompt';
  promptTemplate: string;
  dangerLevel: number;
  timeoutSec: number;
}

export const AI_TOOL_PRESETS: Record<string, AIToolPreset> = {
  claude: {
    binaryName: 'claude',
    displayName: 'Claude Code',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'json_field',
      sessionIdField: 'session_id',
      resumeFlags: ['--resume', '{{sessionRef}}'],
      continueFlags: ['--continue'],
      bidirectionalProtocol: 'stream-json',
    },
    metadata: {
      icon: 'brain',
      color: '#D97706',
      description: 'Anthropic Claude Code CLI -- AI coding assistant',
      homepage: 'https://claude.ai',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Claude Code with stream-json bidirectional output',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },

  codex: {
    binaryName: 'codex',
    displayName: 'Codex CLI',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['OPENAI_API_KEY'],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'filesystem',
      sessionFileGlob: '~/.codex/sessions/**/*.jsonl',
      resumeFlags: ['resume', '{{sessionRef}}'],
      continueFlags: ['resume', '--last'],
      bidirectionalProtocol: 'app-server',
    },
    metadata: {
      icon: 'code',
      color: '#10B981',
      description: 'OpenAI Codex CLI -- AI coding assistant',
      homepage: 'https://openai.com',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Codex CLI via app-server JSON-RPC protocol',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },

  gemini: {
    binaryName: 'gemini',
    displayName: 'Gemini CLI',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    maxConcurrent: 1,
    mcpEnabled: false,
    sessionConfig: {
      sessionIdSource: 'list_command',
      listSessionsCommand: ['gemini', '--list-sessions'],
      listSessionsPattern: '(\\d+)\\.\\s+.+\\[([a-f0-9-]+)\\]',
      resumeFlags: ['--resume', '{{sessionRef}}'],
      continueFlags: ['--resume', 'latest'],
      bidirectionalProtocol: 'tmux',
    },
    metadata: {
      icon: 'sparkles',
      color: '#3B82F6',
      description: 'Google Gemini CLI -- AI coding assistant',
      homepage: 'https://gemini.google.com',
    },
    defaultCapabilities: [
      {
        key: 'prompt',
        label: 'Run Prompt',
        description: 'Send a prompt to Gemini CLI in interactive mode via tmux',
        interactionMode: 'prompt',
        promptTemplate: '{{task_title}}\n\n{{task_description}}\n\n{{input_context.prompt_additions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
    ],
  },
};

/**
 * Look up a preset by binary name.
 */
export function getPresetForBinary(binaryName: string): AIToolPreset | undefined {
  return AI_TOOL_PRESETS[binaryName];
}
