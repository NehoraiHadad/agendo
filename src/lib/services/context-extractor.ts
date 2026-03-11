/**
 * context-extractor.ts
 *
 * Extracts conversation context from a session's event log and produces a
 * transfer prompt for cross-agent session forking.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readEventsFromLog } from '@/lib/realtime/event-utils';
import { getSessionWithDetails } from '@/lib/services/session-service';
import { callSummarizationProvider } from '@/lib/services/summarization-providers';
import { readNativeSession } from '@/lib/services/native-session-reader';
import type { NativeTurn } from '@/lib/services/native-session-reader';
import type { AgendoEvent } from '@/lib/realtime/event-types';

// ============================================================================
// Public types
// ============================================================================

export interface ContextExtractorOptions {
  mode: 'hybrid' | 'full';
  /** Number of most-recent turns to include verbatim. Default: 5 */
  recentTurnCount?: number;
  /** Maximum characters in the output prompt. Default: 40_000 */
  maxChars?: number;
}

export interface ExtractedContext {
  prompt: string;
  meta: {
    totalTurns: number;
    includedVerbatimTurns: number;
    summarizedTurns: number;
    estimatedTokens: number;
    previousAgent: string;
    taskTitle?: string;
    projectName?: string;
    /** Whether older turns were summarized by an LLM (vs per-turn truncation fallback) */
    llmSummarized?: boolean;
  };
}

// ============================================================================
// Internal types
// ============================================================================

interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  durationMs?: number;
}

interface Turn {
  index: number;
  userText: string;
  assistantText: string;
  toolCalls: ToolCall[];
  costUsd: number | null;
  model: string | null;
}

/** Accumulator used while building up a turn from events */
interface TurnAccumulator {
  userText: string;
  assistantText: string;
  toolCalls: ToolCall[];
  pendingTools: Map<string, { toolName: string; input: Record<string, unknown> }>;
  costUsd: number | null;
  model: string | null;
  flushed: boolean;
}

// ============================================================================
// Helper
// ============================================================================

/** Safe string cast — avoids `any` while accessing dynamic record fields */
function safeStr(v: unknown): string {
  return String(v ?? '');
}

function freshAccumulator(): TurnAccumulator {
  return {
    userText: '',
    assistantText: '',
    toolCalls: [],
    pendingTools: new Map(),
    costUsd: null,
    model: null,
    flushed: false,
  };
}

function accumulatorIsNonEmpty(acc: TurnAccumulator): boolean {
  return acc.userText.trim().length > 0 || acc.assistantText.trim().length > 0;
}

// ============================================================================
// LLM-powered summarization
// ============================================================================

/** In-memory cache keyed by content hash of the turns being summarized. */
const summaryCache = new Map<string, string>();

/** Clear the summary cache (for testing). */
export function clearSummaryCache(): void {
  summaryCache.clear();
}

/** Hash turn content to produce a stable, content-aware cache key. */
function hashTurns(sessionId: string, plainText: string): string {
  return createHash('sha256').update(`${sessionId}:${plainText}`).digest('hex').slice(0, 16);
}

/**
 * Formats turns into a plain text representation for the summarization prompt.
 */
export function turnsToPlainText(turns: Turn[]): string {
  return turns
    .map((t) => {
      const toolList =
        t.toolCalls.length > 0
          ? `\n  Tools used: ${t.toolCalls.map(summarizeToolCall).join(', ')}`
          : '';
      return `Turn ${t.index}:\n  User: ${t.userText.trim()}\n  Assistant: ${t.assistantText.trim()}${toolList}`;
    })
    .join('\n\n');
}

/**
 * Calls the configured LLM provider to produce an intelligent summary of
 * older conversation turns. Provider is selected via SUMMARIZATION_PROVIDER
 * env var (default: auto-detect).
 *
 * Returns the raw summary text, or null on failure (caller falls back to
 * per-turn truncation).
 */
