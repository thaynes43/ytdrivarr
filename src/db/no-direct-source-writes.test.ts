import { describe, expect, it } from 'vitest';
import { readFileSync, globSync } from 'node:fs';

/**
 * Guard (the hnet doctrine, hard rule 6): the `sources` table is mutated ONLY through the audited
 * single-writer in `src/domain/sources.ts`. A `.insert/.update/.delete(sources)` anywhere else would
 * let a mutation land WITHOUT its same-transaction audit row — this dumb static scan fails the build
 * on any such reference outside the one allowed file. When you widen the perimeter, widen the guard.
 */
const ALLOWED = 'src/domain/sources.ts';
const FORBIDDEN = [
  /\.insert\(\s*sources\s*\)/,
  /\.update\(\s*sources\s*\)/,
  /\.delete\(\s*sources\s*\)/,
];

describe('no direct writes to the sources table (D-08 guard)', () => {
  it('finds no unguarded sources mutation outside the single-writer', () => {
    const files = globSync('src/**/*.ts').filter(
      (f) => f !== ALLOWED && !f.endsWith('.test.ts') && !f.startsWith('src/testing/'),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (FORBIDDEN.some((re) => re.test(content))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
