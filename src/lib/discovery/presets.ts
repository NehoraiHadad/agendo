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
        description: 'Send a free-form prompt to Claude Code',
        interactionMode: 'prompt',
        promptTemplate:
          '{{task_title}}\n\n{{task_description}}\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
      {
        key: 'code-review',
        label: 'Code Review',
        description: 'Review code changes for bugs, security issues, and improvements',
        interactionMode: 'prompt',
        promptTemplate:
          'Review the code for this task:\n\n{{task_title}}\n\n{{task_description}}\n\nFocus on: bugs, security vulnerabilities, performance issues, and code quality. Provide specific, actionable feedback.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 0,
        timeoutSec: 900,
      },
      {
        key: 'implement-feature',
        label: 'Implement Feature',
        description: 'Implement a feature following project conventions and best practices',
        interactionMode: 'prompt',
        promptTemplate:
          'Implement the following feature:\n\n{{task_title}}\n\n{{task_description}}\n\nFollow existing project conventions. Write clean, tested code. Commit your changes when done.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 3600,
      },
      {
        key: 'fix-bug',
        label: 'Fix Bug',
        description: 'Diagnose and fix a bug with root cause analysis',
        interactionMode: 'prompt',
        promptTemplate:
          'Fix this bug:\n\n{{task_title}}\n\n{{task_description}}\n\nSteps:\n1. Reproduce and understand the root cause\n2. Implement the minimal fix\n3. Verify the fix works\n4. Check for related issues\n\n{{input_context.promptAdditions}}',
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
        description: 'Send a free-form prompt to Codex CLI',
        interactionMode: 'prompt',
        promptTemplate:
          '{{task_title}}\n\n{{task_description}}\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
      {
        key: 'code-review',
        label: 'Code Review',
        description: 'Review code changes for bugs, security issues, and improvements',
        interactionMode: 'prompt',
        promptTemplate:
          'Review the code for this task:\n\n{{task_title}}\n\n{{task_description}}\n\nFocus on: bugs, security vulnerabilities, performance issues, and code quality. Provide specific, actionable feedback.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 0,
        timeoutSec: 900,
      },
      {
        key: 'implement-feature',
        label: 'Implement Feature',
        description: 'Implement a feature following project conventions and best practices',
        interactionMode: 'prompt',
        promptTemplate:
          'Implement the following feature:\n\n{{task_title}}\n\n{{task_description}}\n\nFollow existing project conventions. Write clean, tested code. Commit your changes when done.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 3600,
      },
      {
        key: 'fix-bug',
        label: 'Fix Bug',
        description: 'Diagnose and fix a bug with root cause analysis',
        interactionMode: 'prompt',
        promptTemplate:
          'Fix this bug:\n\n{{task_title}}\n\n{{task_description}}\n\nSteps:\n1. Reproduce and understand the root cause\n2. Implement the minimal fix\n3. Verify the fix works\n4. Check for related issues\n\n{{input_context.promptAdditions}}',
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
        description: 'Send a free-form prompt to Gemini CLI',
        interactionMode: 'prompt',
        promptTemplate:
          '{{task_title}}\n\n{{task_description}}\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 1800,
      },
      {
        key: 'code-review',
        label: 'Code Review',
        description: 'Review code changes for bugs, security issues, and improvements',
        interactionMode: 'prompt',
        promptTemplate:
          'Review the code for this task:\n\n{{task_title}}\n\n{{task_description}}\n\nFocus on: bugs, security vulnerabilities, performance issues, and code quality. Provide specific, actionable feedback.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 0,
        timeoutSec: 900,
      },
      {
        key: 'implement-feature',
        label: 'Implement Feature',
        description: 'Implement a feature following project conventions and best practices',
        interactionMode: 'prompt',
        promptTemplate:
          'Implement the following feature:\n\n{{task_title}}\n\n{{task_description}}\n\nFollow existing project conventions. Write clean, tested code. Commit your changes when done.\n\n{{input_context.promptAdditions}}',
        dangerLevel: 1,
        timeoutSec: 3600,
      },
      {
        key: 'fix-bug',
        label: 'Fix Bug',
        description: 'Diagnose and fix a bug with root cause analysis',
        interactionMode: 'prompt',
        promptTemplate:
          'Fix this bug:\n\n{{task_title}}\n\n{{task_description}}\n\nSteps:\n1. Reproduce and understand the root cause\n2. Implement the minimal fix\n3. Verify the fix works\n4. Check for related issues\n\n{{input_context.promptAdditions}}',
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
