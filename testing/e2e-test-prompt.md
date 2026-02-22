# Agendo — End-to-End Test Protocol

**Goal:** Verify the full Agendo application works correctly with all three AI agents (Claude, Codex, Gemini), including multi-agent orchestration via subtask delegation.

**App URL:** http://localhost:4100
**Working dir:** /home/ubuntu/projects/agendo

---

## Context: What Agendo Is

Agendo is a Next.js 16 app (port 4100) that manages AI coding agent sessions. It has:

- **Projects** — group of tasks + agents
- **Tasks** — work items on a Kanban board (todo → in_progress → done)
- **Sessions** — live conversations with an AI agent (Claude, Codex, Gemini)
- **Worker** — PM2 process (`agendo-worker`) that runs sessions via pg-boss queue
- **MCP server** — agents can call `mcp__agendo__*` tools to update task status from inside a session

## Known Agent Slugs (from current config)

- **Claude Code:** `claude-code-1` (binary: `/home/ubuntu/.local/bin/claude`)
- **Codex CLI:** `codex-cli-1` (binary: `/home/ubuntu/.bun/bin/codex`)
- **Gemini CLI:** `gemini-cli-1` (binary: `/usr/bin/gemini`)

---

## Phase 0: System Health Check

Before testing anything, verify services are healthy:

```bash
pm2 list | grep agendo
```

Expected: all three services are `online`:

- `agendo` (port 4100) — Next.js app
- `agendo-worker` — background job runner
- `agendo-terminal` (port 4101) — xterm.js terminal

```bash
curl -s http://localhost:4100/api/agents | python3 -m json.tool | grep '"name"'
```

Expected: Shows claude, codex, gemini agents in the list.

```bash
curl -s http://localhost:4100/api/agents | python3 -c "
import json,sys
agents = json.load(sys.stdin)['data']
for a in agents:
    if a['slug'] in ['claude-code-1','codex-cli-1','gemini-cli-1']:
        print(f\"{a['name']}: slug={a['slug']}, active={a['isActive']}\")
"
```

**If any agent shows `active: false` or is missing**, go to Settings → Agents in the UI and activate it.

**Check worker stability:**

```bash
pm2 describe agendo-worker | grep -E "restart|uptime|status"
tail -20 /home/ubuntu/.pm2/logs/agendo-worker-error.log
```

Worker should be `online`. If restart count is >10 or error log shows new crashes, stop and fix before proceeding.

---

## Phase 1: Create a Test Project

**Via UI (preferred):**

1. Open http://localhost:4100
2. Click "New Project"
3. Name: `E2E Test [today's date]`
4. Note the project ID from the URL (e.g. `/projects/abc-123`)

**Via API (alternative):**

```bash
curl -s -X POST http://localhost:4100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"E2E Test","description":"End-to-end testing"}' \
  | python3 -m json.tool
```

Save the project ID — you will need it throughout.

---

## Phase 2: Test Claude Code Session

Claude is the most battle-tested agent. Test it first.

### 2a. Create a simple task for Claude

```bash
PROJECT_ID="<your-project-id>"

curl -s -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"Claude: Hello World\",
    \"description\": \"Say hello and tell me what 2+2 equals\"
  }" | python3 -m json.tool
```

Save the task ID.

### 2b. Start a session with Claude

```bash
TASK_ID="<claude-task-id>"

curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$TASK_ID\",
    \"agentId\": \"<claude-code-1-agent-id>\",
    \"prompt\": \"Hello! What is 2+2? Please also use the mcp__agendo__update_task tool to mark this task as in_progress, then add a progress note saying you answered the question, then mark it done.\"
  }" | python3 -m json.tool
```

Note: To get the Claude agent UUID:

```bash
curl -s http://localhost:4100/api/agents | python3 -c "
import json,sys
for a in json.load(sys.stdin)['data']:
    if a['slug'] == 'claude-code-1':
        print(a['id'])
"
```

### 2c. Monitor the session

```bash
SESSION_ID="<session-id>"

# Poll session status until it's not 'queued' or 'running'
for i in {1..30}; do
  STATUS=$(curl -s http://localhost:4100/api/sessions/$SESSION_ID | python3 -c "import json,sys; s=json.load(sys.stdin)['data']; print(s['status'])")
  echo "[$i] status: $STATUS"
  if [[ "$STATUS" != "queued" && "$STATUS" != "running" && "$STATUS" != "active" ]]; then
    break
  fi
  sleep 3
done
```

### 2d. Read session log

```bash
curl -s http://localhost:4100/api/sessions/$SESSION_ID/log | python3 -c "
import json,sys
events = json.load(sys.stdin)['data']
for e in events[-20:]:
    t = e.get('type','?')
    if 'text' in e:
        print(f\"[{t}] {e['text'][:100]}\")
    elif 'message' in e:
        print(f\"[{t}] {e['message'][:100]}\")
"
```

