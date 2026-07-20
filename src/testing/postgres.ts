import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Tests run against a REAL embedded Postgres 16 binary (the hnet idiom — no Docker in this distro,
 * never a SQLite/MySQL substitution). Mirrors haynesnetwork's `@hnet/test-utils` `startPostgres`.
 */
export interface StartedPostgres {
  connectionString: string;
  stop: () => Promise<void>;
}

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const PG_DATABASE = 'ytdrivarr_test';
const START_ATTEMPTS = 3;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function startPostgres(): Promise<StartedPostgres> {
  let lastError: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const port = await getFreePort();
    const dataDir = await mkdtemp(join(tmpdir(), 'ytdrivarr-pg-'));
    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: PG_USER,
      password: PG_PASSWORD,
      port,
      persistent: false,
      onLog: () => {},
    });
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase(PG_DATABASE);
      let stopped = false;
      return {
        connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DATABASE}`,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await pg.stop();
          await rm(dataDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      lastError = err;
      try {
        await pg.stop();
      } catch {
        // best effort
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`embedded Postgres failed to start after ${START_ATTEMPTS} attempts`);
}
