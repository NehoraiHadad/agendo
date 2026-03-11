# מחקר מיגרציה: Claude Agent SDK

**תאריך:** 2026-03-11
**חוקר:** Claude Sonnet 4.6
**קובץ מקור:** `src/lib/worker/adapters/claude-adapter.ts`

---

## סיכום מנהלים

**המלצה: מיגרציה חלקית — Phase 1 מיידי, Phase 2 עתידי.**

ה-SDK קיים, יציב, ועושה בדיוק את מה שאגנדו כרגע עושה ידנית. אך מיגרציה מלאה דורשת שינוי ארכיטקטורלי משמעותי (החלפת `claude-event-mapper.ts` במיפוי SDK messages) ויש סיכון ESM. המלצה: להשתמש ב-SDK **ל-session utilities** (listSessions, getSessionMessages) מיידית ולתכנן מיגרציה מלאה כ-refactor נפרד.

---

## 1. מצב ה-SDK

### זמינות ועדכניות

- **Package:** `@anthropic-ai/claude-agent-sdk`
- **גרסה נוכחית:** `0.2.72` (פורסם אתמול, 130 גרסאות)
- **שינוי שם:** שונה מ-`@anthropic-ai/claude-code` — SDK זהה, רק שם חדש
- **מנוע:** Node >= 18.0.0
- **Peer deps:** `zod@^3.24.1`
- **Module type:** ESM בלבד (`sdk.mjs`, `type: "module"`)
- **TypeScript types:** `sdk.d.ts` מצורף
- **לא מותקן** ב-agendo כרגע (רק `@anthropic-ai/sdk`)

### יציבות

פעיל מאוד — 14 מתחזקים מ-Anthropic, פרסומים יומיים. APIs ב-V1 יציבים. V2 preview (`createSession()`/`send()`/`stream()`) ב-unstable.

---

## 2. שאלות קריטיות — תשובות

### האם TypeScript SDK קיים ויציב?

**כן.** v0.2.72, מנוהל על ידי Anthropic, תיעוד מלא, types מצורפים.

### האם slash commands עובדים דרך ה-SDK?

**כן, עם הסתייגות.**

