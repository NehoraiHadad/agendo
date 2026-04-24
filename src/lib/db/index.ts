import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { config } from '../config';

// In dev mode, Turbopack may re-evaluate this module on each request,
// creating new Pool instances and leaking connections. Cache on globalThis.
const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Returns a Proxy that throws loudly on any property access.
 * This is a safety net: in demo mode services should short-circuit before
 * reaching the DB layer. Any access here means a missing demo branch.
 */
function createDemoProxy(): Db {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      throw new Error(
        `[demo] DB accessed directly (property "${String(prop)}") — a service is missing its demo branch`,
      );
    },
  };
  return new Proxy({}, handler) as Db;
}

const globalForDb = globalThis as unknown as { __agendoPool?: Pool; __agendoDb?: Db };

function createRealDb(): Db {
  if (!globalForDb.__agendoPool) {
    globalForDb.__agendoPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
    });
  }
  return drizzle(globalForDb.__agendoPool, { schema });
}

if (!globalForDb.__agendoDb) {
  globalForDb.__agendoDb = isDemo ? createDemoProxy() : createRealDb();
}

export const db = globalForDb.__agendoDb;

// pool is undefined in demo mode; worker/seed never run in demo so the cast is safe.
export const pool = globalForDb.__agendoPool as Pool;
