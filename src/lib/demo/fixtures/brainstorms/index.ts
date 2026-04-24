/**
 * Barrel export for brainstorm fixture arcs.
 *
 * DEMO_BRAINSTORM_ROOMS maps roomId → event arc, consumed by the demo SSE
 * route branch (Phase 2D) to replay brainstorm events.
 */

import type { BrainstormReplayableEvent } from './room-1';
import { room1Events } from './room-1';
import { DEMO_BRAINSTORM_ROOM_ID } from '@/lib/services/brainstorm-service.demo';

export { room1Events } from './room-1';
export type { BrainstormReplayableEvent } from './room-1';

export const DEMO_BRAINSTORM_ROOMS: Record<string, BrainstormReplayableEvent[]> = {
  [DEMO_BRAINSTORM_ROOM_ID]: room1Events,
};
