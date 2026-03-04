# מחקר מעמיק: Gemini CLI — ACP + stream-json

> **גרסה נוכחית**: Gemini CLI 0.31.0 · @agentclientprotocol/sdk 0.14.1
> **תאריך מחקר**: 2026-03-04
> **מקור**: ניתוח קוד מקור, הרצת CLI, בדיקת SDK types, תיעוד רשמי

---

## תוכן עניינים

1. [CLI — כל הדגלים](#1-cli--כל-הדגלים)
2. [פרוטוקול ACP](#2-פרוטוקול-acp)
3. [פרוטוקול stream-json](#3-פרוטוקול-stream-json)
4. [TOML Policy Engine](#4-toml-policy-engine)
5. [ACP SDK — @agentclientprotocol/sdk](#5-acp-sdk--agentclientprotocolsdk)
6. [מימוש Agendo הנוכחי](#6-מימוש-agendo-הנוכחי)
7. [פערים והמלצות](#7-פערים-והמלצות)

---

## 1. CLI — כל הדגלים

```
Usage: gemini [options] [command]
```

### דגלים ראשיים

| דגל                          | קיצור | ערכים                     | תיאור                                                   |
| ---------------------------- | ----- | ------------------------- | ------------------------------------------------------- |
| `--prompt`                   | `-p`  | `<string>`                | Headless mode — הרץ prompt ויצא. מאפשר stdin.           |
| `--prompt-interactive`       | `-i`  | `<string>`                | הרץ prompt והישאר במצב interactive                      |
| `--model`                    | `-m`  | `<string>`                | Override לMODEL (למשל `gemini-2.5-pro`)                 |
| `--output-format`            | `-o`  | `text\|json\|stream-json` | פורמט פלט                                               |
| `--approval-mode`            | —     | ראה טבלה                  | מצב אישור כלים                                          |
| `--experimental-acp`         | —     | boolean                   | הפעל מצב ACP (stdio JSON-RPC)                           |
| `--allowed-mcp-server-names` | —     | `<array>`                 | רשימת שרתי MCP מורשים. `__none__` — אין שרתים           |
| `--policy`                   | —     | `<array>`                 | קובצי policy נוספים (TOML). comma-separated או multiple |
| `--resume`                   | `-r`  | `<string>`                | חדש session. `"latest"` או מספר index                   |
| `--sandbox`                  | `-s`  | boolean                   | Sandbox mode                                            |
| `--yolo`                     | `-y`  | boolean                   | Auto-approve הכל (מקבילה ישנה ל`--approval-mode yolo`)  |
| `--allowed-tools`            | —     | array                     | **DEPRECATED** — השתמש בPolicy Engine                   |
| `--include-directories`      | —     | array                     | תיקיות נוספות בworkspace                                |
| `--list-sessions`            | —     | boolean                   | הצג sessions ויצא                                       |
| `--delete-session`           | —     | `<string>`                | מחק session לפי index                                   |
| `--extensions` / `-e`        | —     | array                     | רשימת extensions                                        |
| `--list-extensions` / `-l`   | —     | boolean                   | הצג extensions ויצא                                     |
| `--raw-output`               | —     | boolean                   | ⚠ ללא sanitization של ANSI                              |
| `--screen-reader`            | —     | boolean                   | Accessibility mode                                      |
| `--debug` / `-d`             | —     | boolean                   | Debug mode (F12 console)                                |
| `--version` / `-v`           | —     | boolean                   | הצג גרסה                                                |

### `--approval-mode` — כל הערכים

| ערך         | תיאור                                      | ACP modeId   | מתי ב-Agendo                          |
| ----------- | ------------------------------------------ | ------------ | ------------------------------------- |
| `default`   | שאל לפני כל כלי                            | `"default"`  | `permissionMode: 'default'`           |
| `auto_edit` | אשר אוטומטית edit tools (read/write files) | `"autoEdit"` | `permissionMode: 'acceptEdits'`       |
| `yolo`      | אשר הכל אוטומטית                           | `"yolo"`     | `permissionMode: 'bypassPermissions'` |
| `plan`      | Read-only — אין כלי כתיבה                  | `"plan"`     | `permissionMode: 'plan'`              |

> **הערה חשובה**: `plan` הוא approval-mode ב-CLI אבל **אינו** ACP modeId תקני. ניסיון לקרוא `setSessionMode({ modeId: 'plan' })` מחזיר שגיאה -32603. ראה [פרק 2 — setSessionMode](#setsessionmode).

### sub-commands

```
gemini mcp                    # ניהול שרתי MCP
gemini extensions <command>   # ניהול extensions
gemini skills <command>       # ניהול agent skills
gemini hooks <command>        # ניהול hooks
```

---

## 2. פרוטוקול ACP

### מה זה ACP?

ACP (Agent Client Protocol) מוגדר ב-[agentclientprotocol.com](https://agentclientprotocol.com). הוא פרוטוקול JSON-RPC 2.0 על גבי NDJSON (Newline-Delimited JSON) — שורה אחת לכל message, על stdin/stdout.

ב-Agendo: `gemini --experimental-acp` מפעיל ACP mode. Agendo הוא ה**client**, Gemini הוא ה**agent**.

### מקורות תיעוד

- [ACP Overview](https://agentclientprotocol.com/protocol/overview)
- [Initialization](https://agentclientprotocol.com/protocol/initialization)
- [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
- [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
- [Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)
- [Session Modes](https://agentclientprotocol.com/protocol/session-modes)

---

### 2.1 initialize

**Client → Agent** (אחת בתחילת החיבור)

```typescript
// Request
{
  protocolVersion: string,  // PROTOCOL_VERSION מה-SDK
  clientInfo: {
    name: string,           // "agendo"
    version: string,        // "1.0.0"
  },
  clientCapabilities: {
    fs: {
      readTextFile: boolean,   // true — Agendo מממש
      writeTextFile: boolean,  // true — Agendo מממש
    },
    terminal: boolean,         // true — Agendo מדווח אבל לא מממש
  },
}
```

```typescript
// Response — InitializeResponse
{
  agentCapabilities: {
    loadSession?: boolean,        // האם session/load נתמך
    mcpCapabilities?: McpCapabilities,
    promptCapabilities?: PromptCapabilities,
    sessionCapabilities?: SessionCapabilities,
  },
  agentInfo?: { name: string, version: string },
  authMethods?: AuthMethod[],
  protocolVersion: string,
}
```

**מה Agendo עושה**: בודק `agentCapabilities.loadSession` כדי להחליט בין `session/load` ל-`session/new`.

---

### 2.2 session/new (newSession)

**Client → Agent**

```typescript
// Request — NewSessionRequest
{
  cwd: string,           // תיקיית עבודה (absolute path)
  mcpServers: McpServer[], // רשימת שרתי MCP
}

// McpServerStdio (הסוג שAgendo משתמש בו)
type McpServerStdio = {
  name: string,
  command: string,
  args: string[],
  env: Array<{ name: string; value: string }>,  // ⚠ ARRAY, לא object!
}
```

```typescript
// Response — NewSessionResponse
{
  sessionId: string,           // UUID לשימוש בכל הbקשות הבאות
  configOptions?: SessionConfigOption[],
  models?: SessionModelState,  // UNSTABLE
  currentModeId?: string,      // מצב הנוכחי ("default", "autoEdit", "yolo", "plan")
  availableModes?: SessionMode[],
}
```

> **Bug קריטי שתוקן**: `env` חייב להיות **array** של `{name, value}` — לא `Record<string, string>`. שגיאה בזה גורמת ל-ACP -32602 Invalid params.

---

### 2.3 session/load (loadSession)

**Client → Agent** — מעמיס session קיים (ממחזר היסטוריה)

```typescript
// Request — LoadSessionRequest
{
  sessionId: string,
  cwd: string,
  mcpServers: McpServer[],
}

// Response — LoadSessionResponse
// (זהה ל-NewSessionResponse בעיקרו)
// הAgent שולח את ההיסטוריה כ-sessionUpdate notifications
```

**מתי עובד**: רק אם `agentCapabilities.loadSession === true`.
**מתי נופל**: אם session_id לא קיים, Gemini מחזיר שגיאה — Agendo נופל back ל-`session/new`.

> **הערה**: `session/load` שולח את כל ההיסטוריה חזרה כ-notifications. זה יכול להיות יקר. שקול `session/resume` (UNSTABLE) שלא שולח היסטוריה.

---

### 2.4 session/prompt (prompt)

**Client → Agent** — שולח הודעת משתמש

```typescript
// Request — PromptRequest
{
  sessionId: string,
  prompt: ContentBlock[],  // מערך של content blocks
}

// ContentBlock:
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; ... }
  | { type: "resource_link"; ... }

// Response — PromptResponse (מגיע אחרי שהAgent סיים את ה-turn)
{
  stopReason: StopReason,  // "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
  usage?: { inputTokens: number; outputTokens: number },  // UNSTABLE
}
```

**מה קורה בזמן ה-turn**: Agent שולח `sessionUpdate` notifications (ראה 2.7) ויכול לשלוח `requestPermission` requests (ראה 2.8).

**Timeout ב-Agendo**: 10 דקות (`PROMPT_TIMEOUT_MS = 10 * 60 * 1000`)

---

### 2.5 session/cancel

**Client → Agent** — notification (ללא response)

```typescript
// CancelNotification
{
  sessionId: string;
}
```

**מה Gemini עושה**: מפסיק את LLM requests, שולח pending notifications, מחזיר `PromptResponse` עם `stopReason: "cancelled"`.

**מימוש Agendo** (`interrupt()`):

1. שולח `cancel` notification
2. ממתין 2s → SIGINT
3. ממתין 2s → SIGTERM
4. ממתין 5s → SIGKILL

---

### 2.6 setSessionMode

**Client → Agent** — משנה mode בתוך session חי

```typescript
// Request — SetSessionModeRequest
{
  sessionId: string,
  modeId: string,  // "default" | "autoEdit" | "yolo" (לא "plan"!)
}

// Response — SetSessionModeResponse | void
```

**חשוב**: `"plan"` אינו modeId תקני ב-ACP. ניסיון לשנות ל-plan mode via ACP **נכשל עם -32603**. `plan` mode נקבע רק בעת הפעלת ה-CLI עם `--approval-mode plan`.

**Agendo modeMap** (ב-`setPermissionMode`):

```typescript
const modeMap = {
  default: 'default',
  acceptEdits: 'autoEdit',
  bypassPermissions: 'yolo',
  dontAsk: 'yolo',
  // 'plan' → לא קיים → מחזיר false
};
```

---

### 2.7 sessionUpdate (notifications מה-Agent)

Gemini שולח notifications אלה במהלך ה-turn. כולם `SessionNotification` עם `sessionId` ו-`update`:

```typescript
type SessionNotification = {
  sessionId: string;
  update: SessionUpdate;
};
```

#### כל סוגי `sessionUpdate`:

| `sessionUpdate`             | תיאור                      | Agendo מממש?             |
| --------------------------- | -------------------------- | ------------------------ |
| `agent_message_chunk`       | chunk של text מהLLM        | ✅ → `gemini:text`       |
| `agent_thought_chunk`       | chunk של thinking          | ✅ → `gemini:thinking`   |
| `tool_call`                 | כלי התחיל לרוץ (yolo mode) | ✅ → `gemini:tool-start` |
| `tool_call_update`          | כלי סיים / עדכון תוצאה     | ✅ → `gemini:tool-end`   |
| `user_message_chunk`        | echo של הודעת המשתמש       | ❌ לא מטופל              |
| `plan`                      | עדכון execution plan       | ❌ לא מטופל              |
| `available_commands_update` | slash commands זמינים      | ❌ לא מטופל              |
| `current_mode_update`       | Gemini שינה mode           | ❌ לא מטופל              |
| `config_option_update`      | config options השתנו       | ❌ לא מטופל              |
| `session_info_update`       | מידע על session            | ❌ לא מטופל              |
| `usage_update`              | token usage update         | ❌ לא מטופל              |

#### מבנה מפורט:

**`agent_message_chunk`** — streaming text (כל chunk הוא ContentChunk):

```typescript
{
  sessionUpdate: "agent_message_chunk",
  type: "content",
  content: {
    type: "text",
    text: "...",  // חלק מהturn
  }
}
```

> **האם per-token?** כן! כל chunk הוא batch קטן של tokens (לא תמיד token אחד, אבל close). ניתן לממש `agent:text-delta` ל-Gemini — ראה [פרק 7](#72-token-level-streaming-ל-gemini).

**`agent_thought_chunk`** — thinking:

```typescript
{
  sessionUpdate: "agent_thought_chunk",
  type: "content",
  content: {
    type: "text",
    text: "Let me think...",
  }
}
```

**`tool_call`** — כלי התחיל (רק ב-yolo/auto_edit — Gemini לא שולח requestPermission):

```typescript
{
  sessionUpdate: "tool_call",
  toolCallId: "run_shell_command_1234567890_0",
  title: "ls -la",
  kind: "shell_command",
  locations?: [{ path: "/some/file" }],
  content?: ToolCallContent[],
}
```

**`tool_call_update`** — כלי סיים:

```typescript
{
  sessionUpdate: "tool_call_update",
  toolCallId: "run_shell_command_1234567890_0",
  status: "success" | "failed",
  content: [
    {
      type: "content",
      content: { type: "text", text: "output..." }
    }
  ],
}
```

**`plan`** — execution plan (plan mode):

```typescript
{
  sessionUpdate: "plan",
  entries: [
    { id: string, title: string, status: "todo" | "in_progress" | "done" | "cancelled" }
  ],
}
```

**`current_mode_update`** — Gemini שינה mode:

```typescript
{
  sessionUpdate: "current_mode_update",
  currentModeId: "plan" | "default" | "autoEdit" | "yolo",
}
```

---

### 2.8 requestPermission

**Agent → Client** — request (מצפה ל-response)

```typescript
// RequestPermissionRequest
{
  sessionId: string,
  options: PermissionOption[],  // מה האפשרויות שהAgent מציע
  toolCall: ToolCallUpdate,     // מה הכלי שצריך אישור
}

type PermissionOption = {
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always",
  name: string,       // לייבל ל-UI
  optionId: string,   // UUID — זה מה ששולחים בresponse
}

type ToolCallUpdate = {
  toolCallId?: string,
  title?: string,
  rawInput?: unknown,
  locations?: Array<{ path: string }>,
  content?: ToolCallContent[],
  status?: "success" | "failed",
  kind?: string,
}
```

```typescript
// RequestPermissionResponse — ⚠ NESTED STRUCTURE!
{
  outcome: {
    outcome: "selected",
    optionId: "<the-chosen-option-id>",
  }
}
// OR:
{
  outcome: {
    outcome: "cancelled",
  }
}
```

> **Bug קריטי שתוקן**: ה-response **חייב** להיות nested — `{ outcome: { outcome: 'selected', optionId: ... } }`.
> שגיאה נפוצה: `{ outcome: 'selected', optionId: ... }` → גורמת לשגיאת Zod validation ב-Gemini.

---

### 2.9 readTextFile / writeTextFile

**Agent → Client** — requests (מצפים ל-response)

```typescript
// ReadTextFileRequest
{
  path: string,         // absolute path
  line?: number,        // שורת התחלה (1-indexed)
  limit?: number,       // מספר שורות לקרוא
}
// Response: { content: string }

// WriteTextFileRequest
{
  path: string,
  content: string,
}
// Response: {}
```

**מתי Gemini שולח אלה?**
כאשר ה-Gemini agent צריך לקרוא/לכתוב קבצים והclient הצהיר שיש לו `fs.readTextFile` / `fs.writeTextFile` capabilities. Gemini יכול לשלוח אלה **במקום** לשתמש בtools הרגילים שלו לקבצים.

**מימוש Agendo**: מממש שניהם ב-`GeminiClientHandler`. `readTextFile` תומך ב-`line` + `limit` slicing. `writeTextFile` כותב לdisk ישירות.

---

### 2.10 terminal support

ACP מגדיר `createTerminal` / `terminal/*` methods שמאפשרים לAgent ליצור terminal processes שירוצו על ה-client.

**Agendo**: מצהיר `terminal: true` ב-`clientCapabilities` אבל **אינו מממש** את ה-`createTerminal` handler. זה עלול לגרום לשגיאות אם Gemini ינסה להשתמש בזה.

---

### 2.11 unstable methods (UNSTABLE)

| Method                     | תיאור                      | נדרש Capability  |
| -------------------------- | -------------------------- | ---------------- |
| `unstable_forkSession`     | fork session קיים          | `session.fork`   |
| `unstable_listSessions`    | רשימת sessions             | `listSessions`   |
| `unstable_resumeSession`   | resume ללא replay היסטוריה | `session.resume` |
| `unstable_setSessionModel` | החלפת מודל                 | —                |
| `setSessionConfigOption`   | קביעת config option        | —                |

---

### 2.12 תרשים זרימה — ACP turn מלא

```
Agendo (Client)                    Gemini (Agent)
      |                                  |
      |--- initialize() --------------->|
      |<-- InitializeResponse ----------|
      |                                  |
      |--- newSession({ cwd, mcpServers }) -->|
      |<-- NewSessionResponse { sessionId } --|
      |                                  |
      |--- prompt({ sessionId, prompt }) -->|
      |                                  |
      |        [during turn]             |
      |<-- sessionUpdate(agent_message_chunk) --| (streaming text)
      |<-- sessionUpdate(tool_call) ----------| (tool started, yolo mode)
      |<-- requestPermission() -----------| (tool needs approval, default mode)
      |--- [requestPermission response] -->|
      |<-- sessionUpdate(tool_call_update) --|
      |<-- sessionUpdate(agent_message_chunk) --| (more text)
      |                                  |
      |<-- PromptResponse { stopReason: "end_turn" } --|
      |                                  |
      [next turn: repeat prompt()]
```

---

## 3. פרוטוקול stream-json

### מה זה stream-json?

`gemini -p "prompt" -o stream-json` — מצב headless שמוציא NDJSON לstdout. מתאים ל-fire-and-forget executions (task יחיד, ללא multi-turn).

### 3.1 כל event types — JSON payload אמיתי

**`init`** — ראשון תמיד:

```json
{
  "type": "init",
  "timestamp": "2026-03-04T14:51:39.312Z",
  "session_id": "3c1f75d4-144a-4b9f-8bfe-085c344f5249",
  "model": "auto-gemini-3"
}
```

**`message` (user)** — echo של ה-prompt:

```json
{
  "type": "message",
  "timestamp": "2026-03-04T14:51:39.313Z",
  "role": "user",
  "content": "say hi"
}
```

**`message` (assistant) עם `delta: true`** — streaming chunk:

```json
{
  "type": "message",
  "timestamp": "2026-03-04T14:52:08.461Z",
  "role": "assistant",
  "content": "The `/tmp` directory contains",
  "delta": true
}
```

> **הערה**: כאשר `delta: true` — זהו chunk חלקי. Gemini שולח **מספר chunks** ב-stream-json mode, כל אחד עם `delta: true`. **אין** message סופי ללא `delta` עם הturn המלא — כל ה-content הוא בchunks.

**`tool_use`** — כלי הופעל:

```json
{
  "type": "tool_use",
  "timestamp": "2026-03-04T14:52:07.347Z",
  "tool_name": "run_shell_command",
  "tool_id": "run_shell_command_1772635927347_0",
  "parameters": {
    "description": "Listing the contents of the /tmp directory.",
    "command": "ls -F /tmp"
  }
}
```

**`tool_result`** — תוצאת כלי:

```json
{
  "type": "tool_result",
  "timestamp": "2026-03-04T14:52:07.435Z",
  "tool_id": "run_shell_command_1772635927347_0",
  "status": "success",
  "output": "file1\nfile2\n..."
}
```

**`result`** — סיום (תמיד אחרון):

```json
{
  "type": "result",
  "timestamp": "2026-03-04T14:51:43.875Z",
  "status": "success",
  "stats": {
    "total_tokens": 11266,
    "input_tokens": 11000,
    "output_tokens": 52,
    "cached": 0,
    "input": 11000,
    "duration_ms": 4563,
    "tool_calls": 0
  }
}
```

שדות `status` אפשריים: `"success"` | `"error"` | `"cancelled"`.

### 3.2 `--resume` ב-stream-json

**עובד!** ניתן לקרוא עם session_id מה-`init` event:

```bash
gemini -p "follow-up question" -o stream-json --resume "3c1f75d4-144a-4b9f-8bfe-085c344f5249" ...
```

`init` event מחזיר את אותו `session_id` — ההיסטוריה נשמרת. זה multi-turn אמיתי **אבל** כל turn הוא process חדש.

ניתן גם להשתמש ב-`--resume latest` או מספר index (מ-`--list-sessions`).

### 3.3 tool approval ב-stream-json

ב-stream-json mode, tool approval נשלט **רק** דרך `--approval-mode`. אין interactive approval — לכן:

- `--approval-mode yolo` — כל הכלים מאושרים אוטומטית
- `--approval-mode auto_edit` — edit tools אוטומטי, שאר מאושרים
- `--approval-mode default` — **בעייתי** — Gemini ינסה לשאול המשתמש, אבל אין stdin. יגרום ל-hang.

**אין** מנגנון approval interactivity ב-stream-json. זה ההבדל הגדול מACP.

### 3.4 השוואה: stream-json לעומת ACP

| יכולת                     | stream-json                         | ACP                            |
| ------------------------- | ----------------------------------- | ------------------------------ |
| Multi-turn פרוצס יחיד     | ❌ process חדש לכל turn             | ✅                             |
| Streaming text chunks     | ✅ `delta: true` messages           | ✅ `agent_message_chunk`       |
| Tool approval interactive | ❌ רק via flags                     | ✅ `requestPermission`         |
| Token usage stats         | ✅ ב-`result.stats`                 | ⚠ UNSTABLE `usage` field       |
| Session resume            | ✅ `--resume <id>`                  | ✅ `session/load`              |
| MCP servers               | ✅ via `--allowed-mcp-server-names` | ✅ `session/new.mcpServers`    |
| Image input               | ? לא נבדק                           | ✅ `{ type: "image" }` block   |
| Plan mode                 | ✅ `--approval-mode plan`           | ❌ setSessionMode('plan') נכשל |
| stdin input               | ✅ append to prompt                 | ❌ N/A                         |
| מורכבות implementation    | נמוכה                               | גבוהה                          |
| מתאים ל                   | fire-and-forget                     | שיחות ארוכות                   |

---

## 4. TOML Policy Engine

תיעוד רשמי: [geminicli.com/docs/reference/policy-engine](https://geminicli.com/docs/reference/policy-engine)

### 4.1 מיקומי policy files

| Tier          | Path                                         | עדיפות      |
| ------------- | -------------------------------------------- | ----------- |
| Default       | built-in                                     | נמוכה       |
| Extension     | `~/.gemini/extensions/<ext>/policies/*.toml` | —           |
| Workspace     | `<project>/.gemini/policies/*.toml`          | —           |
| User          | `~/.gemini/policies/*.toml`                  | גבוהה       |
| Admin (Linux) | `/etc/gemini-cli/policies/`                  | גבוהה ביותר |

ניתן להוסיף קובצי policy נוספים עם `--policy path/to/file.toml`.

### 4.2 מבנה TOML

```toml
[[rule]]
toolName = "run_shell_command"          # שם הכלי (string או array)
mcpName = "my-server"                   # אופציונלי: MCP server name
argsPattern = '"command":"(git|npm)'    # regex על JSON של ה-args
commandPrefix = "git "                  # קיצור ל-argsPattern של command prefix
commandRegex = "git (commit|push)"      # regex על שדה command (לא יכול להיות עם commandPrefix)
toolAnnotations = { readOnlyHint = true } # filter לפי tool annotations
decision = "allow"                      # חובה: allow | deny | ask_user
priority = 100                          # 0-999 בתוך ה-tier
deny_message = "Cannot run this"        # הודעה בצד
modes = ["yolo", "autoEdit"]            # ב-approval modes אלה בלבד (אופציונלי)
```

### 4.3 tool name patterns (wildcards)

| Pattern              | מה זה matches             |
| -------------------- | ------------------------- |
| `"*"`                | כל כלי                    |
| `"server__*"`        | כל כלי מ-MCP server מסוים |
| `"*__toolName"`      | כלי מסוים מכל MCP server  |
| `"*__*"`             | כל כלי מכל MCP server     |
| `["tool1", "tool2"]` | array של שמות             |

### 4.4 מערכת priority

```
final_priority = tier_base + (toml_priority / 1000)
```

| Tier      | Base |
| --------- | ---- |
| Default   | 1    |
| Extension | 2    |
| Workspace | 3    |
| User      | 4    |
| Admin     | 5    |

דוגמה: User policy עם `priority: 500` → `4.500`. גבוה יותר = ניצחון.

### 4.5 דוגמאות מלאות

```toml
# ~/.gemini/policies/agendo.toml

# אפשר git read operations תמיד
[[rule]]
toolName = "run_shell_command"
commandPrefix = "git status"
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = "git log"
decision = "allow"
priority = 100

[[rule]]
toolName = "run_shell_command"
commandPrefix = "git diff"
decision = "allow"
priority = 100

# חסום delete
[[rule]]
toolName = "run_shell_command"
commandRegex = "^(rm|rmdir|sudo rm)"
decision = "deny"
priority = 500
deny_message = "Deletion operations are not allowed"

# אשר כל MCP tool מ-agendo server
[[rule]]
mcpName = "agendo"
toolName = "*"
decision = "allow"
priority = 200

# ב-plan mode — חסום כל כתיבה
[[rule]]
toolName = "*"
modes = ["plan"]
decision = "ask_user"
priority = 50
```

---

## 5. ACP SDK — @agentclientprotocol/sdk

**גרסה**: 0.14.1
**מחבר**: Zed Industries
**רישיון**: Apache-2.0
**repository**: [github.com/agentclientprotocol/typescript-sdk](https://github.com/agentclientprotocol/typescript-sdk)

### 5.1 classes ראשיים

```typescript
// ClientSideConnection — זה מה-Agendo משתמש
class ClientSideConnection {
  initialize(params: InitializeRequest): Promise<InitializeResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(params: CancelNotification): Promise<void>;
  setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void>;

  // UNSTABLE:
  unstable_forkSession(params): Promise<ForkSessionResponse>;
  unstable_listSessions(params): Promise<ListSessionsResponse>;
  unstable_resumeSession(params): Promise<ResumeSessionResponse>;
  unstable_setSessionModel(params): Promise<SetSessionModelResponse | void>;
  setSessionConfigOption(params): Promise<SetSessionConfigOptionResponse>;
}

// AgentSideConnection — לא בשימוש ב-Agendo (זה צד ה-Agent)
class AgentSideConnection {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params): Promise<RequestPermissionResponse>;
  readTextFile(params): Promise<ReadTextFileResponse>;
  writeTextFile(params): Promise<WriteTextFileResponse>;
  createTerminal(params): Promise<TerminalHandle>;
}

// Utility
function ndJsonStream(writer, reader): Stream; // יוצר NDJSON stream מ-stdin/stdout
const PROTOCOL_VERSION: string; // גרסת פרוטוקול נוכחית
```

### 5.2 Client interface (מה-Agendo מממש)

```typescript
interface Client {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  // + terminal methods
}
```

### 5.3 SessionUpdate types (מלא)

```typescript
type SessionUpdate =
  | (ContentChunk & { sessionUpdate: 'user_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_message_chunk' })
  | (ContentChunk & { sessionUpdate: 'agent_thought_chunk' })
  | (ToolCall & { sessionUpdate: 'tool_call' })
  | (ToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | (Plan & { sessionUpdate: 'plan' })
  | (AvailableCommandsUpdate & { sessionUpdate: 'available_commands_update' })
  | (CurrentModeUpdate & { sessionUpdate: 'current_mode_update' })
  | (ConfigOptionUpdate & { sessionUpdate: 'config_option_update' })
  | (SessionInfoUpdate & { sessionUpdate: 'session_info_update' })
  | (UsageUpdate & { sessionUpdate: 'usage_update' });
```

### 5.4 StopReason

```typescript
type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
```

### 5.5 PermissionOptionKind

```typescript
type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
```

---

## 6. מימוש Agendo הנוכחי

### 6.1 ארכיטקטורה

```
GeminiAdapter (src/lib/worker/adapters/gemini-adapter.ts)
  ↓ spawns
gemini --experimental-acp [-m model] [--approval-mode ...] [--allowed-mcp-server-names ...]
  ↓ ACP over NDJSON (stdin/stdout)
ClientSideConnection (@agentclientprotocol/sdk)
  ↓ calls
GeminiClientHandler (implements Client)
  ↓ emits
synthetic NDJSON events (GeminiEvent)
  ↓ parsed by
mapGeminiJsonToEvents() → AgendoEventPayload[]
  ↓ dispatched by
session-process.ts → PG NOTIFY → SSE → UI
```

### 6.2 GeminiEvent types (synthetic)

```typescript
type GeminiEvent =
  | { type: 'gemini:text'; text: string } // → agent:text
  | { type: 'gemini:thinking'; text: string } // → agent:thinking
  | { type: 'gemini:tool-start'; toolName; toolInput; toolUseId } // → agent:tool-start
  | { type: 'gemini:tool-end'; toolUseId; resultText?; failed? } // → agent:tool-end
  | { type: 'gemini:turn-complete'; result } // → agent:result
  | { type: 'gemini:turn-error'; message } // → agent:result (isError) + system:error
  | { type: 'gemini:init'; model; sessionId }; // → session:init
```

### 6.3 session/load — מימוש

- Agendo בודק `agentCapabilities.loadSession`
- אם `true` ויש `resumeSessionId` → מנסה `loadSession`
- אם נכשל → fallback ל-`newSession`
- אם `false` → `newSession` ישירות

### 6.4 model switching

`setModel(model)`:

1. `modelSwitching = true`
2. Kill old process group (SIGTERM, wait for exit)
3. Spawn new process עם model חדש
4. `acpInitialize()` → `loadOrCreateSession()` (עם existing `sessionId`)
5. `modelSwitching = false`

> לא משתמש ב-`unstable_setSessionModel` ACP method — מבצע restart של תהליך.

### 6.5 approval handling — tool_call vs requestPermission

ב-ACP יש **שני ערוצים** לטיפול בכלים, תלוי במצב:

**`approval-mode yolo/auto_edit`**: Gemini לא שולח `requestPermission`. במקום זאת שולח `tool_call` → `tool_call_update` notifications. Agendo מטפל ב-`sessionUpdate` → `tool_call` / `tool_call_update`.

**`approval-mode default`**: Gemini שולח `requestPermission` request (Agent → Client). Agendo מטפל ב-`GeminiClientHandler.requestPermission()` → קורא ל-`approvalHandler` → מחזיר `optionId`.

מעקב ב-`activeToolCalls: Set<string>` כדי להבדיל בין שני הזרימות.

---

## 7. פערים והמלצות

### 7.1 token-level streaming ל-Gemini (agent:text-delta)

**מה חסר**: Agendo מממש `agent:text-delta` לClaude (עם `--include-partial-messages`) אבל לא לGemini.

**מה יש**: `agent_message_chunk` ב-ACP הוא per-chunk streaming — כל notification הוא טקסט חלקי, בדיוק כמו `text_delta` של Claude.

**פתרון**:
ב-`GeminiClientHandler.sessionUpdate()`, כאשר `sessionUpdate === 'agent_message_chunk'`, במקום לצרף לbuffer ולשלוח `gemini:text` אחד — שלח `gemini:text-delta` לכל chunk.

```typescript
// במקום:
case 'agent_message_chunk':
  this.emitNdjson({ type: 'gemini:text', text: update.content.text })
  break

// שנה ל:
case 'agent_message_chunk':
  this.emitNdjson({ type: 'gemini:text-delta', text: update.content.text })
  break
```

ב-`gemini-event-mapper.ts` הוסף:

```typescript
case 'gemini:text-delta':
  return [{ type: 'agent:text-delta', text: event.text, fromDelta: true }]
```

> **הערה**: יש לבדוק אם Gemini שולח גם message מלא בסוף ה-turn (כמו Claude). מהמחקר: **לא** — Gemini שולח רק chunks ב-ACP, לא message מלא. לכן אין בעיית כפול.

### 7.2 stream-json support לexecutions

**מה חסר**: `execution-runner.ts` רץ רק template/CLI mode. אין adapter לGemini ב-stream-json mode.

**מתי שימושי**: executions חד-פעמיים שלא צריכים multi-turn (כמו `execute-capability`).

**פתרון**: הוסף `GeminiStreamJsonAdapter` שמריץ:

```bash
gemini -p "$prompt" -o stream-json --approval-mode yolo [--allowed-mcp-server-names ...]
```

ומparse את events (init, message, tool_use, tool_result, result).

**יתרון**: פשוט יותר — אין ACP state management, ללא connection lifecycle.

### 7.3 plan notifications לא מטופלים

**מה חסר**: ב-plan mode, Gemini שולח `sessionUpdate: "plan"` עם execution plan. Agendo לא מטפל בזה.

**פתרון**: הוסף handler ל-`plan` notification → emit `gemini:plan` → map ל-AgendoEvent חדש `agent:plan`.

```typescript
case 'plan':
  const entries = (update as PlanUpdate).entries
  this.emitNdjson({ type: 'gemini:plan', entries })
  break
```

### 7.4 current_mode_update לא מטופל

**מה חסר**: כאשר Gemini יוצא מplan mode, הוא שולח `current_mode_update` notification. Agendo לא קורא לזה.

**שימוש**: עדכון UI לmode הנוכחי, sync עם session.permissionMode.

### 7.5 usage_update לא מטופל

**מה חסר**: `sessionUpdate: "usage_update"` יכול לספק token counts בזמן אמת.

**פתרון**: emit `agent:usage` event עם token counts.

### 7.6 terminal capability declaration vs implementation

**הבעיה**: Agendo מצהיר `terminal: true` ב-`clientCapabilities` אבל לא מממש את `createTerminal` handler. אם Gemini ינסה להשתמש בזה — שגיאה.

**פתרון**: או הסר את `terminal: true` מה-capabilities, או מממש stub שמחזיר שגיאה מנוהלת.

### 7.7 unstable_resumeSession — לא בשימוש

**מה יש**: ACP מגדיר `unstable_resumeSession` שמ-resume session **ללא** replay של ההיסטוריה (יותר מהיר מ-`loadSession`).

**שימוש פוטנציאלי**: resume מהיר יותר כשאין צורך בהיסטוריה.

**הגבלה**: UNSTABLE — עלול להשתנות.

### 7.8 policy files — שימוש ב-Agendo

**מה חסר**: Agendo לא מזריק policy files לGemini sessions.

**פתרון**: הוסף `policyFiles?: string[]` ל-`SpawnOpts` ו-`buildArgs()`:

```typescript
if (opts.policyFiles?.length) {
  args.push('--policy', ...opts.policyFiles);
}
```

**יתרון**: control גרנולרי על אילו כלים מותרים ב-session — יותר טוב מ-`--allowed-tools` שה-deprecated.

### 7.9 stream-json resume כ-cold-resume

**מה חסר**: ל-Gemini sessions (ACP), cold-resume יוצר session חדש (fallback מ-loadSession).

**פתרון עם stream-json**: ניתן להשתמש ב-`--resume <session_id>` ב-stream-json mode כ-cold-resume מהיר לexecutions חד-פעמיים.

### סיכום פערים לפי עדיפות

| עדיפות     | פער                                      | מורכבות        |
| ---------- | ---------------------------------------- | -------------- |
| 🔴 גבוהה   | token-level streaming (agent:text-delta) | נמוכה          |
| 🔴 גבוהה   | stream-json adapter לexecutions          | בינונית        |
| 🟡 בינונית | plan notifications                       | נמוכה          |
| 🟡 בינונית | current_mode_update sync                 | נמוכה          |
| 🟡 בינונית | terminal: true → הסר או ממש              | נמוכה          |
| 🟢 נמוכה   | usage_update → agent:usage               | נמוכה          |
| 🟢 נמוכה   | policy files injection                   | נמוכה          |
| 🟢 נמוכה   | unstable_resumeSession                   | בינונית (risk) |
