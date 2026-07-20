import { db as defaultDb, type Database, type DbClient, type Transaction } from './index';

/** Resolve the executor: an injected DbClient (tests / composed tx), or the lazy default db. */
export function resolveDb(exec?: DbClient): DbClient {
  return exec ?? defaultDb;
}

/**
 * Run `fn` inside ONE transaction. If `exec` is already a transaction, this opens a nested
 * SAVEPOINT (writers compose safely); otherwise it opens a top-level transaction on the resolved
 * db. The audit-in-same-tx invariant (D-08 / hard rule 6) rides on this: a writer performs its
 * state change AND its audit insert on the same `tx`, so a failed audit rolls the mutation back.
 */
export function inTransaction<T>(
  exec: DbClient | undefined,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const client = resolveDb(exec) as Database;
  return client.transaction(fn);
}
