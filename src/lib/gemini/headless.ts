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

import { spawnCli } from '@/lib/utils/cli-runner';
import { ndjsonStream } from '@/lib/utils/ndjson-stream';
import type { StreamJsonEvent, StreamJsonStats } from './stream-json-parser';

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

  const { process: cp, cleanup } = spawnCli({
    command: 'gemini',
    args,
    cwd,
    timeoutMs,
    signal,
  });

  if (!cp.stdout) throw new Error('gemini process has no stdout (unexpected)');

  // Wire up the process 'close' event to track exit code
  let exitCode: number | null = null;
  cp.on('close', (code) => {
    exitCode = code;
  });

  try {
    yield* ndjsonStream<StreamJsonEvent>({
      stream: cp.stdout,
      onClose: () => {
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(`gemini process exited with code ${exitCode}`);
        }
      },
    });
  } finally {
    cleanup();
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
