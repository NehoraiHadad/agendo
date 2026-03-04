# Codex CLI (app-server) — מסמך ייחוס מקיף

> **נוצר**: 2026-03-04
> **מקורות**:
>
> - `codex app-server generate-ts --out /tmp/codex-types` (TypeScript types מהגרסה המותקנת)
> - `src/lib/worker/adapters/codex-app-server-adapter.ts`, `codex-app-server-event-mapper.ts`
> - `codex features list`, `codex --help`, `codex app-server --help`
> - [Codex App Server — developers.openai.com](https://developers.openai.com/codex/app-server/)
> - [codex-rs/app-server/README.md — GitHub](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
> - [Codex MCP Integration](https://developers.openai.com/codex/mcp/)
> - [Advanced Configuration](https://developers.openai.com/codex/config-advanced/)
> - [Configuration Reference](https://developers.openai.com/codex/config-reference/)
> - [Unlocking the Codex Harness — OpenAI Blog](https://openai.com/index/unlocking-the-codex-harness/)
>   **גרסה נבדקה**: הגרסה המותקנת על instance-neo

---

## תוכן עניינים

1. [סקירה כללית](#סקירה-כללית)
2. [פרוטוקול JSON-RPC 2.0](#פרוטוקול-json-rpc-20)
3. [Client → Server: Methods](#client--server-methods)
   - [initialize](#initialize)
   - [thread/start](#threadstart)
   - [thread/resume](#threadresume)
   - [thread/fork](#threadfork)
   - [thread/rollback](#threadrollback)
   - [thread/compact/start](#threadcompactstart)
   - [thread/archive / thread/unarchive](#threadarchive--threadunarchive)
   - [thread/setName](#threadsetname)
   - [thread/read](#threadread)
   - [thread/list](#threadlist)
   - [turn/start](#turnstart)
   - [turn/interrupt](#turninterrupt)
   - [turn/steer](#turnsteer)
   - [mcpServerStatus/list](#mcpserverstatuslist)
   - [config/batchWrite](#configbatchwrite)
4. [Server → Client: Notifications](#server--client-notifications)
5. [Server → Client: Requests (Approvals)](#server--client-requests-approvals)
6. [Sandbox Modes & Policies](#sandbox-modes--policies)
7. [Approval Policies](#approval-policies)
8. [Thread Management](#thread-management)
9. [MCP Integration](#mcp-integration)
10. [Plan Mode](#plan-mode)
11. [Feature Flags](#feature-flags)
12. [Multi-Agent / Collaboration Modes](#multi-agent--collaboration-modes)
13. [Model Selection](#model-selection)
14. [Reasoning & Streaming](#reasoning--streaming)
15. [מימוש Agendo הנוכחי](#מימוש-agendo-הנוכחי)
16. [פערים והמלצות](#פערים-והמלצות)

---

## סקירה כללית

`codex app-server` הוא שרת JSON-RPC 2.0 מתמשך שמשמש את כל ה-IDE integrations הרשמיים:

- VS Code Extension (Codex)
- JetBrains Plugin
- Xcode Extension
- macOS Desktop App

**פרוטוקול**: NDJSON (Newline-Delimited JSON) על stdio — **לא** Content-Length/LSP.
**הפעלה**: `codex app-server` (ברירת מחדל: stdio; אפשרי גם WebSocket עם `--listen ws://IP:PORT`)

### יתרונות על `codex exec`

| `codex exec` (הישן)      | `codex app-server` (הנוכחי)    |
| ------------------------ | ------------------------------ |
| spawn חדש לכל turn       | process אחד לכל session        |
| מאבד MCP state בין turns | MCP persistent across turns    |
| אין streaming            | streaming deltas               |
| אין approval handling    | approval bidirectional flow    |
| אין plan mode            | plan items + turn/plan/updated |
| אין resume אמיתי         | thread/resume שומר היסטוריה    |

---

## פרוטוקול JSON-RPC 2.0

### Framing

```
Client → Server (request):
{"jsonrpc":"2.0","id":1,"method":"thread/start","params":{...}}\n

Server → Client (response):
{"jsonrpc":"2.0","id":1,"result":{...}}\n

Server → Client (notification, no id):
{"jsonrpc":"2.0","method":"turn/started","params":{...}}\n

Server → Client (approval request, has id):
{"jsonrpc":"2.0","id":42,"method":"item/commandExecution/requestApproval","params":{...}}\n

Client → Server (approval response):
{"jsonrpc":"2.0","id":42,"result":{"decision":"accept"}}\n
```

**חשוב**: כל message מסתיים ב-`\n`. כל message הוא JSON שלם בשורה אחת.

### Initialization Sequence (חשוב!)

```
Client → Server: initialize (request with id)
Server → Client: initialize response
Client → Server: initialized (NOTIFICATION — no id!) ← Agendo חסר זאת!
Server → Client: ready to accept requests
```

**⚠️ פגם קריטי ב-Agendo**: Agendo לא שולח את ה-`initialized` notification אחרי תשובת `initialize`. תיעוד OpenAI אומר: "Follow initialization with an `initialized` notification. Requests before this handshake receive 'Not initialized' error."

כרגע זה עשוי לעבוד בפועל (Codex אולי מגמיש), אבל זה לא נכון לפי הפרוטוקול הרשמי.

---

## Client → Server: Methods

### `initialize`

**מטרה**: handshake ראשוני, capability negotiation.

**Request params** (`InitializeParams`):

```typescript
{
  clientInfo: {
    name: string,       // "agendo"
    title: string | null, // "Agendo"
    version: string     // "1.0.0"
  },
  capabilities: {
    experimentalApi: boolean,                    // opt into experimental methods/fields
    optOutNotificationMethods?: string[] | null  // suppress specific notification methods
  } | null
}
```

**Response** (`InitializeResponse`):

```typescript
{
  userAgent: string; // e.g. "codex/0.107.0"
}
```

**Agendo current**: ✅ מממש נכון. שולח `experimentalApi: true`.

---

### `thread/start`

**מטרה**: יצירת thread חדש.

**Request params** (`ThreadStartParams`):

```typescript
{
  model?: string | null,           // e.g. "o4-mini", "gpt-4.1"
  modelProvider?: string | null,   // e.g. "openai"
  cwd?: string | null,             // working directory
  approvalPolicy?: AskForApproval | null, // "untrusted"|"on-failure"|"on-request"|"never"
  sandbox?: SandboxMode | null,    // "read-only"|"workspace-write"|"danger-full-access"
  config?: Record<string, JsonValue> | null,  // config overrides
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  personality?: Personality | null,
  ephemeral?: boolean | null,      // don't persist to disk
  experimentalRawEvents: boolean,  // emit raw Responses API items (internal use)
  persistExtendedHistory: boolean  // persist richer history for resume/fork/read
}
```

**Response** (`ThreadStartResponse`):

```typescript
{
  thread: Thread,           // {id, preview, modelProvider, createdAt, updatedAt, cwd, ...}
  model: string,            // effective model (e.g. "o4-mini")
  modelProvider: string,
  cwd: string,
  approvalPolicy: AskForApproval,
  sandbox: SandboxPolicy,   // full policy object (not just the mode string)
  reasoningEffort: ReasoningEffort | null
}
```

**Notification after**: `thread/started` (params: `{thread: Thread}`)

**Agendo current**: ✅ מממש. מגדיר `experimentalRawEvents: false`, `persistExtendedHistory: false`.
**פער**: לא שולח `developerInstructions` (שימושי ל-MCP context preamble במקום system prompt injection שאין עבור Codex).

---

### `thread/resume`

**מטרה**: המשך thread קיים מ-disk (לפי thread ID).

**Request params** (`ThreadResumeParams`):

```typescript
{
  threadId: string,              // ה-thread ID מהתשובה של thread/start
  history?: ResponseItem[] | null, // [UNSTABLE] Codex Cloud בלבד
  path?: string | null,          // [UNSTABLE] rollout path
  model?: string | null,
  modelProvider?: string | null,
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,
  sandbox?: SandboxMode | null,
  config?: Record<string, JsonValue> | null,
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  personality?: Personality | null,
  persistExtendedHistory: boolean
}
```

**Response** (`ThreadResumeResponse`): זהה ל-`ThreadStartResponse` + `thread.turns` מאוכלסים.

**Agendo current**: ✅ מממש. `sessionRef` = `threadId` ב-Agendo.

---

### `thread/fork`

**מטרה**: יצירת branch חדש מ-thread קיים (Thread ID חדש, היסטוריה מועתקת).

**Request params** (`ThreadForkParams`):

```typescript
{
  threadId: string,
  path?: string | null,          // [UNSTABLE]
  model?: string | null,
  modelProvider?: string | null,
  cwd?: string | null,
  approvalPolicy?: AskForApproval | null,
  sandbox?: SandboxMode | null,
  config?: Record<string, JsonValue> | null,
  baseInstructions?: string | null,
  developerInstructions?: string | null,
  persistExtendedHistory: boolean
}
```

**Response** (`ThreadForkResponse`): זהה ל-`ThreadStartResponse` עם thread.id חדש.

**מה זה עושה**: יוצר thread חדש עם אותה היסטוריה כנקודת התחלה. המשך השיחה הולך לthread החדש בלבד.

**Agendo current**: ❌ לא ממומש.

---

### `thread/rollback`

**מטרה**: מחיקת N turns אחרונים מה-thread.

**Request params** (`ThreadRollbackParams`):

```typescript
{
  threadId: string,
  numTurns: number   // >= 1, מחיקת N turns מהסוף
}
```

**Response** (`ThreadRollbackResponse`):

```typescript
{
  thread: Thread; // thread מעודכן עם turns מאוכלסים (ללא file changes)
}
```

**חשוב**: rollback **לא** מבצע revert של שינויי קבצים. האחריות על ה-client (Agendo) לבצע `git revert` או שחזור קבצים בנפרד.

**Agendo current**: ❌ לא ממומש.

---

### `thread/compact/start`

**מטרה**: דחיסת היסטוריית ה-thread (context compaction) — מקביל ל-"compact" של Claude.

**Request params** (`ThreadCompactStartParams`):

```typescript
{
  threadId: string;
}
```

**Response**: `{}` (ריק)

**Notifications after**: `contextCompacted` (deprecated — השתמש ב-`contextCompaction` item type ב-`item/completed`).

**Agendo current**: ❌ לא ממומש.

---

### `thread/archive` / `thread/unarchive`

לא נחוץ ל-Agendo.

### `thread/setName`

הגדרת שם thread. לא נחוץ ל-Agendo.

### `thread/read`

קריאת thread מ-disk כולל turns. לא נחוץ ל-Agendo (משתמשים ב-resume).

### `thread/list`

רשימת threads שמורים. לא נחוץ ל-Agendo (Agendo מנהל sessions ב-DB).

### `config/mcpServer/reload`

**מטרה**: Reload MCP config מ-disk ולרענן threads פעילים. שימושי לאחר עדכון ידני של `config.toml`.

**Agendo current**: ❌ לא ממומש. יכול לשמש לאחר כתיבת MCP config לפני thread/start.

### `model/list`

**מטרה**: קבלת רשימת מודלים זמינים עם יכולות reasoning.

### `experimentalFeature/list`

**מטרה**: רשימת feature flags עם stage metadata. מקביל ל-`codex features list`.

### `collaborationMode/list`

**מטרה**: רשימת collaboration mode presets זמינים.

### `command/exec`

**מטרה**: הרצת פקודה בסביבת ה-sandbox ללא thread/turn. לא נחוץ ל-Agendo כרגע.

---

### `turn/start`

**מטרה**: שליחת הודעה חדשה למודל (turn חדש).

**Request params** (`TurnStartParams`):

```typescript
{
  threadId: string,
  input: UserInput[],          // array של inputs (text, image, localImage, skill, mention)
  cwd?: string | null,         // override cwd
  approvalPolicy?: AskForApproval | null,  // override
  sandboxPolicy?: SandboxPolicy | null,    // full policy object (לא SandboxMode string!)
  model?: string | null,
  effort?: ReasoningEffort | null,  // "low"|"medium"|"high"|null
  summary?: ReasoningSummary | null, // "auto"|"detailed"|"concise"
  personality?: Personality | null,
  outputSchema?: JsonValue | null,  // JSON Schema לאילוץ output סופי
  collaborationMode?: CollaborationMode | null  // EXPERIMENTAL
}
```

**UserInput variants**:

```typescript
| { type: "text", text: string, text_elements: TextElement[] }
| { type: "image", url: string }
| { type: "localImage", path: string }
| { type: "skill", name: string, path: string }
| { type: "mention", name: string, path: string }
```

**Response** (`TurnStartResponse`): `{ turn: Turn }` — Turn ריק (`items: []`, `status: "inProgress"`).

**חשוב**: `turn/start` מחזיר תשובה מיד (async). הנוטיפיקציות (`turn/started`, `item/started`, ..., `turn/completed`) מגיעות מאוחר יותר.

**Agendo current**: ✅ מממש. אבל שולח `SandboxPolicy` כ-object (נכון) ו-`approvalPolicy` כ-string (נכון).
**פגם קטן**: `turn/start` לא שולח `effort` — זה OK כברירת מחדל.
**פגם**: `model` ב-`turn/start` יכול לשנות מודל mid-session. Agendo מגדיר `this.model` אבל לא בודק אם `setModel()` שונה בין turns.

---

### `turn/interrupt`

**מטרה**: עצירת turn שרץ כרגע.

**Request params** (`TurnInterruptParams`):

```typescript
{
  threadId: string,
  turnId: string
}
```

**Response**: `{}` (ריק)

**Notifications after**: `turn/completed` עם `status: "interrupted"`.

**Agendo current**: ✅ מממש ב-`interrupt()`. יש fallback ל-SIGTERM אם timeout.

---

### `turn/steer`

**מטרה**: הזרקת הודעה למודל בזמן ריצה (mid-turn steering) — EXPERIMENTAL.

**Request params** (`TurnSteerParams`):

```typescript
{
  threadId: string,
  input: UserInput[],
  expectedTurnId: string  // precondition — נכשל אם לא match
}
```

**Response** (`TurnSteerResponse`): לא פורסם בבדיקה.

**Agendo current**: ❌ לא ממומש. שימושי להזרקת guidance בזמן ריצה.

---

### `mcpServerStatus/list`

**מטרה**: קבלת רשימת MCP servers וה-tools שלהם.

**Request params** (`ListMcpServerStatusParams`):

```typescript
{
  cursor?: string | null,
  limit?: number | null
}
```

**Response** (`ListMcpServerStatusResponse`): pagination + `items: McpServerStatus[]`

**McpServerStatus**:

```typescript
{
  name: string,
  tools: Record<string, Tool>,
  resources: Resource[],
  resourceTemplates: ResourceTemplate[],
  authStatus: McpAuthStatus
}
```

**Agendo current**: ❌ לא ממומש. יכול לשמש כ-`getMcpStatus()` implementation.

---

### `config/batchWrite`

**מטרה**: עדכון config.toml בזמן ריצה.

**Request params** (`ConfigBatchWriteParams`):

```typescript
{
  edits: ConfigEdit[],
  filePath?: string | null,     // default: user's config.toml
  expectedVersion?: string | null
}
```

**שימוש ב-Agendo**: יכול לשמש להחלפת מודל (במקום `turn/start` override). לא ממומש.

---

## Server → Client: Notifications

כל notification מגיע ללא `id`. **format כללי**:

```json
{"jsonrpc":"2.0","method":"<method>","params":{...}}
```

### Thread Lifecycle

| Method                      | Params                                | תיאור              |
| --------------------------- | ------------------------------------- | ------------------ |
| `thread/started`            | `{thread: Thread}`                    | thread חדש נוצר    |
| `thread/tokenUsage/updated` | `{threadId, usage: ThreadTokenUsage}` | token usage update |
| `thread/nameUpdated`        | `{threadId, name: string}`            | thread שונה שם     |
| `thread/archived`           | `{threadId}`                          | thread archived    |

### Turn Lifecycle

| Method             | Params                                                  | תיאור                                                           |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------- |
| `turn/started`     | `{threadId, turn: Turn}`                                | turn התחיל                                                      |
| `turn/completed`   | `{threadId, turn: Turn}`                                | turn הסתיים (turn.status: "completed"\|"interrupted"\|"failed") |
| `turn/diffUpdated` | `{threadId, turnId, ...}`                               | diff של קבצים שונו                                              |
| `turn/planUpdated` | `{threadId, turnId, explanation, plan: TurnPlanStep[]}` | plan הצעדים עודכן (ראה [Plan Mode](#plan-mode))                 |

### Item Lifecycle

| Method           | Params                                 | תיאור                       |
| ---------------- | -------------------------------------- | --------------------------- |
| `item/started`   | `{item: ThreadItem, threadId, turnId}` | item התחיל                  |
| `item/completed` | `{item: ThreadItem, threadId, turnId}` | item הסתיים (עם תוצאה מלאה) |

**ThreadItem types** (ב-`item/started` ו-`item/completed`):

```typescript
type ThreadItem =
  | { type: 'userMessage'; id; content: UserInput[] }
  | { type: 'agentMessage'; id; text: string }
  | { type: 'plan'; id; text: string }
  | { type: 'reasoning'; id; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id;
      command;
      cwd;
      processId;
      status;
      commandActions;
      aggregatedOutput;
      exitCode;
      durationMs;
    }
  | { type: 'fileChange'; id; changes: FileUpdateChange[]; status: PatchApplyStatus }
  | { type: 'mcpToolCall'; id; server; tool; status; arguments; result; error; durationMs }
  | {
      type: 'collabAgentToolCall';
      id;
      tool: CollabAgentTool;
      status;
      senderThreadId;
      receiverThreadIds;
      prompt;
      agentsStates;
    }
  | { type: 'webSearch'; id; query; action }
  | { type: 'imageView'; id; path }
  | { type: 'enteredReviewMode'; id; review }
  | { type: 'exitedReviewMode'; id; review }
  | { type: 'contextCompaction'; id };
```

### Streaming Deltas

| Method                              | Params                                            | תיאור                              |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `item/agentMessage/delta`           | `{threadId, turnId, itemId, delta: string}`       | streaming text                     |
| `item/plan/delta`                   | `{threadId, turnId, itemId, delta: string}`       | streaming plan text (EXPERIMENTAL) |
| `item/reasoning/summaryTextDelta`   | `{threadId, turnId, itemId, delta, summaryIndex}` | reasoning summary streaming        |
| `item/reasoning/textDelta`          | `{threadId, turnId, itemId, delta}`               | reasoning raw text streaming       |
| `item/reasoning/summaryPartAdded`   | `{threadId, turnId, itemId, summaryIndex}`        | new reasoning section              |
| `item/commandExecution/outputDelta` | `{threadId, turnId, itemId, delta}`               | command output streaming           |
| `item/fileChange/outputDelta`       | `{threadId, turnId, itemId, delta}`               | file change streaming              |
| `item/mcpToolCall/progress`         | `{threadId, turnId, itemId, message}`             | MCP tool progress                  |

### System/Other Notifications

| Method                           | Params                                            | תיאור                                                 |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| `error`                          | `{error: TurnError, willRetry, threadId, turnId}` | שגיאה (עם retry info)                                 |
| `contextCompacted`               | `{threadId, turnId}`                              | **DEPRECATED** — השתמש ב-contextCompaction item       |
| `modelRerouted`                  | `{threadId, turnId, fromModel, toModel, reason}`  | מודל הוחלף אוטומטית                                   |
| `account/rateLimits/updated`     | `{...RateLimitSnapshot}`                          | rate limits עודכנו                                    |
| `configWarning`                  | `{message}`                                       | אזהרת config                                          |
| `mcpServer/startupUpdate`        | `{...McpStartupUpdateEvent}`                      | MCP server סטטוס startup                              |
| `thread/status/changed`          | `{threadId, status}`                              | thread status: `notLoaded\|idle\|systemError\|active` |
| `thread/closed`                  | `{threadId}`                                      | thread נסגר                                           |
| `skills/changed`                 | `{...}`                                           | skill files שונו                                      |
| `mcpServer/oauthLogin/completed` | `{...}`                                           | OAuth flow הסתיים                                     |
| `codex/event/session_configured` | `{...}`                                           | ניתן לסנן דרך `optOutNotificationMethods`             |

**שגיאות Turn** (`TurnError`):

```typescript
{
  message: string,
  codexErrorInfo: {
    httpStatusCode?: number,
    errorCode?: string  // "ContextWindowExceeded"|"UsageLimitExceeded"|"HttpConnectionFailed"|"SandboxError"|"ResponseStreamDisconnected"
  } | null,
  additionalDetails: string | null
}
```

---

## Server → Client: Requests (Approvals)

Approval requests מגיעים **עם id** (בניגוד ל-notifications). ה-client חייב לשלוח תשובה.

### `item/commandExecution/requestApproval`

```typescript
// Server → Client (has id!)
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "item/commandExecution/requestApproval",
  "params": {
    threadId: string,
    turnId: string,
    itemId: string,
    approvalId?: string | null,    // null לבקשות רגילות; UUID ל-zsh-exec-bridge
    reason?: string | null,         // הסבר (e.g. "requires network access")
    command?: string | null,        // הפקודה לביצוע
    cwd?: string | null,
    commandActions?: CommandAction[] | null,  // parsed command breakdown
    proposedExecpolicyAmendment?: ExecPolicyAmendment | null  // array of strings
  }
}
```

**Response**:

```typescript
// Client → Server
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "decision": CommandExecutionApprovalDecision
  }
}
```

**`CommandExecutionApprovalDecision`** (כל הערכים האפשריים):

```typescript
type CommandExecutionApprovalDecision =
  | 'accept' // אפשר פעם אחת
  | 'acceptForSession' // אפשר לכל ה-session
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } // אפשר + שמור כ-rule
  | 'decline' // דחה
  | 'cancel'; // בטל את ה-turn
```

**Agendo current**: ✅ מממש `accept`, `acceptForSession`, `decline`. ❌ לא מממש `acceptWithExecpolicyAmendment`.

### `item/fileChange/requestApproval`

```typescript
// Server → Client (has id!)
{
  "jsonrpc": "2.0",
  "id": 43,
  "method": "item/fileChange/requestApproval",
  "params": {
    threadId: string,
    turnId: string,
    itemId: string,
    reason?: string | null,
    grantRoot?: string | null    // [UNSTABLE] בקשה להרשאת כתיבה ל-root זה
  }
}
```

**Response**:

```typescript
{
  "result": { "decision": "accept" | "acceptForSession" | "decline" | "cancel" }
}
```

**Agendo current**: ✅ מממש.

### `tool/requestUserInput` (EXPERIMENTAL)

```typescript
{
  "jsonrpc": "2.0",
  "id": 44,
  "method": "tool/requestUserInput",
  "params": {
    threadId, turnId, itemId,
    questions: [{
      id: string,
      header: string,
      question: string,
      isOther: boolean,
      isSecret: boolean,
      options: [{id, label, description}] | null
    }]
  }
}
```

**Response**:

```typescript
{
  "result": {
    "answers": {
      "<questionId>": { "answers": ["<selected option id or free text>"] }
    }
  }
}
```

**Agendo current**: ❌ לא ממומש. מקביל ל-`AskUserQuestion` של Claude.

---

## Sandbox Modes & Policies

### `SandboxMode` (string) — ב-thread/start, thread/resume

```typescript
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
```

### `SandboxPolicy` (object) — ב-turn/start

```typescript
type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; access: ReadOnlyAccess }
  | { type: 'externalSandbox'; networkAccess: NetworkAccess }
  | {
      type: 'workspaceWrite';
      writableRoots: string[]; // רשימת directories שמותר לכתוב בהם
      readOnlyAccess: ReadOnlyAccess;
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
```

**`ReadOnlyAccess`**:

```typescript
type ReadOnlyAccess =
  | { type: 'restricted'; includePlatformDefaults: boolean; readableRoots: string[] }
  | { type: 'fullAccess' };
```

### מיפוי PermissionMode → Sandbox (Agendo)

| Agendo `permissionMode`         | `SandboxMode`        | `SandboxPolicy`                                 | `ApprovalPolicy` |
| ------------------------------- | -------------------- | ----------------------------------------------- | ---------------- |
| `bypassPermissions` / `dontAsk` | `danger-full-access` | `{type:"dangerFullAccess"}`                     | `never`          |
| `plan`                          | `read-only`          | `{type:"readOnly", access:{type:"fullAccess"}}` | `on-request`     |
| `default` / `acceptEdits`       | `workspace-write`    | `{type:"workspaceWrite",...}`                   | `on-request`     |

**פגם נוכחי ב-Agendo**: ב-`sandboxPolicy` של `workspaceWrite`, שדה `excludeTmpdirEnvVar` ו-`excludeSlashTmp` נשלחים כ-`false`, וה-`writableRoots` ריק — Codex יכתוב לכל ה-workspace. זה עשוי להיות תכונה, לא bug.

---

## Approval Policies

```typescript
type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';
```

| ערך          | התנהגות                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `untrusted`  | מריץ פקודות "בטוחות" ללא אישור; מעלה לאדם אם הפקודה לא ב-trusted set            |
| `on-failure` | **DEPRECATED** — מריץ הכל ללא אישור; שואל רק אם הפקודה נכשלת. העדף `on-request` |
| `on-request` | המודל מחליט מתי לשאול (מומלץ לsessions אינטראקטיביים)                           |
| `never`      | לעולם לא שואל. כישלונות מוחזרים למודל ישירות                                    |

---

## Thread Management

### fork

```
Thread A (history: t1, t2, t3)
         ↓ thread/fork
Thread B (history: t1, t2, t3) ← independent from here
```

**שימוש**: ניסויים מבלי לפגוע ב-thread המקורי. Thread ID חדש.

### rollback

```
Thread A: [t1, t2, t3, t4, t5]
           ↓ thread/rollback(numTurns: 2)
Thread A: [t1, t2, t3]
```

**אזהרה**: לא מבצע revert קבצים. ה-client אחראי.

### compact

מדחס את היסטוריית ה-context (context compaction). מייצר `contextCompaction` item ב-thread.

**מתי להשתמש**: כש-context window מתמלא.

---

## MCP Integration

### הגדרת MCPs ב-Codex app-server

MCPs **לא** מוגדרים דרך ה-JSON-RPC protocol ב-`thread/start`. הם מוגדרים דרך:

#### שיטה 1: קובץ config.toml (TOML format)

```toml
# ~/.codex/config.toml
[mcp_servers.agendo]
command = "node"
args = ["/home/ubuntu/projects/agendo/dist/mcp-server.js"]
env = { AGENDO_URL = "http://localhost:4100", JWT_SECRET = "..." }
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled = true
required = true              # אם false, שגיאת startup לא תוקע session
enabled_tools = []           # רשימת tools להפעלה (ריק = הכל)
disabled_tools = []          # רשימת tools לניטרול
```

**HTTP servers**:

```toml
[mcp_servers.remote]
url = "https://mcp-server.example.com"
bearer_token_env_var = "MY_TOKEN_ENV"
```

**Project-scoped** (trusted projects בלבד): `.codex/config.toml` בשורש הפרויקט.

#### שיטה 2: `config/batchWrite` JSON-RPC

עדכון config בזמן ריצה (לאחר `initialize`):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "config/batchWrite",
  "params": {
    "edits": [
      {
        "type": "set",
        "key": "mcp_servers.agendo.command",
        "value": "node"
      },
      {
        "type": "set",
        "key": "mcp_servers.agendo.args",
        "value": ["/home/ubuntu/projects/agendo/dist/mcp-server.js"]
      }
    ]
  }
}
```

אחרי `config/batchWrite`, קרא `config/mcpServer/reload` לטעינה מחדש.

**⚠️ אזהרה**: לא ברור אם `config/batchWrite` + `config/mcpServer/reload` עובד לפני `thread/start` (MCP config טעון כאשר process עולה). יש לבדוק בפועל.

#### שיטה 3: Dynamic Tools (EXPERIMENTAL)

```json
{
  "method": "thread/start",
  "params": {
    "dynamicTools": [
      {
        "name": "lookup_ticket",
        "description": "Fetch a ticket by id",
        "inputSchema": {
          "type": "object",
          "properties": { "id": { "type": "string" } },
          "required": ["id"]
        }
      }
    ]
  }
}
```

צריך `capabilities.experimentalApi: true`. **לא** מחליף MCPs — אלה tools ישירים (בלי MCP server).

### MCP State Across Turns

**כן, MCPs מתמשכים בין turns בתוך אותו thread**. Codex app-server שומר את ה-MCP connections חיים לכל אורך ה-thread.

**לעומת `codex exec`**: ב-exec, כל הפעלה הייתה process חדש — MCP connections היו מתאפסים.

### MCP Known Issues

**GitHub Issue #6465**: MCP servers לא נטענים ב-VS Code extension (אבל עובדים ב-CLI). הבעיה: extension מפעיל app-server שלא חולק את ה-MCP process context עם CLI. **לא תוקן** (נובמבר 2025).

**ל-Agendo**: הגדר MCPs ב-`~/.codex/config.toml` **לפני** שinit הprocess.

### בדיקת MCP Status

```json
// Request
{"jsonrpc":"2.0","id":5,"method":"mcpServerStatus/list","params":{}}

// Response
{"jsonrpc":"2.0","id":5,"result":{
  "items": [{
    "name": "agendo",
    "tools": {"create_task": {...}, "update_task": {...}},
    "resources": [],
    "resourceTemplates": [],
    "authStatus": "connected"
  }]
}}
```

### Agendo Current MCP Setup

**בעיה**: Agendo כרגע **לא** מזריק MCP config ל-Codex app-server. הסשן של Codex מסתמך על `~/.codex/config.toml` של המשתמש.

לעומת Gemini שמקבל MCP config דרך ACP session/new params — Codex צריך שה-config יהיה קיים מראש בקובץ.

**פתרון מוצע**: Agendo כותב MCP config ל-`~/.codex/config.toml` עם ecosystem.config.js (פעם אחת), ומוודא שהוא שם לפני spawn של Codex sessions.

---

## Plan Mode

### Plan Items

כאשר המודל מייצר "תוכנית עבודה", מגיע item מסוג `plan`:

```typescript
{ type: "plan", id: string, text: string }
```

- `item/started` → `{ type: "plan", id, text: "" }`
- `item/plan/delta` → `{ threadId, turnId, itemId, delta: string }` (streaming, EXPERIMENTAL)
- `item/completed` → `{ type: "plan", id, text: "<full plan text>" }`

**הערה**: concatenation של deltas לא מובטח להיות זהה ל-`text` הסופי.

### Turn Plan Steps

בנפרד מ-plan items, Codex שולח notification על צעדי תכנון:

```json
{
  "method": "turn/planUpdated",
  "params": {
    "threadId": "...",
    "turnId": "...",
    "explanation": "Breaking down the task...",
    "plan": [
      { "step": "Read existing tests", "status": "completed" },
      { "step": "Implement feature X", "status": "inProgress" },
      { "step": "Run tests", "status": "pending" }
    ]
  }
}
```

**`TurnPlanStepStatus`**: `"pending" | "inProgress" | "completed"`

### Collaboration Mode לתכנון

```typescript
// ב-turn/start:
collaborationMode: {
  mode: "orchestrator" | "subagent" | "solo",
  settings: {
    developer_instructions: string | null  // null = use built-in
  }
}
```

**`collaboration_modes` feature flag**: `stable = true` (פועל ב-Agendo).

### Plan Mode ב-Agendo

**Agendo current**:

- `plan` items מטופלים ב-`normalizeThreadItem()` ↔ `AppServerPlanItem`
- ב-event-mapper: plan item מוצג כ-`agent:text` (כלומר, מוצג בצ'אט כטקסט)
- ❌ `item/plan/delta` notification **לא מטופל** ב-adapter (אין `case 'item/plan/delta'`)
- ❌ `turn/planUpdated` notification **לא מטופל**

---

## Feature Flags

מצב נוכחי (`codex features list`):

| Feature                      | Stage             | פועל? | תיאור                            |
| ---------------------------- | ----------------- | ----- | -------------------------------- |
| `undo`                       | stable            | ❌    | undo operations                  |
| `shell_tool`                 | stable            | ✅    | unified shell tool               |
| `unified_exec`               | stable            | ✅    | unified execution                |
| `shell_snapshot`             | stable            | ✅    | shell state snapshots            |
| `js_repl`                    | under development | ❌    | JavaScript REPL                  |
| `js_repl_tools_only`         | under development | ❌    |                                  |
| `codex_git_commit`           | under development | ❌    | auto git commits                 |
| `memory_tool`                | under development | ❌    | persistent memory                |
| `child_agents_md`            | under development | ❌    | multi-agent via markdown         |
| `apply_patch_freeform`       | under development | ❌    | freeform patch application       |
| `use_linux_sandbox_bwrap`    | experimental      | ❌    | Linux bubblewrap sandbox         |
| `multi_agent`                | experimental      | ❌    | multi-agent support              |
| `apps`                       | experimental      | ❌    | Codex Apps marketplace           |
| `apps_mcp_gateway`           | under development | ❌    | Apps MCP gateway                 |
| `steer`                      | stable            | ✅    | `turn/steer` method              |
| `collaboration_modes`        | stable            | ✅    | collaboration mode in turn/start |
| `personality`                | stable            | ✅    | personality configuration        |
| `enable_request_compression` | stable            | ✅    | request compression              |
| `responses_websockets`       | under development | ❌    | WebSocket transport              |
| `web_search_request`         | deprecated        | ❌    |                                  |
| `search_tool`                | removed           | ❌    |                                  |

**מה זה אומר ל-Agendo**:

- `steer` (stable) — `turn/steer` זמין, Agendo לא מממש אותו
- `collaboration_modes` (stable) — `collaborationMode` ב-`turn/start` זמין
- `multi_agent` (experimental, disabled) — `collabAgentToolCall` items יופיעו רק אם מופעל

---

## Multi-Agent / Collaboration Modes

### Collaboration Tools

כאשר `multi_agent` מופעל, Codex יכול להשתמש בכלים:

```typescript
type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
```

מייצרים `collabAgentToolCall` items:

```typescript
{
  type: "collabAgentToolCall",
  id: string,
  tool: CollabAgentTool,
  status: "inProgress" | "completed" | "failed",
  senderThreadId: string,
  receiverThreadIds: string[],
  prompt: string | null,
  agentsStates: Record<string, CollabAgentState>
}
```

**Agendo current**: ❌ `collabAgentToolCall` לא מטופל ב-`normalizeThreadItem()`.

### Collaboration Modes

ב-`turn/start`, `collaborationMode` מאפשר:

```typescript
type CollaborationMode = {
  mode: 'orchestrator' | 'subagent' | 'solo';
  settings?: {
    developer_instructions: string | null;
  };
};
```

- `solo` — מודל יחיד, אין collaboration
- `orchestrator` — Codex כ-orchestrator שמנהל sub-agents
- `subagent` — Codex כ-sub-agent שמקבל פקודות

---

## Model Selection

### model ב-thread/start

```json
{"method":"thread/start","params":{"model":"o4-mini",...}}
```

מגדיר את המודל לכל ה-thread (ניתן לoverride בכל turn).

### model ב-turn/start

```json
{"method":"turn/start","params":{"threadId":"...","model":"gpt-4.1",...}}
```

מחליף מודל מה-turn הזה ואילך.

### Model Reroute

אם המודל המבוקש לא זמין, Codex יכול לבצע reroute אוטומטי ולשלוח notification:

```json
{
  "method": "modelRerouted",
  "params": { "threadId": "...", "fromModel": "o3", "toModel": "o4-mini", "reason": "..." }
}
```

### Agendo current

```typescript
// codex-app-server-adapter.ts
async setModel(model: string): Promise<boolean> {
  this.model = model;  // שומר locally
  return true;
}
```

**בעיה**: `setModel()` רק שומר locally. ה-model החדש ישלח רק בה-`turn/start` הבא (דרך `this.model`). זה **עובד בפועל** — אין צורך ב-RPC נפרד להחלפת מודל.

---

## Reasoning & Streaming

### Reasoning Item

```typescript
{
  type: "reasoning",
  id: string,
  summary: string[],   // concise summaries (for display)
  content: string[]    // full reasoning content
}
```

### Streaming Notifications לרeasoning:

- `item/reasoning/summaryTextDelta` — `{threadId, turnId, itemId, delta, summaryIndex}`
- `item/reasoning/textDelta` — `{threadId, turnId, itemId, delta}`
- `item/reasoning/summaryPartAdded` — `{threadId, turnId, itemId, summaryIndex}`

**Agendo current**:

- ✅ `item/reasoning/summaryTextDelta` → `as:reasoning.delta` → `agent:thinking-delta`
- ❌ `item/reasoning/textDelta` לא מטופל
- ❌ `item/reasoning/summaryPartAdded` לא מטופל

### `effort` parameter ב-turn/start:

```typescript
type ReasoningEffort = 'low' | 'medium' | 'high' | null;
```

ניתן לשנות בכל turn. **Agendo לא שולח effort**.

---

## מימוש Agendo הנוכחי

### קבצים רלוונטיים

- `src/lib/worker/adapters/codex-app-server-adapter.ts` — ה-adapter הראשי
- `src/lib/worker/adapters/codex-app-server-event-mapper.ts` — מיפוי events לAgendoEventPayloads
- `src/lib/worker/adapters/adapter-factory.ts` — routing לפי `binaryName`

### מה מממש

| Feature                                     | Status       |
| ------------------------------------------- | ------------ |
| `initialize`                                | ✅           |
| `thread/start`                              | ✅           |
| `thread/resume`                             | ✅           |
| `turn/start`                                | ✅           |
| `turn/interrupt`                            | ✅           |
| `item/commandExecution/requestApproval`     | ✅           |
| `item/fileChange/requestApproval`           | ✅           |
| `turn/started` notification                 | ✅           |
| `turn/completed` notification               | ✅           |
| `item/started` notification                 | ✅           |
| `item/agentMessage/delta` streaming         | ✅           |
| `item/reasoning/summaryTextDelta` streaming | ✅           |
| agentMessage item → agent:text              | ✅           |
| reasoning item → agent:thinking             | ✅           |
| commandExecution item → tool-start/tool-end | ✅           |
| fileChange item → tool-start/tool-end       | ✅           |
| mcpToolCall item → tool-start/tool-end      | ✅           |
| plan item → agent:text                      | ✅ (as text) |
| error notification                          | ✅           |

### מה לא מממש

| Feature                                 | Priority | הסבר                               |
| --------------------------------------- | -------- | ---------------------------------- |
| `item/plan/delta` streaming             | MEDIUM   | plan streaming deltas לא מטופלים   |
| `turn/planUpdated` notification         | MEDIUM   | step-by-step plan tracking         |
| `tool/requestUserInput` approval        | HIGH     | מקביל ל-AskUserQuestion של Claude  |
| `turn/steer`                            | LOW      | mid-turn steering                  |
| `thread/fork`                           | LOW      | conversation branching             |
| `thread/rollback`                       | LOW      | undo turns                         |
| `thread/compact/start`                  | MEDIUM   | context compaction                 |
| `mcpServerStatus/list`                  | MEDIUM   | שמיש ל-getMcpStatus()              |
| `acceptWithExecpolicyAmendment`         | LOW      | permanent approval rules           |
| `collabAgentToolCall` item              | LOW      | multi-agent (experimental feature) |
| `item/commandExecution/outputDelta`     | LOW      | streaming command output           |
| `item/reasoning/textDelta`              | LOW      | raw reasoning streaming            |
| MCP injection via config                | HIGH     | Codex לא מקבל MCPs דינמית          |
| `collaborationMode` in turn/start       | LOW      | collaboration modes                |
| `developerInstructions` in thread/start | MEDIUM   | system prompt equivalent           |

---

## פערים והמלצות

### P0 — קריטי

#### 0. `initialized` Notification חסר

**בעיה**: Agendo שולח `initialize` request אבל לא שולח את ה-`initialized` notification שחייב להגיע אחריה.

**קוד הבעיה** (`codex-app-server-adapter.ts`, שורה 252):

```typescript
await this.rpcCall('initialize', {...});
// חסר: שליחת initialized notification
await this.rpcCall('thread/start', {...});  // לא בטוח שעובד ללא initialized
```

**תיקון**:

```typescript
await this.rpcCall('initialize', {...});
// שלח initialized notification (ללא id)
this.sendNotification('initialized', {});
await this.rpcCall('thread/start', {...});
```

**הערה**: בפועל זה נראה עובד (Codex כנראה tolerant), אבל זה לא תקין לפי הפרוטוקול הרשמי.

#### 1. MCP Config Injection

**בעיה**: Agendo לא יכול להזריק MCPs ל-Codex app-server דינמית. Codex צריך שה-MCP יהיה מוגדר ב-`~/.codex/config.toml` לפני ההפעלה.

**פתרון A (מומלץ)**: לפני spawn של Codex, כתוב config ל-`config.toml` דרך `config/batchWrite` או ישירות לקובץ, ואז spawn.

**פתרון B**: השתמש ב-`config/batchWrite` לאחר `initialize` (לפני `thread/start`) להוסיף MCP config:

```json
{"method":"config/batchWrite","params":{
  "edits": [{"type":"set","key":"mcp_servers","value":[...]}]
}}
```

**אמינות**: לא בדקנו אם `config/batchWrite` מוסיף MCPs ל-session קיים.

#### 2. `tool/requestUserInput` Approval Handler

**בעיה**: כאשר Codex שואל את המשתמש שאלה (EquivalentAskUserQuestion), Agendo לא מטפל בבקשה זו.

**פתרון**: הוסף handler ל-`tool/requestUserInput` ב-`handleServerRequest()`:

```typescript
if (method === 'tool/requestUserInput') {
  // emit agent:ask-user event, wait for answer, respond
}
```

### P1 — חשוב

#### 3. `developerInstructions` ב-thread/start

**בעיה**: Agendo מזריק MCP context preamble לClaude דרך `appendSystemPrompt`, אך אין מקביל לזה ב-Codex.

**פתרון**: שלח `developerInstructions` ב-`thread/start` params עם ה-MCP context preamble. זה שדה ייעודי עבור developer-level instructions שלא "ניקחות" מהinitial user prompt.

#### 4. Context Compaction

**בעיה**: Agendo לא מטפל ב-context compaction. Sessions עם שיחות ארוכות ייכשלו כש-context window יתמלא.

**פתרון**:

1. עקוב אחר `thread/tokenUsage/updated` notifications
2. כאשר usage מגיע ל-80%, קרא ל-`thread/compact/start`
3. טפל ב-`contextCompaction` item ב-`item/completed`

#### 5. `turn/planUpdated` Notification

**בעיה**: Codex שולח step-by-step plan updates שAgendo מתעלם מהם.

**פתרון**: הוסף `case 'turn/planUpdated'` ב-`handleNotification()`, emit synthetic event, מפה ל-`agent:thinking` או event חדש.

### P2 — שיפורים

#### 6. `item/plan/delta` Streaming

הוסף `case 'item/plan/delta'` ב-`handleNotification()`:

```typescript
case 'item/plan/delta': {
  const delta = params.delta as string;
  const itemId = params.itemId as string;
  if (delta) this.emitSynthetic({ type: 'as:delta', text: delta, itemId });
  break;
}
```

#### 7. `item/commandExecution/outputDelta` Streaming

לאפשר streaming של command output בזמן ריצה (עכשיו רק `aggregatedOutput` ב-completion).

#### 8. `turn/steer` Mid-Turn Injection

מאפשר הזרקת הוראות בזמן ריצה של turn. שימושי להדרכת agent mid-task.

#### 9. `thread/rollback` + UI

מאפשר undo של turns אחרונים עם UI button. **חשוב**: הזכר את הצורך ב-revert קבצים ב-git.

#### 10. `acceptWithExecpolicyAmendment` Decision

Codex יכול "לזכור" approval rules לסוגי פקודות. Agendo מחמיץ את זה ועשוי לשאול שוב ושוב על אותן פקודות.

### P3 — עתידי

#### 11. `thread/fork` for Conversation Branching

אפשר ל-Agendo לתמוך ב-branching conversations (כמו Claude's `--fork-session`). יצריך שינויי DB.

#### 12. Multi-Agent Support

כאשר `multi_agent` תהפוך stable, Agendo יצטרך לטפל ב-`collabAgentToolCall` items ולספק UI לsub-agents.

---

## נספח: JSON Examples מלאים

### Flow מלא: Session עם אישורים

```jsonc
// 1. Client → Server: initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"agendo","title":"Agendo","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}

// 2. Server → Client: initialize response
{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex/0.107.0"}}

// 2b. Client → Server: initialized notification (חסר ב-Agendo! — no id)
{"jsonrpc":"2.0","method":"initialized","params":{}}

// 3. Client → Server: thread/start
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"model":"o4-mini","cwd":"/home/ubuntu/projects/agendo","approvalPolicy":"on-request","sandbox":"workspace-write","experimentalRawEvents":false,"persistExtendedHistory":false}}

// 4. Server → Client: thread/start response
{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-abc123","preview":"","modelProvider":"openai","createdAt":1741100000,"updatedAt":1741100000,"cwd":"/home/ubuntu/projects/agendo","cliVersion":"0.107.0","source":"app-server","gitInfo":null,"turns":[]},"model":"o4-mini","modelProvider":"openai","cwd":"/home/ubuntu/projects/agendo","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite","writableRoots":[],"readOnlyAccess":{"type":"fullAccess"},"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"reasoningEffort":null}}

// 5. Server → Client: thread/started notification
{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"thread-abc123",...}}}

// 6. Client → Server: turn/start
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"thread-abc123","input":[{"type":"text","text":"list files in current directory","text_elements":[]}],"approvalPolicy":"on-request","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"readOnlyAccess":{"type":"fullAccess"},"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"model":"o4-mini","effort":null,"summary":"auto","outputSchema":null}}

// 7. Server → Client: turn/start response (immediate)
{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-xyz789","items":[],"status":"inProgress","error":null}}}

// 8. Server → Client: turn/started notification
{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-abc123","turn":{"id":"turn-xyz789","items":[],"status":"inProgress","error":null}}}

// 9. Server → Client: item/started (commandExecution)
{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","item":{"type":"commandExecution","id":"item-111","command":"ls -la","cwd":"/home/ubuntu/projects/agendo","processId":null,"status":"inProgress","commandActions":[],"aggregatedOutput":null,"exitCode":null,"durationMs":null}}}

// 10. Server → Client: commandExecution approval request (HAS ID!)
{"jsonrpc":"2.0","id":100,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","itemId":"item-111","command":"ls -la","cwd":"/home/ubuntu/projects/agendo","reason":null,"commandActions":[{"type":"exec","program":"ls"}]}}

// 11. Client → Server: approval response
{"jsonrpc":"2.0","id":100,"result":{"decision":"accept"}}

// 12. Server → Client: item/commandExecution/outputDelta (streaming)
{"jsonrpc":"2.0","method":"item/commandExecution/outputDelta","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","itemId":"item-111","delta":"total 128\n"}}

// 13. Server → Client: item/completed
{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","item":{"type":"commandExecution","id":"item-111","command":"ls -la","cwd":"/home/ubuntu/projects/agendo","status":"completed","aggregatedOutput":"total 128\ndrwxr-xr-x...","exitCode":0,"durationMs":45}}}

// 14. Server → Client: item/agentMessage/delta (streaming text)
{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","itemId":"item-222","delta":"The directory contains "}}

// 15. Server → Client: item/completed (agentMessage)
{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-abc123","turnId":"turn-xyz789","item":{"type":"agentMessage","id":"item-222","text":"The directory contains the following files:\n- src/\n- package.json\n..."}}}

// 16. Server → Client: turn/completed
{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-abc123","turn":{"id":"turn-xyz789","items":[],"status":"completed","error":null}}}
```
