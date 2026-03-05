import { describe, it, expect, vi } from 'vitest';
import type { ApprovalRequest, PermissionDecision } from '@/lib/worker/adapters/types';
import {
  handleCodexCommandApproval,
  handleCodexFileChangeApproval,
  handleCodexUserInputRequest,
  mapDecisionToCodex,
} from '@/lib/worker/adapters/codex-approval-handlers';

type ApprovalHandler = (request: ApprovalRequest) => Promise<PermissionDecision>;

describe('mapDecisionToCodex', () => {
  it('maps "allow" to "accept"', () => {
    expect(mapDecisionToCodex('allow')).toBe('accept');
  });

  it('maps { behavior: "allow" } to "accept"', () => {
    expect(mapDecisionToCodex({ behavior: 'allow' })).toBe('accept');
  });

  it('maps "allow-session" to "acceptForSession"', () => {
    expect(mapDecisionToCodex('allow-session')).toBe('acceptForSession');
  });

  it('maps "deny" to "decline"', () => {
    expect(mapDecisionToCodex('deny')).toBe('decline');
  });
});

describe('handleCodexCommandApproval', () => {
  const baseParams = {
    command: 'ls -la',
    cwd: '/tmp',
    reason: 'list files',
    approvalId: 'ap-1',
  };

  it('returns accept when no handler is provided', async () => {
    const result = await handleCodexCommandApproval(baseParams, null);
    expect(result).toEqual({ decision: 'accept' });
  });

  it('maps handler "allow" to accept', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('allow');
    const result = await handleCodexCommandApproval(baseParams, handler);
    expect(result).toEqual({ decision: 'accept' });
    expect(handler).toHaveBeenCalledWith({
      approvalId: 'ap-1',
      toolName: 'Bash',
      toolInput: {
        command: 'ls -la',
        cwd: '/tmp',
        reason: 'list files',
        proposedExecpolicyAmendment: null,
      },
    });
  });

  it('maps handler "deny" to decline', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('deny');
    const result = await handleCodexCommandApproval(baseParams, handler);
    expect(result).toEqual({ decision: 'decline' });
  });

  it('maps handler "allow-session" to acceptForSession', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('allow-session');
    const result = await handleCodexCommandApproval(baseParams, handler);
    expect(result).toEqual({ decision: 'acceptForSession' });
  });

  it('returns acceptWithExecpolicyAmendment when rememberForSession is true', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      rememberForSession: true,
    });
    const params = {
      ...baseParams,
      proposedExecpolicyAmendment: ['ls *'],
    };
    const result = await handleCodexCommandApproval(params, handler);
    expect(result).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls *'] } },
    });
  });

  it('uses command as fallback amendment when proposedExecpolicyAmendment is null', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      rememberForSession: true,
    });
    const result = await handleCodexCommandApproval(baseParams, handler);
    expect(result).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['ls -la'] } },
    });
  });

  it('returns decline when handler throws', async () => {
    const handler: ApprovalHandler = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await handleCodexCommandApproval(baseParams, handler);
    expect(result).toEqual({ decision: 'decline' });
  });

  it('extracts command from commandActions when command is absent', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('allow');
    const params = {
      commandActions: [{ action: 'npm test' }],
      cwd: '/tmp',
      reason: null,
      itemId: 'item-1',
    };
    const result = await handleCodexCommandApproval(params, handler);
    expect(result).toEqual({ decision: 'accept' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: expect.objectContaining({ command: 'npm test' }),
      }),
    );
  });
});

describe('handleCodexFileChangeApproval', () => {
  const baseParams = {
    itemId: 'fc-1',
    reason: 'edit file',
    grantRoot: '/home/user',
  };

  it('returns accept when no handler is provided', async () => {
    const result = await handleCodexFileChangeApproval(baseParams, null);
    expect(result).toBe('accept');
  });

  it('maps handler "allow" to accept', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('allow');
    const result = await handleCodexFileChangeApproval(baseParams, handler);
    expect(result).toBe('accept');
    expect(handler).toHaveBeenCalledWith({
      approvalId: 'fc-1',
      toolName: 'FileChange',
      toolInput: {
        reason: 'edit file',
        grantRoot: '/home/user',
      },
    });
  });

  it('maps handler "deny" to decline', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('deny');
    const result = await handleCodexFileChangeApproval(baseParams, handler);
    expect(result).toBe('decline');
  });

  it('returns decline when handler throws', async () => {
    const handler: ApprovalHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await handleCodexFileChangeApproval(baseParams, handler);
    expect(result).toBe('decline');
  });
});

describe('handleCodexUserInputRequest', () => {
  const baseParams = {
    questions: [
      {
        id: 'q1',
        header: 'Confirm',
        question: 'Do you want to continue?',
        options: [
          { id: 'yes', label: 'Yes', description: 'Continue' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
    itemId: 'req-1',
  };

  it('returns empty object when no handler is provided', async () => {
    const result = await handleCodexUserInputRequest(baseParams, null);
    expect(result).toEqual({});
  });

  it('returns empty object when questions array is empty', async () => {
    const handler: ApprovalHandler = vi.fn();
    const result = await handleCodexUserInputRequest({ questions: [], itemId: 'r-1' }, handler);
    expect(result).toEqual({});
  });

  it('maps user answers correctly', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: { answers: { '0': 'Yes' } },
    });
    const result = await handleCodexUserInputRequest(baseParams, handler);
    expect(result).toEqual({ q1: { answers: ['Yes'] } });
    expect(handler).toHaveBeenCalledWith({
      approvalId: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [
          {
            question: 'Do you want to continue?',
            header: 'Confirm',
            options: [
              { label: 'Yes', description: 'Continue' },
              { label: 'No', description: '' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
  });

  it('returns empty object when handler denies', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue('deny');
    const result = await handleCodexUserInputRequest(baseParams, handler);
    expect(result).toEqual({});
  });

  it('returns empty object when handler throws', async () => {
    const handler: ApprovalHandler = vi.fn().mockRejectedValue(new Error('err'));
    const result = await handleCodexUserInputRequest(baseParams, handler);
    expect(result).toEqual({});
  });

  it('returns empty object when handler returns allow without answers', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue({ behavior: 'allow' });
    const result = await handleCodexUserInputRequest(baseParams, handler);
    expect(result).toEqual({});
  });

  it('handles multiple questions', async () => {
    const handler: ApprovalHandler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: { answers: { '0': 'Yes', '1': 'Production' } },
    });
    const params = {
      questions: [
        { id: 'q1', header: 'Q1', question: 'Continue?', options: null },
        { id: 'q2', header: 'Q2', question: 'Environment?', options: null },
      ],
      itemId: 'req-2',
    };
    const result = await handleCodexUserInputRequest(params, handler);
    expect(result).toEqual({
      q1: { answers: ['Yes'] },
      q2: { answers: ['Production'] },
    });
  });
});