- פקודות built-in (`/compact`, `/clear`, `/help` וכו') עובדות — שולחים אותן כ-prompt strings רגילים
- פקודות custom מ-`.claude/commands/` עובדות אם מגדירים `settingSources: ['project']`
- **`/btw` — לא עובד.** זוהי פקודה TUI בלבד, לא נתמכת ב-stream-json mode. כבר מתועד בקוד הנוכחי (`// /btw and other TUI-only commands do NOT work here`)
- הפקודות הנוכחיות ב-`KNOWN_SLASH_COMMANDS` (compact, clear, model וכו') כולן עובדות

### האם ה-SDK חושף stream events באותו פורמט?

**לא, פורמט שונה** — זה הסיכון הגדול ביותר במיגרציה.

| SDK Message Type             | תיאור                                                        | אגנדו כרגע                       |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `SDKAssistantMessage`        | `{ type: "assistant", message: BetaMessage }`                | parsed מ-NDJSON `assistant` line |
| `SDKResultMessage`           | `{ type: "result", subtype: "success"\|"error_*" }`          | parsed מ-`result` line           |
| `SDKSystemMessage` (init)    | `{ type: "system", subtype: "init", session_id, ... }`       | parsed מ-`system/init`           |
| `SDKPartialAssistantMessage` | `{ type: "stream_event", event: BetaRawMessageStreamEvent }` | parsed מ-`stream_event`          |
| `SDKCompactBoundaryMessage`  | `{ type: "system", subtype: "compact_boundary" }`            | parsed מ-`compact_boundary`      |

ה-SDK מחזיר typed TypeScript objects — המיפוי ל-`AgendoEvent`s כבר לא יעבור דרך `claude-event-mapper.ts`. צריך ליצור `sdk-event-mapper.ts` חדש.

### האם `--include-partial-messages` נתמך?

**כן.** `options.includePartialMessages: true` → מחזיר `SDKPartialAssistantMessage` עם `type: "stream_event"`.

### האם session resume/fork עובד?

**כן, ישיר.**

- `options.resume: sessionId` ← מחליף את `--resume <ref>`
- `options.forkSession: true` ← מחליף את `--fork-session`
- `options.resumeSessionAt: messageUuid` ← מחליף את `--resume-session-at`
- `options.continue: true` ← resume המושב האחרון (ללא ID)

### האם ה-SDK מאפשר הזרקת env vars, cwd, custom args?

**כן, מלא.**

- `options.cwd: string` — working directory
- `options.env: Record<string, string | undefined>` — env vars לתת-פרוצס
- `options.extraArgs: Record<string, string | null>` — args נוספים
- `options.model`, `options.permissionMode`, `options.maxBudgetUsd`, `options.fallbackModel`, `options.effort` — כולם נתמכים
- `options.appendSystemPrompt` → `options.systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }`
- `options.strictMcpConfig: boolean` — נתמך

**⚠️ חשוב:** `options.env` מוחלף ב-process.env של התת-פרוצס. צריך לוודא ש-`CLAUDECODE` ו-`CLAUDE_CODE_ENTRYPOINT` מסוננים (כמו שנעשה היום ב-`buildChildEnv()`).

### האם tool approvals (permission decisions) זמינים?

**כן, ב-2 דרכים:**

**דרך 1 — `options.canUseTool` (מקביל לנוכחי):**

```typescript
canUseTool: async (toolName, input, { signal, toolUseID }) => {
  const decision = await approvalHandler.handleApprovalRequest({
    approvalId: toolUseID,
    toolName,
    toolInput: input,
  });
  return decision === 'deny'
    ? { behavior: 'deny', message: 'User denied' }
    : { behavior: 'allow', updatedInput: ... };
}
```

**דרך 2 — hooks `PermissionRequest`:**

```typescript
hooks: {
  PermissionRequest: [{ hooks: [permissionHook] }];
}
```

מחליף את כל מנגנון `control_request/control_response` + `handleToolApprovalRequest()`.

### האם MCP servers נתמכים?

**כן.** `options.mcpServers: Record<string, McpServerConfig>`:

```typescript
mcpServers: {
  agendo: {
    type: 'stdio',
    command: 'node',
    args: ['dist/mcp-server.js'],
    env: { AGENDO_URL: '...', JWT_SECRET: '...' }
  }
}
```

מחליף את `--mcp-config <path>` + קובץ JSON. גם `options.strictMcpConfig: true` נתמך.

---

## 3. רכיב קריטי: Multi-Turn (Persistent Session)

זוהי הנקודה המרכזית ביותר לאגנדו. ה-SDK תומך במולטי-טורן דרך **streaming input**:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// צור async channel שמחכה לhמסגיות חדשות
async function* messageChannel() {
  yield { type: 'user', message: { role: 'user', content: initialPrompt } };
  // ממתין לhמסגיות נוספות שמגיעות דרך PG NOTIFY
  while (true) {
    const msg = await waitForNextMessage(); // channel backed by PG NOTIFY
    if (msg === null) break;
    yield msg;
  }
}

const queryObj = query({
  prompt: messageChannel(),
  options: {
    cwd,
    env,
    mcpServers,
    permissionMode,
    canUseTool,
    includePartialMessages: true,
  },
});

// Consume SDK messages → map to AgendoEvents → publish to PG NOTIFY
for await (const sdkMsg of queryObj) {
  const events = mapSdkMessageToAgendoEvents(sdkMsg);
  for (const event of events) await emitEvent(event);
}
```

**Control methods** (זמינים רק ב-streaming input mode):

```typescript
queryObj.interrupt(); // ← מחליף adapter.interrupt()
queryObj.setPermissionMode(); // ← מחליף sendControlRequest('set_permission_mode')
queryObj.setModel(); // ← מחליף sendControlRequest('set_model')
queryObj.mcpServerStatus(); // ← מחליף sendControlRequest('mcp_status')
queryObj.reconnectMcpServer(); // חדש! לא היה ב-adapter
queryObj.toggleMcpServer(); // חדש!
queryObj.close(); // graceful shutdown
```

---

## 4. טבלת השוואה מלאה

| יכולת                    | claude-adapter.ts נוכחי                     | Claude Agent SDK                                                              |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| **Spawn**                | `spawnDetached('claude', claudeArgs, opts)` | `query({ prompt, options })`                                                  |
| **Multi-turn**           | stdin NDJSON + persistent process           | `query({ prompt: AsyncIterable })` + `streamInput()`                          |
| **Resume**               | `--resume <ref>` flag                       | `options.resume: sessionId`                                                   |
| **Fork**                 | `--resume --fork-session` flags             | `options.forkSession: true`                                                   |
| **Resume at**            | `--resume-session-at <uuid>`                | `options.resumeSessionAt`                                                     |
| **Working dir**          | `opts.cwd` → spawn option                   | `options.cwd`                                                                 |
| **Env vars**             | `buildChildEnv()` → spawn option            | `options.env`                                                                 |
| **Model**                | `--model` flag                              | `options.model`                                                               |
| **Permission mode**      | `--permission-mode` flag                    | `options.permissionMode`                                                      |
| **MCP servers**          | `--mcp-config <path>` + JSON file           | `options.mcpServers: Record<...>`                                             |
| **Strict MCP**           | `--strict-mcp-config` flag                  | `options.strictMcpConfig: true`                                               |
| **Partial messages**     | `--include-partial-messages` flag           | `options.includePartialMessages: true`                                        |
| **Tool approvals**       | control_request/control_response NDJSON     | `options.canUseTool` or hooks                                                 |
| **Interrupt**            | SIGTERM + waitForResult()                   | `query.interrupt()`                                                           |
| **Set permission mode**  | `sendControlRequest('set_permission_mode')` | `query.setPermissionMode()`                                                   |
| **Set model**            | `sendControlRequest('set_model')`           | `query.setModel()`                                                            |
| **MCP status**           | `sendControlRequest('mcp_status')`          | `query.mcpServerStatus()`                                                     |
| **MCP reconnect**        | לא קיים                                     | `query.reconnectMcpServer()`                                                  |
| **Session ID extract**   | manual NDJSON parse (extractSessionId)      | SDK message: `{ type:'system', subtype:'init', session_id }`                  |
| **Line buffering**       | `adapterDataBuffer` + processLineBuffer     | מובנה ב-SDK                                                                   |
| **NDJSON parsing**       | manual JSON.parse per line                  | מובנה ב-SDK                                                                   |
| **Buffer management**    | manual carryover buffer                     | מובנה ב-SDK                                                                   |
| **Slash commands**       | raw text → stdin                            | שולחים כ-prompt string                                                        |
| **Image attachments**    | NDJSON `type:'image'` content block         | SDKUserMessage עם image content                                               |
| **Budget limit**         | `--max-budget-usd` flag                     | `options.maxBudgetUsd`                                                        |
| **Fallback model**       | `--fallback-model` flag                     | `options.fallbackModel`                                                       |
| **Effort level**         | `--effort` flag                             | `options.effort`                                                              |
| **No session persist**   | `--no-session-persistence` flag             | `options.persistSession: false`                                               |
| **Worktree**             | `--worktree` flag                           | `options.extraArgs` (לא direct option)                                        |
| **Append system prompt** | `--append-system-prompt` flag               | `options.systemPrompt: { type:'preset', preset:'claude_code', append:'...' }` |
| **Hooks**                | לא קיים                                     | `options.hooks` — 18 event types                                              |
| **File checkpointing**   | לא קיים                                     | `options.enableFileCheckpointing: true`                                       |
| **rewindFiles()**        | לא קיים                                     | `query.rewindFiles(messageId)`                                                |
| **Structured output**    | לא קיים                                     | `options.outputFormat: { type: 'json_schema', schema }`                       |

---

## 5. מה ה-SDK **לא** מכסה (ספציפי לאגנדו)

| רכיב אגנדו                   | מצב                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------- |
| PG NOTIFY publish/subscribe  | **לא נוגע לזה** — נשאר כמו שהוא                                               |
| SSE event fan-out            | **לא נוגע לזה** — נשאר                                                        |
| Session log file writing     | **לא נוגע לזה** — נשאר                                                        |
| DB session state machine     | **לא נוגע לזה** — נשאר                                                        |
| claude-event-mapper.ts       | **צריך להחליף** — ה-SDK מחזיר SDKMessage, לא raw NDJSON                       |
| Tmux session tracking        | **לא נוגע לזה** — נשאר (ה-SDK לא מנהל tmux)                                   |
| AgendoEvent types            | **לא נוגע לזה** — mappings ל-AgendoEvent נשארים                               |
| `buildChildEnv()`            | **חלקי** — `options.env` מקבל env vars, אך filtering של CLAUDECODE עדיין נדרש |
| Session team manager         | **לא נוגע לזה**                                                               |
| Activity tracker / heartbeat | **לא נוגע לזה**                                                               |

---

## 6. סיכוני מיגרציה

### 🔴 גבוה — ESM Compatibility

ה-SDK הוא `type: "module"` (ESM בלבד). Worker מבונה עם esbuild כ-CJS. esbuild **אמור** להצליח לבנדל ESM dependencies ל-CJS, אך חבילות עם optional native deps (כמו `@img/sharp-*` של ה-SDK) עלולות לגרום בעיות. **נדרש בדיקה ב-`pnpm worker:build` לפני כל החלטה.**

### 🟡 בינוני — API Stability של `streamInput`

`streamInput()` מתועד ב-V1 אך V2 preview כולל `send()` כתחליף. אם Anthropic ידחה את V1's streaming API ב-V2 breaking change, תדרש מיגרציה נוספת. המלצה: עקוב אחר `CHANGELOG.md`.

### 🟡 בינוני — `claude-event-mapper.ts` חייב להיכתב מחדש

הקוד הנוכחי מפרסר NDJSON raw ומפה לאגנדו events. עם SDK, המקור הוא typed `SDKMessage` objects. זה אינו refactor קל — כל 40+ אגנדו event types ממופים מ-raw JSON כרגע.

### 🟢 נמוך — `--worktree` flag

אין `options.worktree` ישיר ב-SDK, אבל `options.extraArgs: { '--worktree': null }` אמור לעבוד.

### 🟢 נמוך — `CLAUDECODE` env var filtering

`options.env` מוחלף ב-process.env של Claude process. כשבונים env object צריך לסנן `CLAUDECODE` ו-`CLAUDE_CODE_ENTRYPOINT` כמו שנעשה כיום ב-`buildChildEnv()`.

---

## 7. המלצה

### מיגר חלקי — שני שלבים

#### Phase 1 (מיידי, נמוך סיכון): Session Utilities

השתמש ב-SDK **לקריאת sessions בלבד** — מחליף כל קריאה ידנית של JSONL files:

```typescript
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

// מחליף כל manual JSONL parsing
const sessions = await listSessions({ dir: workingDir });
const messages = await getSessionMessages(sessionRef);
```

זה פשוט, בטוח, ואינו משנה את ה-adapter flow.

#### Phase 2 (refactor נפרד, גבוה ערך): מיגרציה מלאה של ClaudeAdapter

**תנאי מוקדם:** בדוק ESM compatibility עם esbuild:

```bash
pnpm add @anthropic-ai/claude-agent-sdk
pnpm worker:build 2>&1 | head -50
```

**אם הבנייה עוברת**, המיגרציה המלאה כוללת:

1. **צור `sdk-event-mapper.ts`** — ממפה `SDKMessage` → `AgendoEventPayload[]`
2. **שכתב `ClaudeAdapter`** — החלף spawn/stdin/stdout בקריאה ל-`query()` עם AsyncIterable
3. **הסר** `handleToolApprovalRequest()` + `sendControlRequest()` + `waitForResult()` — מוחלפים ב-`canUseTool` + query methods
4. **הסר** `adapterDataBuffer` + line buffering — מובנה ב-SDK
5. **עדכן** `buildSpawnOpts()` → `buildSdkOptions()` שמחזיר `Options` במקום spawn args
6. **הסר** `--permission-prompt-tool stdio` flag — מיותר כשמשתמשים ב-`canUseTool`

**מה שנשמר ללא שינוי:**

- `session-process.ts` — הלוגיקה הכללית נשארת
- `approval-handler.ts` — מוזרם דרך `canUseTool` במקום control_request
- `session-data-pipeline.ts` — פחות עבודה (SDK כבר מפרסר NDJSON)
- כל שאר מערכת PG NOTIFY / SSE / DB

---

## 8. תוכנית מיגרציה ברמה גבוהה (Phase 2)

```
1. npm install @anthropic-ai/claude-agent-sdk
2. בדוק esbuild build — אם נכשל, הוסף --external:@anthropic-ai/claude-agent-sdk ועדכן dist deps
3. צור src/lib/worker/adapters/sdk-event-mapper.ts
   - ממיר SDKMessage → AgendoEventPayload[]
   - כיסוי: assistant, result, system/init, stream_event, compact_boundary, status
4. צור src/lib/worker/adapters/claude-sdk-adapter.ts
   - implements AgentAdapter
   - spawn() → יוצר AsyncQueue, קורא query({ prompt: queue.iter(), options })
   - resume() → query עם options.resume + options.forkSession
   - sendMessage() → queue.push(message)
   - sendToolResult() → queue.push(toolResult)
   - interrupt() → queryObj.interrupt()
   - setPermissionMode() → queryObj.setPermissionMode()
   - setModel() → queryObj.setModel()
   - getMcpStatus() → queryObj.mcpServerStatus()
5. עדכן adapter-factory.ts → בחר ClaudeSdkAdapter כשהdependency קיים
6. מחק claude-adapter.ts (או שמור כ-legacy fallback)
7. מחק claude-event-mapper.ts (או שמור לcomparison)
8. עדכן buildSpawnOpts → buildSdkOptions
9. טסטים: השתמש ב-existing E2E session tests
```

**הערכת מאמץ:** ~3-5 ימי פיתוח למיגרציה מלאה (כולל tests).

---

## 9. מה כדאי לנטר

- [`CHANGELOG.md`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md) — breaking changes ב-V2
- `streamInput()` / `AsyncIterable<SDKUserMessage>` prompt — אם deprecated, `query.send()` בV2 הוא התחליף
- ESM → CJS bundling stability עם esbuild updates
