import { db } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { requireFound } from '@/lib/api-handler';
import {
  sessions,
  tasks,
  agents,
  brainstormRooms,
  contextSnapshots,
  agentWorkspaces,
  plans,
  projects,
} from '@/lib/db/schema';
import type {
  Session,
  Task,
  Agent,
  BrainstormRoom,
  ContextSnapshot,
  AgentWorkspace,
  Plan,
  Project,
} from '@/lib/types';

// Table → return type map for type-safe getById lookups.
// Add entries here as more services adopt the helper.
type TableMap = {
  sessions: { table: typeof sessions; result: Session };
  tasks: { table: typeof tasks; result: Task };
  agents: { table: typeof agents; result: Agent };
  brainstormRooms: { table: typeof brainstormRooms; result: BrainstormRoom };
  contextSnapshots: { table: typeof contextSnapshots; result: ContextSnapshot };
  agentWorkspaces: { table: typeof agentWorkspaces; result: AgentWorkspace };
  plans: { table: typeof plans; result: Plan };
  projects: { table: typeof projects; result: Project };
};

type TableEntry = TableMap[keyof TableMap];
type AnyMappedTable = TableEntry['table'];
type ResultFor<T extends AnyMappedTable> = Extract<TableEntry, { table: T }>['result'];

/**
 * Generic single-row lookup by UUID primary key.
 *
 * Only use for the simple 3-line pattern:
 *   SELECT * FROM table WHERE id = $1 LIMIT 1 → requireFound
 *
 * If the lookup has extra conditions (isActive check, joins, etc.)
 * keep the hand-written query in the service file.
 */
export async function getById<T extends AnyMappedTable>(
  table: T,
  id: string,
  entityName: string,
): Promise<ResultFor<T>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tbl = table as any;
  const [row] = await db.select().from(tbl).where(eq(tbl.id, id)).limit(1);
  return requireFound(row, entityName, id) as ResultFor<T>;
}
