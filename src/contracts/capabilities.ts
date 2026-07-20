import { z } from 'zod';

/**
 * C1 (DESIGN-045 D-04) — the opt-in capability set. A provider declares the SUBSET it
 * implements; everything it omits is NEGATED (the core never invokes that path). This is what
 * keeps a trivial provider (YouTube) a few lines and lets a maximal one (Peloton) declare the
 * full lifecycle against the SAME interface.
 *
 * - `auth`       — a credential/session lifecycle (C2). YouTube: none. Peloton: full.
 * - `scrape`     — a credentialed browser scrape produces the catalog (worker-side).
 * - `tokenMint`  — mint a short-lived bearer for the downloader (worker-side).
 * - `assets`     — generates thumbnails/posters (C8, optional). v1: poster guard stays app-side.
 * - `remediation`— per-item Fix (C6). URL sources: stateless re-download. Peloton: auth-gated.
 */
export const capabilitySchema = z.enum(['auth', 'scrape', 'tokenMint', 'assets', 'remediation']);
export type Capability = z.infer<typeof capabilitySchema>;

/**
 * D-03 — where a provider's discover()/remediate() executes.
 * - `in_core`         — Tier-1 URL-list providers: pure yt-dlp URL enumeration, no browser.
 * - `out_of_process`  — heavy providers (Peloton): the core enqueues a job a plugin-owned
 *                       worker container claims and reports back through the transport (C2/C3/C6).
 */
export const runtimeSchema = z.enum(['in_core', 'out_of_process']);
export type Runtime = z.infer<typeof runtimeSchema>;
