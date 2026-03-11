import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  NativeReadResult,
  NativeReaderOptions,
  NativeTurn,
  NativeToolCall,
  NativeToolResult,
} from './types';

// ---- Internal raw format interfaces ----

interface CodexSessionMeta {
  type: 'session_meta';
  timestamp: string;
  payload: {
    id: string;
    timestamp: string;
    cwd: string;
    originator?: string;
    cli_version?: string;
    model_provider?: string;
  };
}

interface CodexContentItem {
  type: 'input_text' | 'output_text' | string;
  text?: string;
}

interface CodexMessagePayload {
  type: 'message';
  role: 'developer' | 'user' | 'assistant';
  content: CodexContentItem[];
  phase?: string;
}

interface CodexFunctionCallPayload {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
}

interface CodexFunctionCallOutputPayload {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

interface CodexCustomToolCallPayload {
  type: 'custom_tool_call';
  status?: string;
  call_id: string;
  name: string;
  input: string;
}

interface CodexCustomToolCallOutputPayload {
  type: 'custom_tool_call_output';
  call_id: string;
  output: string;
}

interface CodexReasoningPayload {
  type: 'reasoning';
  summary?: Array<{ type: string; text?: string }>;
}

type CodexItemPayload =
  | CodexMessagePayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallPayload
  | CodexCustomToolCallOutputPayload
  | CodexReasoningPayload
  | { type: string };

interface CodexResponseItem {
  type: 'response_item';
  payload: CodexItemPayload;
}

interface CodexTurnContext {
  type: 'turn_context';
  timestamp: string;
  payload: {
    turn_id: string;
    cwd: string;
    model?: string;
    effort?: string;
  };
}

type CodexLine = CodexSessionMeta | CodexResponseItem | CodexTurnContext | { type: string };

// ---- File discovery ----

async function findCodexSessionFile(sessionRef: string): Promise<string | null> {
  const home = process.env.HOME ?? '/root';
  const sessionsBase = path.join(home, '.codex', 'sessions');

  let years: string[];
  try {
    years = await readdir(sessionsBase);
  } catch {
    return null;
  }

  // Search newest-first (reverse sorted years/months/days)
  for (const year of years.slice().sort().reverse()) {
    const yearDir = path.join(sessionsBase, year);
    let months: string[];
    try {
      months = await readdir(yearDir);
    } catch {
      continue;
    }
    for (const month of months.slice().sort().reverse()) {
      const monthDir = path.join(yearDir, month);
      let days: string[];
      try {
        days = await readdir(monthDir);
      } catch {
        continue;
      }
      for (const day of days.slice().sort().reverse()) {
        const dayDir = path.join(monthDir, day);
        let files: string[];
        try {
          files = await readdir(dayDir);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.includes(sessionRef) && file.endsWith('.jsonl')) {
            return path.join(dayDir, file);
          }
        }
      }
    }
  }

  return null;
}

// ---- Content extraction helpers ----

function extractTextFromContent(content: CodexContentItem[]): string {
  return content
    .filter((c) => c.type === 'input_text' || c.type === 'output_text')
    .map((c) => c.text ?? '')
    .join('');
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '...(truncated)';
}

function isBashToolName(name: string): boolean {
  return (
    name === 'exec_command' || name === 'run_shell_command' || name === 'shell' || name === 'bash'
  );
}

// ---- Parser ----

/**
 * Parse Codex JSONL lines into NativeTurn[].
 *
 * Strategy:
 *  - Initial developer/user `message` blocks → one synthetic "user" turn with
 *    the concatenated input text (the user prompt for this session).
 *  - Everything after = assistant activity: assistant messages, function_calls,
 *    and their outputs are grouped into a single assistant turn per logical
 *    exchange (one turn per TURN_CONTEXT block, or one flat turn for older
 *    sessions that lack TURN_CONTEXT).
 *
 * Because TURN_CONTEXT can appear between individual tool calls, we use a
 * flat approach: collect all tool calls, tool results, and assistant text into
 * a running "assistant turn" that is finalised at the end of the file.  If a
 * new user message block appears after the initial setup (i.e. a true
 * multi-turn conversation with human follow-ups), we close the current
 * assistant turn and open a new user turn.
 */
