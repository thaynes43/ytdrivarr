import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { createApp } from './app';

/**
 * The operator console mount (DESIGN-045 D-20/D-21): the static shell is served openly (it
 * carries no data), the assets come from the REAL build pipeline, traversal is refused, and the
 * API stays exactly as guarded as before the console existed.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let app: Hono;
let assetDir: string;

beforeAll(() => {
  assetDir = mkdtempSync(join(tmpdir(), 'ytdrivarr-console-'));
  // Run the actual console build so these tests cover the shipped pipeline, not fixtures.
  execFileSync(process.execPath, [join(repoRoot, 'scripts', 'build-console.mjs'), assetDir], {
    stdio: 'pipe',
  });
  app = createApp({ apiKeys: ['test-key'], consoleDir: assetDir });
});

describe('operator console shell', () => {
  it('serves the SPA shell at / without auth (the shell carries no data)', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('ytdrivarr');
    expect(html).toContain('/ui/console.js');
    expect(html).toContain('/ui/console.css');
  });

  it('serves the bundled JS with the right content type', async () => {
    const res = await app.request('/ui/console.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1000);
    // the SPA fetches with the *arr auth idiom
    expect(body).toContain('x-api-key');
  });

  it('serves the stylesheet and favicon', async () => {
    const css = await app.request('/ui/console.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const svg = await app.request('/ui/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
  });

  it('404s unknown assets, unknown extensions, and traversal attempts', async () => {
    expect((await app.request('/ui/nope.js')).status).toBe(404);
    expect((await app.request('/ui/console.wasm')).status).toBe(404);
    expect((await app.request('/ui/../package.json')).status).toBe(404);
    expect((await app.request('/ui/%2E%2E%2Fpackage.json')).status).toBe(404);
    expect((await app.request('/ui/..%2Fpackage.json')).status).toBe(404);
  });

  it('leaves the API exactly as guarded as before the console existed', async () => {
    expect((await app.request('/api/v1/sources')).status).toBe(401);
    expect((await app.request('/api/v1/providers')).status).toBe(401);
    // /health stays the open liveness/health surface
    expect((await app.request('/livez')).status).toBe(200);
  });

  it('serves an honest fallback page when the assets are not built', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ytdrivarr-noassets-'));
    const bare = createApp({ apiKeys: ['test-key'], consoleDir: empty });
    const res = await bare.request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('not built');
    expect(html).toContain('/openapi.json');
  });
});
