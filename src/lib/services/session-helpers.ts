import { createSession, type CreateSessionInput } from './session-service';
import { type RunSessionJobData } from './session-dispatch';
import { dispatchSession } from './session-dispatch';
import type { Session } from '../types';

interface CreateAndEnqueueSessionOpts extends CreateSessionInput {
  /** Called after createSession but before dispatchSession. Use to link session to other entities. */
  beforeEnqueue?: (session: Session) => Promise<void>;
  /** Extra enqueue options beyond sessionId. */
  enqueueOpts?: Omit<RunSessionJobData, 'sessionId'>;
}

export async function createAndEnqueueSession(opts: CreateAndEnqueueSessionOpts): Promise<Session> {
  const { beforeEnqueue, enqueueOpts, ...createOpts } = opts;
  const session = await createSession(createOpts);
  if (beforeEnqueue) {
    await beforeEnqueue(session);
  }
  await dispatchSession({ sessionId: session.id, ...enqueueOpts });
  return session;
}
