'use client';

import { useRouter } from 'next/navigation';
import type { Project } from '@/lib/types';
import { ProjectEditSheet } from './project-edit-sheet';

interface ProjectCardProps {
  project: Project;
  onUpdated: (project: Project) => void;
  onDeleted: (id: string) => void;
}

export function ProjectCard({ project, onUpdated, onDeleted }: ProjectCardProps) {
  const router = useRouter();
  const accentColor = project.color ?? '#6366f1';

  return (
    <div
      className="group relative flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-card p-4 transition-colors hover:border-white/[0.12] cursor-pointer"
      onClick={() => router.push(`/projects/${project.id}`)}
    >
      {/* Color accent bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg"
        style={{ backgroundColor: accentColor }}
      />

      <div className="pl-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {project.icon && <span className="text-lg leading-none shrink-0">{project.icon}</span>}
          {!project.icon && (
            <span
              className="size-5 rounded-full shrink-0"
              style={{ backgroundColor: accentColor }}
            />
          )}
          <span className="font-semibold text-sm truncate">{project.name}</span>
        </div>

        <div onClick={(e) => e.stopPropagation()}>
          <ProjectEditSheet project={project} onUpdated={onUpdated} onDeleted={onDeleted} />
        </div>
      </div>

      <div className="pl-2 space-y-1">
        <p className="font-mono text-xs text-muted-foreground truncate" title={project.rootPath}>
          {project.rootPath}
        </p>
        {project.description && (
          <p className="text-xs text-muted-foreground/80 line-clamp-2">{project.description}</p>
        )}
      </div>
    </div>
  );
}
