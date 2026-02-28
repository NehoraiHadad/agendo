/* eslint-disable react-refresh/only-export-components */
export const dynamic = 'force-dynamic';

import { listPlans } from '@/lib/services/plan-service';
import { listProjects } from '@/lib/services/project-service';
import { PlansListClient } from './plans-list-client';

export const metadata = { title: 'Plans — agenDo' };

export default async function PlansPage() {
  const [plans, projects] = await Promise.all([listPlans({ limit: 100 }), listProjects(true)]);

  return <PlansListClient plans={plans} projects={projects} />;
}
