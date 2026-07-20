import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootTestDb, type TestDb } from '../testing/db';
import { sources, sourceAudit } from '../db/schema';
import { createLibrary } from './libraries';
import { createSource, deleteSource, updateSource } from './sources';

/**
 * Audit-in-same-tx (DESIGN-045 D-08; hard rule 6 applied service-side): a Source mutation with no
 * audit row must be IMPOSSIBLE. Proven structurally — a trigger that raises on `source_audit` INSERT
 * rolls the whole mutation back.
 */
let t: TestDb;

async function makeLibrary() {
  return createLibrary({
    name: 'L',
    mediaRoot: '/media/youtube',
    projectionPath: '/tmp/proj',
    db: t.db,
  });
}

beforeAll(async () => {
  t = await bootTestDb();
});
afterAll(async () => {
  await t.stop();
});

describe('source single-writer audit', () => {
  it('writes a source_audit row in the same transaction as create/update/delete', async () => {
    const lib = await makeLibrary();
    const src = await createSource({
      libraryId: lib.id,
      providerId: 'in-core-url-list',
      kind: 'url-list',
      mediaKind: 'video',
      displayName: 'X',
      ref: 'https://www.youtube.com/@x',
      apiKeyId: 'key:test',
      db: t.db,
    });
    await updateSource({ id: src.id, patch: { displayName: 'Y' }, db: t.db });
    await deleteSource({ id: src.id, db: t.db });

    const audits = await t.db.select().from(sourceAudit).where(eq(sourceAudit.sourceId, src.id));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(['create', 'delete', 'update']);
    expect(audits.find((a) => a.action === 'create')?.apiKeyId).toBe('key:test');
  });

  it('rolls the source insert back when the audit insert fails (impossible to skip audit)', async () => {
    const lib = await makeLibrary();
    await t.pool.query(
      `CREATE OR REPLACE FUNCTION ytdrivarr_fail_audit() RETURNS trigger
       AS $$ BEGIN RAISE EXCEPTION 'audit blocked'; END; $$ LANGUAGE plpgsql;`,
    );
    await t.pool.query(
      `CREATE TRIGGER t_fail_audit BEFORE INSERT ON source_audit
       FOR EACH ROW EXECUTE FUNCTION ytdrivarr_fail_audit();`,
    );
    try {
      const before = (await t.db.select().from(sources)).length;
      await expect(
        createSource({
          libraryId: lib.id,
          providerId: 'in-core-url-list',
          kind: 'url-list',
          mediaKind: 'video',
          displayName: 'blocked',
          ref: 'https://www.youtube.com/@blocked',
          db: t.db,
        }),
      ).rejects.toThrow(/audit blocked/);
      const after = (await t.db.select().from(sources)).length;
      expect(after).toBe(before); // the source did NOT persist
    } finally {
      await t.pool.query('DROP TRIGGER t_fail_audit ON source_audit;');
    }
  });
});
