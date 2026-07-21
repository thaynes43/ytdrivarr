/**
 * CLI: import the estate's LIVE Peloton `subscriptions.yaml` into ytdrivarr (DESIGN-045 D-19 M3
 * cutover). IDEMPOTENT — safe to re-run; a re-import upserts entries and never duplicates. Ensures
 * the Peloton Library + the single Peloton Source + all subscription entries (the REST equivalent is
 * a seed the operator runs once). Requires DATABASE_URL. Prints the import summary as JSON.
 *
 * Usage:
 *   DATABASE_URL=postgres://… tsx scripts/import-peloton.ts \
 *     --file <path/to/peloton-subscriptions.yaml> \
 *     [--working-directory /config]
 */
import { readFileSync } from 'node:fs';
import { parsePelotonSubscriptions, applyPelotonImport } from '../src/core/import-peloton';
import { getDefaultPool } from '../src/db';
import { logger } from '../src/logger';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function die(message: string): never {
  logger.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const file = arg('file');
  const workingDirectory = arg('working-directory');
  if (!file) die('usage: --file <path> [--working-directory <dir>]');
  if (!process.env.DATABASE_URL) die('DATABASE_URL is required');

  const text = readFileSync(file, 'utf8');
  const parsed = parsePelotonSubscriptions(text);
  const summary = await applyPelotonImport(parsed, {
    apiKeyId: 'cli:import',
    ...(workingDirectory ? { workingDirectory } : {}),
  });

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await getDefaultPool().end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'peloton import failed');
  process.exit(1);
});
