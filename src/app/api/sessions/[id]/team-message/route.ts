/**
 * POST /api/sessions/[id]/team-message
 *
 * Send a message from the Agendo UI to a specific teammate's inbox.
 * Reads the team config to find the inbox path, then atomically appends
 * the message to the JSON array using a tmp-file + rename pattern to prevent
 * corruption if Claude Code is concurrently reading/writing the same file.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getSession } from '@/lib/services/session-service';
import { TeamInboxMonitor } from '@/lib/worker/team-inbox-monitor';
import { BadRequestError, NotFoundError } from '@/lib/errors';

interface InboxMessage {
  from: string;
  text: string;
  summary: string;
  timestamp: string;
  color: string;
}

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = (await req.json()) as { recipient?: string; text?: string };
    const { recipient, text } = body;

    if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
      throw new BadRequestError('recipient is required');
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new BadRequestError('text is required');
    }

    const session = await getSession(id);
    if (!session.sessionRef) {
      throw new BadRequestError('Session has no sessionRef — cannot determine team');
    }

    // Find the team this session is leading
    const teamName = TeamInboxMonitor.findTeamForSession(session.sessionRef);
    if (!teamName) {
      throw new NotFoundError('Team', session.sessionRef);
    }

    // Build the inbox file path
    const inboxPath = join(homedir(), '.claude', 'teams', teamName, 'inboxes', `${recipient}.json`);

    // Ensure the inboxes directory exists
    mkdirSync(dirname(inboxPath), { recursive: true });

    // Read current inbox (handle missing file gracefully)
    let messages: InboxMessage[] = [];
    if (existsSync(inboxPath)) {
      try {
        const raw = readFileSync(inboxPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          messages = parsed as InboxMessage[];
        }
      } catch {
        // File exists but is malformed — start fresh to avoid corruption
        messages = [];
      }
    }

    // Append new message
    const newMessage: InboxMessage = {
      from: 'team-lead',
      text: text.trim(),
      summary: text.trim().slice(0, 60),
      timestamp: new Date().toISOString(),
      color: '',
    };
    messages.push(newMessage);

    // Atomic write: write to tmp file then rename
    const tmpPath = join(dirname(inboxPath), `.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(messages, null, 2), 'utf-8');
    // rename is atomic on POSIX (same filesystem)
    // Node's fs.renameSync is atomic on Linux when src/dst are on the same filesystem
    const { renameSync } = await import('node:fs');
    renameSync(tmpPath, inboxPath);

    return NextResponse.json({ ok: true });
  },
);