export async function summarizeConversation(
  sessionId: string,
  turns: Turn[],
): Promise<string | null> {
  if (turns.length === 0) return null;

  const plainText = turnsToPlainText(turns);

  // Content-aware cache: same turns → same summary
  const cacheKey = hashTurns(sessionId, plainText);
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  try {
    const result = await callSummarizationProvider(plainText);
    if (result && result.text.length > 0) {
      summaryCache.set(cacheKey, result.text);
      return result.text;
    }
  } catch (err) {
    // Log but don't throw — fall back to per-turn truncation
    console.warn('[context-extractor] LLM summarization failed, falling back to truncation:', err);
  }

  return null;
}

// ============================================================================
// segmentTurns
// ============================================================================

/**
 * Groups a flat list of AgendoEvents into discrete Turn objects.
 *
 * Turn boundaries:
 *  - A `user:message` event starts a new turn (flushing the previous one if
 *    non-empty and not already flushed).
 *  - An `agent:result` event captures cost / model and flushes the turn.
 *  - A `session:state` event with status `awaiting_input` acts as a secondary
 *    flush boundary if the turn hasn't been flushed yet.
 */
export function segmentTurns(events: AgendoEvent[]): Turn[] {
  const turns: Turn[] = [];
  let acc = freshAccumulator();

  function flush(index: number): void {
    if (acc.flushed) return;
    if (!accumulatorIsNonEmpty(acc)) return;
    acc.flushed = true;
    turns.push({
      index,
      userText: acc.userText,
      assistantText: acc.assistantText,
      toolCalls: acc.toolCalls,
      costUsd: acc.costUsd,
      model: acc.model,
    });
  }

  for (const event of events) {
    switch (event.type) {
      case 'user:message': {
        // Flush previous accumulator before starting a new turn
        flush(turns.length);
        acc = freshAccumulator();
        acc.userText = event.text;
        break;
      }

      case 'agent:text': {
        acc.assistantText += (acc.assistantText ? '\n' : '') + event.text;
        break;
      }

      // agent:text-delta is ephemeral (not persisted to log files) — skip
      case 'agent:text-delta': {
        break;
      }

      case 'agent:tool-start': {
        acc.pendingTools.set(event.toolUseId, {
          toolName: event.toolName,
          input: event.input,
        });
        break;
      }

      case 'agent:tool-end': {
        const pending = acc.pendingTools.get(event.toolUseId);
        if (pending) {
          acc.toolCalls.push({
            toolName: pending.toolName,
            input: pending.input,
            durationMs: event.durationMs,
          });
          acc.pendingTools.delete(event.toolUseId);
        }
        break;
      }

      case 'agent:result': {
        acc.costUsd = event.costUsd;
        if (event.modelUsage) {
          acc.model = Object.keys(event.modelUsage)[0] ?? null;
        }
        flush(turns.length);
        acc = freshAccumulator();
        break;
      }

      case 'session:state': {
        if (event.status === 'awaiting_input') {
          flush(turns.length);
          // Reset accumulator but keep same turn slot open
          const prev = acc;
          acc = freshAccumulator();
          // If the old acc had data but wasn't flushed, we already flushed it above.
          // If it was empty (no-op), nothing to carry over.
          void prev;
        }
        break;
      }

      default: {
        // All other event types are ignored for context extraction
        break;
      }
    }
  }

  // Flush any trailing partial turn (e.g. session ended without agent:result)
  flush(turns.length);

  // Re-index turns sequentially
  turns.forEach((t, i) => {
    t.index = i + 1;
  });

  return turns;
}

// ============================================================================
// nativeTurnsToContextTurns
// ============================================================================

/**
 * Converts NativeTurn[] (from the native session readers) into the internal
 * Turn format used by context-extractor's buildPrompt().
 *
 * Strategy: pair consecutive user + assistant NativeTurns into a single Turn.
 * If a NativeTurn doesn't have a matching partner (e.g. a trailing assistant
 * turn or an orphan user turn), it's still emitted as a Turn with the
 * missing side left empty.
 *
 * Tool result content is appended to assistantText so it appears verbatim in
 * the rendered context prompt.
 */
