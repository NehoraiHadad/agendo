/**
 * In-memory file contention registry.
 *
 * Tracks which files each active session is modifying and detects overlaps.
 * Severity: same branch = critical (overwrite risk), different branch = warning (merge conflict risk).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionFileState {
  sessionId: string;
  agentName: string;
  agentSlug: string;
  branch: string;
  taskTitle?: string;
  files: Set<string>; // absolute paths of modified + staged files
}

export interface ContentionAlert {
  conflictingFiles: string[];
  severity: 'warning' | 'critical';
  sessions: Array<{
    sessionId: string;
    agentName: string;
    agentSlug: string;
    branch: string;
    taskTitle?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

const activeSessionFiles = new Map<string, SessionFileState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or update) the set of files a session is currently modifying.
 * Returns a ContentionAlert if the new state overlaps with any other session,
 * or null if there is no contention.
 */
export function registerSessionFiles(state: SessionFileState): ContentionAlert | null {
  activeSessionFiles.set(state.sessionId, state);
  return checkContention(state.sessionId);
}

/**
 * Remove a session from the registry (call on session end).
 */
export function deregisterSession(sessionId: string): void {
  activeSessionFiles.delete(sessionId);
}

/**
 * Check whether the given session has file overlaps with any other active session.
 * Returns a ContentionAlert describing all conflicting files and involved sessions,
 * or null if there is no contention.
 */
export function checkContention(sessionId: string): ContentionAlert | null {
  const current = activeSessionFiles.get(sessionId);
  if (!current || current.files.size === 0) return null;

  const conflictingFiles = new Set<string>();
  const involvedSessionIds = new Set<string>();
  let severity: 'warning' | 'critical' = 'warning';

  for (const [otherId, other] of activeSessionFiles) {
    if (otherId === sessionId) continue;

    for (const file of current.files) {
      if (other.files.has(file)) {
        conflictingFiles.add(file);
        involvedSessionIds.add(otherId);

        if (current.branch === other.branch) {
          severity = 'critical';
        }
      }
    }
  }

  if (conflictingFiles.size === 0) return null;

  // Include the current session in the list
  involvedSessionIds.add(sessionId);

  const sessions = [...involvedSessionIds].flatMap((id) => {
    const s = activeSessionFiles.get(id);
    if (!s) return [];
    return {
      sessionId: s.sessionId,
      agentName: s.agentName,
      agentSlug: s.agentSlug,
      branch: s.branch,
      ...(s.taskTitle != null ? { taskTitle: s.taskTitle } : {}),
    };
  });

  return {
    conflictingFiles: [...conflictingFiles].sort(),
    severity,
    sessions,
  };
}

/**
 * Clear the entire registry. Exposed for testing only.
 */
export function clearRegistry(): void {
  activeSessionFiles.clear();
}