function parseCodexLines(
  lines: CodexLine[],
  options: NativeReaderOptions,
): { turns: NativeTurn[]; rawResultChars: number } {
  const includeToolResults = options.includeToolResults ?? true;
  const maxToolResultChars = options.maxToolResultChars ?? 2000;
  const includeBashOutput = options.includeBashOutput ?? true;

  const turns: NativeTurn[] = [];
  let rawResultChars = 0;

  // Accumulator for the current turn being built
  let currentRole: 'user' | 'assistant' | null = null;
  let currentTexts: string[] = [];
  let currentToolCalls: NativeToolCall[] = [];
  let currentToolResults: NativeToolResult[] = [];

  // Map from call_id → NativeToolCall so we can pair with outputs
  const pendingCalls = new Map<string, NativeToolCall>();

  function flushTurn() {
    if (currentRole === null) return;
    turns.push({
      index: turns.length + 1,
      role: currentRole,
      text: currentTexts.join(''),
      toolCalls: [...currentToolCalls],
      toolResults: [...currentToolResults],
    });
    currentRole = null;
    currentTexts = [];
    currentToolCalls = [];
    currentToolResults = [];
  }

  // Track whether we've passed the initial setup messages
  let seenAssistant = false;
  // Buffer user input messages (developer + user) until we see first assistant activity
  let userInputBuffer: string[] = [];
  // After seenAssistant, track whether we're inside a context-reinject block.
  // Codex app-server replays the full context (developer + user system messages)
  // at the start of each turn/start call. These are NOT human follow-ups.
  // We detect them by: after seenAssistant, a developer message always signals
  // the start of a context-reinject block.
  let inContextReinject = false;

  for (const line of lines) {
    if (line.type === 'session_meta') continue;
    if (line.type === 'turn_context') continue;

    if (line.type !== 'response_item') continue;
    const item = line as CodexResponseItem;
    const payload = item.payload;

    if (payload.type === 'reasoning') continue;

    if (payload.type === 'message') {
      const msg = payload as CodexMessagePayload;
      const text = extractTextFromContent(msg.content);

      if (msg.role === 'developer') {
        if (!seenAssistant) {
          // Part of initial setup context — buffer
          if (text.trim()) userInputBuffer.push(text);
        } else {
          // After first assistant activity, developer messages are always
          // context re-injections from a new turn/start call — skip them.
          inContextReinject = true;
        }
      } else if (msg.role === 'user') {
        if (!seenAssistant) {
          // Part of the initial prompt/context — buffer it
          if (text.trim()) userInputBuffer.push(text);
        } else if (inContextReinject) {
          // Still inside context reinject block — skip
        } else {
          // A genuine human follow-up message mid-session
          flushTurn();
          currentRole = 'user';
          currentTexts = text.trim() ? [text] : [];
          flushTurn();
        }
      } else if (msg.role === 'assistant') {
        seenAssistant = true;
        inContextReinject = false; // assistant activity ends any reinject block
        if (currentRole !== 'assistant') {
          // Start a new assistant turn, first emitting any buffered user input
          if (currentRole === 'user') {
            flushTurn();
          } else if (userInputBuffer.length > 0) {
            // First assistant action: emit the buffered user turn first
            turns.push({
              index: turns.length + 1,
              role: 'user',
              text: userInputBuffer.join('\n\n'),
              toolCalls: [],
              toolResults: [],
            });
            userInputBuffer = [];
          }
          currentRole = 'assistant';
        }
        if (text.trim()) currentTexts.push(text);
      }
      continue;
    }

    if (payload.type === 'function_call') {
      const fc = payload as CodexFunctionCallPayload;
      seenAssistant = true;
      inContextReinject = false; // function calls always end any reinject block

      // Emit buffered user turn if this is the first agent action
      if (currentRole !== 'assistant' && userInputBuffer.length > 0) {
        turns.push({
          index: turns.length + 1,
          role: 'user',
          text: userInputBuffer.join('\n\n'),
          toolCalls: [],
          toolResults: [],
        });
        userInputBuffer = [];
      }

      if (currentRole !== 'assistant') {
        currentRole = 'assistant';
      }

      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(fc.arguments) as Record<string, unknown>;
      } catch {
        input = { _raw: fc.arguments };
      }

      const tc: NativeToolCall = {
        toolUseId: fc.call_id,
        toolName: fc.name,
        input,
      };
      currentToolCalls.push(tc);
      pendingCalls.set(fc.call_id, tc);
      continue;
    }

    if (payload.type === 'function_call_output') {
      const fco = payload as CodexFunctionCallOutputPayload;
      const rawOutput = fco.output;
      rawResultChars += rawOutput.length;

      const callName = pendingCalls.get(fco.call_id)?.toolName ?? '';
      const isBash = isBashToolName(callName);
      const shouldInclude = isBash ? includeBashOutput : true;

      if (includeToolResults && shouldInclude) {
        const content = truncate(rawOutput, maxToolResultChars);
        currentToolResults.push({
          toolUseId: fco.call_id,
          content,
        });
      }
      continue;
    }

    if (payload.type === 'custom_tool_call') {
      const ctc = payload as CodexCustomToolCallPayload;
      seenAssistant = true;
      inContextReinject = false;

      if (userInputBuffer.length > 0 && currentRole !== 'assistant') {
        turns.push({
          index: turns.length + 1,
          role: 'user',
          text: userInputBuffer.join('\n\n'),
          toolCalls: [],
          toolResults: [],
        });
        userInputBuffer = [];
      }

      if (currentRole !== 'assistant') {
        currentRole = 'assistant';
      }

      const tc: NativeToolCall = {
        toolUseId: ctc.call_id,
        toolName: ctc.name,
        input: { _patch: ctc.input },
      };
      currentToolCalls.push(tc);
      pendingCalls.set(ctc.call_id, tc);
      continue;
    }

    if (payload.type === 'custom_tool_call_output') {
      const ctco = payload as CodexCustomToolCallOutputPayload;
      const rawOutput = ctco.output;
      rawResultChars += rawOutput.length;

      if (includeToolResults) {
        const content = truncate(rawOutput, maxToolResultChars);
        currentToolResults.push({
          toolUseId: ctco.call_id,
          content,
        });
      }
      continue;
    }
  }

  // Flush any open turn
  flushTurn();

  // If we never saw an assistant (empty/context-only session), still emit user turn
  if (turns.length === 0 && userInputBuffer.length > 0) {
    turns.push({
      index: 1,
      role: 'user',
      text: userInputBuffer.join('\n\n'),
      toolCalls: [],
      toolResults: [],
    });
  }

  return { turns, rawResultChars };
}

// ---- Public reader ----

export async function readCodexSession(
  sessionRef: string,
  options?: NativeReaderOptions,
): Promise<NativeReadResult | null> {
  const filePath = await findCodexSessionFile(sessionRef);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines: CodexLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as CodexLine);
    } catch {
      // skip malformed lines
    }
  }

  const opts: NativeReaderOptions = options ?? {};
  const { turns: rawTurns, rawResultChars } = parseCodexLines(lines, opts);

  // Apply maxTurns (keep last N turns)
  const turns =
    opts.maxTurns && opts.maxTurns > 0 && rawTurns.length > opts.maxTurns
      ? rawTurns.slice(-opts.maxTurns)
      : rawTurns;
  turns.forEach((t, i) => {
    t.index = i + 1;
  });

  return {
    turns,
    provider: 'codex',
    sessionId: sessionRef,
    rawResultChars,
  };
}
