/**
 * agenDo MCP Server — standalone Node.js process (stdio transport).
 * All logging goes to stderr; stdout is reserved for JSON-RPC.
 *
 * IMPORTANT: No `@/` path aliases — this file is bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAll } from './tools/index.js';

const AGENDO_URL = process.env.AGENDO_URL ?? 'http://localhost:4100';

function log(msg: string): void {
  process.stderr.write(`[agendo-mcp] ${msg}\n`);
}

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
  log(`Starting MCP server (API: ${AGENDO_URL})`);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server connected via stdio');
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
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
  handleAddProgressNote,
  handleListProjects,
  handleGetProject,
  handleStartAgentSession,
  handleAssignTask,
  handleSaveSnapshot,
  handleUpdateSnapshot,
} from './tools/index.js';
export { apiCall, resolveAgentSlug, parsePriority } from './tools/shared.js';
