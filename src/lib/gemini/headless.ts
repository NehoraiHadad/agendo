/**
 * Lightweight Gemini headless runner using `gemini -p "..." -o stream-json`.
 *
 * Purpose: utility/fire-and-forget calls (translate, summarize, generate) that
 * should stay on the CLI billing tier (OAuth/subscription) rather than using the
 * direct Gemini API (pay-per-token). No sessions, no pg-boss, no worker.
 *
 * Usage:
 *   // One-shot — returns full text
 *   const { text } = await runGeminiPrompt({ prompt: 'Translate to French: Hello' });
 *
 *   // Streaming — yields events as they arrive
 *   for await (const event of spawnGeminiHeadless({ prompt: '...' })) {
 *     if (event.type === 'message' && event.role === 'assistant') console.log(event.content);
 *   }
 */

import { spawn } from 'node:child_process';
import {
  parseStreamJsonLine,
  type StreamJsonEvent,
  type StreamJsonStats,
} from './stream-json-parser';

export interface GeminiHeadlessOpts {
  /** The prompt to send. */
  prompt: string;
  /** Working directory for the gemini process. Defaults to process.cwd(). */
  cwd?: string;
  /** Model override, e.g. "gemini-2.5-flash". Omits flag if not set (uses Gemini default). */
  model?: string;
  /** Hard kill timeout in ms. Default: 120_000 (2 min). */
  timeoutMs?: number;
  /** Abort signal — SIGTERMs the process when fired (e.g. on client disconnect). */
  signal?: AbortSignal;
}

export interface GeminiHeadlessResult {
  /** Full accumulated assistant text from all delta chunks. */
  text: string;
  /** Token stats from the final result event. */
  stats: StreamJsonStats | undefined;
  /** Gemini session_id from the init event (for --resume if needed later). */
  sessionId: string;
  /** The model that ran. */
  model: string;
}

/**
 * Spawn `gemini -p "..." -o stream-json` and yield parsed events.
 *
 * The generator cleans up the process on return/throw/abort.
 * Callers typically filter for:
 *   - `event.type === 'message' && event.role === 'assistant'` — text deltas
 *   - `event.type === 'result'` — completion + stats
 */
export async function* spawnGeminiHeadless(
  opts: GeminiHeadlessOpts,
): AsyncGenerator<StreamJsonEvent> {
  const { prompt, cwd, model, timeoutMs = 120_000, signal } = opts;

  const args: string[] = [
    '-p',
    prompt,
    '-o',
    'stream-json',
    '--approval-mode',
    'yolo', // required: no interactive stdin in headless mode
    '--allowed-mcp-server-names',
    '__none__', // disable MCP for utility calls
  ];
  if (model) args.push('-m', model);

  // Strip vars that block the CLI when running inside a Claude Code session
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDECODE' && key !== 'CLAUDE_CODE_ENTRYPOINT') {
      childEnv[key] = value;
    }
  }

  const cp = spawn('gemini', args, {
    cwd: cwd ?? process.cwd(),
    env: childEnv as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin closed prevents hangs
    shell: false,
  });

  const timeoutId = setTimeout(() => {
    try {
      cp.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      cp.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  };
  signal?.addEventListener('abort', onAbort);

  // Simple async queue: shared between event emitters and the generator consumer
  const queue: Array<StreamJsonEvent | Error | null> = [];
  let resolveNext: (() => void) | null = null;

  function push(item: StreamJsonEvent | Error | null) {
    queue.push(item);
    resolveNext?.();
    resolveNext = null;
  }

  let lineBuffer = '';

  // stdout is always Readable because stdio[1] = 'pipe'
  if (!cp.stdout) throw new Error('gemini process has no stdout (unexpected)');
  cp.stdout.on('data', (chunk: Buffer) => {
    const combined = lineBuffer + chunk.toString('utf-8');
    const parts = combined.split('\n');
    lineBuffer = parts.pop() ?? '';
    for (const line of parts) {
      const event = parseStreamJsonLine(line);
      if (event) push(event);
    }
  });

  cp.on('error', (err) => push(err));

  cp.on('close', (code) => {
    // Flush any partial data remaining in the buffer
    if (lineBuffer.trim()) {
      const event = parseStreamJsonLine(lineBuffer);
      if (event) push(event);
      lineBuffer = '';
    }
    if (code !== 0 && code !== null) {
      push(new Error(`gemini process exited with code ${code}`));
    } else {
      push(null); // done sentinel
    }
  });

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      const item = queue.shift() as StreamJsonEvent | Error | null;
      if (item === null) break;
      if (item instanceof Error) throw item;
      yield item;
    }
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
    try {
      cp.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run a prompt and return the full assembled result.
 *
 * Accumulates all assistant delta chunks. Throws if the process errors or
 * Gemini returns a non-success status.
 */
export async function runGeminiPrompt(opts: GeminiHeadlessOpts): Promise<GeminiHeadlessResult> {
  const textParts: string[] = [];
  let sessionId = '';
  let model = '';
  let stats: StreamJsonStats | undefined;

  for await (const event of spawnGeminiHeadless(opts)) {
    switch (event.type) {
      case 'init':
        sessionId = event.session_id;
        model = event.model;
        break;
      case 'message':
        if (event.role === 'assistant') {
          textParts.push(event.content);
        }
        break;
      case 'result':
        if (event.status !== 'success') {
          throw new Error(`gemini returned status "${event.status}"`);
        }
        stats = event.stats;
        break;
    }
  }

  return { text: textParts.join(''), stats, sessionId, model };
}
