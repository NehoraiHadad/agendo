import { db } from '@/lib/db';
import { artifacts } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { isDemoMode } from '@/lib/demo/flag';

export async function createArtifact(params: {
  sessionId?: string | null;
  planId?: string | null;
  title: string;
  type: 'html' | 'svg';
  content: string;
}) {
  if (isDemoMode()) {
    const demo = await import('./artifact-service.demo');
    return demo.createArtifact(params);
  }

  const [artifact] = await db
    .insert(artifacts)
    .values({
      sessionId: params.sessionId ?? null,
      planId: params.planId ?? null,
      title: params.title,
      type: params.type,
      content: params.content,
    })
    .returning();

  return artifact;
}

export async function getArtifact(id: string) {
  if (isDemoMode()) {
    const demo = await import('./artifact-service.demo');
    return demo.getArtifact(id);
  }

  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return artifact ?? null;
}

export async function listArtifactsBySession(sessionId: string) {
  if (isDemoMode()) {
    const demo = await import('./artifact-service.demo');
    return demo.listArtifactsBySession(sessionId);
  }

  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sessionId, sessionId))
    .orderBy(artifacts.createdAt);
}

export async function listArtifactsByPlan(planId: string) {
  if (isDemoMode()) {
    const demo = await import('./artifact-service.demo');
    return demo.listArtifactsByPlan(planId);
  }

  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.planId, planId))
    .orderBy(artifacts.createdAt);
}
