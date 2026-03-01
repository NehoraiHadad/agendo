import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { getAgentById } from '@/lib/services/agent-service';
import { BadRequestError } from '@/lib/errors';

const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Factory that builds GET and POST handlers for the memory API.
 * @param getAgentId - async function that receives the entity id and returns the agent id
 */
export function buildMemoryHandlers(getAgentId: (id: string) => Promise<string>) {
  const GET = async (
    _req: NextRequest,
    { params }: { params: Promise<Record<string, string>> },
  ) => {
    const { id } = await params;
    const agentId = await getAgentId(id);
    const agent = await getAgentById(agentId);
    const projectPath = agent.workingDir ?? null;

    const [globalContent, projectContent] = await Promise.all([
      readFileOrEmpty(GLOBAL_CLAUDE_MD),
      projectPath ? readFileOrEmpty(path.join(projectPath, 'CLAUDE.md')) : Promise.resolve(''),
    ]);

    return NextResponse.json({
      data: {
        global: globalContent,
        project: projectContent,
        projectPath,
      },
    });
  };

  const POST = async (
    req: NextRequest,
    { params }: { params: Promise<Record<string, string>> },
  ) => {
    const { id } = await params;
    const { type, content } = (await req.json()) as {
      type: 'global' | 'project';
      content: string;
    };

    if (type !== 'global' && type !== 'project') {
      throw new BadRequestError('type must be "global" or "project"');
    }

    let filePath: string;
    if (type === 'global') {
      filePath = GLOBAL_CLAUDE_MD;
    } else {
      const agentId = await getAgentId(id);
      const agent = await getAgentById(agentId);
      if (!agent.workingDir) {
        throw new BadRequestError('No project working directory configured for this agent');
      }
      filePath = path.join(agent.workingDir, 'CLAUDE.md');
    }

    await writeFile(filePath, content, 'utf-8');
    return NextResponse.json({ data: { saved: true } });
  };

  return { GET, POST };
}
