'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Project } from '@/lib/types';
import { ProjectCard } from './project-card';
import { ProjectCreateDialog } from './project-create-dialog';
import { DeletedProjectCard } from './deleted-project-card';

interface ProjectsClientProps {
  initialProjects: Project[];
  initialDeletedProjects: Project[];
}

export function ProjectsClient({ initialProjects, initialDeletedProjects }: ProjectsClientProps) {
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [deletedProjects, setDeletedProjects] = useState<Project[]>(initialDeletedProjects);
  const [showDeleted, setShowDeleted] = useState(false);

  function handleCreated(project: Project) {
    setProjects((prev) => [project, ...prev]);
  }

  function handleUpdated(updated: Project) {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleDeleted(id: string) {
    setProjects((prev) => {
      const project = prev.find((p) => p.id === id);
      if (project) {
        setDeletedProjects((d) => [project, ...d]);
      }
      return prev.filter((p) => p.id !== id);
    });
  }

  function handleRestored(project: Project) {
    setDeletedProjects((prev) => prev.filter((p) => p.id !== project.id));
    setProjects((prev) => [project, ...prev]);
  }

  function handlePurged(id: string) {
    setDeletedProjects((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Projects</h1>
        <div className="flex items-center gap-2">
          {deletedProjects.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowDeleted((v) => !v)}
            >
              {showDeleted ? (
                <ChevronUp className="size-4 mr-1.5" />
              ) : (
                <ChevronDown className="size-4 mr-1.5" />
              )}
              {showDeleted ? 'Hide deleted' : 'Show deleted'} ({deletedProjects.length})
            </Button>
          )}
          <ProjectCreateDialog onCreated={handleCreated} />
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            No projects yet. Create one to start organizing your tasks by codebase.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}

      {showDeleted && deletedProjects.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Deleted projects</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {deletedProjects.map((project) => (
              <DeletedProjectCard
                key={project.id}
                project={project}
                onRestored={handleRestored}
                onPurged={handlePurged}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
