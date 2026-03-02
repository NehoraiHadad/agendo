export const dynamic = 'force-dynamic';

import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { AnalyzeDashboardClient } from './analyze-dashboard-client';

export default async function AnalyzePage() {
  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      rootPath: projects.rootPath,
    })
    .from(projects)
    .where(eq(projects.isActive, true));

  return (
    <div className="flex flex-col h-full min-h-0">
      <AnalyzeDashboardClient projects={allProjects} />
    </div>
  );
}
