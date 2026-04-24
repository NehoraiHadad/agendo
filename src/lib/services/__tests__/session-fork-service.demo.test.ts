import { describe, it, expect } from 'vitest';
import { forkSessionToAgent } from '../session-fork-service.demo';

const CLAUDE_AGENT_ID = '11111111-1111-4111-a111-111111111111';
const CODEX_AGENT_ID = '22222222-2222-4222-a222-222222222222';
const GEMINI_AGENT_ID = '33333333-3333-4333-a333-333333333333';
const PARENT_SESSION_ID = '77777777-7777-4777-a777-777777777777';

describe('session-fork-service.demo', () => {
  it('returns a ForkToAgentResult without throwing', async () => {
    const result = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });

    expect(result.session).toBeDefined();
    expect(result.agentName).toBeDefined();
    expect(result.contextMeta).toBeDefined();
  });

  it('forked session has a new unique id (not parent id)', async () => {
    const result = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });

    expect(result.session.id).not.toBe(PARENT_SESSION_ID);
    expect(result.session.id).toBeTypeOf('string');
  });

  it('forked session references the parent session', async () => {
    const result = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });

    expect(result.session.parentSessionId).toBe(PARENT_SESSION_ID);
  });

  it('forked session uses the requested agent id', async () => {
    const result = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: GEMINI_AGENT_ID,
      contextMode: 'full',
    });

    expect(result.session.agentId).toBe(GEMINI_AGENT_ID);
  });

  it('agentName matches the known fixture agents', async () => {
    const codexResult = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });
    expect(codexResult.agentName).toBe('Codex CLI');

    const claudeResult = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CLAUDE_AGENT_ID,
      contextMode: 'hybrid',
    });
    expect(claudeResult.agentName).toBe('Claude Code');
  });

  it('contextMeta has required numeric fields', async () => {
    const result = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });

    expect(result.contextMeta.totalTurns).toBeTypeOf('number');
    expect(result.contextMeta.includedVerbatimTurns).toBeTypeOf('number');
    expect(result.contextMeta.summarizedTurns).toBeTypeOf('number');
    expect(result.contextMeta.estimatedTokens).toBeTypeOf('number');
  });

  it('two forks produce different session ids', async () => {
    const r1 = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });
    const r2 = await forkSessionToAgent({
      parentSessionId: PARENT_SESSION_ID,
      newAgentId: CODEX_AGENT_ID,
      contextMode: 'hybrid',
    });

    expect(r1.session.id).not.toBe(r2.session.id);
  });
});
