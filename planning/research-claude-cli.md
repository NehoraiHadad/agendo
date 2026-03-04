# Claude Code CLI — מדריך ייחוס מקיף לאינטגרציה עם Agendo

> **מסמך זה נוצר ב-2026-03-04** על ידי מחקר מעמיק של: קוד המקור של Agendo, פלט `claude --help`, וניתוח לוגים אמיתיים מסשנים חיים.
> Claude Code CLI גרסה: **2.1.68**

---

## תוכן עניינים

1. [כל דגלי ה-CLI](#1-כל-דגלי-ה-cli)
2. [פרוטוקול stream-json — stdout (Claude → Agendo)](#2-פרוטוקול-stream-json--stdout-claude--agendo)
3. [פרוטוקול stream-json — stdin (Agendo → Claude)](#3-פרוטוקול-stream-json--stdin-agendo--claude)
4. [Multi-turn sessions](#4-multi-turn-sessions)
5. [Tool Approvals (control_request / control_response)](#5-tool-approvals-control_request--control_response)
6. [Control Requests — סוגים נוספים](#6-control-requests--סוגים-נוספים)
7. [Permission Modes](#7-permission-modes)
8. [MCP Integration](#8-mcp-integration)
9. [דגלים שלא בשימוש כרגע ב-Agendo](#9-דגלים-שלא-בשימוש-כרגע-ב-agendo)
10. [פערים והמלצות](#10-פערים-והמלצות)

---

## 1. כל דגלי ה-CLI

### דגלי ליבה

| דגל                          | מה עושה                                                 | Agendo משתמש?                                     |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `-p, --print`                | הרץ בשלב אחד ויצא — non-interactive pipe mode           | **לא** בסשנים (persistentSession=true מדלג על -p) |
| `--output-format <format>`   | `text` / `json` / `stream-json`                         | **כן** — תמיד `stream-json`                       |
| `--input-format <format>`    | `text` / `stream-json`                                  | **כן** — תמיד `stream-json`                       |
| `--include-partial-messages` | שולח stream_event עם text_delta/thinking_delta בזמן אמת | **כן** — תמיד                                     |
| `--verbose`                  | פלט מורחב (כולל tool I/O)                               | **כן** — תמיד                                     |
| `--permission-mode <mode>`   | מצב אישורי כלים (ראה סעיף 7)                            | **כן** — מ-session.permissionMode                 |

### דגלי Session Management

| דגל                          | מה עושה                                                                     | Agendo משתמש?                           |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `-r, --resume [value]`       | המשך סשן קיים לפי session ID, או picker אינטראקטיבי                         | **כן** — בכל cold-resume                |
| `--fork-session`             | כשמשתמשים עם `--resume` — יוצר session ID חדש המאותחל מהיסטוריית הסשן האב   | **כן** — ב-fork path (forkSession=true) |
| `--resume-session-at <uuid>` | גוזר את ההיסטוריה ב-assistant message UUID מסוים (לשימוש עם --fork-session) | **כן** — ב-resumeSessionAt              |
| `--session-id <uuid>`        | השתמש ב-UUID ספציפי לסשן חדש (חייב להיות UUID תקין)                         | **לא** — ראה הסבר בסעיף 9               |
| `--no-session-persistence`   | אל תשמור סשן לדיסק (לא ניתן לresumeה)                                       | **לא**                                  |
| `-c, --continue`             | המשך את הסשן האחרון בתיקייה הנוכחית                                         | **לא**                                  |
| `--from-pr [value]`          | Resume סשן מקושר ל-PR לפי מספר/URL                                          | **לא**                                  |

### דגלי MCP ו-Tools

| דגל                                     | מה עושה                                                     | Agendo משתמש?                                                  |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `--mcp-config <configs...>`             | טען MCP servers מקבצי JSON או מחרוזות JSON                  | **כן** — `--mcp-config <mcpConfigPath>`                        |
| `--strict-mcp-config`                   | השתמש רק ב-MCP servers שב-`--mcp-config`, התעלם מהגלובלי    | **כן** — כשיש `mcpConfigPath`                                  |
| `--permission-prompt-tool <type>`       | איך להציג בקשות אישור (`stdio` = control_request על stdout) | **כן** — תמיד `stdio`                                          |
| `--allowedTools, --allowed-tools`       | רשימת כלים מותרים (e.g. "Bash(git:\*) Edit")                | **לא** ישירות — session.allowedTools מנוהל דרך ApprovalHandler |
| `--disallowedTools, --disallowed-tools` | רשימת כלים חסומים                                           | **לא**                                                         |
| `--tools <tools...>`                    | הגדר את סט הכלים הזמינים                                    | **לא**                                                         |

### דגלי Prompt ו-Model

| דגל                               | מה עושה                                                | Agendo משתמש?                   |
| --------------------------------- | ------------------------------------------------------ | ------------------------------- |
| `--model <model>`                 | מודל לסשן (e.g. 'sonnet', 'opus', 'claude-sonnet-4-6') | **כן** — כש-session.model מוגדר |
| `--fallback-model <model>`        | fallback לשימוש כשהמודל הראשי עמוס (רק עם --print)     | **כן** — כש-opts.fallbackModel  |
| `--system-prompt <prompt>`        | החלפת system prompt (override מלא)                     | **לא**                          |
| `--append-system-prompt <prompt>` | הוסף לsystem prompt הקיים                              | **כן** — ל-MCP context preamble |
| `--max-budget-usd <amount>`       | תקציב מקסימום ב-USD (Claude עוצר כשנחצה)               | **כן** — כש-opts.maxBudgetUsd   |
| `--effort <level>`                | רמת מאמץ: low / medium / high                          | **לא**                          |

### דגלי Multi-Agent

| דגל               | מה עושה                                                                              | Agendo משתמש? |
| ----------------- | ------------------------------------------------------------------------------------ | ------------- |
| `--agent <agent>` | Agent לסשן הנוכחי (override לsetting 'agent')                                        | **לא**        |
| `--agents <json>` | JSON עם הגדרת custom sub-agents: `{"name": {"description": "...", "prompt": "..."}}` | **לא**        |

### דגלי Worktree

| דגל                     | מה עושה                      | Agendo משתמש? |
| ----------------------- | ---------------------------- | ------------- |
| `-w, --worktree [name]` | צור git worktree חדש לסשן זה | **לא**        |
| `--tmux`                | צור tmux session ל-worktree  | **לא**        |

### דגלי Debugging

| דגל                      | מה עושה                                | Agendo משתמש?       |
| ------------------------ | -------------------------------------- | ------------------- |
| `-d, --debug [filter]`   | debug mode עם filtering אופציונלי      | **לא**              |
| `--debug-file <path>`    | כתוב debug logs לקובץ                  | **לא**              |
| `--mcp-debug`            | [DEPRECATED — use --debug] MCP debug   | **לא**              |
| `--verbose`              | verbose output                         | **כן**              |
| `--replay-user-messages` | Re-emit user messages מ-stdin ב-stdout | **לא** — ראה סעיף 9 |

### דגלים אחרים

| דגל                           | מה עושה                                               | Agendo משתמש? |
| ----------------------------- | ----------------------------------------------------- | ------------- |
| `--add-dir <directories...>`  | ספריות נוספות לגישת כלים                              | **לא**        |
| `--setting-sources <sources>` | מקורות settings: user, project, local                 | **לא**        |
| `--settings <file-or-json>`   | path לקובץ settings או JSON                           | **לא**        |
| `--betas <betas...>`          | Beta headers ל-API (למשתמשי API key)                  | **לא**        |
| `--file <specs...>`           | File resources להורדה בהפעלה: `file_id:relative_path` | **לא**        |
| `--json-schema <schema>`      | JSON Schema לvalidation של structured output          | **לא**        |
| `--disable-slash-commands`    | נטרל את כל ה-skills                                   | **לא**        |
| `--chrome`                    | הפעל Claude in Chrome integration                     | **לא**        |
| `--ide`                       | חיבור אוטומטי ל-IDE                                   | **לא**        |

---

## 2. פרוטוקול stream-json — stdout (Claude → Agendo)

כל event הוא שורת JSON (NDJSON) עם `\n` בסוף. הפרוצס נשאר חי לאורך הסשן (persistentSession=true).

### 2.1 `system` (subtype: `init`)

**שלח פעם אחת בתחילת הסשן.**

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/home/ubuntu/projects/agendo",
  "session_id": "c53896ae-6e3e-4488-bd48-4f36708d19cf",
  "tools": ["Agent", "Bash", "Read", "Edit", "mcp__agendo__create_task", "..."],
  "mcp_servers": [{ "name": "agendo", "status": "connected" }],
  "model": "claude-sonnet-4-6",
  "permissionMode": "bypassPermissions",
  "slash_commands": ["compact", "context", "review", "..."],
  "apiKeySource": "none",
  "claude_code_version": "2.1.68",
  "output_style": "default",
  "agents": ["general-purpose", "Explore", "Plan", "..."],
  "skills": ["agendo", "brainstorm", "..."],
  "plugins": [{ "name": "context7", "path": "..." }],
  "uuid": "6421fb96-6802-4e1a-a9a4-e94d152e2e85",
  "fast_mode_state": "off"
}
```

**Agendo mapping:** `session:init` — שומר `sessionRef`, `model`, `mcpServers`, `tools`, `permissionMode`.

---

### 2.2 `system` (subtype: `compact_boundary`)

**שלח כשמתרחשת קומפקציה (חדש — גרסה מ-2.1+).**

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compact_metadata": {
    "trigger": "auto",
    "pre_tokens": 185432
  },
  "session_id": "...",
  "uuid": "..."
}
```

**Agendo mapping:** `system:info` עם `compactMeta: { trigger, preTokens }`.

**Legacy:** `{"type": "compact"}` — גרסה ישנה, ללא metadata. Agendo מזהה גם אותה.

---

### 2.3 `assistant`

**שלח בסיום כל API call (complete message).**

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_018FLGZx88qHGdEFWByRfCUC",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me start by...",
        "signature": "EvsBCk..."
      },
      {
        "type": "tool_use",
        "id": "toolu_01GA6CCRyB4UDTqQmCiGoSV2",
        "name": "mcp__agendo__get_my_task",
        "input": {},
        "caller": { "type": "direct" }
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 13316,
      "cache_read_input_tokens": 28480,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 13316
      },
      "output_tokens": 7,
      "service_tier": "standard",
      "inference_geo": "not_available"
    },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "c53896ae-...",
  "uuid": "41ec683e-..."
}
```

**content block types:**

- `text` — טקסט רגיל → `agent:text`
- `thinking` — שרשרת מחשבה מורחבת → `agent:thinking`
- `tool_use` — קריאת כלי → `agent:tool-start`

**שדה `uuid`:** UUID ייחודי לסשן — ניתן להעברה ל-`--resume-session-at` לcutoff ההיסטוריה.

**שדה `caller`:** מסמן איך נקרא הכלי — `direct` (מ-Claude ישירות) vs sub-agent.

---

### 2.4 `user`

**שלח אחרי כל tool_result — Claude מחזיר את התגובה לעצמו.**

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01GA6CCRyB4UDTqQmCiGoSV2",
        "type": "tool_result",
        "content": [{ "type": "text", "text": "{...tool result JSON...}" }]
      }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "c53896ae-...",
  "uuid": "edbb3032-...",
  "tool_use_result": {
    "filePath": "/path/to/file.ts",
    "oldString": "...",
    "newString": "..."
  }
}
```

**Agendo mapping:** `agent:tool-end` — `toolUseId`, `content`, `durationMs`, `numFiles`, `truncated`.

**גילוי interactive tools:** כשיש `is_error: true` ב-tool_result — סימן שClaude ניסה להפעיל AskUserQuestion/ExitPlanMode ב-pipe mode ונכשל. Agendo מגלה זאת דרך `checkForHumanResponseBlocks()`.

---

### 2.5 `result`

**שלח בסיום כל turn (לא כל API call — רק כשClaude מחכה לקלט).**

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 392331,
  "duration_api_ms": 324154,
  "num_turns": 55,
  "result": "Done. Here's what was implemented:\n...",
  "stop_reason": null,
  "session_id": "898ad141-...",
  "total_cost_usd": 2.3804095,
  "usage": {
    "input_tokens": 50,
    "cache_creation_input_tokens": 58552,
    "cache_read_input_tokens": 2952119,
    "output_tokens": 21526,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 58552,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "claude-sonnet-4-6": {
      "inputTokens": 50,
      "outputTokens": 21526,
      "cacheReadInputTokens": 2952119,
      "cacheCreationInputTokens": 58552,
      "webSearchRequests": 0,
      "costUSD": 2.3804095,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "fast_mode_state": "off",
  "uuid": "15051f91-..."
}
```

**`subtype` ערכים:**

- `"success"` — הצלחה רגילה
- `"error_during_execution"` — שגיאה בביצוע
- `"error_max_tokens"` — חרג ממגבלת טוקנים
- `"error_budget_exceeded"` — חרג מתקציב ה-USD

**שדה `errors[]`:** נוכח רק כש-`is_error: true`, מכיל הודעות שגיאה.

**שדה `permission_denials[]`:** רשימת כלים שנדחו בסשן.

**Agendo mapping:** `agent:result` — מכיל cost, turns, durations, modelUsage, serviceTier, serverToolUse. Agendo שומר `total_cost_usd` ו-`num_turns` ל-DB.

**הערה חשובה:** `modelUsage` מצטבר על פני כל ה-API calls בסשן — לא מדויק ל-context window. השתמש ב-`stream_event.message_start.usage` לנתונים מדויקים per-call.

---

### 2.6 `stream_event`

**שלח בכל token בזמן אמת (עם `--include-partial-messages`).**

#### message_start (תחילת API call)

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "model": "claude-sonnet-4-6",
      "id": "msg_018FLGZx88qHGdEFWByRfCUC",
      "type": "message",
      "role": "assistant",
      "content": [],
      "stop_reason": null,
      "stop_sequence": null,
      "usage": {
        "input_tokens": 3,
        "cache_creation_input_tokens": 13316,
        "cache_read_input_tokens": 28480,
        "cache_creation": {
          "ephemeral_5m_input_tokens": 0,
          "ephemeral_1h_input_tokens": 13316
        },
        "output_tokens": 7,
        "service_tier": "standard",
        "inference_geo": "not_available"
      }
    }
  },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "fcffb7f1-..."
}
```

**Agendo:** שולף per-call context stats ← `usage.input_tokens + cache_*` → `lastPerCallContextStats`.

#### content_block_start: thinking

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "thinking", "thinking": "", "signature": "" }
  },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "9b850519-..."
}
```

#### content_block_delta: thinking_delta

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "thinking_delta", "thinking": "Let me start" }
  },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "f16d2cce-..."
}
```

**Agendo:** `appendThinkingDelta()` → batched flush → `agent:thinking-delta` via PG NOTIFY.

#### content_block_delta: text_delta

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 1,
    "delta": { "type": "text_delta", "text": "Here is my analysis" }
  },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "..."
}
```

**Agendo:** `appendDelta()` → batched flush (200ms) → `agent:text-delta` via PG NOTIFY.

#### message_delta (סוף message)

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": {
      "stop_reason": "tool_use",
      "stop_sequence": null
    },
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 13316,
      "cache_read_input_tokens": 28480,
      "output_tokens": 116
    },
    "context_management": {
      "applied_edits": []
    }
  },
  "session_id": "...",
  "parent_tool_use_id": null,
  "uuid": "8bdff417-..."
}
```

**`stop_reason` ערכים:** `"tool_use"`, `"end_turn"`, `"max_tokens"`.

**Agendo:** לא מעובד (הנתונים מגיעים גם ב-`assistant` הסופי).

---

### 2.7 `control_request` — Tool Approval

**שלח כשClaude צריך אישור לכלי (כשמשתמשים ב-`--permission-prompt-tool stdio`).**

```json
{
  "type": "control_request",
  "request_id": "c70cff9f-77d3-4922-85d9-2c07c1f045de",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "AskUserQuestion",
    "input": {
      "questions": [
        {
          "question": "Which approach for the session action buttons?",
          "header": "Button layout",
          "options": [
            {
              "label": "Single ⋯ menu",
              "description": "One ellipsis button everywhere...",
              "markdown": "ASCII diagram preview..."
            }
          ],
          "multiSelect": false
        }
      ]
    }
  }
}
```

**Agendo:** `handleToolApprovalRequest()` ב-claude-adapter.ts → שולח ל-`approvalHandler.handleApprovalRequest()`.

---

### 2.8 `rate_limit_event`

**שלח כשיש rate limit.**

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1772391600,
    "rateLimitType": "five_hour",
    "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled",
    "isUsingOverage": false
  },
  "uuid": "22e62fe4-...",
  "session_id": "..."
}
```

**Agendo mapping:** `system:rate-limit` עם כל שדות ה-rate limit info.

---

## 3. פרוטוקול stream-json — stdin (Agendo → Claude)

כל message הוא שורת JSON (NDJSON) עם `\n` בסוף.

### 3.1 User Message (הודעת משתמש רגילה)

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "הטקסט שהמשתמש שלח"
  },
  "session_id": "c53896ae-6e3e-4488-bd48-4f36708d19cf",
  "parent_tool_use_id": null
}
```

