// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  chooseInitialScreen,
  clearApiKey,
  getApiKey,
  isOpenDeployment,
  setApiKey,
  UNAUTHORIZED_EVENT,
} from './api';

/**
 * The console's single data path (D-21): every request carries X-Api-Key; a 401 clears the stored
 * key and announces it so the shell drops back to key entry.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api()', () => {
  beforeEach(() => {
    setApiKey('secret-key');
  });
  afterEach(() => {
    clearApiKey();
    vi.unstubAllGlobals();
  });

  it('sends the stored key as X-Api-Key on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/v1/sources');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
  });

  it('clears the key and announces unauthorized on a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })));
    const listener = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, listener);

    await expect(api('/api/v1/sources')).rejects.toMatchObject({ status: 401 });
    expect(getApiKey()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  });

  it('surfaces the API error body message and details on non-401 failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: 'request body failed validation',
          details: [{ path: ['ref'] }],
        }),
      ),
    );

    const err = await api('/api/v1/sources', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('request body failed validation');
    expect((err as ApiError).details).toEqual([{ path: ['ref'] }]);
    expect(getApiKey()).toBe('secret-key'); // only a 401 clears the key
  });
});

/**
 * Gate-skip on boot (owner ruling 2026-07-20): probe a guarded route WITHOUT a key. A 200 means an
 * open (keyless, LAN-only) deployment — go straight to the shell, no key screen.
 */
describe('isOpenDeployment()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the unauthenticated probe answers 200 — and sends NO key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
    vi.stubGlobal('fetch', fetchMock);

    expect(await isOpenDeployment()).toBe(true);
    // Probed the guarded route with no init/headers at all — never depends on stored key state.
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/providers');
    expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('returns false when the probe is rejected (api-key deployment, 401)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' })));
    expect(await isOpenDeployment()).toBe(false);
  });

  it('returns false on a network error (fail closed to the key screen)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await isOpenDeployment()).toBe(false);
  });
});

describe('chooseInitialScreen()', () => {
  it('skips straight to the shell on an open deployment (no key needed)', () => {
    expect(chooseInitialScreen({ open: true, hasStoredKey: false })).toBe('shell');
    expect(chooseInitialScreen({ open: true, hasStoredKey: true })).toBe('shell');
  });

  it('shows the shell when a key is already stored (api-key deployment)', () => {
    expect(chooseInitialScreen({ open: false, hasStoredKey: true })).toBe('shell');
  });

  it('asks for a key only on a gated deployment with nothing stored', () => {
    expect(chooseInitialScreen({ open: false, hasStoredKey: false })).toBe('key');
  });
});
