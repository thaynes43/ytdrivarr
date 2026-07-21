import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { bootTestDb, type TestDb } from '../testing/db';
import { parsePelotonSubscriptions, applyPelotonImport } from './import-peloton';
import { getLibrary } from '../domain/libraries';
import { listSources } from '../domain/sources';
import { listEntriesForSource } from '../domain/entries';
import { runDiscovery } from './discovery';
import type { Library, Source } from '../db/schema';

/**
 * End-to-end proof that the emit window shrinks the PROJECTED FILE ON DISK through the real
 * orchestrator (`runDiscovery` → recompose → project), and that windowed-out rows keep their
 * immutable numbering (windowing is emission-only; the ledger is untouched). Uses the 229-entry
 * estate live file seeded into embedded Postgres, then back-dates a subset's `created_at`
 * (first-seen) past the window.
 */

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../testing/fixtures/estate-peloton-subscriptions.yaml', import.meta.url)),
  'utf8',
);

function countEntries(block: Record<string, Record<string, unknown>>): number {
  return Object.values(block).reduce((n, group) => n + Object.keys(group).length, 0);
}

describe('emit window — the projected subscriptions.yaml shrinks to the windowed set (embedded PG)', () => {
  let t: TestDb;
  let lib: Library;
  let src: Source;

  beforeAll(async () => {
    t = await bootTestDb();
    process.env.DATABASE_URL = t.connectionString;
    const parsed = parsePelotonSubscriptions(FIXTURE);
    await applyPelotonImport(parsed, { apiKeyId: 'test', db: t.db });
    const sources = await listSources(t.db);
    src = sources.find((s) => s.providerId === 'peloton') as Source;
    lib = (await getLibrary(src.libraryId, t.db)) as Library;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    delete process.env.DATABASE_URL;
  });

  it('drops entries first-seen outside the window from the FILE, keeps their rows + numbering in the DB', async () => {
    const projectionRoot = await mkdtemp(join(tmpdir(), 'ytdrivarr-window-'));
    const subsPath = join(projectionRoot, lib.projectionPath, 'subscriptions.yaml');

    const seeded = await listEntriesForSource(src.id, t.db);
    expect(seeded).toHaveLength(229);

    // Back-date every even-episode class 30 days (past the 15-day window). Capture one to prove its
    // numbering is untouched after it is windowed OUT.
    const backdate = await t.pool.query(
      "UPDATE subscription_entries SET created_at = now() - interval '30 days' WHERE episode_number % 2 = 0",
    );
    const staleCount = backdate.rowCount ?? 0;
    expect(staleCount).toBeGreaterThan(0);
    const staleSample = seeded.find((r) => r.episodeNumber !== null && r.episodeNumber % 2 === 0)!;
    const staleOriginalEpisode = staleSample.episodeNumber;

    // 1) Window ON (15d): the stale, back-dated classes drop from the projected file.
    await runDiscovery({
      scope: 'library',
      scopeRef: lib.id,
      emitWindowDays: 15,
      projectionRoot,
      db: t.db,
    });
    const windowed = parse(await readFile(subsPath, 'utf8')) as Record<string, unknown>;
    const windowedCount = countEntries(
      windowed['Plex TV Show by Date'] as Record<string, Record<string, unknown>>,
    );
    expect(windowedCount).toBe(229 - staleCount);

    // the ledger row + its immutable numbering survive (windowing is emission-only).
    const afterRows = await listEntriesForSource(src.id, t.db);
    expect(afterRows).toHaveLength(229);
    const afterStale = afterRows.find((r) => r.entryKey === staleSample.entryKey)!;
    expect(afterStale.episodeNumber).toBe(staleOriginalEpisode);

    // 2) The escape hatch (0 = unbounded): the whole 229-entry ledger projects again.
    await runDiscovery({
      scope: 'library',
      scopeRef: lib.id,
      emitWindowDays: 0,
      projectionRoot,
      db: t.db,
    });
    const unbounded = parse(await readFile(subsPath, 'utf8')) as Record<string, unknown>;
    const unboundedCount = countEntries(
      unbounded['Plex TV Show by Date'] as Record<string, Record<string, unknown>>,
    );
    expect(unboundedCount).toBe(229);

    await rm(projectionRoot, { recursive: true, force: true });
  }, 60_000);
});
