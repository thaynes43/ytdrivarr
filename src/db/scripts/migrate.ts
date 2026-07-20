import { runMigrations } from '../migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required to run migrations');
  process.exit(1);
}

await runMigrations({ databaseUrl: url });
console.log('ytdrivarr: migrations applied');
