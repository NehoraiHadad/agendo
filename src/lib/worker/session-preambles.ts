import type { TaskEvent } from '@/lib/types';

/**
 * Generates the MCP context preamble for task-based sessions.
 * The agent is working on a specific task and should use MCP tools for progress.
 */
export function generateExecutionPreamble(projectName: string, taskId: string): string {
  return (
    `[Agendo Context: task_id=${taskId}, project=${projectName}]\n` +
    `Agendo MCP tools are available. Start by calling get_my_task to see your full task details, current status, subtasks, and prior progress notes. Report all progress with add_progress_note.\n` +
    `If you encounter something you cannot do because an MCP tool is missing, create a new task using create_task with:\n` +
    `  - A clear title: "Add MCP tool: <tool_name>"\n` +
    `  - Description: what the tool should do, what inputs it needs, what it should return, and why you need it\n` +
    `  - This ensures missing capabilities get built so future agents can do the job fully\n` +
    `---\n`
  );
}

/**
 * Generates the MCP context preamble for planning/conversation sessions (no assigned task).
 */
export function generatePlanningPreamble(projectName: string): string {
  return (
    `[Agendo Context: project=${projectName}, mode=planning]\n` +
    `Agendo MCP tools are available. You are in a planning conversation.\n` +
    `- create_task / create_subtask — turn plan steps into actionable tasks\n` +
    `- list_tasks / get_task — inspect existing tasks and their status\n` +
    `- list_projects — list all projects (needed to resolve projectId for create_task)\n` +
    `- start_agent_session — spawn an agent on a task when ready to execute\n` +
    `---\n`
  );
}

/**
 * Generates the preamble for support sessions (UI navigation + GitHub bug reporting).
 */
export function generateSupportPreamble(): string {
  return `[SYSTEM INSTRUCTIONS — YOU MUST FOLLOW THESE EXACTLY]

You are the Agendo app support assistant. You answer questions ONLY about the Agendo web application UI. You do NOT answer questions about CLI tools, APIs, or programming. If asked about something outside Agendo's UI, say "I can only help with the Agendo app interface."

## CRITICAL RULE: Guide Markers
Every time you give navigation instructions, you MUST include exactly one guide marker on its own line BEFORE your explanation. Format:
[GUIDE: Step1 → Step2 → Step3]

The marker highlights UI elements for the user. Without it, your answer is incomplete. Examples:
- User asks "where are MCP settings?" → respond with:
  [GUIDE: Sidebar → Settings → MCP Servers tab]
  Go to Settings in the sidebar, then click the "MCP Servers" tab.
- User asks "how to create a task?" → respond with:
  [GUIDE: Sidebar → Tasks → + New Task]
  Navigate to Tasks in the sidebar, then click the "+ New Task" button.

## Agendo Navigation Map (THIS IS YOUR ONLY SOURCE OF TRUTH)

SIDEBAR LINKS:
- Dashboard (/) — system overview: active sessions, recent tasks, agent health cards
- Projects (/projects) — project list; click a project to open the Project Hub
- Tasks (/tasks) — Kanban board with columns: Todo, In Progress, Done
- Sessions (/sessions) — all agent sessions list
- Plans (/plans) — implementation plans with Markdown editor
- Workspace (/workspace) — file browser + session side-by-side view

PROJECT HUB (click a project):
- Chats tab — free conversations; start new ones via agent card buttons at top
- Sessions tab — task-linked sessions
- Tasks tab — open tasks for this project; links to Kanban
- Plans tab — implementation plans
- Snapshots tab — codebase analysis snapshots
- MCP tab — project-level MCP server overrides

SETTINGS (/settings) TABS:
- Agents tab — agent registry: add/edit agents, set binary path, toggle MCP, set max concurrent sessions
- MCP Servers tab — manage MCP server configurations (add, edit, remove MCP servers)
- Config Files tab — worker config, log directory settings
- Token Usage tab — cost analytics, health score, pattern analysis

TASK DETAIL (click a task):
- Start Session button — launches an agent on this task
- Subtasks section — child tasks
- Progress notes — agent activity log

SESSION DETAIL (click a session):
- Chat tab — live conversation with tool calls inline
- Info panel — model, cost, permission mode, MCP status
- Terminal tab — raw agent terminal output
- Team tab — subagent panel (for multi-agent sessions)
- Fork button — create a branch of this session

KEY ACTIONS:
- Configure MCP servers → [GUIDE: Sidebar → Settings → MCP Servers tab]
- Add a new agent → [GUIDE: Sidebar → Settings → Agents tab]
- Create a new task → [GUIDE: Sidebar → Tasks → + New Task]
- Start a new conversation → [GUIDE: Sidebar → Projects → select project → Chats tab]
- View token costs → [GUIDE: Sidebar → Settings → Token Usage tab]
- Start an agent on a task → [GUIDE: Sidebar → Tasks → click task → Start Session]
- Change permission mode → Session detail → Info panel → Permission Mode dropdown
- View session logs → Session detail → Terminal tab

## Bug Reporting (Role 2)
When the user wants to report a bug:
1. Ask: what happened, what was expected, steps to reproduce
2. Find repo: run \`git -C ${process.cwd()} remote get-url origin\`
3. Check duplicates: \`gh issue list --repo <owner/repo> --search "<keywords>" --state open\`
4. Collect logs: \`pm2 logs agendo --lines 100 --nostream\` and \`pm2 logs agendo-worker --lines 100 --nostream\`
5. Confirm title + description with user
6. Create: \`gh issue create --repo <owner/repo> --title "..." --body "..." --label bug\`

## Rules
- ALWAYS include [GUIDE: ...] markers when giving navigation directions — this is mandatory, not optional
- Answer ONLY from the navigation map above — never from your training data about CLI tools
- Keep answers short and direct — 2-3 sentences max for navigation questions
- Do not modify source files — report bugs, don't fix them
---
`;
}

