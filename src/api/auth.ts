import type { MiddlewareHandler } from 'hono';

/**
 * D-21 — a SINGLE API key guards the API (the *arr `X-Api-Key` idiom; no user management). Keys are
 * comma-separated in `YTDRIVARR_API_KEYS` for rotation. With no keys configured the API is locked
 * (deny-by-default); haynesnetwork holds one key via ESO and calls the service server-side.
 */
export function apiKeyAuth(validKeys: readonly string[]): MiddlewareHandler {
  const keys = new Set(validKeys);
  return async (c, next) => {
    const provided = c.req.header('x-api-key');
    if (keys.size === 0 || !provided || !keys.has(provided)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
    return;
  };
}

/** A stable label for the calling key, recorded in machine-level audit (D-08) — never a member. */
export function apiKeyLabel(c: { req: { header(name: string): string | undefined } }): string {
  const key = c.req.header('x-api-key');
  if (!key) return 'api';
  // A short non-reversible-ish tag so audit rows don't carry the raw key.
  return `key:${key.slice(0, 4)}…${key.slice(-2)}`;
}
