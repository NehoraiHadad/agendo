/**
 * Registers all agendo MCP tools on the given server instance.
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from './task-tools.js';
import { registerSubtaskTools } from './subtask-tools.js';
import { registerProgressTools } from './progress-tools.js';
import { registerProjectTools } from './project-tools.js';
import { registerSessionTools } from './session-tools.js';
import { registerSnapshotTools } from './snapshot-tools.js';
import { registerPlanTools } from './plan-tools.js';
import { registerArtifactTools } from './artifact-tools.js';
import { registerTeamTools } from './team-tools.js';

export function registerAll(server: McpServer): void {
  registerTaskTools(server);
  registerSubtaskTools(server);
  registerProgressTools(server);
  registerProjectTools(server);
  registerSessionTools(server);
  registerSnapshotTools(server);
  registerPlanTools(server);
  registerArtifactTools(server);
  registerTeamTools(server);
}

// Re-export handlers for testing
export {
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetMyTask,
  handleGetTask,
  handleSetExecutionOrder,
  handleListReadyTasks,
} from './task-tools.js';
export { handleCreateSubtask, handleListSubtasks } from './subtask-tools.js';
export { handleAddProgressNote, handleGetProgressNotes } from './progress-tools.js';
export { handleListProjects, handleGetProject } from './project-tools.js';
export { handleStartAgentSession, handleAssignTask } from './session-tools.js';
export { handleSaveSnapshot, handleUpdateSnapshot } from './snapshot-tools.js';
export { handleSavePlan } from './plan-tools.js';
export { handleRenderArtifact } from './artifact-tools.js';
export {
  handleCreateTeam,
  handleSendTeamMessage,
  handleGetTeamStatus,
  handleGetTeammates,
  buildTeamContextMessage,
} from './team-tools.js';
