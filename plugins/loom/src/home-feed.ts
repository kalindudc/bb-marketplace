// Home's Since you looked: what happened across every live project since a time, in the kinds the human scans for.
// Events of no such kind (a post, a step Loom took) stay on each project's History.
import type { EventRow, Store } from "./db/store";
import { feedText } from "./feed-text";
import { FEED_KINDS, HOME_FEED_LIMIT, HOME_FEED_MAX, type FeedKind } from "./feed-kinds";

export { FEED_KINDS, HOME_FEED_LIMIT, HOME_FEED_MAX, type FeedKind };

export interface HomeFeedRow {
  id: number;
  at: number;
  slug: string;
  projectKey: string;
  ticketKey: string | null;
  kind: FeedKind;
  text: string;
}

export interface HomeFeed {
  /** The newest events of the kind asked for (every kind without one), at most the limit asked for. */
  rows: HomeFeedRow[];
  /** Events of each kind since the time, every one Loom read; `partial` names the projects it could not read to the end. */
  counts: Record<FeedKind, number>;
  /** Events of the kind asked for, or of every kind: more than `rows` when there are older ones to load. */
  matched: number;
  /** Projects with more events since the time than Loom reads at once: their counts start at `from`, and the events
   *  before it are on the project's History. */
  partial: Array<{ slug: string; projectKey: string; from: number }>;
}

/** Events read per project, a page at a time; past this, the project is partial. */
export const READ_LIMIT = 20_000;
const READ_PAGE = 2_000;

export function kindOf(event: EventRow): FeedKind | null {
  const data = JSON.parse(event.data_json) as Record<string, unknown>;
  switch (event.kind) {
    case "ticket.state":
      if (data.to === "done") return "shipped";
      if (data.to === "blocked") return "blocked";
      if (data.from === "checking" && data.to === "working") return "sentBack";
      return null;
    case "review.verdict":
      return data.verdict === "approved" ? null : "sentBack";
    case "planner.asked":
      return "asks";
    case "phase.done":
      return "phase";
    case "human.action":
      return "you";
    default:
      return null;
  }
}

export function homeFeed(store: Store, since: number, options: { kind?: FeedKind | null; limit?: number; readLimit?: number } = {}): HomeFeed {
  const kind = options.kind ?? null;
  const limit = Math.min(options.limit ?? HOME_FEED_LIMIT, HOME_FEED_MAX);
  const readLimit = options.readLimit ?? READ_LIMIT;
  const counts = Object.fromEntries(FEED_KINDS.map((each) => [each, 0])) as Record<FeedKind, number>;
  const found: Array<{ event: EventRow; kind: FeedKind; project: { slug: string; key: string }; keys: Map<number, string> }> = [];
  const partial: HomeFeed["partial"] = [];
  for (const project of store.projects()) {
    if (project.state === "archived") continue;
    let keys: Map<number, string> | null = null;
    let read = 0;
    let oldest: EventRow | null = null;
    for (;;) {
      const page = store.eventsSince(project.id, since, Math.min(READ_PAGE, readLimit - read), oldest?.id);
      if (page.length === 0) break;
      keys ??= new Map(store.tickets(project.id).map((ticket) => [ticket.id, ticket.key]));
      for (const event of page) {
        const each = kindOf(event);
        if (each === null) continue;
        counts[each] += 1;
        if (kind === null || each === kind) found.push({ event, kind: each, project: { slug: project.slug, key: project.key }, keys });
      }
      read += page.length;
      oldest = page[page.length - 1]!;
      if (read >= readLimit) {
        if (store.eventsSince(project.id, since, 1, oldest.id).length > 0) partial.push({ slug: project.slug, projectKey: project.key, from: oldest.at });
        break;
      }
    }
  }
  const rows = found
    .sort((x, y) => y.event.at - x.event.at || y.event.id - x.event.id)
    .slice(0, limit)
    .map(({ event, kind: each, project, keys }) => ({ id: event.id, at: event.at, slug: project.slug, projectKey: project.key, ticketKey: event.ticket_id === null ? null : (keys.get(event.ticket_id) ?? null), kind: each, text: feedText(event, keys, { you: true }) }));
  return { rows, counts, matched: found.length, partial };
}
