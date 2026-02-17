'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { addDependencyAction, removeDependencyAction } from '@/lib/actions/task-actions';
import { X as XIcon } from 'lucide-react';

interface Dep {
  id: string;
  title: string;
  status: string;
}

interface TaskDependenciesPanelProps {
  taskId: string;
}

export function TaskDependenciesPanel({ taskId }: TaskDependenciesPanelProps) {
  const [dependencies, setDependencies] = useState<Dep[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fetchedResults, setFetchedResults] = useState<Dep[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/tasks/${taskId}/dependencies`)
      .then((res) => res.json())
      .then((json) => setDependencies(json.data ?? []))
      .catch(() => {});
  }, [taskId]);

  // Derive visible search results: show fetched results only when query is non-empty
  const searchResults = useMemo(
    () => (searchQuery.trim() ? fetchedResults : []),
    [searchQuery, fetchedResults],
  );

  const searchTasks = useCallback(async (currentTaskId: string, currentDeps: Dep[]) => {
    try {
      const res = await fetch('/api/tasks?limit=10');
      const json = await res.json();
      const existing = new Set([currentTaskId, ...currentDeps.map((d) => d.id)]);
      setFetchedResults((json.data ?? []).filter((t: Dep) => !existing.has(t.id)));
    } catch {
      setFetchedResults([]);
    }
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) return;

    const timeout = setTimeout(() => {
      searchTasks(taskId, dependencies);
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchQuery, taskId, dependencies, searchTasks]);

  const handleAdd = async (depId: string) => {
    setError(null);
    const result = await addDependencyAction({
      taskId,
      dependsOnTaskId: depId,
    });

    if (result.success) {
      const added = searchResults.find((r) => r.id === depId);
      if (added) {
        setDependencies((prev) => [...prev, added]);
      }
      setIsAdding(false);
      setSearchQuery('');
    } else {
      setError(result.error);
    }
  };

  const handleRemove = async (depId: string) => {
    const result = await removeDependencyAction(taskId, depId);
    if (result.success) {
      setDependencies((prev) => prev.filter((d) => d.id !== depId));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Blocked By</h3>
        <Button variant="ghost" size="sm" onClick={() => setIsAdding(true)}>
          + Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {dependencies.map((dep) => (
        <div key={dep.id} className="flex items-center justify-between rounded border px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm">{dep.title}</span>
            <Badge variant="outline" className="text-xs">
              {dep.status}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => handleRemove(dep.id)}
          >
            <XIcon className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {dependencies.length === 0 && !isAdding && (
        <p className="text-sm text-muted-foreground">No dependencies</p>
      )}

      {isAdding && (
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setIsAdding(false);
                setSearchQuery('');
              }
            }}
          />
          {searchResults.map((result) => (
            <button
              key={result.id}
              className="rounded border px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => handleAdd(result.id)}
            >
              {result.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
