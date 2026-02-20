CREATE INDEX idx_tasks_parent_status
  ON tasks(parent_task_id, status)
  WHERE parent_task_id IS NOT NULL;