**תוכן כ-array (לתמונות):**

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "תאר את התמונה" },
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "iVBORw0KGg..."
        }
      }
    ]
  },
  "session_id": "...",
  "parent_tool_use_id": null
}
```

**Agendo:** `sendMessage()` בclaude-adapter.ts. ה-`session_id` מגיע מה-`system:init` event.

---

### 3.2 Tool Result

**נשלח אחרי שClaude קרא לkלי ו-Agendo/CLI ביצע אותו.**

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01GA6CCRyB4UDTqQmCiGoSV2",
        "content": "התוצאה כמחרוזת או כarray"
      }
    ]
  },
  "session_id": "c53896ae-...",
  "parent_tool_use_id": null
}
```

**Agendo:** `sendToolResult(toolUseId, content)` בclaude-adapter.ts.
**שימוש ב-Agendo:** כשאגנט שלח `AskUserQuestion` ונכשל ב-pipe mode — Agendo שולח את תשובת המשתמש כ-tool_result.

---

### 3.3 Interrupt (הפסקת הרצה)

```json
{
  "request_id": "abc123def456",
  "type": "control_request",
  "request": { "subtype": "interrupt" }
}
```

**Agendo:** `interrupt()` בclaude-adapter.ts. אם לא מגיעה `result` תוך 3 שניות → SIGTERM.

