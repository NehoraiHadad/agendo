import type { PermissionDecision } from '@/lib/worker/adapters/types';

type ApprovalHandler =
  | ((request: {
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }) => Promise<PermissionDecision>)
  | null;

// ---------------------------------------------------------------------------
// mapDecisionToCodex: PermissionDecision -> Codex approval string
// ---------------------------------------------------------------------------

export function mapDecisionToCodex(decision: PermissionDecision): string {
  if (decision === 'allow' || (typeof decision === 'object' && decision.behavior === 'allow')) {
    return 'accept';
  }
  if (decision === 'allow-session') {
    return 'acceptForSession';
  }
  return 'decline';
}

// ---------------------------------------------------------------------------
// handleCodexCommandApproval
// ---------------------------------------------------------------------------

export async function handleCodexCommandApproval(
  params: Record<string, unknown>,
  handler: ApprovalHandler,
): Promise<Record<string, unknown>> {
  if (!handler) return { decision: 'accept' };

  const command =
    (params.command as string | null) ??
    (params.commandActions as Array<{ action?: string }> | null)?.[0]?.action ??
    'unknown';
  const approvalId =
    (params.approvalId as string | null) ?? (params.itemId as string) ?? String(Date.now());
  const proposedAmendment = (params.proposedExecpolicyAmendment as string[] | null) ?? null;

  let decision: PermissionDecision;
  try {
    decision = await handler({
      approvalId,
      toolName: 'Bash',
      toolInput: {
        command,
        cwd: params.cwd as string,
        reason: (params.reason as string | null) ?? null,
        proposedExecpolicyAmendment: proposedAmendment,
      },
    });
  } catch {
    return { decision: 'decline' };
  }

  if (
    typeof decision === 'object' &&
    'behavior' in decision &&
    decision.behavior === 'allow' &&
    'rememberForSession' in decision &&
    decision.rememberForSession
  ) {
    const amendment = proposedAmendment ?? [command];
    return {
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } },
    };
  }

  return { decision: mapDecisionToCodex(decision) };
}

// ---------------------------------------------------------------------------
// handleCodexFileChangeApproval
// ---------------------------------------------------------------------------

export async function handleCodexFileChangeApproval(
  params: Record<string, unknown>,
  handler: ApprovalHandler,
): Promise<string> {
  if (!handler) return 'accept';

  const approvalId = (params.itemId as string) ?? String(Date.now());

  let decision: PermissionDecision;
  try {
    decision = await handler({
      approvalId,
      toolName: 'FileChange',
      toolInput: {
        reason: (params.reason as string | null) ?? null,
        grantRoot: (params.grantRoot as string | null) ?? null,
      },
    });
  } catch {
    return 'decline';
  }

  return mapDecisionToCodex(decision);
}

// ---------------------------------------------------------------------------
// handleCodexUserInputRequest
// ---------------------------------------------------------------------------

type CodexQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }> | null;
};

export async function handleCodexUserInputRequest(
  params: Record<string, unknown>,
  handler: ApprovalHandler,
): Promise<Record<string, { answers: string[] }>> {
  const rawQuestions = (params.questions as CodexQuestion[] | null) ?? [];
  const requestId = (params.itemId as string | null) ?? `codex-ask-${Date.now()}`;

  if (!handler || rawQuestions.length === 0) {
    return {};
  }

  const questionIds = rawQuestions.map((q) => q.id);
  const mappedQuestions = rawQuestions.map((q) => ({
    question: q.question,
    header: q.header,
    options: (q.options ?? []).map((o) => ({
      label: o.label,
      description: o.description ?? '',
    })),
    multiSelect: false,
  }));

  let decision: PermissionDecision;
  try {
    decision = await handler({
      approvalId: requestId,
      toolName: 'AskUserQuestion',
      toolInput: { questions: mappedQuestions },
    });
  } catch {
    return {};
  }

  if (typeof decision !== 'object' || !('behavior' in decision) || decision.behavior !== 'allow') {
    return {};
  }

  const rawAnswers = (decision.updatedInput as Record<string, unknown> | undefined)?.answers as
    | Record<string, string>
    | undefined;

  if (!rawAnswers) return {};

  const answers: Record<string, { answers: string[] }> = {};
  for (const [idx, text] of Object.entries(rawAnswers)) {
    const questionId = questionIds[Number(idx)] ?? idx;
    answers[questionId] = { answers: [text] };
  }
  return answers;
}
