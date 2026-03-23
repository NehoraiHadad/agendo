/**
 * Claude history — two reading strategies for SSE reconnect fallback:
 *
 * 1. JSONL direct read (preferred): reads ~/.claude/projects/{encodedPath}/{sessionId}.jsonl
 *    directly, preserving timestamps and full metadata. ~1ms, ~90x faster than SDK.
 *
 * 2. SDK fallback (legacy): uses getSessionMessages() from @anthropic-ai/claude-agent-sdk.
 *    Strips timestamps and some metadata. ~89ms. Kept for backward compatibility.
 *
 * Limitations vs the Agendo log file (either strategy):
 * - No cost/duration data (runtime-only events)
 * - No system events, approvals, team messages, or subagent events
 * - Tool result metadata (durationMs, numFiles) is lost
 *
 * This gives ~60% fidelity — enough for a usable reconnect experience.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Preamble stripping — remove system context injected into the first user
// message before displaying it in the chat UI. Matches:
//   [Agendo Context: ...]  ...  ---\n
//   [Previous Work Summary] ...  ---\n
//   [Resume Context]        ...  ---\n
//   [SYSTEM INSTRUCTIONS ...] ... ---\n
// ---------------------------------------------------------------------------

const PREAMBLE_RE =
  /^\[(?:Agendo Context|Previous Work Summary|Resume Context|SYSTEM INSTRUCTIONS)[^\]]*\][\s\S]*?---\n/;

/**
 * Strip any Agendo system preamble from the beginning of a user message.
 * Returns the cleaned text (or the original if no preamble found).
 */
function stripPreamble(text: string): string {
  return text.replace(PREAMBLE_RE, '').trimStart();
}

// ---------------------------------------------------------------------------
// Raw JSONL record types
// ---------------------------------------------------------------------------

/** Content block types found in assistant messages. */
interface TextBlock {
  type: 'text';
  text: string;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | { type: string };

/** User message content when it's a tool result. */
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | unknown;
}

interface RawMessageUser {
  role: 'user';
  content: string | Array<{ type: string; text?: string }>;
}

interface RawMessageAssistant {
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason: string;
  id: string;
}

/** A user turn record from the JSONL file. */
export interface RawUserRecord {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string;
  permissionMode: string;
  cwd: string;
  gitBranch: string;
  message: RawMessageUser;
  toolUseResult?: { durationMs: number; numFiles?: number };
}

/** An assistant turn record from the JSONL file. */
export interface RawAssistantRecord {
  type: 'assistant';
  uuid: string;
  parentUuid: string;
  isSidechain: boolean;
  timestamp: string;
  requestId: string;
  cwd: string;
  gitBranch: string;
  message: RawMessageAssistant;
}

/**
 * A queue-operation record from the JSONL file.
 *
 * Claude SDK writes these when messages are enqueued/dequeued/removed via
 * the message queue (sendMessage). They represent the queue lifecycle:
 *   - enqueue: user message entered the queue (may be consumed mid-turn
 *              as a system-reminder, or dequeued as the next user turn)
 *   - dequeue: message was consumed from the queue
 *   - remove:  message was cancelled before consumption
 *
 * These are NOT part of the uuid-linked conversation chain — they exist
 * alongside it with their own timestamp-based ordering.
 */
export interface RawQueueOperationRecord {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | 'remove';
  timestamp: string;
  sessionId: string;
  /** Message content — only present on 'enqueue' operations. */
  content?: string;
}

/** Union of the conversation record types. */
export type RawRecord = RawUserRecord | RawAssistantRecord;

/** Union including queue operations for the full JSONL parse. */
type RawJsonlRecord = RawRecord | RawQueueOperationRecord;

// ---------------------------------------------------------------------------
// Types matching the Claude SDK's SessionMessage shape (typed as unknown)
// ---------------------------------------------------------------------------

/** Minimal shape of what getSessionMessages() returns. */
interface SessionMessage {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: null;
}

// ---------------------------------------------------------------------------
// JSONL file path resolution
// ---------------------------------------------------------------------------

/**
 * Encode a working directory path to the format Claude uses for project directories.
 * Claude replaces all `/` with `-`. The leading `/` naturally becomes the leading `-`.
 * Example: `/home/ubuntu/projects/agendo` → `-home-ubuntu-projects-agendo`
 */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Build the expected JSONL file path for a Claude session.
 * Path: ~/.claude/projects/{encodedPath}/{sessionId}.jsonl
 */
