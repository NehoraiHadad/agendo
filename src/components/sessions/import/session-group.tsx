'use client';

import { SessionEntryCard } from './session-entry-card';
import type { CliSessionEntry } from '@/lib/services/cli-import/types';

interface SessionGroupProps {
  projectPath: string;
  entries: CliSessionEntry[];
}

export function SessionGroup({ projectPath, entries }: SessionGroupProps) {
  const projectName = projectPath.split('/').pop() ?? projectPath;

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground/60">
        {projectName}
      </h3>
      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <SessionEntryCard key={entry.cliSessionId} entry={entry} />
        ))}
      </div>
    </div>
  );
}
