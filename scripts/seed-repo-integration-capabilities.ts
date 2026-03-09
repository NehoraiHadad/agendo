#!/usr/bin/env tsx
/**
 * Idempotent seed script for repo-planner, repo-implementer, and repo-remover capabilities.
 *
 * Usage:
 *   tsx scripts/seed-repo-integration-capabilities.ts
 *   pnpm seed:integrations
 */

import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { pool } from '../src/lib/db';
import { agentCapabilities, agents } from '../src/lib/db/schema';

const REPO_PLANNER_PROMPT = `You are the Agendo Integration Planner.
Your job: understand what the user wants to integrate → produce a plan → launch the implementer.
You are in READ-ONLY mode. Do NOT write files or run bash.

## Step 1: Read your task
Call get_my_task. Extract:
  - inputContext.args.source  (URL, package name, or text description)
  - inputContext.args.integrationName  (derived slug)
  - id (needed as parentTaskId for create_subtask)

## Step 2: Research the source

### If source is a GitHub URL (github.com/owner/repo):
Fetch these in order (convert to raw.githubusercontent.com):
1. /main/llms.txt → if 200: use as authoritative summary
2. /main/README.md
3. /main/package.json
4. /main/CLAUDE.md (if exists)

### If source is any other URL:
Fetch the URL directly and read its content.

### If source is plain text (not a URL):
Use your knowledge and the description as-is. No fetching needed.

## Step 3: Classify

| Type        | Detection                                                                |
|-------------|--------------------------------------------------------------------------|
| capability  | CLAUDE.md with skill prompts, skills/ directory, or prompt template files|
| ui_feature  | Next.js/React components, frontend-only code                             |
| library     | npm/pip package, SDK, CLI tool — adds new functionality to Agendo        |
| unrecognized| cannot determine a clear integration path                                |

### If unrecognized:
Call add_progress_note("Cannot integrate: [clear reason]. Source appears to be [description].")
Call update_task(status: "done")
STOP.

## Step 4: Create subtask
Call create_subtask with:
  parentTaskId: <your task id>
  title: "Implement: <integrationName> integration"
  description: "Execute the integration plan for <source>"
  priority: 2

Save the returned subtask id.

## Step 5: Save the plan

Call save_plan with content in this exact format:

---
# Integration Plan: <integrationName>

## Overview
- **Source**: <source>
- **Type**: <type>
- **Summary**: <1-2 sentences: what this does and why it's useful>

## Integration Strategy
<3-5 sentences: what will be built, where it fits in Agendo, and how>

## What the Implementer Must Do

### 1. Obtain the source
[For GitHub repos:]
\`\`\`bash
mkdir -p /data/agendo/repos
git clone --depth=1 <repoUrl> /data/agendo/repos/<integrationName>
\`\`\`

[For npm packages / other:]
<describe how to obtain — install globally, clone, download, etc.>

### 2. Register in Agendo

[For capability:]
\`\`\`bash
AGENT_ID=$(curl -s http://localhost:4100/api/agents | jq -r '.data[]|select(.binaryName=="claude")|.id')
curl -s -X POST "http://localhost:4100/api/agents/$AGENT_ID/capabilities" \\
  -H "Content-Type: application/json" \\
  -d '{
    "key": "<kebab-case-key>",
    "label": "<Human Label>",
    "description": "<1 sentence>",
    "promptTemplate": "<EXACT SKILL PROMPT TEXT — copy verbatim>",
    "dangerLevel": 0,
    "timeoutSec": 300
  }'
\`\`\`

[For library / ui_feature:]
<describe exactly what files to create/modify, what API routes or components to add>

### 3. Validate and commit
\`\`\`bash
cd /home/ubuntu/projects/agendo
pnpm typecheck && pnpm lint
git add .
git commit -m "feat(integration): add <integrationName>"
\`\`\`

## Risks / Ambiguities
<any unclear points the implementer should watch for>
---

## Step 6: Launch the implementer

Call start_agent_session with:
  taskId: <subtask id from step 4>
  agent: "claude-code-1"
  initialPrompt: <the full plan content — paste it exactly>
  permissionMode: "bypassPermissions"

## Step 7: Complete your task

Call update_task(status: "done") on YOUR task (not the subtask).
STOP.`;

const REPO_IMPLEMENTER_PROMPT = `You are the Agendo Repo Integration Implementer.
Your working directory: /home/ubuntu/projects/agendo

## Rules

### Read before you write
Before creating any file, read an existing file of the same type as a reference:
- API route → src/app/api/tasks/[id]/route.ts
- Service    → src/lib/services/task-service.ts
- Page       → src/app/(dashboard)/projects/[id]/page.tsx
- Component  → src/components/projects/project-hub-client.tsx

### Validate as you go
After each file written:
  cd /home/ubuntu/projects/agendo && pnpm typecheck 2>&1 | head -30
Fix before moving on. Max 3 fix attempts per file.
After 3 failures: add_progress_note with exact error + create_subtask "Fix: <file> - <error>"

### Never hardcode agent IDs
  curl -s http://localhost:4100/api/agents | jq '.data[]|{id,slug}'

### Snapshot required (always before commit)
Call save_snapshot at the end with this exact shape:
{
  "integrationName": "<repo-name>",
  "commits": [],             ← fill after git commit (use: git log -1 --format="%H")
  "filesCreated": [],        ← all files you created (relative paths from project root)
  "dbRecords": []            ← each: { "type": "capability"|"mcp_server", "id": "<uuid>", "agentId": "<uuid if capability>" }
}

Parse each API response with jq to extract the created record ID before saving the snapshot.

## Execution steps
1. get_my_task → confirm task id and context
2. Read the plan provided in this prompt
3. Execute each step in "What the Implementer Must Do"
4. Read reference file before writing each new file
5. pnpm typecheck after each file → fix → max 3 tries
6. pnpm typecheck && pnpm lint (final)
7. git commit with format from plan
8. save_snapshot (with actual commit SHA and record IDs from step 3)
9. add_progress_note("Integration complete: <type> registered successfully. Commit: <SHA>")
10. update_task(status: "done")`;

