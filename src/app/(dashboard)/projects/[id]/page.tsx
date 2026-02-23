export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProjectHubClient } from '@/components/projects/project-hub-client';
import { getProject } from '@/lib/services/project-service';
import { listTasksByStatus } from '@/lib/services/task-service';
import { listSessionsByProject } from '@/lib/services/session-service';
import { listAgents } from '@/lib/services/agent-service';
import { NotFoundError } from '@/lib/errors';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let project;
  try {
    project = await getProject(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [{ tasks: openTasks }, recentSessions, allAgents] = await Promise.all([
    listTasksByStatus({ projectId: id, limit: 10 }),
    listSessionsByProject(id, 5),
    listAgents({ group: 'ai' }),
  ]);

  const activeAgents = allAgents.filter((a) => a.isActive);

  return (
    <div className="flex flex-col gap-6">
      {/* Nav */}
      <div className="flex items-center gap-2">
        <Link href="/projects">
          <Button variant="ghost" size="icon" className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <span className="text-sm text-muted-foreground">Projects</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-sm font-medium truncate">{project.name}</span>
        <div className="ml-auto">
          <Link href="/projects">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit project">
              <Pencil className="size-3.5" />
            </Button>
          </Link>
        </div>
      </div>

      <ProjectHubClient
        project={project}
        recentSessions={recentSessions}
        openTasks={openTasks}
        agents={activeAgents}
      />
    </div>
  );
}
