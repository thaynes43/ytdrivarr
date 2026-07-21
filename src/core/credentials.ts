import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SessionArtifacts } from '../contracts';
import type { Library } from '../db/schema';

/**
 * C2 session delivery (DESIGN-045 D-05) — the core persists the short-lived credential material a
 * provider (Peloton) mints and writes it to the DOWNLOADER's reach: `bearer.txt` + `cookies.txt` on
 * the shared volume, so the ytdl-sub `__preset__` picks up `${PELOTON_BEARER}` / the cookiefile at
 * runtime. Writes are ATOMIC (write-temp-then-rename, the projection primitive) so a downloader
 * mid-tick never reads a half-written credential file.
 *
 * `bearer.txt` content is the RAW `Authorization` header value verbatim from the worker — i.e. it
 * INCLUDES the `Bearer ` prefix, exactly as the donor's scraper_manager writes `token.strip()`
 * (NOT the bare token). `cookies.txt` is the worker's Netscape/Mozilla cookie jar, byte-for-byte.
 */

export interface CredentialDelivery {
  dir: string;
  bearerPath?: string;
  cookiesPath?: string;
}

/**
 * Resolve a Library's credential directory: its `credentialPath`, else its `mediaRoot` (the estate's
 * live `/media/peloton`). A relative path resolves under `credentialRoot` (falling back to cwd for
 * tests) so the estate's absolute NFS paths pass through untouched while tests stay sandboxed.
 */
export function resolveCredentialDir(
  library: Pick<Library, 'credentialPath' | 'mediaRoot'>,
  credentialRoot?: string,
): string {
  const base = library.credentialPath ?? library.mediaRoot;
  if (isAbsolute(base)) return base;
  return join(credentialRoot ?? process.cwd(), base);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Deliver the session artifacts a worker minted to the Library's credential dir. Only the artifacts
 * actually present are written (a `mode:'refresh'` mint may carry only a bearer). Returns the paths
 * written so the caller can record them / log the delivery.
 */
export async function deliverSession(
  library: Pick<Library, 'credentialPath' | 'mediaRoot'>,
  session: SessionArtifacts,
  credentialRoot?: string,
): Promise<CredentialDelivery> {
  const dir = resolveCredentialDir(library, credentialRoot);
  await mkdir(dir, { recursive: true });
  const delivery: CredentialDelivery = { dir };
  if (session.bearer !== undefined) {
    const bearerPath = join(dir, 'bearer.txt');
    await atomicWrite(bearerPath, session.bearer);
    delivery.bearerPath = bearerPath;
  }
  if (session.cookies !== undefined) {
    const cookiesPath = join(dir, 'cookies.txt');
    await atomicWrite(cookiesPath, session.cookies);
    delivery.cookiesPath = cookiesPath;
  }
  return delivery;
}
