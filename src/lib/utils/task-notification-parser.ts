// ---------------------------------------------------------------------------
// Parser — extracts <task-notification> XML from assistant text
// ---------------------------------------------------------------------------

export interface TaskNotification {
  taskId: string;
  toolUseId: string;
  outputFile: string;
  status: string;
  summary: string;
  result: string;
  usage: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  } | null;
  worktree: {
    path: string;
    branch: string;
  } | null;
}

const TASK_NOTIFICATION_RE = /<task-notification>\s*([\s\S]*?)\s*<\/task-notification>/g;

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function parseNotification(xml: string): TaskNotification {
  const totalTokens = parseInt(extractTag(xml, 'total_tokens'), 10);
  const toolUses = parseInt(extractTag(xml, 'tool_uses'), 10);
  const durationMs = parseInt(extractTag(xml, 'duration_ms'), 10);
  const worktreePath = extractTag(xml, 'worktreePath');
  const worktreeBranch = extractTag(xml, 'worktreeBranch');

  return {
    taskId: extractTag(xml, 'task-id'),
    toolUseId: extractTag(xml, 'tool-use-id'),
    outputFile: extractTag(xml, 'output-file'),
    status: extractTag(xml, 'status'),
    summary: extractTag(xml, 'summary'),
    result: extractTag(xml, 'result'),
    usage: !isNaN(totalTokens)
      ? {
          totalTokens,
          toolUses: isNaN(toolUses) ? 0 : toolUses,
          durationMs: isNaN(durationMs) ? 0 : durationMs,
        }
      : null,
    worktree: worktreePath ? { path: worktreePath, branch: worktreeBranch } : null,
  };
}

/** Check if text contains task notifications */
export function hasTaskNotifications(text: string): boolean {
  return /<task-notification>/.test(text);
}

export interface TextSegment {
  kind: 'text';
  content: string;
}

export interface NotificationSegment {
  kind: 'notification';
  notification: TaskNotification;
}

export type ParsedSegment = TextSegment | NotificationSegment;

/**
 * Split text into alternating text/notification segments.
 * Text before, between, and after notifications is preserved.
 */
export function parseTaskNotifications(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let lastIndex = 0;

  // Reset regex state
  TASK_NOTIFICATION_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TASK_NOTIFICATION_RE.exec(text)) !== null) {
    // Text before this notification
    const before = text.slice(lastIndex, match.index).trim();
    if (before) {
      segments.push({ kind: 'text', content: before });
    }

    segments.push({
      kind: 'notification',
      notification: parseNotification(match[1]),
    });

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last notification
  const after = text.slice(lastIndex).trim();
  if (after) {
    segments.push({ kind: 'text', content: after });
  }

  return segments;
}
