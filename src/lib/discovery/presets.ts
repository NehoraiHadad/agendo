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
  },

  copilot: {
    binaryName: 'copilot',
    displayName: 'GitHub Copilot CLI',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    envAllowlist: ['GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GH_HOST'],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'acp',
      resumeFlags: ['--resume={{sessionRef}}'],
      continueFlags: ['--continue'],
      bidirectionalProtocol: 'acp',
    },
    metadata: {
      icon: 'github',
      color: '#6B7280',
      description: 'GitHub Copilot CLI — AI coding assistant with multi-provider model support',
      homepage: 'https://docs.github.com/copilot/how-tos/copilot-cli',
    },
  },

  opencode: {
    binaryName: 'opencode',
    displayName: 'OpenCode',
    kind: 'builtin',
    toolType: 'ai-agent',
    discoveryMethod: 'preset',
    // All provider API keys that OpenCode can use
    envAllowlist: [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
      'AZURE_API_KEY',
      'AZURE_RESOURCE_NAME',
      'GITHUB_TOKEN',
      'MISTRAL_API_KEY',
      'DEEPSEEK_API_KEY',
      'FIREWORKS_API_KEY',
      'OPENCODE_API_KEY',
      // Internal config injection (for permission bypass and MCP pre-config)
      'OPENCODE_CONFIG_CONTENT',
    ],
    maxConcurrent: 1,
    mcpEnabled: true,
    sessionConfig: {
      sessionIdSource: 'acp', // ACP session/new response contains sessionId
      resumeFlags: ['-s', '{{sessionRef}}'],
      continueFlags: ['-c'],
      bidirectionalProtocol: 'acp',
    },
    metadata: {
      icon: 'terminal',
      color: '#8B5CF6',
      description: 'OpenCode — open-source terminal coding agent with multi-provider support',
      homepage: 'https://opencode.ai',
    },
  },
};

/**
 * Look up a preset by binary name.
 */
export function getPresetForBinary(binaryName: string): AIToolPreset | undefined {
  return AI_TOOL_PRESETS[binaryName];
}
