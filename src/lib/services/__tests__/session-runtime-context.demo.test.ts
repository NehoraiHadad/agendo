import { describe, it, expect } from 'vitest';
import { resolveSessionRuntimeContext } from '../session-runtime-context.demo';

const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';
const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';

describe('session-runtime-context.demo', () => {
  it('returns a valid SessionRuntimeContext without throwing', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx).toBeDefined();
  });

  it('context has all required fields', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.session).toBeDefined();
    expect(ctx.agent).toBeDefined();
    expect(ctx.project).toBeDefined();
    expect(ctx.resolvedProjectId).toBeDefined();
    expect(ctx.cwd).toBeTypeOf('string');
    expect(ctx.envOverrides).toBeDefined();
  });

  it('session is the Claude demo session', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.session.id).toBe(CLAUDE_SESSION_ID);
    expect(ctx.session.agentId).toBe(CLAUDE_AGENT_ID);
  });

  it('agent is Claude Code', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.agent.id).toBe(CLAUDE_AGENT_ID);
    expect(ctx.agent.name).toBe('Claude Code');
  });

  it('project is the agendo demo project', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.project?.id).toBe(AGENDO_PROJECT_ID);
    expect(ctx.resolvedProjectId).toBe(AGENDO_PROJECT_ID);
  });

  it('task is null in the demo context', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.task).toBeNull();
  });

  it('cwd is the agendo project root path', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.cwd).toBe('/home/ubuntu/projects/agendo');
  });

  it('envOverrides includes AGENDO_PROJECT_ID', async () => {
    const ctx = await resolveSessionRuntimeContext(CLAUDE_SESSION_ID);
    expect(ctx.envOverrides['AGENDO_PROJECT_ID']).toBe(AGENDO_PROJECT_ID);
  });

  it('returns same fixture regardless of sessionId input', async () => {
    const ctx1 = await resolveSessionRuntimeContext('any-session-id');
    const ctx2 = await resolveSessionRuntimeContext('another-session-id');
    expect(ctx1.session.id).toBe(ctx2.session.id);
  });
});
