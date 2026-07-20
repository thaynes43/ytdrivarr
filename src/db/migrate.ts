import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';

/**
 * The SQL migrations ship uncompiled next to the app (Dockerfile COPY migrations). Resolve the
 * folder from cwd so it works both in dev (repo root) and in the image (WORKDIR /app), overridable
 * via YTDRIVARR_MIGRATIONS_DIR.
 */
export function defaultMigrationsFolder(): string {
  return process.env.YTDRIVARR_MIGRATIONS_DIR ?? join(process.cwd(), 'migrations');
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsFolder?: string;
}

/**
 * Apply the drizzle migrations. Idempotent: already-applied migrations (tracked in
 * drizzle.__drizzle_migrations) are skipped. Runs on service boot (unless YTDRIVARR_SKIP_MIGRATE),
 * and in tests via the embedded-Postgres harness.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder();
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}
