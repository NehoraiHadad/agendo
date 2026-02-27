import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { inArray } from 'drizzle-orm';
import { decodeDirName } from './decode-dir';
import type { CliSessionEntry } from './types';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** How many bytes from the start of a JSONL file to read for metadata */
const HEAD_BYTES = 8192;

interface DiscoverOpts {
  hideImported?: boolean;
}

/**
 * Discover Claude CLI sessions from ~/.claude/projects.
 * Only reads the first ~8KB of each JSONL file for speed.
 */
export async function discoverCliSessions(opts?: DiscoverOpts): Promise<CliSessionEntry[]> {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const entries: CliSessionEntry[] = [];
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );

  for (const dir of projectDirs) {
    const projectPath = decodeDirName(dir.name);
    const dirPath = join(CLAUDE_PROJECTS_DIR, dir.name);

    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const jsonlPath = join(dirPath, file);
      const cliSessionId = file.replace('.jsonl', '');

      try {
        const entry = parseJsonlHead(cliSessionId, jsonlPath, projectPath);
        if (entry) entries.push(entry);
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Sort by modified desc
  entries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  // Flag already-imported sessions — batch in chunks of 500 to avoid SQL limit
  if (entries.length > 0) {
    const importedSet = new Set<string>();
    const allRefs = entries.map((e) => e.cliSessionId);
    for (let i = 0; i < allRefs.length; i += 500) {
      const chunk = allRefs.slice(i, i + 500);
      const rows = await db
        .select({ sessionRef: sessions.sessionRef })
        .from(sessions)
        .where(inArray(sessions.sessionRef, chunk));
      for (const r of rows) {
        if (r.sessionRef) importedSet.add(r.sessionRef);
      }
    }
    for (const entry of entries) {
      entry.alreadyImported = importedSet.has(entry.cliSessionId);
    }
  }

  if (opts?.hideImported) {
    return entries.filter((e) => !e.alreadyImported);
  }

  return entries;
}

/**
 * Read only the first HEAD_BYTES of a JSONL file to extract metadata.
 * Estimates message count from file size.
 */
function parseJsonlHead(
  cliSessionId: string,
  jsonlPath: string,
  projectPath: string,
): CliSessionEntry | null {
  const stat = statSync(jsonlPath);
  if (stat.size < 50) return null; // Too small to be useful

  // Read first chunk
  const buf = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
  const fd = openSync(jsonlPath, 'r');
  try {
    readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }

  const head = buf.toString('utf-8');
  // Only parse complete lines (drop the last partial line)
  const lines = head
    .split('\n')
    .slice(0, -1)
    .filter((l) => l.trim());

  if (lines.length === 0) return null;

  let firstPrompt: string | null = null;
  let gitBranch: string | null = null;
  let hasUserMessage = false;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      if (obj.type === 'user') hasUserMessage = true;

      if (!gitBranch && typeof obj.gitBranch === 'string') {
        gitBranch = obj.gitBranch;
      }

      if (!firstPrompt && obj.type === 'user') {
        const msg = obj.message as
          | { content?: string | Array<{ type: string; text?: string }> }
          | undefined;
        if (msg?.content) {
          if (typeof msg.content === 'string') {
            firstPrompt = msg.content;
          } else if (Array.isArray(msg.content)) {
            const textBlock = msg.content.find((b) => b.type === 'text' && b.text);
            if (textBlock?.text) firstPrompt = textBlock.text;
          }
        }
      }

      // Once we have all metadata we need, stop parsing
      if (firstPrompt && gitBranch) break;
    } catch {
      // Skip malformed lines
    }
  }

  // Skip files that don't seem to have a real conversation
  if (!hasUserMessage && stat.size < 5000) return null;

  // Estimate message count from file size (rough: ~2KB per message average)
  const estimatedMessages = Math.max(1, Math.round(stat.size / 2048));

  return {
    cliSessionId,
    agentType: 'claude',
    projectPath,
    summary: null,
    firstPrompt: firstPrompt ? firstPrompt.slice(0, 200) : null,
    messageCount: estimatedMessages,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    gitBranch,
    jsonlPath,
    alreadyImported: false,
  };
}