function buildJsonlPath(sessionRef: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return join(homedir(), '.claude', 'projects', encoded, `${sessionRef}.jsonl`);
}

// ---------------------------------------------------------------------------
// JSONL chain building algorithm
// ---------------------------------------------------------------------------

/**
 * Type guard: check if a parsed JSON value is a valid user or assistant record.
 * Skips 'progress', 'system', 'file-history-snapshot', 'last-prompt', and other
 * meta record types that do not contribute to the conversation history.
 */
function isConversationRecord(value: unknown): value is RawRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  // Must have type and uuid
  if (typeof obj['type'] !== 'string') return false;
  if (typeof obj['uuid'] !== 'string') return false;

  // Only user + assistant records form the conversation chain
  if (obj['type'] !== 'user' && obj['type'] !== 'assistant') return false;

  // Skip team messages (teamName present) and meta records (isMeta === true)
  if ('teamName' in obj && obj['teamName'] !== undefined) return false;
  if (obj['isMeta'] === true) return false;

  // Must have a message body
  if (typeof obj['message'] !== 'object' || obj['message'] === null) return false;

  return true;
}

/**
 * Type guard: check if a parsed JSON value is a queue-operation record.
 */
function isQueueOperationRecord(value: unknown): value is RawQueueOperationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['type'] === 'queue-operation' &&
    typeof obj['operation'] === 'string' &&
    typeof obj['timestamp'] === 'string'
  );
}

/**
 * Build the main conversation chain from a flat list of parsed JSONL records.
 *
 * Claude's JSONL can contain sidechains (e.g. from interrupted turns, retries,
 * or forked conversations). We want only the canonical chain — the leaf-to-root
 * path of the most-recently-completed conversation thread.
 *
 * Algorithm (mirrors what Claude SDK does internally):
 *   1. Skip records where isSidechain === true (branched off the main chain).
 *   2. Build a uuid → record lookup map.
 *   3. Build a set of all uuids referenced as parentUuid (i.e. non-leaf nodes).
 *   4. Among non-sidechain records NOT in that set, find the leaf with the
 *      latest timestamp — this is the end of the main conversation thread.
 *   5. Walk backwards from that leaf through parentUuid links until null.
 *   6. Reverse the result to get chronological (oldest-first) order.
 */
function buildConversationChain(allRecords: RawRecord[]): RawRecord[] {
  // Step 1: filter out sidechains and build uuid lookup
  const mainRecords = allRecords.filter((r) => !r.isSidechain);
  const byUuid = new Map<string, RawRecord>();
  for (const record of mainRecords) {
    byUuid.set(record.uuid, record);
  }

  // Step 2: find all uuids that are referenced as a parentUuid (non-leaf nodes)
  const referencedAsParent = new Set<string>();
  for (const record of mainRecords) {
    if (record.parentUuid !== null) {
      referencedAsParent.add(record.parentUuid);
    }
  }

  // Step 3: find leaves (records NOT referenced as parent by any other record)
  const leaves = mainRecords.filter((r) => !referencedAsParent.has(r.uuid));

  if (leaves.length === 0) return [];

  // Step 4: pick the leaf with the latest timestamp as the chain endpoint
  const latestLeaf = leaves.reduce((best, candidate) => {
    const bestTs = new Date(best.timestamp).getTime();
    const candidateTs = new Date(candidate.timestamp).getTime();
    return candidateTs > bestTs ? candidate : best;
  });

  // Step 5: walk backwards from latestLeaf to root, collecting the chain
  const chain: RawRecord[] = [];
  let current: RawRecord | undefined = latestLeaf;
  while (current !== undefined) {
    chain.push(current);
    const parentUuid: string | null = current.parentUuid;
    current = parentUuid !== null ? byUuid.get(parentUuid) : undefined;
  }

  // Step 6: reverse to get chronological order (oldest first)
  chain.reverse();
  return chain;
}

// ---------------------------------------------------------------------------
// Public API: JSONL direct read
// ---------------------------------------------------------------------------

