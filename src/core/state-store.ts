import { and, eq } from 'drizzle-orm';
import { providerState } from '../db/schema';
import { resolveDb } from '../db/client';
import type { Database, DbClient } from '../db';
import type { ProviderStateStore } from '../contracts';

/**
 * C5 (DESIGN-045 D-08) — a `ProviderStateStore` scoped to one provider's namespace, backed by the
 * `provider_state` table. This is the whole surface a provider sees of its durable state; it never
 * reaches other providers' namespaces.
 */
export function createStateStore(namespace: string, exec?: DbClient): ProviderStateStore {
  const d = resolveDb(exec) as Database;
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const rows = await d
        .select()
        .from(providerState)
        .where(and(eq(providerState.namespace, namespace), eq(providerState.key, key)))
        .limit(1);
      const row = rows[0];
      return row ? (row.value as T) : undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await d
        .insert(providerState)
        .values({ namespace, key, value })
        .onConflictDoUpdate({
          target: [providerState.namespace, providerState.key],
          set: { value, updatedAt: new Date() },
        });
    },
    async delete(key: string): Promise<void> {
      await d
        .delete(providerState)
        .where(and(eq(providerState.namespace, namespace), eq(providerState.key, key)));
    },
  };
}
