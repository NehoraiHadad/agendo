import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { db } from '@/lib/db';
import { agents } from '@/lib/db/schema';
import { BadRequestError } from '@/lib/errors';

const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const session = await getSession(id);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, session.agentId))
      .limit(1);
    const projectPath = agent?.workingDir ?? null;

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
  },
);

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const { type, content } = (await req.json()) as {
      type: 'global' | 'project';
      content: string;
    };

    if (type !== 'global' && type !== 'project') {
      throw new BadRequestError('type must be "global" or "project"');
    }

    const session = await getSession(id);

    let filePath: string;
    if (type === 'global') {
      filePath = GLOBAL_CLAUDE_MD;
    } else {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, session.agentId))
        .limit(1);
      if (!agent?.workingDir) {
        throw new BadRequestError('No project working directory configured for this agent');
      }
      filePath = path.join(agent.workingDir, 'CLAUDE.md');
    }

    await writeFile(filePath, content, 'utf-8');
    return NextResponse.json({ data: { saved: true } });
  },
);
