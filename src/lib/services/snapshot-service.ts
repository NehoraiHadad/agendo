import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { contextSnapshots } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import { createSession } from '@/lib/services/session-service';
import { enqueueSession } from '@/lib/worker/queue';
import type { ContextSnapshot, SnapshotFindings } from '@/lib/types';

export interface CreateSnapshotInput {
  projectId: string;
  sessionId?: string;
  name: string;
  summary: string;
  keyFindings?: SnapshotFindings;
}

export interface ResumeFromSnapshotOpts {
  agentId: string;
  capabilityId: string;
  permissionMode?: string;
  additionalContext?: string;
}

export async function createSnapshot(input: CreateSnapshotInput): Promise<ContextSnapshot> {
  const [snapshot] = await db
    .insert(contextSnapshots)
    .values({
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      name: input.name,
      summary: input.summary,
      keyFindings: input.keyFindings ?? {
        filesExplored: [],
        findings: [],
        hypotheses: [],
        nextSteps: [],
      },
    })
    .returning();
  return snapshot;
}

export async function getSnapshot(id: string): Promise<ContextSnapshot> {
  const [snapshot] = await db
    .select()
    .from(contextSnapshots)
    .where(eq(contextSnapshots.id, id))
    .limit(1);
  if (!snapshot) throw new NotFoundError('ContextSnapshot', id);
  return snapshot;
}

export async function listSnapshots(filters?: {
  projectId?: string;
  limit?: number;
}): Promise<ContextSnapshot[]> {
  const conditions = [];
  if (filters?.projectId) conditions.push(eq(contextSnapshots.projectId, filters.projectId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = filters?.limit ?? 50;

  return db
    .select()
    .from(contextSnapshots)
    .where(where)
    .orderBy(desc(contextSnapshots.createdAt))
    .limit(limit);
}

export async function deleteSnapshot(id: string): Promise<void> {
  const [deleted] = await db
    .delete(contextSnapshots)
    .where(eq(contextSnapshots.id, id))
    .returning({ id: contextSnapshots.id });
  if (!deleted) throw new NotFoundError('ContextSnapshot', id);
}

/**
 * Resume from a snapshot by creating a new agent session seeded with the
 * snapshot's summary, key findings, and any additional context provided.
 */
export async function resumeFromSnapshot(
  snapshotId: string,
  opts: ResumeFromSnapshotOpts,
): Promise<{ sessionId: string }> {
  const snapshot = await getSnapshot(snapshotId);

  const promptParts: string[] = [`Context snapshot: ${snapshot.name}`, '', snapshot.summary];

  const { keyFindings } = snapshot;
  if (keyFindings) {
    if (keyFindings.filesExplored.length > 0) {
      promptParts.push('', 'Files explored:', ...keyFindings.filesExplored.map((f) => `- ${f}`));
    }
    if (keyFindings.findings.length > 0) {
      promptParts.push('', 'Key findings:', ...keyFindings.findings.map((f) => `- ${f}`));
    }
    if (keyFindings.hypotheses.length > 0) {
      promptParts.push('', 'Hypotheses:', ...keyFindings.hypotheses.map((h) => `- ${h}`));
    }
    if (keyFindings.nextSteps.length > 0) {
      promptParts.push('', 'Next steps:', ...keyFindings.nextSteps.map((s) => `- ${s}`));
    }
  }

  if (opts.additionalContext) {
    promptParts.push('', 'Additional context:', opts.additionalContext);
  }

  const initialPrompt = promptParts.join('\n');

  const session = await createSession({
    projectId: snapshot.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    capabilityId: opts.capabilityId,
    initialPrompt,
    permissionMode: opts.permissionMode as
      | 'default'
      | 'bypassPermissions'
      | 'acceptEdits'
      | 'plan'
      | 'dontAsk'
      | undefined,
  });

  await enqueueSession({ sessionId: session.id });

  return { sessionId: session.id };
}
