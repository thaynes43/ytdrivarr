/**
 * The header search state — a tiny module-level bus so the shell's input and the Sources view
 * stay decoupled (the view re-filters its rows on change without a full refetch).
 */

let value = '';
const listeners = new Set<(v: string) => void>();

export function getSearch(): string {
  return value;
}

export function setSearch(next: string): void {
  value = next;
  for (const listener of listeners) listener(next);
}

export function onSearch(listener: (v: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
