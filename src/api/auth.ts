import type { MiddlewareHandler } from 'hono';

/** How the API gate behaves (DESIGN-045 D-21, extended by the owner 2026-07-20 keyless-on-LAN ruling). */
export type AuthMode = 'api-key' | 'open';

/**
 * Is `provided` an acceptable `X-Api-Key`? Trims the presented value (a secret store or a paste can
 * carry a stray trailing newline/space) and — because `YTDRIVARR_API_KEYS` is itself a comma list —
 * accepts a client that pastes the WHOLE list verbatim as long as any one comma-segment is a known
 * key. This is the root-cause fix for "login failed even WITH a key": an operator copying the raw
 * secret value (`k1,k2`) exact-mismatched a set of individual keys, while a single key worked.
 */
export function keyAccepted(provided: string | undefined, validKeys: ReadonlySet<string>): boolean {
  if (!provided || validKeys.size === 0) return false;
  const trimmed = provided.trim();
  if (validKeys.has(trimmed)) return true;
  // Tolerate a pasted comma-list (the exact shape of YTDRIVARR_API_KEYS): any known segment passes.
  return trimmed.split(',').some((part) => {
    const k = part.trim();
    return k.length > 0 && validKeys.has(k);
  });
}

/**
 * D-21 — a SINGLE API key guards the API (the *arr `X-Api-Key` idiom; no user management). Keys are
 * comma-separated in `YTDRIVARR_API_KEYS` for rotation. Two gate modes (owner ruling 2026-07-20,
 * "Sonarr and Radarr do not need tokens"):
 *
 *  - `api-key` (default, for public reuse): every `/api/v1` request must present a known key; with
 *    no keys configured the API is locked (deny-by-default).
 *  - `open` (the estate deploy — safe because the ingress is LAN-only by design, D-17/D-21): NO key
 *    is required for any request, exactly like Sonarr's "Authentication: Disabled for Local
 *    Addresses". A presented key is still accepted (never rejected) so keyed clients — haynesnetwork
 *    via ESO, the out-of-process worker — keep working unchanged in either mode.
 */
export function apiKeyAuth(
  validKeys: readonly string[],
  mode: AuthMode = 'api-key',
): MiddlewareHandler {
  const keys = new Set(validKeys.map((k) => k.trim()).filter((k) => k.length > 0));
  return async (c, next) => {
    if (mode === 'open') {
      await next();
      return;
    }
    if (!keyAccepted(c.req.header('x-api-key'), keys)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
    return;
  };
}

/** A stable label for the calling key, recorded in machine-level audit (D-08) — never a member. */
export function apiKeyLabel(c: { req: { header(name: string): string | undefined } }): string {
  const key = c.req.header('x-api-key')?.trim();
  if (!key) return 'api';
  // A short non-reversible-ish tag so audit rows don't carry the raw key.
  return `key:${key.slice(0, 4)}…${key.slice(-2)}`;
}
