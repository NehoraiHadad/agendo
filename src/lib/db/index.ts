import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { config } from '../config';

// In dev mode, Turbopack may re-evaluate this module on each request,
// creating new Pool instances and leaking connections. Cache on globalThis.
const globalForDb = globalThis as unknown as {
  __agendoPool?: Pool;
};

if (!globalForDb.__agendoPool) {
  globalForDb.__agendoPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
  });
}

const pool = globalForDb.__agendoPool;

export const db = drizzle(pool, { schema });
export { pool };
