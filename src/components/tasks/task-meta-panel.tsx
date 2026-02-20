'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { assignAgentAction, updateTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { apiFetch } from '@/lib/api-types';
import type { Agent, Task } from '@/lib/types';
import { X as XIcon } from 'lucide-react';

interface TaskMetaPanelProps {
  task: {
    id: string;
    assigneeAgentId: string | null;
    parentTaskId: string | null;
    parentTask: { id: string; title: string } | null;
    dueAt: string | null;
    projectId?: string | null;
  };
}

export function TaskMetaPanel({ task }: TaskMetaPanelProps) {
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const projectsById = useTaskBoardStore((s) => s.projectsById);
  const [agents, setAgents] = useState<Agent[]>([]);

  // Parent task editing
  const [parentSearchOpen, setParentSearchOpen] = useState(false);
  const [parentQuery, setParentQuery] = useState('');
  const [parentResults, setParentResults] = useState<{ id: string; title: string }[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiFetch<{ data: Agent[] }>('/api/agents')
      .then((res) => setAgents(res.data.filter((a) => a.isActive && a.toolType === 'ai-agent')))
      .catch(() => {});
  }, []);

  // Debounced parent search
  useEffect(() => {
    if (!parentSearchOpen) return;
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(async () => {
      try {
        const url = `/api/tasks?limit=8${parentQuery ? `&q=${encodeURIComponent(parentQuery)}` : ''}`;
        const res = await apiFetch<{ data: { id: string; title: string }[]; meta: unknown }>(url);
        setParentResults((res.data ?? []).filter((t) => t.id !== task.id));
      } catch {
        setParentResults([]);
      }
    }, 250);

    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, [parentQuery, parentSearchOpen, task.id]);

  const handleAssign = async (agentId: string) => {
    const id = agentId === 'unassigned' ? null : agentId;
    const result = await assignAgentAction(task.id, id);
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  const handleProjectChange = async (v: string) => {
    const result = await updateTaskAction(task.id, { projectId: v === 'none' ? null : v });
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  const handleDueDateChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.value) return;
    const result = await updateTaskAction(task.id, { dueAt: new Date(e.target.value) });
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  const clearDue = async () => {
    const result = await updateTaskAction(task.id, { dueAt: null });
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  const handleSetParent = async (parentId: string) => {
    const result = await updateTaskAction(task.id, { parentTaskId: parentId });
    if (result.success) {
      updateTask(result.data as Task);
    }
    setParentSearchOpen(false);
    setParentQuery('');
  };

  const handleRemoveParent = async () => {
    const result = await updateTaskAction(task.id, { parentTaskId: null });
    if (result.success) {
      updateTask(result.data as Task);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xs uppercase tracking-widest text-muted-foreground/60 font-medium">
        Details
      </h3>

      {/* Assignee */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground/60">Assignee</span>
        <Select value={task.assigneeAgentId ?? 'unassigned'} onValueChange={handleAssign}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Project */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground/60">Project</span>
        <Select value={task.projectId ?? 'none'} onValueChange={handleProjectChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No project</SelectItem>
            {Object.values(projectsById).map((project) => (
              <SelectItem key={project.id} value={project.id}>
                <div className="flex items-center gap-2">
                  {project.color && (
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  )}
                  {project.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Due date */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground/60">Due date</span>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : ''}
            onChange={handleDueDateChange}
            className="text-sm font-mono bg-transparent border border-input rounded px-2 py-1 text-foreground/80 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {task.dueAt && (
            <button
              className="text-xs text-muted-foreground/60 hover:text-destructive"
              onClick={clearDue}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Parent task — editable */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground/60">Parent task</span>

        {task.parentTask ? (
          <div className="flex items-center justify-between rounded border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <span className="flex-1 truncate text-sm text-foreground/80">{task.parentTask.title}</span>
            <button
              className="ml-2 shrink-0 text-muted-foreground/40 hover:text-destructive transition-colors"
              aria-label="Remove parent"
              onClick={handleRemoveParent}
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <>
            {!parentSearchOpen ? (
              <button
                className="text-left text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors"
                onClick={() => { setParentSearchOpen(true); setParentQuery(''); }}
              >
                + Set parent task
              </button>
            ) : (
              <div className="flex flex-col gap-1">
                <input
                  autoFocus
                  type="text"
                  value={parentQuery}
                  onChange={(e) => setParentQuery(e.target.value)}
                  placeholder="Search tasks…"
                  className="w-full rounded border border-input bg-transparent px-2 py-1 text-sm text-foreground/80 placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                  onKeyDown={(e) => { if (e.key === 'Escape') setParentSearchOpen(false); }}
                />
                {parentResults.length > 0 && (
                  <div className="rounded border border-white/[0.08] bg-popover text-sm shadow-md">
                    {parentResults.map((r) => (
                      <button
                        key={r.id}
                        className="block w-full truncate px-2.5 py-1.5 text-left text-foreground/80 hover:bg-white/[0.06] transition-colors"
                        onClick={() => handleSetParent(r.id)}
                      >
                        {r.title}
                      </button>
                    ))}
                  </div>
                )}
                {parentResults.length === 0 && parentQuery && (
                  <p className="text-xs text-muted-foreground/40 px-1">No results</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
