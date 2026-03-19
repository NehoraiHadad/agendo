'use server';

import type { DiscoveredTool } from '@/lib/discovery';
import { runDiscovery } from '@/lib/discovery';
import {
  getExistingSlugs,
  getExistingBinaryPaths,
  createFromDiscovery,
} from '@/lib/services/agent-service';
import type { Agent } from '@/lib/types';
import { withAction, type ActionResult } from './action-utils';

export const confirmTool: (tool: DiscoveredTool) => Promise<ActionResult<Agent>> = withAction(
  (tool: DiscoveredTool) => createFromDiscovery(tool),
  { revalidate: '/agents' },
);

export const triggerScan: (extraTargets?: string[]) => Promise<ActionResult<DiscoveredTool[]>> =
  withAction(async (extraTargets?: string[]) => {
    const [existingSlugs, existingBinaryPaths] = await Promise.all([
      getExistingSlugs(),
      getExistingBinaryPaths(),
    ]);
    const schemaTargets =
      extraTargets && extraTargets.length > 0 ? new Set(extraTargets) : undefined;
    return runDiscovery(schemaTargets, existingSlugs, existingBinaryPaths);
  });
