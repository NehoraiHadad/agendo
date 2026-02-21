import { describe, it, expect } from 'vitest';
import {
  generateExternalHookScript,
  generateExternalProjectHooksConfig,
  generatePostToolUseHook,
  generateSessionHooksConfig,
  generateStopHook,
} from '../agendo-hooks';

describe('generatePostToolUseHook', () => {
  it('produces a sh shebang script', () => {
    const script = generatePostToolUseHook('http://localhost:4100', 'sess-123');
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('contains the session-scoped events endpoint', () => {
    const script = generatePostToolUseHook('http://localhost:4100', 'sess-abc');
    expect(script).toContain('http://localhost:4100/api/sessions/sess-abc/events');
  });

  it('contains agent:activity event type', () => {
    const script = generatePostToolUseHook('http://localhost:4100', 'sess-abc');
    expect(script).toContain('agent:activity');
  });

  it('includes curl with max-time guard', () => {
    const script = generatePostToolUseHook('http://localhost:4100', 'sess-abc');
    expect(script).toContain('--max-time 2');
    expect(script).toContain('|| true');
  });

  it('reads tool_name from stdin JSON (not env var)', () => {
    const script = generatePostToolUseHook('http://localhost:4100', 'sess-abc');
    expect(script).toContain('INPUT=$(cat)');
    expect(script).toContain('grep -o');
    expect(script).toContain('"tool_name"');
  });
});

describe('generateStopHook', () => {
  it('produces a sh shebang script', () => {
    const script = generateStopHook('http://localhost:4100', 'sess-123', null);
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('contains the session-scoped events endpoint', () => {
    const script = generateStopHook('http://localhost:4100', 'sess-xyz', null);
    expect(script).toContain('http://localhost:4100/api/sessions/sess-xyz/events');
  });

  it('includes task id in note when taskId is provided', () => {
    const script = generateStopHook('http://localhost:4100', 'sess-123', 'task-456');
    expect(script).toContain('task-456');
  });

  it('does not include task reference when taskId is null', () => {
    const script = generateStopHook('http://localhost:4100', 'sess-123', null);
    expect(script).not.toContain('task:');
  });
});

describe('generateSessionHooksConfig', () => {
  it('returns an object with PostToolUse and Stop hooks', () => {
    const config = generateSessionHooksConfig('http://localhost:4100', 'sess-123', null);
    expect(config.hooks.PostToolUse).toHaveLength(1);
    expect(config.hooks.Stop).toHaveLength(1);
  });

  it('PostToolUse hook matches Write|Edit|Bash', () => {
    const config = generateSessionHooksConfig('http://localhost:4100', 'sess-123', null);
    expect(config.hooks.PostToolUse?.[0].matcher).toBe('Write|Edit|Bash');
  });

  it('PostToolUse hook type is command', () => {
    const config = generateSessionHooksConfig('http://localhost:4100', 'sess-123', null);
    expect(config.hooks.PostToolUse?.[0].hooks[0].type).toBe('command');
  });

  it('Stop hook type is command', () => {
    const config = generateSessionHooksConfig('http://localhost:4100', 'sess-123', null);
    expect(config.hooks.Stop?.[0].hooks[0].type).toBe('command');
  });
});

describe('generateExternalHookScript', () => {
  it('produces a sh shebang script', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('exits early when AGENDO_TASK_ID is unset', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    expect(script).toContain('if [ -z "$AGENDO_TASK_ID" ]');
    expect(script).toContain('exit 0');
  });

  it('POSTs to the task events endpoint using $AGENDO_TASK_ID', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    expect(script).toContain('http://localhost:4100/api/tasks/$AGENDO_TASK_ID/events');
  });

  it('uses agent_note as the eventType', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    expect(script).toContain('agent_note');
  });

  it('reads tool_name from stdin JSON (not env var)', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    // Claude Code passes hook input via stdin as JSON — must read stdin, not env var.
    expect(script).toContain('INPUT=$(cat)');
    expect(script).toContain('grep -o');
    expect(script).toContain('"tool_name"');
  });

  it('falls back to "unknown" when tool_name is absent from stdin', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    // Shell parameter expansion provides the fallback without TypeScript interpolation.
    expect(script).toMatch(/TOOL_NAME=\$\{TOOL_NAME:-unknown\}/);
  });

  it('includes curl with max-time guard', () => {
    const script = generateExternalHookScript('http://localhost:4100');
    expect(script).toContain('--max-time 2');
    expect(script).toContain('|| true');
  });

  it('interpolates a custom agendoUrl', () => {
    const script = generateExternalHookScript('http://custom-host:9999');
    expect(script).toContain('http://custom-host:9999/api/tasks/$AGENDO_TASK_ID/events');
  });
});

describe('generateExternalProjectHooksConfig', () => {
  it('returns an object with a PostToolUse hooks array', () => {
    const config = generateExternalProjectHooksConfig('http://localhost:4100') as {
      hooks: {
        PostToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };

    expect(config.hooks.PostToolUse).toHaveLength(1);
  });

  it('PostToolUse hook matches Write|Edit|Bash', () => {
    const config = generateExternalProjectHooksConfig('http://localhost:4100') as {
      hooks: {
        PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      };
    };

    expect(config.hooks.PostToolUse[0].matcher).toBe('Write|Edit|Bash');
  });

  it('PostToolUse hook type is command', () => {
    const config = generateExternalProjectHooksConfig('http://localhost:4100') as {
      hooks: {
        PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      };
    };

    expect(config.hooks.PostToolUse[0].hooks[0].type).toBe('command');
  });

  it('embeds the hook script as the command value', () => {
    const url = 'http://localhost:4100';
    const config = generateExternalProjectHooksConfig(url) as {
      hooks: {
        PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      };
    };
    const command = config.hooks.PostToolUse[0].hooks[0].command;

    // The embedded script must contain the task events endpoint
    expect(command).toContain(`${url}/api/tasks/$AGENDO_TASK_ID/events`);
    // And the shell shebang
    expect(command).toContain('#!/bin/sh');
  });

  it('does not include a Stop hook (external mode only fires on tool use)', () => {
    const config = generateExternalProjectHooksConfig('http://localhost:4100') as {
      hooks: Record<string, unknown>;
    };

    expect(config.hooks['Stop']).toBeUndefined();
  });
});