export function nativeTurnsToContextTurns(nativeTurns: NativeTurn[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;

  while (i < nativeTurns.length) {
    const current = nativeTurns[i];

    if (current.role === 'user') {
      // Try to pair with the next assistant turn
      const next = nativeTurns[i + 1];
      if (next && next.role === 'assistant') {
        turns.push(buildTurnFromPair(current, next, turns.length + 1));
        i += 2;
      } else {
        // Orphan user turn
        turns.push(buildTurnFromPair(current, null, turns.length + 1));
        i += 1;
      }
    } else {
      // Orphan assistant turn (no preceding user turn in this window)
      turns.push(buildTurnFromPair(null, current, turns.length + 1));
      i += 1;
    }
  }

  return turns;
}

function buildTurnFromPair(
  userTurn: NativeTurn | null,
  assistantTurn: NativeTurn | null,
  index: number,
): Turn {
  const userText = userTurn?.text ?? '';
  let assistantText = assistantTurn?.text ?? '';

  // Append tool result content to assistantText so it's visible in verbatim renders
  if (assistantTurn && assistantTurn.toolResults.length > 0) {
    const resultLines: string[] = [];
    for (const tr of assistantTurn.toolResults) {
      if (tr.content.trim()) {
        resultLines.push(`[Tool result]: ${tr.content}`);
      }
    }
    if (resultLines.length > 0) {
      assistantText = assistantText
        ? `${assistantText}\n\n${resultLines.join('\n')}`
        : resultLines.join('\n');
    }
  }

  const toolCalls: ToolCall[] =
    assistantTurn?.toolCalls.map((tc) => ({
      toolName: tc.toolName,
      input: tc.input,
    })) ?? [];

  return {
    index,
    userText,
    assistantText,
    toolCalls,
    costUsd: null,
    model: null,
  };
}

// ============================================================================
// summarizeToolCall
// ============================================================================

/**
 * Produces a compact single-line summary of a tool call for inclusion in
 * summarized turns.
 */
export function summarizeToolCall(tc: ToolCall): string {
  const name = tc.toolName;

  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const path = safeStr(tc.input['file_path'] ?? tc.input['path'] ?? '');
    return `Edit(${path})`;
  }

  if (name === 'Read' || name === 'Glob' || name === 'Grep') {
    const path = safeStr(
      tc.input['file_path'] ?? tc.input['path'] ?? tc.input['pattern'] ?? tc.input['glob'] ?? '',
    );
    return `Read(${path})`;
  }

  if (name === 'Bash') {
    const cmd = safeStr(tc.input['command'] ?? '');
    const preview = cmd.slice(0, 60);
    return `Bash(\`${preview}\`)`;
  }

  if (name.startsWith('mcp__')) {
    // Strip mcp__agendo__ prefix (or any mcp__ prefix) and show tool name
    const stripped = name.replace(/^mcp__[^_]+__/, '');
    return `MCP(${stripped})`;
  }

  return name;
}

// ============================================================================
// summarizeTurn
// ============================================================================

/**
 * Renders a turn as a single compact summary line for the "earlier turns"
 * section of a hybrid prompt.
 */
export function summarizeTurn(turn: Turn): string {
  const userPreview = turn.userText.trim().slice(0, 120);
  const assistantPreview =
    turn.assistantText.trim().length > 0 ? turn.assistantText.trim().slice(0, 150) : 'no response';

  const toolsSuffix =
    turn.toolCalls.length > 0 ? `. Tools: ${turn.toolCalls.map(summarizeToolCall).join(', ')}` : '';

  return `- Turn ${turn.index}: User asked: ${userPreview}. Assistant: ${assistantPreview}${toolsSuffix}`;
}

// ============================================================================
// renderTurnVerbatim
// ============================================================================

/**
 * Renders a turn in full for the "recent turns" section.
 */
