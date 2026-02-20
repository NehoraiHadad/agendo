'use client';

import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignAgentAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { Agent, Task } from '@/lib/types';

interface TaskMetaPanelProps {
  task: {
    id: string;
    assigneeAgentId: string | null;
    parentTask: { id: string; title: string } | null;
    dueAt: string | null;
  };
}

export function TaskMetaPanel({ task }: TaskMetaPanelProps) {
  const updateTask = useTaskBoardStore((s) => s.updateTask);
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

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xs uppercase tracking-widest text-muted-foreground/60 font-medium">
        Details
      </h3>

      {/* Assignee — full width on mobile, label above */}
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

      {task.parentTask && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground/60">Parent task</span>
          <span className="text-sm text-foreground/80">{task.parentTask.title}</span>
        </div>
      )}

      {task.dueAt && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground/60">Due date</span>
          <span className="text-sm font-mono text-foreground/80">
            {new Date(task.dueAt).toLocaleDateString()}
          </span>
        </div>
      )}
    </div>
  );
}
