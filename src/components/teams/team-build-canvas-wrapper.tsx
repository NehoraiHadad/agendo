'use client';

import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useTeamCanvasStore } from '@/stores/team-canvas-store';
import { TeamBuildCanvas } from './team-build-canvas';

interface TeamBuildCanvasWrapperProps {
  taskId?: string;
  projectId?: string;
}

/**
 * Client-side wrapper that initializes the store with query params
 * and wraps the canvas in ReactFlowProvider.
 */
export function TeamBuildCanvasWrapper({ taskId, projectId }: TeamBuildCanvasWrapperProps) {
  const setParentTaskId = useTeamCanvasStore((s) => s.setParentTaskId);
  const setProjectId = useTeamCanvasStore((s) => s.setProjectId);

  useEffect(() => {
    if (taskId) setParentTaskId(taskId);
    if (projectId) setProjectId(projectId);
  }, [taskId, projectId, setParentTaskId, setProjectId]);

  return (
    <ReactFlowProvider>
      <TeamBuildCanvas />
    </ReactFlowProvider>
  );
}
