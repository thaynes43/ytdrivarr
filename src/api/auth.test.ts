import { describe, expect, it } from 'vitest';
import { createApp } from './app';

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
});
