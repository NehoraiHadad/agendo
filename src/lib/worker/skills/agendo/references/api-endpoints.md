# Inter-Agent Communication API

HTTP endpoints for sending messages to running agent sessions, monitoring their output, and checking status. Use these after spawning agents with `start_agent_session`.

## Send a Message to a Running Session

```
POST /api/sessions/{sessionId}/message
Content-Type: application/json

{ "message": "Change approach: use OAuth instead of API keys." }
```

### Request Body

| Field      | Type                         | Required | Description                                  |
| ---------- | ---------------------------- | -------- | -------------------------------------------- |
| `message`  | `string`                     | Yes      | Text to inject into the agent's conversation |
| `priority` | `"now" \| "next" \| "later"` | No       | Delivery priority (default: immediate)       |

### Response (HTTP 202)

| Session state                        | Response body         | What happens                                     |
| ------------------------------------ | --------------------- | ------------------------------------------------ |
| `active` or `awaiting_input`         | `{ delivered: true }` | Message sent to the live agent process instantly |
| `idle` or `ended` (with session ref) | `{ resuming: true }`  | Session cold-resumes with your message as prompt |

Sessions in `ended` state without a `sessionRef` will reject the message (HTTP 400).

### Delivery Details

- **Hot delivery**: if the agent process is alive, the message is forwarded via Worker HTTP (port 4102) and injected as user input — even if the agent is mid-thought.
- **Cold resume**: if the session is idle/ended, the message triggers a cold resume via the `run-session` queue. The agent restarts with full prior context and your message as the resume prompt.
- **Fallback**: if the worker doesn't have the process in memory (e.g. after a restart), the endpoint automatically falls back to cold resume.

---

## Monitor Session Output (SSE)

```
GET /api/sessions/{sessionId}/events
Accept: text/event-stream
```

Returns a Server-Sent Events stream of `AgendoEvent` payloads:

- `agent:text` / `agent:text-delta` — agent text output
- `agent:tool-start` / `agent:tool-end` — tool invocations
- `system:status` — session status changes
- `system:error` — errors
- `agent:result` — final agent response

The stream proxies directly from the worker (port 4102) — zero buffering. Supports reconnection via `Last-Event-ID` header.

---

## Check Session Status

```
GET /api/sessions/{sessionId}
```

Returns the full session object including:

- `status` — `active`, `awaiting_input`, `idle`, `ended`
- `model` — current model being used
- `permissionMode` — current permission mode
- `taskId` — linked task (if any)
- `agentId` — which agent is running
- `createdAt` / `updatedAt` — timing metadata

---

## Finding Session IDs

- **From `start_agent_session`**: the MCP response includes `sessionId` — save it immediately
- **From task context**: use `get_task` or `get_progress_notes` — agents often log their session ID in progress notes

---

## Example: Orchestrator Sends Course Correction

```
// 1. Spawn a sub-agent
const { sessionId } = start_agent_session({
  taskId: "<subtask-id>",
  agent: "claude-code-1",
  initialPrompt: "Implement auth using API keys",
  permissionMode: "bypassPermissions"
})

// 2. Requirements change — send a course correction
POST /api/sessions/{sessionId}/message
{ "message": "PRIORITY UPDATE: Use OAuth2 instead of API keys. The client library is already installed at src/lib/oauth.ts." }

// 3. Check progress
GET /api/sessions/{sessionId}  →  { status: "active", ... }
```

## Programmatic Access from Agent Code

From within an agent session, call the API via `curl` or `fetch` against `http://localhost:4100`:

```bash
curl -X POST http://localhost:4100/api/sessions/<sessionId>/message \
  -H 'Content-Type: application/json' \
  -d '{"message": "Update: use the new schema from migrations."}'
```

Or check status:

```bash
curl http://localhost:4100/api/sessions/<sessionId> | jq '.data.status'
```