---

## 4. Multi-turn sessions

### איך Agendo מנהל סשן רב-תורות

**מצב חדש (spawn):**

1. `claude [flags] --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode <mode> --permission-prompt-tool stdio [--mcp-config <path>] [--strict-mcp-config]`
2. הודעה ראשונה → stdin (user message NDJSON)
3. Claude עונה → stdout (system:init → stream_events → assistant → user → ... → result)
4. **הסשן נשאר חי** — Claude ממתין ל-stdin
5. הודעת המשתמש הבאה → stdin (שוב user message NDJSON)
6. ...חוזר

**מצב resume (cold-resume):**

1. `claude --resume <sessionRef> [--resume-session-at <uuid>] [--fork-session] ...`
2. Claude טוען את היסטוריית הסשן
3. הודעה ראשונה → stdin
4. ממשיך כרגיל

### Session Persistence

Claude שומר סשנים ל-`~/.claude/projects/` בפורמט JSONL. ה-`session_id` מגיע ב-`system:init` ומשמש כ-`sessionRef` ל-resume.

**Agendo** שומר את ה-`sessionRef` ב-DB (`sessions.sessionRef`) ומשתמש בו ל-`--resume`.

### Fork (ענף מסשן קיים)

```
claude --resume <parentSessionRef> --fork-session [--resume-session-at <assistantMsgUUID>] ...
```

