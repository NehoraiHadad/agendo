'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import { Loader2, Search, Terminal } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-types';
import { SessionGroup } from './session-group';
import type { CliSessionEntry } from '@/lib/services/cli-import/types';

export function ImportSessionDialog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CliSessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const fetchIdRef = useRef(0);

  const fetchSessions = useCallback(() => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    apiFetch<{ data: CliSessionEntry[] }>('/api/cli-sessions?hideImported=false')
      .then((res) => {
        if (fetchIdRef.current === id) setEntries(res.data);
      })
      .catch(console.error)
      .finally(() => {
        if (fetchIdRef.current === id) setLoading(false);
      });
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) fetchSessions();
    },
    [fetchSessions],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.firstPrompt?.toLowerCase().includes(q) ||
        e.projectPath.toLowerCase().includes(q) ||
        e.gitBranch?.toLowerCase().includes(q),
    );
  }, [entries, search]);

  // Group by projectPath
  const groups = useMemo(() => {
    const map = new Map<string, CliSessionEntry[]>();
    for (const entry of filtered) {
      const arr = map.get(entry.projectPath) ?? [];
      arr.push(entry);
      map.set(entry.projectPath, arr);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-white/[0.1] gap-1.5">
          <Terminal className="size-3.5" />
          Import from Terminal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import from Terminal</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
          <Input
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 border-white/[0.08] bg-white/[0.04]"
          />
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 min-h-0 pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground/50" />
            </div>
          ) : groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground/50">
              No CLI sessions found.
            </p>
          ) : (
            groups.map(([projectPath, groupEntries]) => (
              <SessionGroup key={projectPath} projectPath={projectPath} entries={groupEntries} />
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
