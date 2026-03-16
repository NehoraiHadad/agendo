/**
 * agenDo MCP Server — standalone Node.js process (stdio transport).
 * All logging goes to stderr; stdout is reserved for JSON-RPC.
 *
 * IMPORTANT: No `@/` path aliases — this file is bundled with esbuild.
 */

import pino from 'pino';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAll } from './tools/index.js';

const AGENDO_URL = process.env.AGENDO_URL ?? 'http://localhost:4100';

// Logs MUST go to stderr (fd 2) — stdout is the JSON-RPC protocol channel.
const log = pino(
  { level: process.env.LOG_LEVEL ?? 'info', base: { service: 'agendo-mcp' } },
  pino.destination({ dest: 2, sync: true }),
);

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: 'agendo',
    version: '1.0.0',
  });

  registerAll(server);

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log.info({ agendoUrl: AGENDO_URL }, 'Starting MCP server');

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info('MCP server connected via stdio');
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Re-exports for testing (handlers live in tools/)
// ---------------------------------------------------------------------------

export {
  handleCreateTask,
  handleUpdateTask,
  handleListTasks,
  handleGetMyTask,
  handleGetTask,
  handleCreateSubtask,
  handleListSubtasks,
  handleAddProgressNote,
  handleGetProgressNotes,
  handleListProjects,
  handleGetProject,
  handleStartAgentSession,
  handleAssignTask,
  handleSaveSnapshot,
  handleUpdateSnapshot,
  handleSavePlan,
  handleSetExecutionOrder,
  handleListReadyTasks,
  handleRenderArtifact,
} from './tools/index.js';
export {
  apiCall,
  apiCallWithMeta,
  resolveAgentSlug,
  resolveTaskId,
  parsePriority,
  AGENT_NOTE,
} from './tools/shared.js';
