import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { EmittedConfig } from './emitter';

export interface ProjectionResult {
  dir: string;
  configPath: string;
  subscriptionsPath: string;
}

/** Resolve a Library's projectionPath against the projection root (absolute paths pass through). */
export function resolveProjectionDir(projectionPath: string, projectionRoot?: string): string {
  if (isAbsolute(projectionPath)) return projectionPath;
  return join(projectionRoot ?? process.cwd(), projectionPath);
}

/**
 * ATOMIC projection (DESIGN-045 D-14) — render each file to a unique `.tmp` sibling, then `rename`
 * onto the final name. `rename` is atomic on a single filesystem, so a downloader mounting the
 * volume NEVER reads a half-written `subscriptions.yaml`. A failed write cleans up its temp file
 * and leaves any prior projected file untouched.
 */
export async function projectLibrary(
  dir: string,
  emitted: EmittedConfig,
): Promise<ProjectionResult> {
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'config.yaml');
  const subscriptionsPath = join(dir, 'subscriptions.yaml');
  await atomicWrite(configPath, emitted.configYaml);
  await atomicWrite(subscriptionsPath, emitted.subscriptionsYaml);
  return { dir, configPath, subscriptionsPath };
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
