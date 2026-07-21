import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { keyAccepted } from './auth';

/**
 * D-21 — the single API key guards the API. Uses a route that never touches the DB (/providers reads
 * the registry) so the auth boundary is tested in isolation.
 */
describe('X-Api-Key auth (D-21)', () => {
  const app = createApp({ apiKeys: ['secret-key'] });

  it('401s a guarded route with no key', async () => {
    const res = await app.request('/api/v1/providers');
    expect(res.status).toBe(401);
  });

  it('401s a guarded route with the wrong key', async () => {
    const res = await app.request('/api/v1/providers', { headers: { 'x-api-key': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('200s a guarded route with the right key', async () => {
    const res = await app.request('/api/v1/providers', { headers: { 'x-api-key': 'secret-key' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.some((p) => p.id === 'in-core-url-list')).toBe(true);
  });

  it('leaves open endpoints reachable without a key', async () => {
    expect((await app.request('/livez')).status).toBe(200);
    expect((await app.request('/openapi.json')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
  });

  it('locks everything when no keys are configured (deny-by-default)', async () => {
    const locked = createApp({ apiKeys: [] });
    const res = await locked.request('/api/v1/providers', { headers: { 'x-api-key': 'anything' } });
    expect(res.status).toBe(401);
  });

  it('defaults to api-key mode when authMode is omitted (still 401s unauthenticated)', async () => {
    expect((await app.request('/api/v1/providers')).status).toBe(401);
  });
});

/**
 * AUTH_MODE matrix (owner ruling 2026-07-20 — "Sonarr and Radarr do not need tokens"). `open` is the
 * keyless-on-LAN gate: no key is required for any request, yet a presented key is never rejected so
 * keyed clients (haynesnetwork via ESO, the worker) keep working. `api-key` is the default.
 */
describe('AUTH_MODE gate', () => {
  it('open: an UNAUTHENTICATED guarded route returns 200 (no key required)', async () => {
    const open = createApp({ apiKeys: ['secret-key'], authMode: 'open' });
    expect((await open.request('/api/v1/providers')).status).toBe(200);
  });

  it('open: a VALID presented key still returns 200 (haynesnetwork keeps sending one)', async () => {
    const open = createApp({ apiKeys: ['secret-key'], authMode: 'open' });
    const res = await open.request('/api/v1/providers', { headers: { 'x-api-key': 'secret-key' } });
    expect(res.status).toBe(200);
  });

  it('open: even a WRONG/stale key is not rejected (no wedge)', async () => {
    const open = createApp({ apiKeys: ['secret-key'], authMode: 'open' });
    const res = await open.request('/api/v1/providers', { headers: { 'x-api-key': 'stale' } });
    expect(res.status).toBe(200);
  });

  it('open: works even with no keys configured at all', async () => {
    const open = createApp({ apiKeys: [], authMode: 'open' });
    expect((await open.request('/api/v1/providers')).status).toBe(200);
  });

  it('api-key: an UNAUTHENTICATED guarded route returns 401', async () => {
    const gated = createApp({ apiKeys: ['secret-key'], authMode: 'api-key' });
    expect((await gated.request('/api/v1/providers')).status).toBe(401);
  });

  it('api-key: a VALID key returns 200', async () => {
    const gated = createApp({ apiKeys: ['secret-key'], authMode: 'api-key' });
    const res = await gated.request('/api/v1/providers', {
      headers: { 'x-api-key': 'secret-key' },
    });
    expect(res.status).toBe(200);
  });
});

/**
 * Presented-key hardening — the root-cause fix for "login failed even WITH a key". `keyAccepted`
 * trims the presented value and, because `YTDRIVARR_API_KEYS` is itself a comma list, accepts the
 * WHOLE list pasted verbatim (any known segment). A single key always worked; the joined raw secret
 * did not. Unit-tested directly so it never depends on how the HTTP layer normalizes header OWS.
 */
describe('keyAccepted — trim + comma-list tolerance', () => {
  const keys = new Set(['key-one', 'key-two']);

  it('accepts an exact single key', () => {
    expect(keyAccepted('key-one', keys)).toBe(true);
  });

  it('accepts a key with surrounding whitespace / a trailing newline (paste-trim)', () => {
    expect(keyAccepted('  key-one  ', keys)).toBe(true);
    expect(keyAccepted('key-two\n', keys)).toBe(true);
    expect(keyAccepted('\tkey-one', keys)).toBe(true);
  });

  it('accepts the FULL comma-list value pasted verbatim (the raw secret)', () => {
    expect(keyAccepted('key-one,key-two', keys)).toBe(true);
    expect(keyAccepted('key-one, key-two', keys)).toBe(true);
    expect(keyAccepted(' key-two ,nope', keys)).toBe(true);
  });

  it('rejects a wrong key, empty input, and an empty key set', () => {
    expect(keyAccepted('nope', keys)).toBe(false);
    expect(keyAccepted('', keys)).toBe(false);
    expect(keyAccepted(undefined, keys)).toBe(false);
    expect(keyAccepted('key-one', new Set())).toBe(false);
  });

  it('is exercised end-to-end: a comma-list header is accepted through the app', async () => {
    const app = createApp({ apiKeys: ['key-one', 'key-two'] });
    const res = await app.request('/api/v1/providers', {
      headers: { 'x-api-key': 'key-one,key-two' },
    });
    expect(res.status).toBe(200);
  });
});
