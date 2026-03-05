import { createSession, type CreateSessionInput } from './session-service';
import { enqueueSession, type RunSessionJobData } from '../worker/queue';
import type { Session } from '../types';

interface CreateAndEnqueueSessionOpts extends CreateSessionInput {
  /** Called after createSession but before enqueueSession. Use to link session to other entities. */
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
  await enqueueSession({ sessionId: session.id, ...enqueueOpts });
  return session;
}
