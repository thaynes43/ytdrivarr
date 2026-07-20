import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = ReturnType<typeof drizzle<typeof schema>>;
/** A Drizzle transaction over this schema (the `tx` inside db.transaction()). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything a writer accepts as an executor: the base db, or an open transaction. */
export type DbClient = Database | Transaction;

/** Build a fresh Drizzle client + pool over an explicit connection string (tests, workers). */
export function createDb(connectionString: string): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

let _pool: Pool | undefined;
let _db: Database | undefined;

function getDefaultDb(): Database {
  if (!_db) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

/**
 * Lazy Drizzle client over a pg Pool created from DATABASE_URL on first property access — importing
 * `@/db` never connects at module load, so builds and unit tests that don't touch the DB need no
 * DATABASE_URL (the hnet idiom).
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    return Reflect.get(getDefaultDb(), prop, receiver);
  },
});

export function getDefaultPool(): Pool {
  void getDefaultDb();
  return _pool as Pool;
}

export * from './schema';
