# Task: Run an E2E test of the integration pipeline and monitor it

## Overview

The integration system has a 3-stage pipeline: Planner → Implementer → (optional) Remover. Run a full test, monitor the logs, and report what worked and what didn't.

## Prerequisites

Verify services are running:

```bash
pm2 status  # agendo (port 4100) and agendo-worker must be online
```

## Step 1: Submit an integration

Pick a simple, safe target. Good options:

- `https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem` (MCP server, stdio)
- `https://github.com/modelcontextprotocol/servers/tree/main/src/memory` (MCP server, stdio — was tested before, see memory/integration-test-insights.md)
- Any public MCP server repo

```bash
curl -s -X POST http://localhost:4100/api/integrations \
  -H "Content-Type: application/json" \
  -d '{"source": "<URL>"}' | jq .
```

Save the returned `taskId` and `sessionId`.

## Step 2: Monitor the planner session

The planner runs in `plan` mode (read-only). Watch its log:

```bash
# Get log path
curl -s "http://localhost:4100/api/sessions/<sessionId>" | jq '.data.logFilePath'

# Follow tool calls in real-time
tail -f <logFilePath> | grep --line-buffered '"type":"agent:tool-start"' | python3 -c "
import sys, json
for l in sys.stdin:
    idx = l.find('{')
    if idx == -1: continue
    d = json.loads(l[idx:])
    args = d.get('input', {}).get('arguments', {})
    cmd = args.get('command', args.get('note', args.get('taskId', str(list(args.values())[0])[:80] if args else '')))
    print(f'{d[\"toolName\"]}: {str(cmd)[:80]}')
    sys.stdout.flush()
"
```

### Expected planner flow:

1. `get_my_task` → extracts source, integrationName, assigneeAgent.slug
2. `add_progress_note` (multiple)
3. `get_file_contents` (GitHub MCP) — fetches llms.txt, README.md, package.json, CLAUDE.md
4. Deep dive into the specific subdirectory
5. `create_subtask` on the parent task
6. `save_plan` with the integration plan
7. `start_agent_session` — launches the implementer (same agent slug as itself)
8. `update_task` on parent → done

## Step 3: Monitor the implementer session

The implementer runs in `bypassPermissions` mode. Find it:

```bash
# Find the subtask ID from the planner's create_subtask call, then:
curl -s "http://localhost:4100/api/sessions?taskId=<subtaskId>" | jq '.data[] | {id, status, agentId}'
```

Then follow its log the same way.

### Expected implementer flow:

1. `get_my_task`
2. Bash commands: explore API schema, clone repo, build
3. `POST /api/mcp-servers` to register (or capability registration)
4. `pnpm typecheck && pnpm lint`
5. `update_task` on PARENT task with `## Implementation Record` in description (MANDATORY)
6. `update_task` on own task: `in_progress` then `done`

## Step 4: Verify results

```bash
# Check MCP servers
curl -s http://localhost:4100/api/mcp-servers | jq '[.[] | {name, transportType, enabled}]'

# Check task statuses
curl -s "http://localhost:4100/api/tasks/<parentTaskId>" | jq '{status: .data.status, description: .data.description}'

# Verify the Implementation Record exists in the parent task description
curl -s "http://localhost:4100/api/tasks/<parentTaskId>" | jq -r '.data.description' | grep "Implementation Record"

# Test the MCP server actually works
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | timeout 5 node <path-to-dist/index.js> 2>/dev/null | head -5
```

## Step 5: (Optional) Test removal

```bash
curl -s -X DELETE "http://localhost:4100/api/integrations/<integrationName>" | jq .
```

Monitor the remover session the same way. It should:

1. Read the Implementation Record from the parent task
2. DELETE the MCP server via API
3. Remove cloned repo from `/data/agendo/repos/`
4. Mark task done

## Known issues from previous test (2026-03-09)

Read `memory/integration-test-insights.md` for full analysis. Key points:

1. **Codex is slow** — o3-class model spends 1-5 min reasoning between each tool call. Total was 52 min. Claude would be ~10-15 min. Consider testing with Claude (agentId for claude-code-1: `4af57358-...`, or just let the UI agent picker select it).

2. **npm build may fail** — workspace packages may need `--include=dev` for @types/node. The agent should self-correct.

3. **Task status lifecycle** — must go `todo → in_progress → done`. Cannot skip. Prompts now include this but watch for it.

4. **Implementation Record** — the implementer MUST write this to the parent task description before marking done. Without it, the remover cannot find what to clean up. This was fixed in the prompts but verify it happens.

## Useful commands during monitoring

```bash
# Session status
curl -s "http://localhost:4100/api/sessions/<id>" | jq '{status: .data.status}'

# Worker logs (errors)
pm2 logs agendo-worker --lines 20 --nostream 2>&1 | grep -i error

# All tool calls for a session (summary)
grep '"type":"agent:tool-start"' <logFilePath> | python3 -c "
import sys, json
for l in sys.stdin:
    d = json.loads(l[l.index('{'):])
    args = d.get('input', {}).get('arguments', {})
    cmd = args.get('command', args.get('note', str(list(args.values())[0])[:80] if args else ''))
    print(f'{d[\"toolName\"]}: {str(cmd)[:80]}')
"

# Timeline with gaps (shows reasoning delays)
grep '"type":"agent:tool-start"' <logFilePath> | python3 -c "
import sys, json, datetime
prev = None
for l in sys.stdin:
    d = json.loads(l[l.index('{'):])
    ts = d.get('ts', 0)
    t = datetime.datetime.fromtimestamp(ts/1000, tz=datetime.timezone.utc).strftime('%H:%M:%S')
    gap = f'  +{(ts-prev)/1000:.0f}s' if prev and (ts-prev) > 30000 else ''
    args = d.get('input', {}).get('arguments', {})
    cmd = args.get('command', args.get('note', str(list(args.values())[0])[:60] if args else ''))
    print(f'{t} {d[\"toolName\"]}: {str(cmd)[:60]}{gap}')
    prev = ts
"
```