/**
 * Read a Claude session's JSONL file directly and return the ordered conversation
 * chain as RawRecord[].
 *
 * @param sessionRef - The Claude session ID (used as the filename stem).
 * @param cwd - The working directory the session was started in. Used to locate
 *   the project subdirectory under ~/.claude/projects/.
 * @returns Ordered array of user + assistant + queue-operation records (oldest
 *   first), or null if the file cannot be found or parsed. Queue operations
 *   are merged into the chain at their chronological positions.
 */
export function readClaudeJsonl(
  sessionRef: string,
  cwd?: string,
): ReadonlyArray<RawRecord | RawQueueOperationRecord> | null {
  if (!cwd) return null;

  const filePath = buildJsonlPath(sessionRef, cwd);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Parse each non-empty line as JSON, collecting conversation records and
  // queue-operation records separately. Queue operations (enqueue/dequeue/remove)
  // are not part of the uuid-linked conversation chain — they are merged by
  // timestamp after the chain is built.
  const allRecords: RawRecord[] = [];
  const queueOps: RawQueueOperationRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isConversationRecord(parsed)) {
        allRecords.push(parsed);
      } else if (isQueueOperationRecord(parsed)) {
        queueOps.push(parsed);
      }
    } catch {
      // Skip malformed lines (partial writes, corruption, etc.)
    }
  }

  if (allRecords.length === 0 && queueOps.length === 0) return null;

  const chain = buildConversationChain(allRecords);
  if (chain.length === 0 && queueOps.length === 0) return null;

  // Merge queue operations into the conversation chain at their chronological
  // positions. This surfaces mid-turn user messages and cancellations that
  // would otherwise be invisible in the CLI history.
  return mergeQueueOperations(chain, queueOps);
}

// ---------------------------------------------------------------------------
// Queue operation merging
// ---------------------------------------------------------------------------

/**
 * Merge queue-operation records into the conversation chain at the correct
 * chronological positions.
 *
 * Queue operations represent the message queue lifecycle:
 *   - enqueue: user sent a message (may be mid-turn or awaiting_input)
 *   - dequeue: Claude consumed the message from the queue
 *   - remove:  user cancelled the message before consumption
 *
 * An enqueue immediately followed by a dequeue (same second) means the message
 * became a regular user turn — it already exists as a `user` record in the chain.
 * These are filtered out to avoid duplicates.
 *
 * Remaining enqueue records are mid-turn messages that Claude received as
 * system-reminders — they need to be inserted into the chain so the UI shows them.
 *
 * Remove records are cancelled messages — inserted as synthetic user records
 * so the UI can show "message cancelled" indicators.
 */
