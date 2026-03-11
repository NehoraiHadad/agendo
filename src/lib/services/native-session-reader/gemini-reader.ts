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

interface GeminiFunctionResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

interface GeminiToolCallResult {
  functionResponse?: GeminiFunctionResponse;
}

interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: GeminiToolCallResult[];
  status?: string;
  timestamp?: string;
  resultDisplay?: string;
  displayName?: string;
  description?: string;
  renderOutputAsMarkdown?: boolean;
}

interface GeminiMessageContentItem {
  text: string;
}

interface GeminiMessage {
  id: string;
  timestamp: string;
  type: 'user' | 'gemini';
  /** content is a string for gemini messages, or list for user messages */
  content: string | GeminiMessageContentItem[];
  thoughts?: string;
  tokens?: number;
  model?: string;
  toolCalls?: GeminiToolCall[];
}

interface GeminiSessionFile {
  sessionId: string;
  projectHash: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
  kind?: string;
}

// ---- File discovery ----

async function findGeminiSessionFile(sessionRef: string): Promise<string | null> {
  const home = process.env.HOME ?? '/root';
  const geminiTmp = path.join(home, '.gemini', 'tmp');

  let projectDirs: string[];
  try {
    projectDirs = await readdir(geminiTmp);
  } catch {
    return null;
  }

  const prefix8 = sessionRef.slice(0, 8);

  // First pass: fast check using filename prefix (first 8 chars of UUID)
  for (const projectDir of projectDirs) {
    const chatsDir = path.join(geminiTmp, projectDir, 'chats');
    try {
      const files = await readdir(chatsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        if (file.includes(prefix8)) {
          const filePath = path.join(chatsDir, file);
          try {
            const raw = await readFile(filePath, 'utf-8');
            const data = JSON.parse(raw) as GeminiSessionFile;
            if (data.sessionId === sessionRef) return filePath;
          } catch {
            // invalid JSON or read error — skip
          }
        }
      }
    } catch {
      // chats dir doesn't exist for this project dir — skip
    }
  }

  // Second pass (fallback): scan all JSON files without filename filter
  for (const projectDir of projectDirs) {
    const chatsDir = path.join(geminiTmp, projectDir, 'chats');
    try {
      const files = await readdir(chatsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        // Already checked prefix-matched files above; skip them
        if (file.includes(prefix8)) continue;
        const filePath = path.join(chatsDir, file);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const data = JSON.parse(raw) as GeminiSessionFile;
          if (data.sessionId === sessionRef) return filePath;
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  return null;
}

// ---- Content extraction helpers ----

function extractMessageText(msg: GeminiMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => c.text ?? '').join('');
  }
  return '';
}

function extractToolCallResult(tc: GeminiToolCall): string {
  if (!tc.result || tc.result.length === 0) return '';
  const parts: string[] = [];
  for (const item of tc.result) {
    if (item.functionResponse?.response) {
      const resp = item.functionResponse.response;
      if (typeof resp['output'] === 'string') {
        parts.push(resp['output'] as string);
      } else {
        parts.push(JSON.stringify(resp));
      }
    }
  }
  return parts.join('\n');
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '...(truncated)';
}

// ---- Public reader ----

export async function readGeminiSession(
  sessionRef: string,
  options?: NativeReaderOptions,
): Promise<NativeReadResult | null> {
  const filePath = await findGeminiSessionFile(sessionRef);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  let data: GeminiSessionFile;
  try {
    data = JSON.parse(raw) as GeminiSessionFile;
  } catch {
    return null;
  }

  const messages = data.messages ?? [];
  const includeToolResults = options?.includeToolResults ?? true;
  const maxToolResultChars = options?.maxToolResultChars ?? 2000;
  const includeBashOutput = options?.includeBashOutput ?? true;

  let rawResultChars = 0;
  let turns: NativeTurn[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role: 'user' | 'assistant' = msg.type === 'user' ? 'user' : 'assistant';
    const text = extractMessageText(msg);

    const toolCalls: NativeToolCall[] = [];
    const toolResults: NativeToolResult[] = [];

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        const toolCall: NativeToolCall = {
          toolUseId: tc.id,
          toolName: tc.name,
          input: tc.args ?? {},
        };
        toolCalls.push(toolCall);

        if (includeToolResults) {
          const resultText = extractToolCallResult(tc);
          rawResultChars += resultText.length;

          // Bash tools: respect includeBashOutput flag
          const isBashTool =
            tc.name === 'run_shell_command' || tc.name === 'exec_command' || tc.name === 'shell';
          const shouldInclude = isBashTool ? includeBashOutput : true;

          if (shouldInclude) {
            const content = truncate(resultText, maxToolResultChars);
            const isError = tc.status === 'error' || tc.status === 'failure';
            toolResults.push({
              toolUseId: tc.id,
              content,
              ...(isError ? { isError: true } : {}),
            });
          }
        }
      }
    }

    turns.push({
      index: i + 1,
      role,
      text,
      toolCalls,
      toolResults,
    });
  }

  // Apply maxTurns (keep last N turns)
  if (options?.maxTurns && options.maxTurns > 0 && turns.length > options.maxTurns) {
    turns = turns.slice(-options.maxTurns);
    turns.forEach((t, i) => {
      t.index = i + 1;
    });
  }

  return {
    turns,
    provider: 'gemini',
    sessionId: sessionRef,
    rawResultChars,
  };
}
