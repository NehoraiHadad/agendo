import { describe, it, expect } from 'vitest';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import { TemplateAdapter } from '@/lib/worker/adapters/template-adapter';
import type { Agent, AgentCapability } from '@/lib/types';

function makeAgent(binaryPath: string): Agent {
  return {
    id: 'agent-1',
    ownerId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000001',
    name: 'Test',
    slug: 'test',
    kind: 'builtin',
    binaryPath,
    baseArgs: [],
    workingDir: '/tmp',
    envAllowlist: [],
    isActive: true,
    maxConcurrent: 1,
    discoveryMethod: 'manual',
    version: null,
    packageName: null,
    packageSection: null,
    toolType: null,
    mcpEnabled: false,
    sessionConfig: null,
    lastScannedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCap(mode: 'template' | 'prompt'): AgentCapability {
  return {
    id: 'cap-1',
    agentId: 'agent-1',
    key: 'test',
    label: 'Test',
    description: null,
    source: 'manual',
    interactionMode: mode,
    commandTokens: mode === 'template' ? ['test'] : null,
    promptTemplate: mode === 'prompt' ? '{{prompt}}' : null,
    argsSchema: {},
    requiresApproval: false,
    isEnabled: true,
    dangerLevel: 0,
    timeoutSec: 300,
    maxOutputBytes: 10485760,
    createdAt: new Date(),
  };
}

describe('selectAdapter', () => {
  it('returns TemplateAdapter for template mode', () => {
    const adapter = selectAdapter(makeAgent('/usr/bin/git'), makeCap('template'));
    expect(adapter).toBeInstanceOf(TemplateAdapter);
  });

  it('returns ClaudeAdapter for claude binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/claude'), makeCap('prompt'));
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it('returns CodexAdapter for codex binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/codex'), makeCap('prompt'));
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it('returns GeminiAdapter for gemini binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/gemini'), makeCap('prompt'));
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  it('throws for unknown binary', () => {
    expect(() => selectAdapter(makeAgent('/usr/bin/unknown'), makeCap('prompt'))).toThrow(
      'No adapter found',
    );
  });
});
