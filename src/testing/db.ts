import { createDb, type Database } from '../db';
import { runMigrations } from '../db/migrate';
import { startPostgres } from './postgres';
import type { Pool } from 'pg';

export interface TestDb {
  db: Database;
  pool: Pool;
  connectionString: string;
  stop: () => Promise<void>;
}

/** Boot an embedded Postgres 16, apply all migrations, return a Drizzle client bound to it. */
export async function bootTestDb(): Promise<TestDb> {
  const pg = await startPostgres();
  await runMigrations({ databaseUrl: pg.connectionString });
  const { db, pool } = createDb(pg.connectionString);
  return {
    db,
    pool,
    connectionString: pg.connectionString,
    stop: async () => {
      await pool.end();
      await pg.stop();
    },
  };
}
