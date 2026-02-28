/* eslint-disable react-refresh/only-export-components */
export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { getPlan } from '@/lib/services/plan-service';
import { getProject } from '@/lib/services/project-service';
import { PlanDetailClient } from './plan-detail-client';
import type { Project } from '@/lib/types';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const plan = await getPlan(id);
    return { title: `${plan.title} — agenDo` };
  } catch {
    return { title: 'Plan — agenDo' };
  }
}

export default async function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let plan;
  try {
    plan = await getPlan(id);
  } catch {
    notFound();
  }

  let project: Project | null = null;
  try {
    project = await getProject(plan.projectId);
  } catch {
    // project may be missing — render without it
  }

  return <PlanDetailClient plan={plan} project={project} />;
}
