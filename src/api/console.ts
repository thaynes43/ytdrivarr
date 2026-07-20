import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';

/**
 * The operator console (DESIGN-045 D-20) — a Fable-built, hash-routed vanilla-TS SPA in
 * `src/console/`, bundled by `scripts/build-console.mjs` into a flat static dir this module
 * serves. The console is a THIN VIEW over the same REST API: the static shell carries no data, so
 * it is served unauthenticated; every byte of data the SPA renders is fetched with `X-Api-Key`
 * (D-21). LAN-only reach is the deployment's job (internal ingress, D-17).
 */

const ASSET_NAME = /^[A-Za-z0-9._-]+$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Served when the asset dir is missing — an honest state, not a broken one. */
export const consoleFallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ytdrivarr</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
      code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <h1>ytdrivarr</h1>
    <p>The REST API is live, but the operator console assets are not built. Run
      <code>pnpm build</code> (or <code>node scripts/build-console.mjs</code>) and reload.</p>
    <ul>
      <li><a href="/health">/health</a> — service + per-source health</li>
      <li><a href="/openapi.json">/openapi.json</a> — the generated API spec</li>
    </ul>
  </body>
</html>
`;

/**
 * Resolve where the built console assets live. An explicit dir (tests) or the
 * `YTDRIVARR_CONSOLE_DIR` env override is authoritative; otherwise probe
 * `<bundle dir>/public` (the production layout — `dist/index.js` next to `dist/public/`) and
 * fall back to `<cwd>/dist/public` (the dev layout — `tsx` runs from src/).
 */
export function resolveConsoleDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.YTDRIVARR_CONSOLE_DIR) return process.env.YTDRIVARR_CONSOLE_DIR;
  const bundleAdjacent = join(dirname(fileURLToPath(import.meta.url)), 'public');
  if (existsSync(join(bundleAdjacent, 'index.html'))) return bundleAdjacent;
  return join(process.cwd(), 'dist', 'public');
}

/** Mount the console on the app: `/` → the SPA shell, `/ui/:file` → its flat static assets. */
export function registerConsole(app: Hono, explicitDir?: string): void {
  const dir = resolveConsoleDir(explicitDir);

  app.get('/', async (c) => {
    c.header('cache-control', 'no-store');
    try {
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      return c.html(html);
    } catch {
      return c.html(consoleFallbackHtml);
    }
  });

  app.get('/ui/:file', async (c) => {
    const name = c.req.param('file');
    if (!name || !ASSET_NAME.test(name) || name.includes('..')) {
      return c.notFound();
    }
    const ext = name.slice(name.lastIndexOf('.'));
    const type = CONTENT_TYPES[ext];
    if (!type) return c.notFound();
    try {
      const body = await readFile(join(dir, name));
      return c.body(new Uint8Array(body), 200, {
        'content-type': type,
        // not content-hashed, and browsers happily reuse memory-cached assets across visits —
        // no-store keeps operators on the console the image actually ships
        'cache-control': 'no-store',
      });
    } catch {
      return c.notFound();
    }
  });
}
