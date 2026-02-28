'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Globe, FolderOpen } from 'lucide-react';

interface ProjectOption {
  id: string;
  name: string;
  rootPath: string;
}

interface ConfigScopeSelectorProps {
  scope: string;
  projects: ProjectOption[];
  onChange: (scope: string) => void;
}

export function ConfigScopeSelector({ scope, projects, onChange }: ConfigScopeSelectorProps) {
  return (
    <Select value={scope} onValueChange={onChange}>
      <SelectTrigger
        className="h-8 text-xs border-white/[0.08] bg-[oklch(0.10_0_0)] hover:bg-[oklch(0.12_0_0)] focus:ring-0 focus:ring-offset-0 focus:border-white/[0.15] transition-colors gap-2"
        aria-label="Config scope"
      >
        <div className="flex items-center gap-2 min-w-0">
          {scope === 'global' ? (
            <Globe className="h-3 w-3 text-violet-400 shrink-0" />
          ) : (
            <FolderOpen className="h-3 w-3 text-cyan-400 shrink-0" />
          )}
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent className="border-white/[0.08] bg-[oklch(0.10_0_0)]">
        <SelectItem
          value="global"
          className="text-xs cursor-pointer focus:bg-white/[0.06] data-[state=checked]:text-violet-400"
        >
          <div className="flex items-center gap-2">
            <Globe className="h-3 w-3 text-violet-400 shrink-0" />
            <span>Global (~/.claude/)</span>
          </div>
        </SelectItem>
        {projects.map((project) => (
          <SelectItem
            key={project.id}
            value={project.rootPath}
            className="text-xs cursor-pointer focus:bg-white/[0.06] data-[state=checked]:text-cyan-400"
          >
            <div className="flex items-center gap-2">
              <FolderOpen className="h-3 w-3 text-cyan-400 shrink-0" />
              <span className="truncate max-w-[160px]">{project.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
