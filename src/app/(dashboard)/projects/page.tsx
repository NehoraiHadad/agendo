export const dynamic = 'force-dynamic';

import { listProjects } from '@/lib/services/project-service';
import { ProjectsClient } from '@/components/projects/projects-client';

export default async function ProjectsPage() {
  const projects = await listProjects();
  return <ProjectsClient initialProjects={projects} />;
}
