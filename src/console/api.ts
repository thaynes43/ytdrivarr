/**
 * The console's single data path: `fetch` against the service's own REST API, every request
 * carrying `X-Api-Key` (DESIGN-045 D-21 — one key guards the API and the console; LAN-only by
 * design, so localStorage is an acceptable place for an operator to park the key). A 401 anywhere
 * clears the stored key and announces it, which returns the shell to the key-entry screen.
 */

const STORAGE_KEY = 'ytdrivarr.apiKey';

/** Fired on any 401 so the shell can drop back to key entry. */
export const UNAUTHORIZED_EVENT = 'ytdrivarr:unauthorized';

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export function getApiKey(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key: string): void {
  window.localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-api-key': getApiKey() ?? '' };
  const init: RequestInit = { method: opts.method ?? 'GET', headers };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, `network error reaching ${path}`);
  }

  if (res.status === 401) {
    clearApiKey();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new ApiError(401, 'unauthorized — the API key was rejected');
  }

  if (!res.ok) {
    let message = `${res.status} from ${path}`;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: string; details?: unknown };
      if (body.error) message = body.error;
      details = body.details;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new ApiError(res.status, message, details);
  }

  return (await res.json()) as T;
}

/** Probe a candidate key against a cheap authed route without touching stored state. */
export async function verifyKey(key: string): Promise<boolean> {
  const res = await fetch('/api/v1/providers', { headers: { 'x-api-key': key } });
  return res.ok;
}