function mergeQueueOperations(
  chain: RawRecord[],
  queueOps: RawQueueOperationRecord[],
): RawJsonlRecord[] {
  if (queueOps.length === 0) return chain;

  // Build a set of enqueue timestamps that have a matching dequeue within 1 second.
  // These messages became regular user turns and already exist in the chain.
  const dequeuedTimestamps = new Set<string>();
  const immediateDequeueTimestamps = new Set<string>();
  for (let i = 0; i < queueOps.length; i++) {
    const op = queueOps[i];
    if (op.operation !== 'enqueue') continue;
    // Look for a dequeue within 1 second after this enqueue
    const enqueueTime = new Date(op.timestamp).getTime();
    for (let j = i + 1; j < queueOps.length; j++) {
      const next = queueOps[j];
      const nextTime = new Date(next.timestamp).getTime();
      if (nextTime - enqueueTime > 1000) break; // too far away
      if (next.operation === 'dequeue') {
        dequeuedTimestamps.add(op.timestamp);
        immediateDequeueTimestamps.add(next.timestamp);
        break;
      }
    }
  }

  // Filter to only the queue ops we need to insert:
  //   - enqueue WITHOUT immediate dequeue (mid-turn messages)
  //   - dequeue WITHOUT immediate preceding enqueue (split marker for mid-turn messages)
  //   - remove (cancelled messages)
  const toInsert = queueOps.filter((op) => {
    if (op.operation === 'enqueue' && op.content) {
      return !dequeuedTimestamps.has(op.timestamp);
    }
    if (op.operation === 'dequeue') {
      return !immediateDequeueTimestamps.has(op.timestamp);
    }
    if (op.operation === 'remove') {
      return true;
    }
    return false;
  });

  if (toInsert.length === 0) return chain;

  // Merge by timestamp: interleave queue ops into the conversation chain.
  const merged: RawJsonlRecord[] = [];
  let qIdx = 0;

  for (const record of chain) {
    const recordTs = new Date(record.timestamp).getTime();
    // Insert all queue ops that come before this record
    while (qIdx < toInsert.length) {
      const opTs = new Date(toInsert[qIdx].timestamp).getTime();
      if (opTs <= recordTs) {
        merged.push(toInsert[qIdx]);
        qIdx++;
      } else {
        break;
      }
    }
    merged.push(record);
  }

  // Append any remaining queue ops after the last chain record
  while (qIdx < toInsert.length) {
    merged.push(toInsert[qIdx]);
    qIdx++;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Public API: map JSONL records to AgendoEventPayload[]
// ---------------------------------------------------------------------------

/**
 * Map an ordered array of RawRecord objects (from readClaudeJsonl()) to
 * AgendoEventPayload[]. Preserves the full content structure from the JSONL.
 *
 * Note: AgendoEventPayload does not carry a top-level `ts` field — timestamps
 * live in the session log envelope added by worker-sse.ts. The richer record
 * data (timestamps, model, stop_reason) improves content fidelity but the
 * payload shape remains the same as mapClaudeSessionMessages().
 */
export function mapClaudeJsonlToEvents(
  records: ReadonlyArray<RawRecord | RawQueueOperationRecord>,
): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];

  // Build a map of tool_use_id → tool_result content for pairing.
  // Tool results appear in user records with content array containing
  // tool_result blocks.
  const toolResults = new Map<string, string>();
  for (const record of records) {
    if (record.type !== 'user') continue;
    const content = record.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type: string }>) {
      if (block.type === 'tool_result') {
        const tr = block as unknown as ToolResultBlock;
        toolResults.set(
          tr.tool_use_id,
          typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        );
      }
    }
  }

  for (const record of records) {
    if (record.type === 'user') {
      events.push(...mapJsonlUserRecord(record));
    } else if (record.type === 'assistant') {
      events.push(...mapJsonlAssistantRecord(record, toolResults));
    } else if (record.type === 'queue-operation') {
      events.push(...mapQueueOperationRecord(record));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// JSONL-specific mapping helpers
// ---------------------------------------------------------------------------

function mapJsonlUserRecord(record: RawUserRecord): AgendoEventPayload[] {
  const content = record.message.content;

  // String content → simple text message
  if (typeof content === 'string') {
    const cleaned = stripPreamble(content);
    if (!cleaned) return [];
    return [{ type: 'user:message', text: cleaned }];
  }

  // Array content → could be text + image, or tool_result blocks
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; text?: string }>;

    // Skip tool_result user messages — they are paired with tool_use in assistant mapping
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (hasToolResult) return [];

    // Extract text and check for images
    const textParts: string[] = [];
    let hasImage = false;
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        hasImage = true;
      }
    }

    const text = stripPreamble(textParts.join('\n'));
    if (!text && !hasImage) return [];

    return [{ type: 'user:message', text, ...(hasImage ? { hasImage: true } : {}) }];
  }

  return [];
}

function mapQueueOperationRecord(record: RawQueueOperationRecord): AgendoEventPayload[] {
  if (record.operation === 'enqueue' && record.content) {
    const cleaned = stripPreamble(record.content);
    if (!cleaned) return [];
    return [{ type: 'user:message', text: cleaned }];
  }
  if (record.operation === 'dequeue') {
    return [{ type: 'user:message-dequeued' }];
  }
  // 'remove' operations could map to user:message-cancelled, but they lack
  // a clientId (required by the event type). Skip for now — the enqueue
  // event is the important one to show.
  return [];
}

