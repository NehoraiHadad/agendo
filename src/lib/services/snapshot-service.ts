import { eq, desc } from 'drizzle-orm';
import { buildFilters } from '@/lib/db/filter-builder';
import { db } from '@/lib/db';
import { contextSnapshots } from '@/lib/db/schema';
import { requireFound } from '@/lib/api-handler';
import { getById } from '@/lib/services/db-helpers';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';
import { isDemoMode } from '@/lib/demo/flag';
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
  permissionMode?: string;
  additionalContext?: string;
}

export async function createSnapshot(input: CreateSnapshotInput): Promise<ContextSnapshot> {
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.createSnapshot(input);
  }

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
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.getSnapshot(id);
  }

  return getById(contextSnapshots, id, 'ContextSnapshot');
}

export async function listSnapshots(filters?: {
  projectId?: string;
  limit?: number;
}): Promise<ContextSnapshot[]> {
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.listSnapshots(filters);
  }

  const where = buildFilters(
    { projectId: filters?.projectId },
    { projectId: contextSnapshots.projectId },
  );
  const limit = filters?.limit ?? 50;

  return db
    .select()
    .from(contextSnapshots)
    .where(where)
    .orderBy(desc(contextSnapshots.createdAt))
    .limit(limit);
}

export async function updateSnapshot(
  id: string,
  patch: { name?: string; summary?: string; keyFindings?: SnapshotFindings },
): Promise<ContextSnapshot> {
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.updateSnapshot(id, patch);
  }

  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.summary !== undefined) updates.summary = patch.summary;
  if (patch.keyFindings !== undefined) updates.keyFindings = patch.keyFindings;

  if (Object.keys(updates).length === 0) {
    return getSnapshot(id);
  }

  const [updated] = await db
    .update(contextSnapshots)
    .set(updates)
    .where(eq(contextSnapshots.id, id))
    .returning();
  return requireFound(updated, 'ContextSnapshot', id);
}

export async function deleteSnapshot(id: string): Promise<void> {
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.deleteSnapshot(id);
  }

  const [deleted] = await db
    .delete(contextSnapshots)
    .where(eq(contextSnapshots.id, id))
    .returning({ id: contextSnapshots.id });
  requireFound(deleted, 'ContextSnapshot', id);
}

/**
 * Resume from a snapshot by creating a new agent session seeded with the
 * snapshot's summary, key findings, and any additional context provided.
 */
export async function resumeFromSnapshot(
  snapshotId: string,
  opts: ResumeFromSnapshotOpts,
): Promise<{ sessionId: string }> {
  if (isDemoMode()) {
    const demo = await import('./snapshot-service.demo');
    return demo.resumeFromSnapshot(snapshotId, opts);
  }

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

  const session = await createAndEnqueueSession({
    projectId: snapshot.projectId,
    kind: 'conversation',
    agentId: opts.agentId,
    initialPrompt,
    permissionMode: opts.permissionMode as
      | 'default'
      | 'bypassPermissions'
      | 'acceptEdits'
      | 'plan'
      | 'dontAsk'
      | undefined,
  });

  return { sessionId: session.id };
}
