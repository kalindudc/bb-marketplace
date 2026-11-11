// The order of Home's Needs you queue, for the server's items and the page's, which adds the threads bb shows waiting. A leaf module: the page imports it.

/** Oldest first; an item whose start Loom does not know goes after them, newest project first. */
export function queueOrder<T extends { startedAt: number | null; slug: string | null }>(items: T[], createdOf: (slug: string) => number): T[] {
  const known = items.filter((item) => item.startedAt !== null).sort((x, y) => x.startedAt! - y.startedAt!);
  // A planning conversation has no project yet, so it is the newest.
  const created = (slug: string | null) => (slug === null ? Number.MAX_SAFE_INTEGER : createdOf(slug));
  const unknown = items.filter((item) => item.startedAt === null).sort((x, y) => created(y.slug) - created(x.slug));
  return [...known, ...unknown];
}