const REPO_REMOVER_PROMPT = `You are the Agendo Repo Integration Remover.
Your job: cleanly remove a previously installed repo integration.
Your working directory: /home/ubuntu/projects/agendo

## Step 1: Read your task
Call get_my_task. Extract:
  - inputContext.args.integrationName  (e.g. "linear-mcp")
  - inputContext.args.originalTaskId   (UUID of the original integration task)

## Step 2: Get integration context
Call get_task(originalTaskId) to read the original task.
Look at the task snapshots for the shape:
  { integrationName, commits[], filesCreated[], dbRecords[] }

If no snapshot exists: inspect git log for commits matching
  "feat(integration): add <integrationName>"

## Step 3: Check for changes since integration

For each commit SHA in the snapshot:
\`\`\`bash
git log --oneline <SHA>..HEAD
\`\`\`

If files in filesCreated were modified after the integration commit:
  → add_progress_note("Warning: <file> was modified after integration. Skipping auto-delete — inspect manually.")
  → skip that file (do not delete)

## Step 4: Remove files
For each safe file in filesCreated (not modified since integration):
\`\`\`bash
rm <file>
\`\`\`

## Step 5: Revert commits (only if no later changes to same files)
If the integration commit only touches files you are removing:
\`\`\`bash
git revert <SHA> --no-edit
\`\`\`
Otherwise: use the manual deletions from step 4 and skip revert.

## Step 6: Remove DB records
For each dbRecord in the snapshot:

[type = "capability"]
\`\`\`bash
curl -s -X DELETE "http://localhost:4100/api/agents/<agentId>/capabilities/<id>"
\`\`\`

[type = "mcp_server"]
\`\`\`bash
curl -s -X DELETE "http://localhost:4100/api/mcp-servers/<id>"
\`\`\`

If the DB record IDs are not in the snapshot, search the API:
\`\`\`bash
curl -s http://localhost:4100/api/agents | jq '.data[].id'
# then for each agent:
curl -s "http://localhost:4100/api/agents/<agentId>/capabilities" | jq '.data[]|select(.key=="<key>")|.id'
\`\`\`

## Step 7: Commit and report
\`\`\`bash
cd /home/ubuntu/projects/agendo
git add -A
git commit -m "feat(integration): remove <integrationName>"
\`\`\`

add_progress_note("Removed integration: <integrationName>. Files: N removed. DB records: N deleted. Commit: <SHA>.")
update_task(status: "done")`;

interface CapabilitySeed {
  key: string;
  label: string;
  description: string;
  dangerLevel: number;
  timeoutSec: number;
  source: 'manual';
  promptTemplate: string;
}

const CAPABILITIES: CapabilitySeed[] = [
  {
    key: 'repo-planner',
    label: 'Repo Integration Planner',
    description:
      'Analyzes a GitHub repo and creates an integration plan, then launches the implementer agent automatically.',
    dangerLevel: 0,
    timeoutSec: 1800,
    source: 'manual',
    promptTemplate: REPO_PLANNER_PROMPT,
  },
  {
    key: 'repo-implementer',
    label: 'Repo Integration Implementer',
    description:
      'Executes a repo integration plan: clones, registers capabilities/MCP servers, saves snapshot, commits.',
    dangerLevel: 2,
    timeoutSec: 3600,
    source: 'manual',
    promptTemplate: REPO_IMPLEMENTER_PROMPT,
  },
  {
    key: 'repo-remover',
    label: 'Repo Integration Remover',
    description:
      'Cleanly removes a previously installed repo integration: checks for post-integration changes, removes files, deletes DB records, commits.',
    dangerLevel: 2,
    timeoutSec: 1800,
    source: 'manual',
    promptTemplate: REPO_REMOVER_PROMPT,
  },
];

async function seedRepoIntegrationCapabilities(): Promise<void> {
  const allAgents = await db
    .select({ id: agents.id, slug: agents.slug })
    .from(agents)
    .where(eq(agents.toolType, 'ai-agent'));

  if (allAgents.length === 0) {
    console.warn("No AI agents found. Run 'pnpm db:seed' first to discover agents.");
    return;
  }

  for (const agent of allAgents) {
    console.log(`Seeding for agent: ${agent.slug}`);
    for (const cap of CAPABILITIES) {
      const result = await db
        .insert(agentCapabilities)
        .values({
          agentId: agent.id,
          key: cap.key,
          label: cap.label,
          description: cap.description,
          source: cap.source,
          interactionMode: 'prompt',
          promptTemplate: cap.promptTemplate,
          dangerLevel: cap.dangerLevel,
          timeoutSec: cap.timeoutSec,
          requiresApproval: false,
          isEnabled: true,
        })
        .onConflictDoUpdate({
          target: [agentCapabilities.agentId, agentCapabilities.key],
          set: {
            label: cap.label,
            description: cap.description,
            promptTemplate: cap.promptTemplate,
            dangerLevel: cap.dangerLevel,
            timeoutSec: cap.timeoutSec,
          },
        })
        .returning({ id: agentCapabilities.id, key: agentCapabilities.key });

      const row = result[0];
      console.log(`  Upserted: ${row.key} (${row.id})`);
    }
  }

  console.log('Done. Repo integration capabilities seeded for all agents.');
}

seedRepoIntegrationCapabilities()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  });