- `--fork-session` → Claude יוצר session ID חדש המאותחל מהיסטוריית הסשן האב
- `--resume-session-at <uuid>` → גוזר את ההיסטוריה ב-UUID של assistant message (מ-`assistant.uuid` בstream-json)
- Agendo מגדיר `forkSourceRef` ב-DB session ומשתמש ב-`resume()` עם `forkSession: true`

---

## 5. Tool Approvals (control_request / control_response)

### בקשת אישור (stdout → Agendo)

```json
{
  "type": "control_request",
  "request_id": "c70cff9f-77d3-4922-85d9-2c07c1f045de",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": {
      "command": "rm -rf /tmp/old",
      "description": "Clean up temp files"
    }
  }
}
```

### תגובת אישור (Agendo → stdin)

**אישור:**

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "c70cff9f-77d3-4922-85d9-2c07c1f045de",
    "response": {
      "behavior": "allow",
      "updatedInput": {}
    }
  }
}
```

**אישור עם input ערוך (`updatedInput`):**

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "c70cff9f-...",
    "response": {
      "behavior": "allow",
      "updatedInput": {
        "command": "rm -rf /tmp/old_safe",
        "description": "Modified by user"
      }
    }
  }
}
```

**דחייה:**

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "c70cff9f-...",
    "response": {
      "behavior": "deny",
      "message": "User denied",
      "interrupt": false
    }
  }
}
```

**חשוב:** `request_id` חייב להיות בתוך `response.response_id`, לא ברמה העליונה.
Claude's `injectControlResponse()` עושה `H.response?.request_id` — בלי זה הוא מתעלם מהתגובה.

---

## 6. Control Requests — סוגים נוספים

### 6.1 Set Permission Mode (in-place)

**stdin → Claude:**

```json
{
  "type": "control_request",
  "request_id": "ctrl-1709561234-abc123",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "bypassPermissions"
  }
}
```

**Claude → stdout (תגובה):**

```json
{
  "type": "control_response",
  "request_id": "ctrl-1709561234-abc123",
  "response": { "subtype": "success", "...": "..." }
}
```

**Agendo:** `setPermissionMode(mode)` → `sendControlRequest('set_permission_mode', { mode })`.

### 6.2 Set Model (in-place)

```json
{
  "type": "control_request",
  "request_id": "ctrl-...",
  "request": {
    "subtype": "set_model",
    "model": "claude-opus-4-6"
  }
}
```

**Agendo:** `setModel(model)` → `sendControlRequest('set_model', { model })`.

### 6.3 MCP Status

```json
{
  "type": "control_request",
  "request_id": "ctrl-...",
  "request": { "subtype": "mcp_status" }
}
```

**Agendo:** `getMcpStatus()` — שולח כל 60 שניות לבדיקת MCP health.

### 6.4 ExitPlanMode (tool approval gated)

ExitPlanMode נשלח כ-`can_use_tool` control_request. Agendo מנהל אותו דרך `APPROVAL_GATED_TOOLS` — תגובה מגיע דרך ה-control_response הרגיל.

---

## 7. Permission Modes

**תיעוד רשמי:** https://code.claude.com/docs/en/permissions

| Mode                | התנהגות                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `default`           | Claude שואל על כל כלי מסוכן — מוצג בTUI                                |
| `acceptEdits`       | אישור אוטומטי ל-Read/Edit/Write. חוסם Bash ו-MCP tool calls            |
| `bypassPermissions` | אישור אוטומטי לכל כלי (Bash, MCP, הכל). לשימוש בסביבה מאובטחת          |
| `dontAsk`           | **דחייה אוטומטית** לכל כלי שלא pre-approved ב-`--allowedTools`         |
| `plan`              | מצב תכנון — Claude מתחיל ב-plan mode, read-only, דורש אישור לפני ביצוע |

**Agendo mapping:**

- `acceptEdits` → מתאים לסביבות שמאשרות עריכות קבצים אבל לא shell
- `bypassPermissions` → נדרש לכל agent שצריך להשתמש ב-MCP tools או Bash אוטונומית
- `plan` → Claude plan mode (מגיע כ-`system:init.currentModeId = "plan"` כשפעיל)

**הגדרה בCLI:** `--permission-mode <mode>`
**שינוי בזמן ריצה:** `control_request` עם `subtype: "set_permission_mode"`

---

## 8. MCP Integration

### הגדרת MCP Config

Agendo יוצר קובץ JSON זמני עם הגדרת MCP servers:

```json
{
  "mcpServers": {
    "agendo": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js"],
      "env": {
        "AGENDO_URL": "http://localhost:4100",
        "AGENDO_SESSION_ID": "c53896ae-...",
        "AGENDO_TASK_ID": "b654d330-...",
        "JWT_SECRET": "..."
      }
    }
  }
}
```

**הפעלה:**

```bash
claude --mcp-config /tmp/mcp-config-abc123.json --strict-mcp-config ...
```

### `--strict-mcp-config`

כשפעיל — Claude משתמש **רק** ב-MCP servers שב-`--mcp-config`. מתעלם מ-`~/.claude/claude_desktop_config.json` ומהגדרות גלובליות אחרות.

**Agendo משתמש תמיד ב-`--strict-mcp-config`** כשיש `mcpConfigPath`.

### MCP Health Check

Agendo בודק כל 60 שניות דרך `getMcpStatus()` control_request אם ה-MCP עדיין מחובר. אם לא — שולח `system:info` עם אזהרה.

### סטטוס MCP ב-system:init

```json
"mcp_servers": [
  {"name": "agendo", "status": "connected"}
]
```

סטטוסים: `"connected"` / `"failed"` / `"disconnected"`.

---

## 9. דגלים שלא בשימוש כרגע ב-Agendo

### 9.1 `--replay-user-messages`

**מה עושה:** Re-emits user messages מ-stdin ב-stdout לאישור. רק עם `--input-format=stream-json` ו-`--output-format=stream-json`.

**פרוטוקול:** כשClaude מקבל user message ב-stdin, הוא שולח אותו בחזרה ב-stdout עם `type: "user"` לפני שהוא מתחיל לעבד.

**שימוש פוטנציאלי:** ל-debugging וlog accuracy — לדעת מתי בדיוק Claude קיבל הודעה.

**מה חסר ב-Agendo:** לא בשימוש. הוספת זה ל-ClaudeAdapter.launch() תדרוש parsing של echo-back events ומניעת כפילויות ב-session log.

---

### 9.2 `--session-id <uuid>`

**מה עושה:** מאפשר להגדיר UUID מוגדר-מראש לסשן חדש (במקום שClaude יגרנר).

**הערה בclaude-adapter.ts:**

```
// NOTE: --session-id is intentionally omitted. For new sessions Claude
// generates its own ID (reported via system:init). For resumed sessions
// --resume already identifies the target; adding --session-id would
// require --fork-session which we don't want.
```

**שימוש פוטנציאלי:** סנכרון session ID בין Agendo (DB) ל-Claude (JSONL). כרגע Agendo משתמש ב-agendo UUID כ-sessionId ב-stdin messages אך לא ב-`--session-id`.

**למה לא בשימוש:** Claude כבר מדווח את ה-session_id שלו דרך `system:init`, ו-Agendo מקבל אותו בחזרה. הוספת `--session-id` תדרוש שה-UUID של Agendo יהיה תקין כ-Claude session ID — שאולי לא תמיד כך.

---

### 9.3 `--agents <json>`

**תיעוד רשמי:** https://code.claude.com/docs/en/sub-agents

**מה עושה:** הגדרת custom sub-agents שClaude יכול להפעיל. פורמט מלא:

```json
{
  "reviewer": {
    "description": "Reviews code for bugs and security",
    "prompt": "You are a code reviewer. Analyze code critically.",
    "tools": ["Read", "Glob", "Grep"],
    "disallowedTools": ["Bash", "Edit"],
    "model": "sonnet",
    "skills": ["code-review"],
    "mcpServers": { "agendo": { "command": "node", "args": ["..."] } },
    "maxTurns": 10
  }
}
```

**שדות נתמכים:**

- `description` (**חובה**) — מתי להפעיל את ה-subagent
- `prompt` (**חובה**) — system prompt של ה-subagent
- `tools` — רשימת כלים מותרים (e.g. `["Read", "Edit", "Bash"]`)
- `disallowedTools` — כלים מחוסמים מפורשות
- `model` — מודל: `"sonnet"`, `"opus"`, `"haiku"`, `"inherit"`
- `skills` — skills לטעון מראש
- `mcpServers` — MCP server configuration
- `maxTurns` — מקסימום אגנטי turns

**שימוש פוטנציאלי:** ב-Agendo multi-agent sessions — ניתן לתת לClaude הגדרת sub-agents שמקבילים לagents ב-DB. כרגע Agendo מנהל multi-agent דרך team protocol (pg-boss + PG NOTIFY), לא דרך Claude's built-in agents.

**הבדל מ-Agendo TeamManager:** Claude's `--agents` הם synchronous sub-calls בתוך אותו process. Agendo's TeamManager שולח הודעות ל-agents נפרדים (processes נפרדים, sessions נפרדים).

---

### 9.4 `--fork-session` (ב-שימוש חלקי)

**מה עושה:** בשימוש עם `--resume` — יוצר session ID חדש במקום לשכתב את הסשן הקיים. הסשן החדש מאותחל מהיסטוריית הסשן האב.

**Agendo:** משתמש ב-`forkSession: true` בSpawnOpts → `extraFlags.push('--fork-session')`.

**מה חסר:** הממשק ל-fork ב-UI מוגדר, אבל endpoint יצירת fork sessions (`POST /api/sessions` עם `forkSourceRef`) נבנה. `--resume-session-at` פועל בשילוב עם זה.

---

### 9.5 `--no-session-persistence`

**מה עושה:** Claude לא שומר את הסשן לדיסק (`~/.claude/projects/`). לא ניתן לresumeה.

**שימוש פוטנציאלי:** עבור short-lived one-off sessions שלא צריך לresumeן. חסכון בדיסק.

**מה חסר ב-Agendo:** לא בשימוש. ב-Agendo כל הסשנים ניתנים ל-resume כי `sessionRef` נשמר ב-DB.

---

### 9.6 `--from-pr [value]`

**מה עושה:** Resume סשן מקושר ל-GitHub PR לפי מספר/URL. פותח picker אינטראקטיבי עם search term אופציונלי.

**שימוש פוטנציאלי:** integration עם GitHub PRs — למשל, session שנוצר לsession של code review.

**מה חסר:** Agendo לא מתחיל סשנים מ-PRs. היה אפשר להוסיף workflow: PR webhook → Agendo task → Claude session עם `--from-pr`.

---

### 9.7 `--worktree [name]` + `--tmux`

**מה עושה:** יוצר git worktree חדש, מפעיל Claude בתוך הworktree. `--tmux` מוסיף tmux session.

**מה חסר:** Agendo משתמש ב-tmux (ראה tmux-manager.ts) אבל לא ב-Claude's built-in worktree support. שילוב עלול לגרום לconflict כי Agendo כבר יוצר tmux session ידנית.

---

### 9.8 `--effort <level>`

**מה עושה:** רמת מאמץ: `low` / `medium` / `high`. משפיע על depth של thinking ושימוש ב-resources.

**שימוש פוטנציאלי:** הוספת effort שדה ל-session config — ניתן להוסיף ל-SpawnOpts ול-`--effort` flag.

---

### 9.9 `--json-schema <schema>`

**מה עושה:** JSON Schema לvalidation של structured output. Claude מנסה לייצר פלט תואם לschema.

**שימוש פוטנציאלי:** עבור executions שצריכות output מובנה (e.g. capability שמחזירה JSON).

---

### 9.10 `--file <specs...>`

**מה עושה:** File resources להורדה בהפעלה. Format: `file_id:relative_path`.

**שימוש פוטנציאלי:** העברת קבצים ל-context של Claude בלי להעלות לserver.

---

## 10. פערים והמלצות

### פער 1: `--session-id` לסנכרון IDs

**בעיה:** כרגע Agendo ו-Claude משתמשים ב-UUIDs שונים. Agendo שומר את ה-sessionRef של Claude (מ-system:init) אחרי העובדה.

**פתרון:** הוספת `--session-id` עם agendo's UUID. דורש שהUUID יהיה בפורמט תקין שClaude מקבל.

**השפעה:** session logs יתואמו ל-DB IDs. session JSONL files ב-`~/.claude/projects/` יהיו ישירות נגישים לפי agendo UUID.

**אזהרה:** אם נוסיף `--session-id` לcold-resume, נצטרך גם `--fork-session` — אחרת Claude עלול לנסות לשכתב סשן קיים.

---

### פער 2: `--replay-user-messages` לlogging מדויק

**בעיה:** Agendo כותב user messages לlog file בעצמו (לפני שנשלחות ל-Claude). אין confirmation שClaude קיבל אותן.

**פתרון:** הוספת `--replay-user-messages` — Claude יאשר כל הודעה. Agendo יזהה את ה-echo ב-stdout וידע בדיוק מתי Claude קיבל.

**מימוש:** בstream_event handler — זהה `type: "user"` events שמגיעים מ-stdout (לא מ-stdin) ואל תעבד אותם כ-tool_results.

---

### פער 3: `--agents` לCoordination מקומי

**בעיה:** כרגע multi-agent coordination דורשת sessions נפרדים וpg-boss routing מורכב.

**הזדמנות:** עבור use cases פשוטים (e.g. code reviewer), `--agents` נותן Claude יכולת sub-agents מקומית — מהירה יותר, ללא overhead של sessions נפרדים.

**מימוש:** הוספת שדה `agentsJson` ל-session config → `--agents '{"reviewer": {...}}'` בCLI args.

---

### פער 4: `--effort` לcontrol עלות

**בעיה:** אין שליטה על רמת המאמץ per-session. כל sessionns רצים עם default effort.

**פתרון:** הוספת `effort` שדה ל-session model → `--effort <level>` ב-SpawnOpts.

---

### פער 5: `--no-session-persistence` לone-off executions

**בעיה:** כל הסשנים שומרים JSONL ל-disk גם כשלא צריך.

**פתרון:** עבור quick/one-off sessions שלא יresume-ו (e.g. CI-mode), הוספת `noSessionPersistence: boolean` ל-SpawnOpts.

---

### פער 6: `--fork-session` UI לא מלא

**מצב נוכחי:** fork infrastructure קיים (forkSourceRef, resumeSessionAt), אבל:

- UI ב-session view לא חושף fork button
- לא ניתן לבחור `--resume-session-at` UUID דרך ה-UI

**פתרון:** הוספת "Fork from here" button ל-assistant messages בchat view, שמשתמש ב-`message.uuid` שמגיע מ-`assistant` NDJSON events.

---

### פער 7: Stream-json מ-`message_delta.context_management`

**בעיה:** שדה `context_management.applied_edits` מגיע ב-message_delta אבל לא מעובד.

**שימוש פוטנציאלי:** מעקב אחרי context optimizations שClaude עשה.

---

### פער 8: Server-side tool usage tracking

**שדה:** `result.usage.server_tool_use.web_search_requests` / `web_fetch_requests`.

**מצב נוכחי:** Agendo מפרסר ומשלח ב-`agent:result`, אבל לא שומר ב-DB.

**פתרון:** הוספת `webSearchRequests`, `webFetchRequests` עמודות ל-sessions table (analytics).

---

### פער 9: `--json-schema` לstructured executions

**הזדמנות:** עבור template-mode capabilities שמצפות ל-JSON output — `--json-schema` ייתן Claude הגדרת schema ברורה.

**מימוש:** הוספת `jsonSchema?: object` ל-SpawnOpts/capability config.

---

### סיכום עדיפויות

| עדיפות | פער                                  | קושי   |
| ------ | ------------------------------------ | ------ |
| גבוה   | Fork UI (message UUID → fork button) | נמוך   |
| גבוה   | `--effort` ב-session config          | נמוך   |
| בינוני | `--session-id` לסנכרון               | בינוני |
| בינוני | `--no-session-persistence` לone-off  | נמוך   |
| נמוך   | `--agents` ל-local sub-agents        | גבוה   |
| נמוך   | `--replay-user-messages` לlogging    | בינוני |

---

## נספח A: Claude CLI Commands

| פקודה                     | תיאור                               |
| ------------------------- | ----------------------------------- | ----------------- |
| `claude agents [options]` | רשימת agents מוגדרים                |
| `claude auth`             | ניהול authentication                |
| `claude doctor`           | בדיקת health של auto-updater        |
| `claude install [target]` | התקנת גרסה (stable/latest/specific) |
| `claude mcp`              | הגדרת MCP servers                   |
| `claude plugin`           | ניהול plugins                       |
| `claude setup-token`      | הגדרת auth token ארוך-טווח          |
| `claude update            | upgrade`                            | בדיקת ועדכון גרסה |

---

## נספח B: Slash Commands (ב-Interactive Mode)

הפקודות הבאות נשלחות כ-raw text ל-stdin (לא NDJSON) כי readline interceptsהן:

```
/compact, /clear, /cost, /memory, /mcp, /permissions, /status, /doctor,
/model, /review, /init, /bug, /help, /vim, /terminal, /login, /logout,
/release-notes, /pr_comments, /exit
```

**Agendo:** `KNOWN_SLASH_COMMANDS` ב-claude-adapter.ts — commands ידועים נשלחים כ-raw text. commands לא ידועים שמתחילים ב-`/` נשלחים כ-NDJSON message רגיל.

---

## נספח C: Environment Variables שAgendo מגדיר

```bash
AGENDO_SESSION_ID=<session-uuid>    # לhooks ולsub-processes
AGENDO_AGENT_ID=<agent-uuid>        # מזהה ה-agent
AGENDO_TASK_ID=<task-uuid>          # כשהסשן מקושר לtask