export function renderTurnVerbatim(turn: Turn): string {
  const lines: string[] = [];

  lines.push(`**Turn ${turn.index} (User):**`);
  lines.push(turn.userText.trim() || '(no user text)');
  lines.push('');
  lines.push(`**Turn ${turn.index} (Assistant):**`);
  lines.push(turn.assistantText.trim() || '(no response)');

  for (const tc of turn.toolCalls) {
    if (tc.toolName === 'Edit' || tc.toolName === 'Write' || tc.toolName === 'MultiEdit') {
      const path = safeStr(tc.input['file_path'] ?? tc.input['path'] ?? '');
      lines.push(`[Tool: Edit ${path}]`);
    } else if (tc.toolName === 'Bash') {
      const cmd = safeStr(tc.input['command'] ?? '').slice(0, 60);
      lines.push(`[Tool: Bash \`${cmd}\`]`);
    } else {
      lines.push(`[Tool: ${summarizeToolCall(tc)}]`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// buildPrompt
// ============================================================================

interface SessionMeta {
  agentName: string | null;
  agentSlug: string | null;
  taskTitle: string | null;
  projectName: string | null;
}

/**
 * Assembles the full transfer prompt from turns and session metadata.
 * When `llmSummary` is provided, it replaces the per-turn truncation for
 * older turns in hybrid mode. Falls back to per-turn summaries otherwise.
 * Applies maxChars truncation by dropping oldest turns first.
 */
function buildPrompt(
  turns: Turn[],
  session: SessionMeta,
  options: Required<ContextExtractorOptions>,
  llmSummary?: string | null,
): string {
  const { mode, recentTurnCount, maxChars } = options;

  const totalTurns = turns.length;
  const totalCostUsd = turns.reduce<number | null>((sum, t) => {
    if (t.costUsd === null) return sum;
    return (sum ?? 0) + t.costUsd;
  }, null);

  // Build header
  const headerLines: string[] = [];
  headerLines.push('## Conversation Context Transfer');
  headerLines.push('');
  headerLines.push(`**Previous agent:** ${session.agentName ?? 'Unknown'}`);
  if (session.taskTitle) headerLines.push(`**Task:** ${session.taskTitle}`);
  if (session.projectName) headerLines.push(`**Project:** ${session.projectName}`);
  headerLines.push(`**Total turns:** ${totalTurns}`);
  if (totalCostUsd !== null) {
    headerLines.push(`**Total cost:** $${totalCostUsd.toFixed(4)}`);
  }
  headerLines.push('');

  // Determine split — in 'full' mode, all turns are rendered verbatim
  const verbatimCount = mode === 'full' ? totalTurns : Math.min(recentTurnCount, totalTurns);
  const summarizeCount = totalTurns - verbatimCount;
  const summarizedTurns = turns.slice(0, summarizeCount);
  const verbatimTurns = turns.slice(summarizeCount);

  // Build body sections
  const bodyLines: string[] = [];

  if (mode === 'hybrid' && summarizedTurns.length > 0) {
    if (llmSummary) {
      // Use LLM-generated summary instead of per-turn truncation
      bodyLines.push(`### Earlier conversation (${summarizeCount} turns summarized by AI)`);
      bodyLines.push('');
      bodyLines.push(llmSummary);
      bodyLines.push('');
    } else {
      // Fallback: per-turn truncation
      bodyLines.push('### Earlier turns (summarized)');
      bodyLines.push('');
      for (const turn of summarizedTurns) {
        bodyLines.push(summarizeTurn(turn));
      }
      bodyLines.push('');
    }
  }

  if (verbatimTurns.length > 0) {
    if (mode === 'hybrid' && summarizedTurns.length > 0) {
      bodyLines.push('### Recent turns (verbatim)');
    } else {
      bodyLines.push('### Conversation');
    }
    bodyLines.push('');
    for (const turn of verbatimTurns) {
      bodyLines.push(renderTurnVerbatim(turn));
      bodyLines.push('');
    }
  }

  // Footer
  const footerLines: string[] = ['---', '', 'Continue from where the previous agent left off.'];

  // Assemble full prompt
  const header = headerLines.join('\n');
  const footer = footerLines.join('\n');

  // Apply maxChars — drop oldest verbatim turns first (LLM summary stays intact)
  let body = bodyLines.join('\n');
  let prompt = `${header}${body}\n${footer}`;

  if (prompt.length <= maxChars) {
    return prompt;
  }

  // If we have an LLM summary, only drop verbatim turns (preserve the summary)
  if (llmSummary && verbatimTurns.length > 1) {
    let dropVerbatim = 0;
    while (prompt.length > maxChars && dropVerbatim < verbatimTurns.length - 1) {
      dropVerbatim += 1;
      const remainingVerbatim = verbatimTurns.slice(dropVerbatim);
      const newBody: string[] = [];
      newBody.push(`### Earlier conversation (${summarizeCount} turns summarized by AI)`);
      newBody.push('');
      newBody.push(llmSummary);
      newBody.push('');
      newBody.push('### Recent turns (verbatim)');
      newBody.push('');
      for (const turn of remainingVerbatim) {
        newBody.push(renderTurnVerbatim(turn));
        newBody.push('');
      }
      body = newBody.join('\n');
      prompt = `${header}${body}\n${footer}`;
    }
  } else {
    // No LLM summary — original iterative drop logic
    let dropIndex = 0;
    const allTurns = [...summarizedTurns, ...verbatimTurns];

    while (prompt.length > maxChars && dropIndex < allTurns.length) {
      dropIndex += 1;
      const remaining = allTurns.slice(dropIndex);
      const newSummarized = remaining.filter((t) => summarizedTurns.includes(t));
      const newVerbatim = remaining.filter((t) => verbatimTurns.includes(t));

      const newBody: string[] = [];
      if (mode === 'hybrid' && newSummarized.length > 0) {
        newBody.push('### Earlier turns (summarized)');
        newBody.push('');
        for (const turn of newSummarized) newBody.push(summarizeTurn(turn));
        newBody.push('');
      }
      if (newVerbatim.length > 0) {
        if (mode === 'hybrid' && newSummarized.length > 0) {
          newBody.push('### Recent turns (verbatim)');
        } else {
          newBody.push('### Conversation');
        }
        newBody.push('');
        for (const turn of newVerbatim) {
          newBody.push(renderTurnVerbatim(turn));
          newBody.push('');
        }
      }

      body = newBody.join('\n');
      prompt = `${header}${body}\n${footer}`;
    }
  }

  // Hard cap as last resort
  if (prompt.length > maxChars) {
    prompt = prompt.slice(0, maxChars);
  }

  return prompt;
}

// ============================================================================
// buildEmptyContext
// ============================================================================

/**
 * Returns a minimal context when the log is missing or unreadable.
 */
function buildEmptyContext(session: SessionMeta): ExtractedContext {
  const promptLines = [
    '## Conversation Context Transfer',
    '',
    `**Previous agent:** ${session.agentName ?? 'Unknown'}`,
  ];
  if (session.taskTitle) promptLines.push(`**Task:** ${session.taskTitle}`);
  if (session.projectName) promptLines.push(`**Project:** ${session.projectName}`);
  promptLines.push('**Total turns:** 0');
  promptLines.push('');
  promptLines.push('*(No conversation history available.)*');
  promptLines.push('');
  promptLines.push('---');
  promptLines.push('');
  promptLines.push('Continue from where the previous agent left off.');

  const prompt = promptLines.join('\n');

  return {
    prompt,
    meta: {
      totalTurns: 0,
      includedVerbatimTurns: 0,
      summarizedTurns: 0,
      estimatedTokens: Math.ceil(prompt.length / 4),
      previousAgent: session.agentName ?? 'Unknown',
      taskTitle: session.taskTitle ?? undefined,
      projectName: session.projectName ?? undefined,
    },
  };
}

// ============================================================================
// extractSessionContext — main entry point
// ============================================================================

/**
 * Extracts conversation context from a session's event log and produces a
 * transfer prompt suitable for handing off to a different agent.
 *
 * @param sessionId - UUID of the session to extract context from
 * @param options   - Extraction options (mode, recentTurnCount, maxChars)
 */
export async function extractSessionContext(
  sessionId: string,
  options: ContextExtractorOptions,
): Promise<ExtractedContext> {
  const resolvedOptions: Required<ContextExtractorOptions> = {
    mode: options.mode,
    recentTurnCount: options.recentTurnCount ?? 5,
    maxChars: options.maxChars ?? 40_000,
  };

  const session = await getSessionWithDetails(sessionId);

  const sessionMeta: SessionMeta = {
    agentName: session.agentName,
    agentSlug: session.agentSlug,
    taskTitle: session.taskTitle,
    projectName: session.projectName,
  };

  // Try native reader first — richer tool results than the event-log path
  if (session.sessionRef && session.agentSlug) {
    const projectCwd = session.projectRootPath ?? process.cwd();
    const native = await readNativeSession(session.sessionRef, session.agentSlug, projectCwd, {
      includeToolResults: true,
      maxToolResultChars: 2000,
      includeBashOutput: true,
      maxTurns: 0,
    });
    if (native && native.turns.length > 0) {
      const turns = nativeTurnsToContextTurns(native.turns);

      const verbatimCount =
        resolvedOptions.mode === 'full'
          ? turns.length
          : Math.min(resolvedOptions.recentTurnCount, turns.length);
      const summarizeCount = turns.length - verbatimCount;

      let llmSummary: string | null = null;
      if (resolvedOptions.mode === 'hybrid' && summarizeCount > 0) {
        const turnsToSummarize = turns.slice(0, summarizeCount);
        llmSummary = await summarizeConversation(sessionId, turnsToSummarize);
      }

      const prompt = buildPrompt(turns, sessionMeta, resolvedOptions, llmSummary);

      return {
        prompt,
        meta: {
          totalTurns: turns.length,
          includedVerbatimTurns: verbatimCount,
          summarizedTurns: summarizeCount,
          estimatedTokens: Math.ceil(prompt.length / 4),
          previousAgent: session.agentName ?? 'Unknown',
          taskTitle: session.taskTitle ?? undefined,
          projectName: session.projectName ?? undefined,
          llmSummarized: llmSummary !== null,
        },
      };
    }
  }

  // No log file — return empty context
  if (!session.logFilePath) {
    return buildEmptyContext(sessionMeta);
  }

  // Read log file — return empty context on any read error
  let logContent: string;
  try {
    logContent = await readFile(session.logFilePath, 'utf-8');
  } catch {
    return buildEmptyContext(sessionMeta);
  }

  // Parse events from log content
  const events = readEventsFromLog(logContent, 0);

  // Segment into turns
  const turns = segmentTurns(events);

  if (turns.length === 0) {
    return buildEmptyContext(sessionMeta);
  }

  // Determine verbatim / summarized split — in 'full' mode, all turns are verbatim
  const verbatimCount =
    resolvedOptions.mode === 'full'
      ? turns.length
      : Math.min(resolvedOptions.recentTurnCount, turns.length);
  const summarizeCount = turns.length - verbatimCount;

  // In hybrid mode with turns to summarize, call the LLM for an intelligent summary
  let llmSummary: string | null = null;
  if (resolvedOptions.mode === 'hybrid' && summarizeCount > 0) {
    const turnsToSummarize = turns.slice(0, summarizeCount);
    llmSummary = await summarizeConversation(sessionId, turnsToSummarize);
  }

  // Build prompt (with maxChars applied internally)
  const prompt = buildPrompt(turns, sessionMeta, resolvedOptions, llmSummary);

  return {
    prompt,
    meta: {
      totalTurns: turns.length,
      includedVerbatimTurns: verbatimCount,
      summarizedTurns: summarizeCount,
      estimatedTokens: Math.ceil(prompt.length / 4),
      previousAgent: session.agentName ?? 'Unknown',
      taskTitle: session.taskTitle ?? undefined,
      projectName: session.projectName ?? undefined,
      llmSummarized: llmSummary !== null,
    },
  };
}
