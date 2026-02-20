'use client';

import { useEffect, useState } from 'react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { assignAgentAction, updateTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Agent, Task } from '@/lib/types';

interface TaskMetaPanelProps {
  task: {
    id: string;
    assigneeAgentId: string | null;
    parentTask: { id: string; title: string } | null;
    dueAt: string | null;
    projectId?: string | null;
  };
}

export function TaskMetaPanel({ task }: TaskMetaPanelProps) {
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const projectsById = useTaskBoardStore((s) => s.projectsById);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    apiFetch<ApiResponse<Agent[]>>('/api/agents')
      .then((res) => setAgents(res.data.filter((a) => a.isActive && a.toolType === 'ai-agent')))
      .catch(() => {});
  }, []);

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

      {task.parentTask && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground/60">Parent task</span>
          <span className="text-sm text-foreground/80">{task.parentTask.title}</span>
        </div>
      )}
    </div>
  );
}
