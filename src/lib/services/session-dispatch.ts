import { sendSessionStart } from '@/lib/realtime/worker-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-dispatch');

/** Job data shape for dispatching a session to the worker. */
export interface RunSessionJobData {
  sessionId: string;
  resumeRef?: string;
  /** Claude JSONL UUID to pass as --resume-session-at (conversation branching). */
  resumeSessionAt?: string;
  /**
   * The message to send on cold resume. Passed via job data instead of
   * overwriting session.initialPrompt so the original first prompt is preserved
   * for the InitialPromptBanner in the UI.
   */
  resumePrompt?: string;
  /**
   * Client-generated UUID nonce for the resume message.
   * Passed through to the user:message SSE event so the frontend
   * dedup effect can clear the optimistic message / pill on cold-resume.
   */
  resumeClientId?: string;
  /**
   * When true, skip prepending the generateResumeContext block (task title +
   * progress notes). Used for mid-turn auto-resumes (worker/infra restart) where
   * the agent already has its full conversation history via resumeRef and only
   * needs a short "continue" nudge — not a redundant context dump.
   */
  skipResumeContext?: boolean;
}

/**
 * Dispatch a session to the worker via HTTP.
 *
 * POST worker:4102/sessions/:id/start → worker calls runSession() directly.
 * Throws if the HTTP call fails (worker unreachable).
 */
export async function dispatchSession(data: RunSessionJobData): Promise<void> {
  log.info({ sessionId: data.sessionId }, 'Dispatching session to worker via HTTP');
  const result = await sendSessionStart(data.sessionId, data);
  if (!result.ok) {
    throw new Error(`Failed to dispatch session ${data.sessionId} to worker`);
  }
}
