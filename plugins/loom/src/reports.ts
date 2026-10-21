// What the page and the CLI both read about a project: its metrics and its feed.
import type { FeedRow } from "./contract";
import type { ProjectRow, Store } from "./db/store";
import { feedText } from "./feed-text";
import { computeMetrics, type ProjectMetrics } from "./metrics";

const FEED_LIMIT = 200;

export function projectMetrics(store: Store, project: ProjectRow, now: number): ProjectMetrics {
  return computeMetrics({
    tickets: store.tickets(project.id),
    events: store.projectEvents(project.id),
    posts: store.postsForProject(project.id),
    threads: store.threadsForProject(project.id),
    reviews: store.reviewsForProject(project.id),
    now,
  });
}

/** The newest 200 events, oldest first, or those of them newer than `afterId`. */
export function projectFeed(store: Store, project: ProjectRow, afterId?: number): { rows: FeedRow[]; lastId: number } {
  const keys = new Map(store.tickets(project.id).map((ticket) => [ticket.id, ticket.key]));
  const rows = store
    .eventsNewest(project.id, FEED_LIMIT)
    .reverse()
    .filter((event) => afterId === undefined || event.id > afterId)
    .map((event) => ({ id: event.id, at: event.at, kind: event.kind, actor: event.actor, ticketKey: event.ticket_id === null ? null : (keys.get(event.ticket_id) ?? null), text: feedText(event, keys) }));
  return { rows, lastId: rows.at(-1)?.id ?? afterId ?? 0 };
}