function mapJsonlAssistantRecord(
  record: RawAssistantRecord,
  toolResults: Map<string, string>,
): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  const contentBlocks = (record.message.content ?? []) as ContentBlock[];

  let hasToolUse = false;

  for (const block of contentBlocks) {
    switch (block.type) {
      case 'thinking': {
        const thinking = block as ThinkingBlock;
        if (thinking.thinking) {
          events.push({ type: 'agent:thinking', text: thinking.thinking });
        }
        break;
      }

      case 'text': {
        const text = block as TextBlock;
        if (text.text) {
          events.push({ type: 'agent:text', text: text.text });
        }
        break;
      }

      case 'tool_use': {
        hasToolUse = true;
        const tool = block as ToolUseBlock;
        events.push(buildToolStartEvent(tool.id, tool.name, tool.input));

        // Pair with tool_result if available
        const result = toolResults.get(tool.id);
        if (result !== undefined) {
          events.push(buildToolEndEvent(tool.id, result));
        }
        break;
      }

      // Skip unknown block types
      default:
        break;
    }
  }

  // Emit agent:result after each assistant turn (unless it was a pure tool_use
  // turn — the result will come after the tool results are processed)
  if (!hasToolUse || contentBlocks.some((b) => b.type === 'text')) {
    events.push({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public API: SDK-style fallback (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Map an array of SessionMessage objects (from getSessionMessages()) to
 * AgendoEventPayload[]. The output can be used directly by worker-sse.ts
 * to send catchup events to a reconnecting browser.
 *
 * This is the legacy path. Prefer readClaudeJsonl() + mapClaudeJsonlToEvents()
 * when the cwd is available — it is ~90x faster and preserves timestamps.
 */
export function mapClaudeSessionMessages(messages: unknown[]): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];

  // Build a map of tool_use_id → tool_result content for pairing
  const toolResults = new Map<string, string>();
  for (const raw of messages) {
    const msg = raw as SessionMessage;
    if (msg.type !== 'user') continue;
    const content = (msg.message as { content: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type: string }>) {
      if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock;
        toolResults.set(
          tr.tool_use_id,
          typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        );
      }
    }
  }

  for (const raw of messages) {
    const msg = raw as SessionMessage;

    if (msg.type === 'user') {
      const userEvents = mapSdkUserMessage(msg);
      events.push(...userEvents);
    } else if (msg.type === 'assistant') {
      const assistantEvents = mapSdkAssistantMessage(msg, toolResults);
      events.push(...assistantEvents);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// SDK-style mapping helpers (unchanged from original)
// ---------------------------------------------------------------------------

function mapSdkUserMessage(msg: SessionMessage): AgendoEventPayload[] {
  const msgBody = msg.message as { role: string; content: unknown };
  const content = msgBody.content;

  // String content → simple text message
  if (typeof content === 'string') {
    const cleaned = stripPreamble(content);
    if (!cleaned) return [];
    return [{ type: 'user:message', text: cleaned }];
  }

  // Array content → could be text + image, or tool_result blocks
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; text?: string }>;

    // Skip tool_result user messages — they are paired with tool_use in assistant mapping
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (hasToolResult) return [];

    // Extract text and check for images
    const textParts: string[] = [];
    let hasImage = false;
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        hasImage = true;
      }
    }

    const text = stripPreamble(textParts.join('\n'));
    if (!text && !hasImage) return [];

    return [{ type: 'user:message', text, ...(hasImage ? { hasImage: true } : {}) }];
  }

  return [];
}

function mapSdkAssistantMessage(
  msg: SessionMessage,
  toolResults: Map<string, string>,
): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  const msgBody = msg.message as { content?: unknown[] };
  const contentBlocks = (msgBody.content ?? []) as ContentBlock[];

  let hasToolUse = false;

  for (const block of contentBlocks) {
    switch (block.type) {
      case 'thinking': {
        const thinking = block as ThinkingBlock;
        if (thinking.thinking) {
          events.push({ type: 'agent:thinking', text: thinking.thinking });
        }
        break;
      }

      case 'text': {
        const text = block as TextBlock;
        if (text.text) {
          events.push({ type: 'agent:text', text: text.text });
        }
        break;
      }

      case 'tool_use': {
        hasToolUse = true;
        const tool = block as ToolUseBlock;
        events.push(buildToolStartEvent(tool.id, tool.name, tool.input));

        // Pair with tool_result if available
        const result = toolResults.get(tool.id);
        if (result !== undefined) {
          events.push(buildToolEndEvent(tool.id, result));
        }
        break;
      }

      // Skip unknown block types
      default:
        break;
    }
  }

  // Emit agent:result after each assistant turn (unless it was a pure tool_use
  // turn — the result will come after the tool results are processed)
  if (!hasToolUse || contentBlocks.some((b) => b.type === 'text')) {
    events.push({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });
  }

  return events;
}