# מוסרים לפני spawn (מונעים nested-session error):
# CLAUDECODE — נוכח בסביבת Claude Code עצמה
# CLAUDE_CODE_ENTRYPOINT — מזהה entry point
```

---

---

## נספח D: דגלים חבויים (Undocumented)

דגלים אלה לא מופיעים ב-`claude --help` אך תועדו בפורום הקהילה:

### `ENABLE_EXPERIMENTAL_MCP_CLI=true` (env var)

**מה עושה:** טוען MCP tools דרך CLI wrapper במקום לטעון את כל ה-schemas מראש. **חוסך 32K+ טוקנים** מה-system prompt.

**מקור:** https://paddo.dev/blog/claude-code-hidden-mcp-flag/

**שימוש פוטנציאלי ב-Agendo:** הוספה ל-childEnv בsession-process.ts. **מומלץ לבדוק** — עלול לשפר משמעותית את context window utilization.

### `--sdk-url` (WebSocket mode)

**מה עושה:** הופך את ה-CLI לWebSocket client. מאפשר שליטה מרחוק.

**מקור:** https://medium.com/coding-nexus/i-found-a-hidden-flags-in-claude-codes-cli

### `--remote` + `--teleport`

**מה עושה:** יצירת sessions בservers של claude.ai ו-resume מכל מכונה.

**מקור:** https://blog.starbased.net/uncovering-claude-codes-hidden-teleport-flag

### TeammateTool (Multi-Agent, feature-flagged)

**מה עושה:** מערכת multi-agent מובנית עם 13 פעולות orchestration. כרגע disabled by feature flag.

**מקור:** https://paddo.dev/blog/claude-code-hidden-swarm/

---

## נספח E: קישורים לתיעוד רשמי

| נושא                       | URL                                           |
| -------------------------- | --------------------------------------------- |
| CLI Reference (כל הדגלים)  | https://code.claude.com/docs/en/cli-reference |
| Sub-agents (`--agents`)    | https://code.claude.com/docs/en/sub-agents    |
| Permissions                | https://code.claude.com/docs/en/permissions   |
| Run Programmatically (SDK) | https://code.claude.com/docs/en/headless      |
| Changelog                  | https://code.claude.com/docs/en/changelog     |
| GitHub Repository          | https://github.com/anthropics/claude-code     |

---

_מסמך זה משקף את המצב של claude-adapter.ts גרסה `2.1.68`. לעדכון — בדוק `claude --version` ו-`claude --help` לדגלים חדשים._