**Expected:**

- Log shows `agent:text` events with Claude's response ("Hello! 2+2 = 4...")
- Task status on the board updated to `done` (Claude used MCP tools)
- Session reached `awaiting_input` or `ended` state
- Worker error log has NO new crashes

### 2e. Test multi-turn (send a follow-up message)

```bash
# Session should be in 'awaiting_input' state
curl -s http://localhost:4100/api/sessions/$SESSION_ID | python3 -c "
import json,sys; print(json.load(sys.stdin)['data']['status'])
"

# Send a follow-up
curl -s -X POST http://localhost:4100/api/sessions/$SESSION_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 3+3?"}'

# Wait and check log
sleep 10
curl -s http://localhost:4100/api/sessions/$SESSION_ID/log | python3 -c "
import json,sys
events = json.load(sys.stdin)['data']
for e in events[-10:]:
    if e.get('type') in ['agent:text','user:message']:
        print(f\"[{e['type']}] {e.get('text','')[:100]}\")
"
```

**Expected:** Claude responds "3+3 = 6". Session goes back to `awaiting_input`.

---

## Phase 3: Test Codex CLI Session

**Important known behaviors:**

- Codex uses `codex mcp-server` (MCP protocol, NOT tmux)
- Output comes via `result.content` from `callTool` response
- Session ID (threadId) is a UUID returned on first turn
- Codex has quota limits — if you get a quota error, that's expected and OK

### 3a. Create a task for Codex

```bash
curl -s -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"Codex: List files\",
    \"description\": \"List the files in /home/ubuntu/projects/agendo/src/lib/worker/adapters/ and describe what each one does\"
  }" | python3 -m json.tool
```

Get Codex agent UUID:

```bash
curl -s http://localhost:4100/api/agents | python3 -c "
import json,sys
for a in json.load(sys.stdin)['data']:
    if a['slug'] == 'codex-cli-1':
        print(a['id'])
"
```

### 3b. Start a Codex session

```bash
curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$CODEX_TASK_ID\",
    \"agentId\": \"$CODEX_AGENT_ID\",
    \"prompt\": \"List the files in /home/ubuntu/projects/agendo/src/lib/worker/adapters/ and tell me what each adapter file does in one sentence.\"
  }" | python3 -m json.tool
```

### 3c. Monitor Codex session (it's slower — MCP protocol)

```bash
for i in {1..40}; do
  RESP=$(curl -s http://localhost:4100/api/sessions/$CODEX_SESSION_ID)
  STATUS=$(echo $RESP | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['status'])")
  echo "[$i] status: $STATUS"
  if [[ "$STATUS" != "queued" && "$STATUS" != "running" && "$STATUS" != "active" ]]; then
    break
  fi
  sleep 5
done
```

### 3d. Check Codex output

```bash
curl -s http://localhost:4100/api/sessions/$CODEX_SESSION_ID/log | python3 -c "
import json,sys
events = json.load(sys.stdin)['data']
for e in events:
    if e.get('type') == 'agent:text':
        print(e['text'][:200])
"
```

**Expected:**

- Log shows adapter file descriptions from Codex
- Session reaches `awaiting_input` or `ended`
- Worker has NOT crashed (restart count stable)

**If Codex returns quota error:** That's an API-level issue, not a bug in Agendo. The session should gracefully end (not crash the worker).

---

## Phase 4: Test Gemini CLI Session

**Important known behaviors:**

- Gemini uses ACP v0.20 protocol (JSON-RPC over stdio)
- Requires `gemini --experimental-acp`
- Session ID is a UUID from `session/new` response
- Gemini must be authenticated: run `gemini` interactively first if OAuth expired

**Pre-check: Is Gemini authenticated?**

```bash
echo "Hello, say hi back" | timeout 10 gemini --experimental-acp 2>&1 | head -20
```

If you see `invalid_grant` or OAuth error, run `gemini` interactively to re-authenticate.

### 4a. Create a task for Gemini

```bash
curl -s -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"Gemini: Simple test\",
    \"description\": \"Say hello and explain what Agendo is in one paragraph\"
  }" | python3 -m json.tool
```

Get Gemini agent UUID:

```bash
curl -s http://localhost:4100/api/agents | python3 -c "
import json,sys
for a in json.load(sys.stdin)['data']:
    if a['slug'] == 'gemini-cli-1':
        print(a['id'])
"
```

### 4b. Start a Gemini session

```bash
curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$GEMINI_TASK_ID\",
    \"agentId\": \"$GEMINI_AGENT_ID\",
    \"prompt\": \"Hello! Please respond with: 1) A greeting, 2) What programming language Node.js uses, 3) The number 42.\"
  }" | python3 -m json.tool
```

