/**
 * CLI: import an existing ytdl-sub `subscriptions.yaml` into ytdrivarr Sources (DESIGN-045 D-19 M2
 * cutover). IDEMPOTENT — safe to re-run; a re-import updates in place and never duplicates. This is
 * the operator path that brings the ~80 estate YouTube channels in at cutover (the REST equivalent
 * is `POST /api/v1/import/ytdl-sub`). Requires DATABASE_URL. Prints the import summary as JSON.
 *
 * Usage:
 *   DATABASE_URL=postgres://… tsx scripts/import-subscriptions.ts \
 *     --file <path/to/subscriptions.yaml> \
 *     --video-library <libraryId> \
 *     [--music-library <libraryId>] \
 *     [--apply-preset] \
 *     [--music-chip Music]
 */
import { readFileSync } from 'node:fs';
import { parseSubscriptionsYaml, applyYtdlSubImport } from '../src/core/import-ytdl-sub';
import { getDefaultPool } from '../src/db';
import { logger } from '../src/logger';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function die(message: string): never {
  logger.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const file = arg('file');
  const videoLibraryId = arg('video-library');
  const musicLibraryId = arg('music-library');
  const musicChip = arg('music-chip');

  if (!file || !videoLibraryId) {
    die(
      'usage: --file <path> --video-library <id> [--music-library <id>] [--apply-preset] [--music-chip <chip>]',
    );
  }
  if (!process.env.DATABASE_URL) die('DATABASE_URL is required');

  const text = readFileSync(file, 'utf8');
  const parsed = parseSubscriptionsYaml(text, musicChip ? { musicChip } : {});
  const hasMusic = parsed.channels.some((c) => c.mediaKind === 'music');
  if (hasMusic && !musicLibraryId) {
    die('the file contains music channels but --music-library was not provided');
  }

  const summary = await applyYtdlSubImport(
    parsed,
    { videoLibraryId, ...(musicLibraryId ? { musicLibraryId } : {}) },
    { apiKeyId: 'cli:import', applyPreset: flag('apply-preset') },
  );

  process.stdout.write(
    `${JSON.stringify({ presetNames: parsed.presetNames, ...summary }, null, 2)}\n`,
  );
  await getDefaultPool().end();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'import failed');
  process.exit(1);
});
