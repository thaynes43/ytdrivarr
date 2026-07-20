import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parse } from 'yaml';
import { projectLibrary, resolveProjectionDir } from './projection';
import { emitLibrary, type EmitLibrary } from './emitter';
import type { SubscriptionEntry } from '../contracts';

const library: EmitLibrary = {
  presetName: 'Plex TV Show by Date',
  workingDirectory: '/workdir/',
  emitPolicy: { overrides: { tv_show_directory: '/media/youtube' } },
  libraryKind: 'video',
};
const entries: SubscriptionEntry[] = [
  {
    entryKey: 'https://www.youtube.com/@a',
    displayName: 'A',
    downloadRef: 'https://www.youtube.com/@a',
    preset: 'Plex TV Show by Date',
    chip: 'Animation',
  },
];

describe('projectLibrary — atomic projection (D-14)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ytdrivarr-proj-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes complete, valid config.yaml + subscriptions.yaml (no partial reads)', async () => {
    const emitted = emitLibrary(library, entries);
    const result = await projectLibrary(dir, emitted);

    const config = await readFile(result.configPath, 'utf8');
    const subs = await readFile(result.subscriptionsPath, 'utf8');
    // Fully-parseable == complete file; a rename can never surface a half-written doc.
    expect(() => parse(config)).not.toThrow();
    expect(() => parse(subs)).not.toThrow();
    expect(subs).toContain('Plex TV Show by Date');
  });

  it('leaves NO temp files behind after projection', async () => {
    await projectLibrary(dir, emitLibrary(library, entries));
    const files = await readdir(dir);
    expect(files.sort()).toEqual(['config.yaml', 'subscriptions.yaml']);
    expect(files.some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('overwrites cleanly on re-projection', async () => {
    await projectLibrary(dir, emitLibrary(library, entries));
    const changed = emitLibrary(library, [{ ...entries[0]!, displayName: 'B', entryKey: 'k2' }]);
    await projectLibrary(dir, changed);
    const subs = await readFile(join(dir, 'subscriptions.yaml'), 'utf8');
    expect(subs).toContain('B');
    expect(subs).not.toContain('"A"');
    const files = await readdir(dir);
    expect(files.sort()).toEqual(['config.yaml', 'subscriptions.yaml']);
  });

  it('leaves a prior projected file intact when a new write cannot complete', async () => {
    const good = emitLibrary(library, entries);
    await projectLibrary(dir, good);
    const before = await readFile(join(dir, 'subscriptions.yaml'), 'utf8');
    // Make the config path un-writable by turning it into a directory so the next rename fails.
    await rm(join(dir, 'config.yaml'));
    await mkdir(join(dir, 'config.yaml'));
    await expect(projectLibrary(dir, good)).rejects.toBeDefined();
    // subscriptions.yaml (written first, successfully) is unchanged and still complete.
    const after = await readFile(join(dir, 'subscriptions.yaml'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('resolveProjectionDir', () => {
  it('passes absolute paths through and joins relative ones under the root', () => {
    expect(resolveProjectionDir('/abs/path')).toBe('/abs/path');
    const resolved = resolveProjectionDir('rel/path', '/root');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toContain('rel/path');
  });
});