### 4c. Monitor and verify

Same pattern as Codex — poll every 5 seconds for up to 3 minutes.

**Expected:**

- Session reaches `awaiting_input` or `ended`
- Log shows Gemini's response via `agent:text` events
- Worker stable (no new crashes)

---

## Phase 5: Multi-Agent Orchestration

This is the most important test — a primary Claude agent orchestrates sub-agents.

**Scenario:** Claude is the orchestrator. It creates subtasks and delegates them to Codex and Gemini.

### 5a. Create the orchestration task

```bash
curl -s -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d "{
    \"projectId\": \"$PROJECT_ID\",
    \"title\": \"Multi-agent: Code review orchestration\",
    \"description\": \"Primary Claude agent orchestrates: creates subtasks and delegates to Codex and Gemini for parallel analysis\"
  }" | python3 -m json.tool
```

### 5b. Start the orchestrator session (Claude)

The prompt must instruct Claude to:

1. Read its task
2. Create subtasks assigned to specific agents
3. Report progress via notes
4. Mark itself done

```bash
curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$ORCH_TASK_ID\",
    \"agentId\": \"$CLAUDE_AGENT_ID\",
    \"prompt\": \"You are an orchestrator agent. Do the following steps:\n\n1. Call mcp__agendo__get_my_task() to read your task\n2. Call mcp__agendo__update_task with status=in_progress\n3. Call mcp__agendo__add_progress_note with note='Starting orchestration: will delegate code analysis to Codex and Gemini'\n4. Call mcp__agendo__create_subtask with parentTaskId=<your task id>, title='Analyze adapter files with Codex', description='List and briefly describe the files in src/lib/worker/adapters/', assignee='codex-cli-1'\n5. Call mcp__agendo__create_subtask with parentTaskId=<your task id>, title='Analyze adapter files with Gemini', description='List and briefly describe the files in src/lib/worker/adapters/', assignee='gemini-cli-1'\n6. Call mcp__agendo__add_progress_note with note='2 subtasks created and delegated to codex-cli-1 and gemini-cli-1'\n7. Call mcp__agendo__update_task with status=done\n\nIMPORTANT: Use the actual task ID from get_my_task() in all calls. Do not make up IDs.\"
  }" | python3 -m json.tool
```

### 5c. Verify orchestration results

After the Claude session ends (2-3 minutes):

```bash
# Check the parent task — should be done and have 2 subtasks
curl -s http://localhost:4100/api/tasks/$ORCH_TASK_ID | python3 -c "
import json,sys
task = json.load(sys.stdin)['data']
print(f\"Parent status: {task['status']}\")
print(f\"Subtasks: {len(task.get('subtasks',[]))}\")
for s in task.get('subtasks',[]):
    print(f\"  - [{s['status']}] {s['title']} → assignee: {s.get('assignee','none')}\")
"
```

**Expected:**

- Parent task: `done`
- 2 subtasks created, both assigned to codex-cli-1 and gemini-cli-1
- Progress notes visible on the parent task

### 5d. Start sub-agent sessions

Now launch sessions for each subtask (as if the sub-agents picked up their assigned work):

```bash
# Get the subtask IDs
SUBTASKS=$(curl -s http://localhost:4100/api/tasks/$ORCH_TASK_ID | python3 -c "
import json,sys
for s in json.load(sys.stdin)['data'].get('subtasks',[]):
    print(f\"{s['id']} {s['title'][:30]} {s.get('assignee','')}\")
")
echo "$SUBTASKS"
```

For each subtask, start a session with the appropriate agent:

```bash
# Codex subtask
curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$CODEX_SUBTASK_ID\",
    \"agentId\": \"$CODEX_AGENT_ID\",
    \"prompt\": \"Read your task with mcp__agendo__get_my_task(), do the work described, add a progress note with your findings, then mark the task done.\"
  }"

# Gemini subtask
curl -s -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"$GEMINI_SUBTASK_ID\",
    \"agentId\": \"$GEMINI_AGENT_ID\",
    \"prompt\": \"Read your task with mcp__agendo__get_my_task(), do the work described, add a progress note with your findings, then mark the task done.\"
  }"
```

### 5e. Verify sub-agent results

After both sub-agents finish:

```bash
curl -s http://localhost:4100/api/tasks/$ORCH_TASK_ID | python3 -c "
import json,sys
task = json.load(sys.stdin)['data']
for s in task.get('subtasks',[]):
    print(f\"Subtask: {s['title']}\")
    print(f\"  Status: {s['status']}\")
    for note in s.get('progressNotes',[]):
        print(f\"  Note: {note['content'][:150]}\")
"
```

