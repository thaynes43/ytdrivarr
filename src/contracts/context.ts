import type { Logger } from '../logger';
import type { MediaKind } from './media-kind';

/**
 * C5 (DESIGN-045 D-08) — a provider's durable, namespaced state area in ytdrivarr's DB. YouTube's
 * "state" IS the user-editable Source list (what Edit mutates); Peloton's is machine state (last
 * bearer, scrape history, dedup ids). The core injects a store scoped to the provider's namespace.
 */
export interface ProviderStateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The Source a discovery/remediation run operates on (core-owned; the provider only reads it). */
export interface SourceView {
  id: string;
  libraryId: string;
  providerId: string;
  kind: string;
  mediaKind: MediaKind;
  displayName: string;
  ref: string;
  settings: Record<string, unknown>;
  enabled: boolean;
}

/**
 * C2 (D-05) — session artifacts a provider mints; the core persists them and delivers the
 * short-lived material to the downloader's reach (bearer.txt / cookies.txt on NFS). YouTube: none.
 */
export interface SessionArtifacts {
  bearer?: string;
  cookies?: string;
  mintedAt?: string;
  expiresAt?: string;
}

/**
 * The context the core injects into a provider call. Secrets come from ESO, never hardcoded
 * (C2 — the core injects, the provider never reads env). A no-auth provider gets an empty
 * `secrets` and never mints a `session`.
 */
export interface ProviderContext {
  source: SourceView;
  secrets: Readonly<Record<string, string>>;
  state: ProviderStateStore;
  session?: SessionArtifacts;
  logger: Logger;
}
