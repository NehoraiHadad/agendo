import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { ConflictError, BadRequestError } from '@/lib/errors';
import { db } from '@/lib/db';
import { agents, agentCapabilities, sessions, projects } from '@/lib/db/schema';
import { createSession } from '@/lib/services/session-service';
import { createTask } from '@/lib/services/task-service';
import { convertClaudeJsonl, writeImportedLog } from '@/lib/services/cli-import';

const importSchema = z.object({
  cliSessionId: z.string().min(1),
  jsonlPath: z.string().min(1),
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  projectPath: z.string().optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = importSchema.parse(await req.json());

  // Validate JSONL file exists
  if (!existsSync(body.jsonlPath)) {
    throw new BadRequestError('JSONL file not found', { path: body.jsonlPath });
  }

  // Check not already imported
  const [existing] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.sessionRef, body.cliSessionId))
    .limit(1);

  if (existing) {
    throw new ConflictError('Session already imported', { sessionId: existing.id });
  }

  // Find Claude agent + prompt capability
  const [claudeAgent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, 'claude-code-1'))
    .limit(1);

  if (!claudeAgent) {
    throw new BadRequestError('Claude agent not found. Please register a Claude agent first.');
  }

  const [capability] = await db
    .select({ id: agentCapabilities.id })
    .from(agentCapabilities)
    .where(
      and(
        eq(agentCapabilities.agentId, claudeAgent.id),
        eq(agentCapabilities.interactionMode, 'prompt'),
      ),
    )
    .limit(1);

  if (!capability) {
    throw new BadRequestError('Claude prompt capability not found.');
  }

  // Convert JSONL
  const { events, metadata } = convertClaudeJsonl(body.jsonlPath, 'placeholder');

  // Resolve project
  let projectId = body.projectId ?? null;
  if (!projectId && body.projectPath) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.rootPath, body.projectPath))
      .limit(1);
    if (project) projectId = project.id;
  }

  // Resolve or create task
  let taskId = body.taskId ?? null;
  if (!taskId) {
    const title = metadata.firstPrompt
      ? metadata.firstPrompt.slice(0, 80)
      : `Imported CLI session ${body.cliSessionId.slice(0, 8)}`;
    const task = await createTask({
      title,
      description: `Imported from Claude CLI session ${body.cliSessionId}`,
      status: 'in_progress',
      projectId: projectId ?? undefined,
      isAdHoc: true,
    });
    taskId = task.id;
  }

  // Create session row
  const session = await createSession({
    taskId,
    agentId: claudeAgent.id,
    capabilityId: capability.id,
    model: metadata.model ?? undefined,
  });

  // Re-stamp events with actual sessionId
  for (const event of events) {
    event.sessionId = session.id;
  }

  // Write log file
  const logPath = writeImportedLog(session.id, events);

  // Update session with metadata
  await db
    .update(sessions)
    .set({
      sessionRef: body.cliSessionId,
      status: 'idle',
      logFilePath: logPath,
      totalTurns: metadata.totalTurns,
      eventSeq: events.length,
      title: metadata.firstPrompt ? metadata.firstPrompt.slice(0, 80) : null,
      model: metadata.model,
    })
    .where(eq(sessions.id, session.id));

  return NextResponse.json({ data: { sessionId: session.id, taskId } }, { status: 201 });
});
