'use client';

interface TaskExecutionHistoryProps {
  taskId: string;
}

export function TaskExecutionHistory(_props: TaskExecutionHistoryProps) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Execution History</h3>
      <p className="text-sm text-muted-foreground">
        No executions yet. Execution support will be available after agent capabilities are
        configured.
      </p>
    </div>
  );
}
