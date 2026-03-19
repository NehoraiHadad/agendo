'use server';

import { createAgent, updateAgent, deleteAgent } from '@/lib/services/agent-service';
import type { Agent } from '@/lib/types';
import { withAction, type ActionResult } from './action-utils';

interface CreateAgentInput {
  name: string;
  binaryPath: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
}

interface UpdateAgentInput {
  name?: string;
  workingDir?: string | null;
  envAllowlist?: string[];
  maxConcurrent?: number;
  isActive?: boolean;
  mcpEnabled?: boolean;
}

export const createAgentAction: (data: CreateAgentInput) => Promise<ActionResult<Agent>> =
  withAction((data: CreateAgentInput) => createAgent(data), { revalidate: '/agents' });

const _updateAgent = withAction(
  ({ id, data }: { id: string; data: UpdateAgentInput }) => updateAgent(id, data),
  { revalidate: '/agents' },
);

export async function updateAgentAction(
  id: string,
  data: UpdateAgentInput,
): Promise<ActionResult<Agent>> {
  return _updateAgent({ id, data });
}

export const deleteAgentAction: (id: string) => Promise<ActionResult<void>> = withAction(
  (id: string) => deleteAgent(id),
  { revalidate: '/agents' },
);
