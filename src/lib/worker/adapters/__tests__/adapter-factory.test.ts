import { describe, it, expect } from 'vitest';
import { selectAdapter } from '@/lib/worker/adapters/adapter-factory';
import { ClaudeAdapter } from '@/lib/worker/adapters/claude-adapter';
import { CodexAdapter } from '@/lib/worker/adapters/codex-adapter';
import { GeminiAdapter } from '@/lib/worker/adapters/gemini-adapter';
import type { Agent } from '@/lib/types';

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
    parsedFlags: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('selectAdapter', () => {
  it('returns ClaudeAdapter for claude binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/claude'));
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it('returns CodexAdapter for codex binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/codex'));
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it('returns GeminiAdapter for gemini binary', () => {
    const adapter = selectAdapter(makeAgent('/usr/local/bin/gemini'));
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  it('throws for unknown binary', () => {
    expect(() => selectAdapter(makeAgent('/usr/bin/unknown'))).toThrow('No adapter found');
  });
});
