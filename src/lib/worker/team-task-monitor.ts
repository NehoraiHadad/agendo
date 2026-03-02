import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamTask {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

// ---------------------------------------------------------------------------
// TeamTaskMonitor
// ---------------------------------------------------------------------------

/**
 * Polls `~/.claude/tasks/{teamName}/` every `intervalMs` milliseconds.
 * Detects changes by comparing a JSON snapshot of all tasks.
 * Emits the full tasks array on any change.
 */
export class TeamTaskMonitor {
  private tasksDir: string;
  private lastSnapshot = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(teamName: string) {
    this.tasksDir = join(homedir(), '.claude', 'tasks', teamName);
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Synchronously read all task JSON files from the tasks directory.
   * Returns an empty array if the directory does not exist or cannot be read.
   * Skips malformed or non-JSON files gracefully.
   */
  readAllTasks(): TeamTask[] {
    if (!existsSync(this.tasksDir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(this.tasksDir) as string[];
    } catch {
      return [];
    }

    const tasks: TeamTask[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.json')) continue;

      const filePath = join(this.tasksDir, entry);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const obj = JSON.parse(raw) as Record<string, unknown>;
        tasks.push(this.parseTask(obj));
      } catch {
        // Malformed — skip
      }
    }
    return tasks;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  /**
   * Start polling the tasks directory every `intervalMs` milliseconds.
   * Calls `onUpdate` with the full tasks array whenever any change is detected.
   * Pre-existing state is snapshotted at start time — callback fires only on
   * subsequent changes.
   *
   * No-op if polling is already active.
   */
  startPolling(intervalMs: number, onUpdate: (tasks: TeamTask[]) => void): void {
    if (this.pollTimer !== null) return;

    // Take initial snapshot so we don't fire for pre-existing state.
    const initial = this.readAllTasks();
    this.lastSnapshot = JSON.stringify(initial);

    this.pollTimer = setInterval(() => {
      const tasks = this.readAllTasks();
      const snapshot = JSON.stringify(tasks);
      if (snapshot !== this.lastSnapshot) {
        this.lastSnapshot = snapshot;
        onUpdate(tasks);
      }
    }, intervalMs);
  }

  /**
   * Stop polling. Safe to call multiple times or when not polling.
   */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private parseTask(obj: Record<string, unknown>): TeamTask {
    return {
      id: typeof obj.id === 'string' ? obj.id : String(obj.id ?? ''),
      subject: typeof obj.subject === 'string' ? obj.subject : '',
      status: this.parseStatus(obj.status),
      owner: typeof obj.owner === 'string' ? obj.owner : undefined,
      blocks: Array.isArray(obj.blocks)
        ? (obj.blocks as unknown[]).filter((b) => typeof b === 'string')
        : [],
      blockedBy: Array.isArray(obj.blockedBy)
        ? (obj.blockedBy as unknown[]).filter((b) => typeof b === 'string')
        : [],
    };
  }

  private parseStatus(val: unknown): TeamTask['status'] {
    if (val === 'pending' || val === 'in_progress' || val === 'completed') return val;
    return 'pending';
  }
}
