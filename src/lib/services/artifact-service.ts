import { db } from '@/lib/db';
import { artifacts } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function createArtifact(params: {
  sessionId?: string | null;
  planId?: string | null;
  title: string;
  type: 'html' | 'svg';
  content: string;
}) {
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
  const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return artifact ?? null;
}

export async function listArtifactsBySession(sessionId: string) {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sessionId, sessionId))
    .orderBy(artifacts.createdAt);
}

export async function listArtifactsByPlan(planId: string) {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.planId, planId))
    .orderBy(artifacts.createdAt);
}