**Expected:**

- Both subtasks: `done`
- Each has a progress note with the analysis results from that agent

---

## Phase 6: Session Resume Test

Test cold-resume — session ends, then user sends another message, session re-activates.

```bash
# Use the Claude session from Phase 2
# It should be in 'awaiting_input' state.
# Simulate a cold resume by sending a message after a delay.

sleep 30   # Let idle timer fire (default: 5min — skip if impatient, just send message)

curl -s http://localhost:4100/api/sessions/$CLAUDE_SESSION_ID | python3 -c "
import json,sys; print('status:', json.load(sys.stdin)['data']['status'])
"

# Send a message — should trigger resume
curl -s -X POST http://localhost:4100/api/sessions/$CLAUDE_SESSION_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What is 10*10? Short answer only."}'

# Wait for response
sleep 15
curl -s http://localhost:4100/api/sessions/$CLAUDE_SESSION_ID/log | python3 -c "
import json,sys
for e in json.load(sys.stdin)['data'][-5:]:
    if e.get('type') in ['agent:text','user:message','system:info']:
        print(f\"[{e['type']}] {e.get('text',e.get('message',''))[:100]}\")
"
```

**Expected:** "10\*10 = 100" — session resumes cleanly.

---

## Phase 7: Worker Stability Check

After all tests complete, verify the worker is still stable:

```bash
pm2 list | grep agendo-worker
pm2 describe agendo-worker | grep -E "restart|uptime"
```

**Check for new crashes since testing started:**

```bash
tail -30 /home/ubuntu/.pm2/logs/agendo-worker-error.log
```

**Expected:** No new crash traces in the error log. Restart count should not have increased during testing.

---

## Phase 8: UI Verification (Manual)

Open http://localhost:4100 in a browser and verify:

1. **Kanban board** — All tasks from this test appear in correct columns
2. **Session list** — `/sessions` page shows all sessions with correct statuses
3. **Session detail** — Click a session; see the log stream with agent responses
4. **Task detail** — Click the orchestration task; see parent + subtasks with progress notes
5. **Live streaming** — Open a session that's actively running; verify the log updates in real time without page refresh

---

## Expected Final State

| Test                   | Expected Outcome                                           |
| ---------------------- | ---------------------------------------------------------- |
| Phase 0: Health        | All 3 PM2 services `online`, no worker crashes             |
| Phase 2: Claude        | Response received, task marked done via MCP tools          |
| Phase 2e: Multi-turn   | Follow-up response received correctly                      |
| Phase 3: Codex         | Response received (or graceful quota error)                |
| Phase 4: Gemini        | Response received (or OAuth prompt if not authed)          |
| Phase 5: Orchestration | Parent done, 2 subtasks created, sub-agents completed them |
| Phase 6: Resume        | Session re-activates and responds to follow-up             |
| Phase 7: Stability     | Worker restart count unchanged                             |

---

## Common Issues & Fixes

| Symptom                                | Cause                     | Fix                                               |
| -------------------------------------- | ------------------------- | ------------------------------------------------- |
| Worker crashes on Gemini               | ACP OAuth expired         | Run `gemini` interactively to re-auth             |
| Codex session stuck in `running`       | Quota exceeded            | Wait or use different API key                     |
| Session stays `queued` forever         | Worker not running        | `pm2 restart agendo-worker`                       |
| `tmux new-session` error in logs       | Old tmux session exists   | Already fixed in tmux-manager.ts — rebuild worker |
| Task stays `todo` after Claude session | MCP not enabled for agent | Check agent settings → mcpEnabled                 |
| Session `ended` with no log            | Codex `--mcp-config` flag | Already fixed — gate on binaryName=claude         |

---

## Architecture Notes (for debugging)

- **Claude adapter** uses tmux + persistent NDJSON stream (multi-turn native)
- **Codex adapter** uses `codex mcp-server` via MCP SDK (one `callTool` per turn, threadId for resume)
- **Gemini adapter** uses `gemini --experimental-acp` JSON-RPC over stdio (ACP v0.20 protocol)
- Worker picks up jobs from pg-boss `run-session` queue
- Sessions emit events via SSE to the frontend
- MCP server at `config.MCP_SERVER_PATH` is only injected for Claude agents (not Codex/Gemini)
- `session-ref` (tmux name / threadId / ACP sessionId) is persisted to DB for cold resume

**Key log locations:**

```
/home/ubuntu/.pm2/logs/agendo-worker-out.log   — worker stdout
/home/ubuntu/.pm2/logs/agendo-worker-error.log  — worker crashes
/home/ubuntu/.pm2/logs/agendo-out.log           — Next.js app
/home/ubuntu/.pm2/logs/agendo-error.log         — Next.js errors
```