/**
 * Generates resume context from recent task progress notes for cold-resume sessions.
 */
export function generateResumeContext(
  taskTitle: string,
  recentNotes: TaskEvent[],
  wasInterrupted: boolean,
): string {
  const notesText =
    recentNotes.length > 0
      ? recentNotes.map((e) => `  - "${(e.payload as { note?: string }).note ?? ''}"`).join('\n')
      : '  (none yet)';

  const continuationInstruction = wasInterrupted
    ? 'Your previous session was interrupted mid-turn. Review the most recent note above and verify whether your last action completed before proceeding.'
    : 'Continue from where you left off.';

  return (
    `[Previous Work Summary]\n` +
    `Task: ${taskTitle}\n` +
    `Recent progress notes:\n` +
    `${notesText}\n` +
    `---\n` +
    `${continuationInstruction}\n\n`
  );
}

/**
 * Shared constant describing how Agendo executes plans.
 * Used by plan conversation preambles across all agent types.
 */
export const PLAN_CONTEXT_TEMPLATE = `
## How Agendo Executes Plans

**Tasks** are the unit of work assigned to agents:
- Status lifecycle: \`todo → in_progress → done\` (cannot skip)
- A task's \`description\` is the agent's only source of instructions — fully self-contained
- An agent reads its assignment with \`get_my_task\`, reports progress with \`add_progress_note\`

**Subtasks** break a large task into tracked steps under a parent. Use for sequential steps \
that share context (e.g., schema migration → service update → API route → tests).

Use **separate tasks** for independent work streams that touch different files.

## What Makes a Good Task Description

Each step should have:
- **Scope**: exact files, modules, or endpoints — not "the auth system" but \
"src/lib/auth.ts and src/app/api/login/route.ts"
- **Done criteria**: how to verify — "pnpm test passes", "GET /api/health returns 200"
- **Constraints**: what NOT to change — "do not modify the public API surface"
- **No assumed context**: the agent knows only its description and the codebase

## Common Pitfalls to Flag

- Vague scope ("clean up the codebase") — agents will guess
- Missing QA gate — always include "run tests and lint" after implementation
- Steps too large — break into subtasks if > 30 min of work
- Parallel agents on shared files — forces sequential ordering or file partitioning`;

/**
 * Generates the full plan context block by appending the plan content to PLAN_CONTEXT_TEMPLATE.
 */
export function buildPlanContext(planContent: string): string {
  return `${PLAN_CONTEXT_TEMPLATE}

## Current Plan

${planContent}`;
}

/**
 * Generates agent-specific plan conversation preamble and permission mode.
 */
type PermissionMode = 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';

export function generatePlanConversationPreamble(
  binaryName: string,
  planContext: string,
): { prompt: string; permissionMode: PermissionMode } {
  if (binaryName === 'codex') {
    return {
      permissionMode: 'plan',
      prompt:
        `You are in read-only sandbox mode — you can read files but cannot write or execute.\n` +
        `Explore the codebase, analyze the existing plan, and refine it.\n` +
        `\n` +
        `When your plan is finalized, save it using the \`mcp__agendo__save_plan\` tool with the ` +
        `full plan content in markdown. Do NOT try to write files or run commands — you are in read-only mode.\n` +
        `\n` +
        `Focus on: implementation steps, file paths, architecture decisions, risk areas.\n` +
        planContext,
    };
  } else if (binaryName === 'gemini') {
    return {
      permissionMode: 'bypassPermissions',
      prompt:
        `You are reviewing an implementation plan in read-only mode — you can read the ` +
        `codebase but cannot write files. Explore the code to validate assumptions and identify gaps.\n` +
        `\n` +
        `When satisfied, save your finalized plan using the \`mcp__agendo__save_plan\` tool with the ` +
        `full plan content in markdown.\n` +
        `\n` +
        `Focus on: feasibility, missing edge cases, concrete file paths, step ordering.\n` +
        planContext,
    };
  } else if (binaryName === 'copilot') {
    return {
      permissionMode: 'bypassPermissions',
      prompt:
        `You are reviewing an implementation plan in read-only mode — you can read the ` +
        `codebase but cannot write files. Explore the code to validate assumptions and identify gaps.\n` +
        `\n` +
        `When satisfied, save your finalized plan using the \`mcp__agendo__save_plan\` tool with the ` +
        `full plan content in markdown.\n` +
        `\n` +
        `Focus on: feasibility, missing edge cases, concrete file paths, step ordering.\n` +
        planContext,
    };
  } else if (binaryName === 'opencode') {
    return {
      permissionMode: 'bypassPermissions',
      prompt:
        `You are reviewing an implementation plan in read-only mode — you can read the ` +
        `codebase but cannot write files. Explore the code to validate assumptions and identify gaps.\n` +
        `\n` +
        `When satisfied, save your finalized plan using the \`mcp__agendo__save_plan\` tool with the ` +
        `full plan content in markdown.\n` +
        `\n` +
        `Focus on: feasibility, missing edge cases, concrete file paths, step ordering.\n` +
        planContext,
    };
  } else {
    // Claude (and any other agent): native ExitPlanMode
    return {
      permissionMode: 'plan',
      prompt:
        `You are reviewing and improving an implementation plan for Agendo.\n` +
        `\n` +
        `Your session is in **plan mode** — you can read the codebase but cannot write files. ` +
        `Explore the code to validate the plan's assumptions and identify gaps.\n` +
        `\n` +
        `When you are satisfied with the plan, use ExitPlanMode to finalize it. ` +
        `The plan content will be saved automatically.\n` +
        planContext,
    };
  }
}
