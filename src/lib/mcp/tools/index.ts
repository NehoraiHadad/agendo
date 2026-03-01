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

export function registerAll(server: McpServer): void {
  registerTaskTools(server);
  registerSubtaskTools(server);
  registerProgressTools(server);
  registerProjectTools(server);
  registerSessionTools(server);
  registerSnapshotTools(server);
}

// Re-export handlers for testing
export {
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetMyTask,
  handleGetTask,
} from './task-tools.js';
export { handleCreateSubtask } from './subtask-tools.js';
export { handleAddProgressNote } from './progress-tools.js';
export { handleListProjects, handleGetProject } from './project-tools.js';
export { handleStartAgentSession, handleAssignTask } from './session-tools.js';
export { handleSaveSnapshot, handleUpdateSnapshot } from './snapshot-tools.js';
