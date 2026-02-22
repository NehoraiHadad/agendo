import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { NextRequest, NextResponse } from 'next/server';
import {
  generateClaudeMcpConfig,
  generateCodexMcpConfig,
  generateGeminiMcpConfig,
} from '@/lib/mcp/config-templates';

const VALID_TOOLS = ['claude', 'codex', 'gemini'] as const;
type ToolName = (typeof VALID_TOOLS)[number];

function buildConfigs(serverPath: string) {
  return {
    claude: {
      format: 'json',
      filename: '~/.claude.json (user scope)',
      content: generateClaudeMcpConfig(serverPath),
    },
    codex: {
      format: 'toml',
      filename: '~/.codex/config.toml',
      content: generateCodexMcpConfig(serverPath),
    },
    gemini: {
      format: 'json',
      filename: '~/.gemini/settings.json',
      content: generateGeminiMcpConfig(serverPath),
    },
  };
}

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const serverPath =
    process.env.MCP_SERVER_PATH ??
    '/home/ubuntu/projects/agendo/dist/mcp-server.js';
  const tool = req.nextUrl.searchParams.get('tool') ?? 'all';

  const configs = buildConfigs(serverPath);

  if (tool !== 'all') {
    if (!VALID_TOOLS.includes(tool as ToolName)) {
      throw new BadRequestError(`Unknown tool '${tool}'. Valid values: ${VALID_TOOLS.join(', ')}`);
    }
    return NextResponse.json({ data: { [tool]: configs[tool as ToolName] } });
  }

  return NextResponse.json({ data: configs });
});
