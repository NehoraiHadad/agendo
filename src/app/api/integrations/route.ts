import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql, isNull } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';
import { NotFoundError } from '@/lib/errors';
import { createTask, updateTask } from '@/lib/services/task-service';
import { createAndEnqueueSession } from '@/lib/services/session-helpers';
import { getOrCreateSystemProject } from '@/lib/services/project-service';
import { db } from '@/lib/db';
import { agents, tasks } from '@/lib/db/schema';
import { eq, and, like } from 'drizzle-orm';

const postSchema = z.object({
  // Free-form: URL, package name, or natural language description
  source: z.string().min(3).max(2000),
  title: z.string().min(1).max(500).optional(),
  // Optional: pin to a specific agent; falls back to first available repo-planner
  agentId: z.string().uuid().optional(),
});

/**
 * Derives a slug for the integration name from the source string.
 * - URL  → last non-empty path segment (e.g. "linear-mcp")
 * - Text → first 3 meaningful words, joined with "-"
 */
function deriveIntegrationName(source: string): string {
  try {
    const url = new URL(source);
    const parts = url.pathname.replace(/^\//, '').replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
  } catch {
    // not a URL
  }
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join('-') || 'integration'
  );
}

/**
 * Builds the planner prompt for an integration session.
 *
 * The planner researches the source, creates subtasks, saves a plan, then
 * spawns a separate Implementer session via start_agent_session.
 * The Implementer executes the subtasks and commits — the Planner never writes code.
 */
function buildIntegrationDescription(source: string): string {
  return `## Your role: Integration Planner

You research the source, decide how to integrate it into Agendo, create concrete subtasks, save a plan, then spawn an Implementer agent to do the actual coding. You do NOT write code yourself.

---

## What to integrate
${source}

If the auto-derived task title does not accurately reflect what you're integrating, call update_task with a better title (e.g. "Integrate: <proper-name>").

---

## Agendo codebase — key facts

- Next.js 16 App Router at \`/home/ubuntu/projects/agendo\`
- API routes: \`src/app/api/\` — use \`withErrorBoundary\`, named exports only
- UI pages: \`src/app/(dashboard)/\`
- UI components: \`src/components/\` — shadcn/ui + Tailwind CSS
- Services: \`src/lib/services/\`
- DB: Drizzle ORM + PostgreSQL (\`src/lib/db/schema.ts\`)
- Build check: \`pnpm lint && pnpm typecheck\` (zero warnings — must pass before commit)
- PM2: \`pm2 restart agendo\` (port 4100)

---

## Integration decision framework

**Read the actual source first.** Do NOT guess. Fetch README, main source files, key scripts from GitHub raw URLs before deciding anything.

**Embedding strategy (choose based on what you read):**

| What the repo provides | Strategy |
|---|---|
| npm/JS package | Install + import directly |
| React components | Copy or install, embed in right page |
| Plain HTML/JS UI | Port to React — don't iframe |
| Python/CLI tool | Call via \`child_process\` from API route (on-demand, not a daemon) |
| Logic only | Port to TypeScript from the actual source |

**Where it lives:**
- New feature → \`src/app/(dashboard)/[name]/page.tsx\`
- Extension of existing page → add a tab (e.g. in \`/config\`, \`/settings\`)
- Background utility → \`src/lib/services/\` or \`src/lib/utils/\`
- New API → \`src/app/api/[name]/route.ts\`

**No extra servers.** Replace any built-in HTTP server with a Next.js API route.

---

## Planner workflow

1. \`get_my_task\` — save your taskId, read what to integrate
2. Fetch the actual repo files (README, source files) from GitHub raw URLs
3. Read relevant Agendo files to understand existing patterns
4. \`create_subtask\` × 2–5 — one per coherent chunk of work. Each subtask must include:
   - Exact file paths to create or modify
   - Exact commands to run (install, build, etc.)
   - What the end result should look like
5. \`save_plan\` — full implementation brief: architecture decision, embedding strategy, file list, code snippets the Implementer needs
6. \`start_agent_session\` — spawn the Implementer:
   \`\`\`
   agent: "claude-code-1"
   taskId: <your taskId from step 1>
   permissionMode: "bypassPermissions"
   initialPrompt: "You are an Integration Implementer. Call get_my_task to read the integration plan and list_tasks (filter by parentTaskId) to get your subtasks. Execute each subtask in order — mark each done as you finish it. Run pnpm lint && pnpm typecheck and fix all errors. Commit with git. Mark the parent task done when complete."
   \`\`\`
7. \`update_task\` → \`in_progress\` — planning done; Implementer takes over`;
}

/**
 * GET /api/integrations
 * Lists all integration tasks under the system project.
 */
export const GET = withErrorBoundary(async () => {
  const systemProject = await getOrCreateSystemProject();
  const integrationTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, systemProject.id),
        sql`${tasks.inputContext}->'args'->>'integrationName' IS NOT NULL`,
        isNull(tasks.parentTaskId),
        like(tasks.title, 'Integrate:%'),
      ),
    )
    .orderBy(sql`${tasks.createdAt} DESC`);
  return NextResponse.json({ data: integrationTasks });
});

/**
 * POST /api/integrations
 *
 * Kicks off an integration analysis run:
 * 1. Derives an integration name from the source.
 * 2. Uses the built-in Agendo System project.
 * 3. Creates a planning task and enqueues a repo-planner session.
 * Returns { data: { taskId, sessionId } } with 201.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { source, title, agentId: requestedAgentId } = postSchema.parse(body);

  const integrationName = deriveIntegrationName(source);
  const systemProject = await getOrCreateSystemProject();

  const agentRow = requestedAgentId
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, requestedAgentId), eq(agents.isActive, true)))
        .limit(1)
        .then((r) => r[0] ?? null)
    : // Prefer Claude (slug contains 'claude') — best for autonomous codebase integration
      await db
        .select({ id: agents.id, slug: agents.slug })
        .from(agents)
        .where(and(eq(agents.isActive, true), eq(agents.toolType, 'ai-agent')))
        .then((rows) => rows.find((r) => r.slug.includes('claude')) ?? rows[0] ?? null);

  if (!agentRow) {
    throw new NotFoundError('Agent', requestedAgentId ?? 'active ai-agent');
  }
  const agentId = agentRow.id;

  const task = await createTask({
    title: title ?? `Integrate: ${integrationName}`,
    description: buildIntegrationDescription(source),
    projectId: systemProject.id,
    assigneeAgentId: agentId,
    inputContext: {
      args: {
        source,
        integrationName,
      },
    },
  });

  const session = await createAndEnqueueSession({
    taskId: task.id,
    projectId: systemProject.id,
    kind: 'integration',
    agentId,
    permissionMode: 'plan',
  });

  // Store sessionId so the UI can link to the planner session.
  await updateTask(task.id, {
    inputContext: { args: { source, integrationName, sessionId: session.id } },
  });

  return NextResponse.json({ data: { taskId: task.id, sessionId: session.id } }, { status: 201 });
});
