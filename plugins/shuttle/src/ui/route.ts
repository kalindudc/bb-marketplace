export const SOURCES = ["all", "asked", "team", "mentioned", "tracked"] as const;
export type Source = (typeof SOURCES)[number];

export type Route =
  | { view: "inbox"; key: string | null }
  | { view: "mine"; key: string | null }
  | { view: "done"; key: string | null }
  | { view: "reviews"; source: Source; key: string | null }
  | { view: "insights"; tab: InsightsTab }
  | { view: "pr"; key: string }
  /** Words to find among the PRs Shuttle has; "" before the user types any. */
  | { view: "search"; query: string; key: string | null };

export const INSIGHTS_TABS = ["overview", "log", "sync"] as const;
export type InsightsTab = (typeof INSIGHTS_TABS)[number];

/** A route that shows a list, with the PR selected in it. */
export type ListRoute = Exclude<Route, { view: "insights" | "pr" }>;

/** The four areas of the page; Merged and closed sits under My PRs. */
export type Area = "inbox" | "mine" | "reviews" | "insights";

/** A looked-up PR and search results belong to no area. */
export function areaOf(route: Route): Area | null {
  if (route.view === "done") return "mine";
  if (route.view === "pr" || route.view === "search") return null;
  return route.view;
}

const INBOX: Route = { view: "inbox", key: null };

/** 0.2's sections, so its links and bookmarks still open something sensible. */
const OLD_SECTIONS: Record<string, (key: string | null) => Route> = {
  needs: (key) => ({ view: "inbox", key }),
  requested: (key) => ({ view: "reviews", source: "asked", key }),
  team: (key) => ({ view: "reviews", source: "team", key }),
  mentioned: (key) => ({ view: "reviews", source: "mentioned", key }),
  watching: (key) => ({ view: "reviews", source: "tracked", key }),
  inflight: (key) => ({ view: "mine", key }),
};

/**
 * The page's subPath: "inbox", "mine", "done" and "reviews" are their lists, each followed by a
 * selected PR's key as path segments, "insights", "insights/log" and "insights/sync", "pr/<key>" one looked-up PR, and
 * "search/<words>" the search results, the words percent-encoded as one segment, then a selected key.
 * A Reviews source other than Everything rides on the area as "reviews~team": server ids are lowercase
 * words, so a "~" can never be mistaken for one. A key travels as plain segments: bb encodes the
 * subPath again, so a percent-encoded key would come back still encoded. "" also parses as the Inbox, but the
 * page opens there on the route it was last left on (see routeOf), so no link Shuttle makes is "".
 */
export function parseRoute(subPath: string): Route {
  const [first = "", ...rest] = subPath.replace(/^\/+|\/+$/gu, "").split("/");
  const key = rest.length === 0 ? null : keyFromSegments(rest);
  if (first === "" || first === "inbox") return { view: "inbox", key };
  if (first === "mine" || first === "done") return { view: first, key };
  if (first === "insights") return rest.length === 1 && (rest[0] === "log" || rest[0] === "sync") ? { view: "insights", tab: rest[0] } : { view: "insights", tab: "overview" };
  if (first === "activity" && rest.length === 0) return { view: "insights", tab: "log" };
  if (first === "pr") return key === null ? INBOX : { view: "pr", key };
  if (first === "search") return { view: "search", query: rest[0] === undefined ? "" : decoded(rest[0]), key: rest.length > 1 ? keyFromSegments(rest.slice(1)) : null };
  const reviews = /^reviews(?:~([a-z]+))?$/u.exec(first);
  if (reviews) {
    const source = SOURCES.find((item) => item === (reviews[1] ?? "all"));
    return source === undefined ? { view: "reviews", source: "all", key } : { view: "reviews", source, key };
  }
  const old = OLD_SECTIONS[first];
  return old === undefined ? INBOX : old(key);
}

export function formatRoute(route: Route): string {
  switch (route.view) {
    case "pr": return `pr/${keySegments(route.key)}`;
    case "search": {
      // No words, no results: nothing to select.
      if (route.query === "") return "search";
      const words = `search/${encodeURIComponent(route.query)}`;
      return route.key === null ? words : `${words}/${keySegments(route.key)}`;
    }
    case "insights": return route.tab === "overview" ? "insights" : `insights/${route.tab}`;
    case "inbox": return route.key === null ? "inbox" : `inbox/${keySegments(route.key)}`;
    case "mine":
    case "done": return route.key === null ? route.view : `${route.view}/${keySegments(route.key)}`;
    case "reviews": {
      const area = route.source === "all" ? "reviews" : `reviews~${route.source}`;
      return route.key === null ? area : `${area}/${keySegments(route.key)}`;
    }
  }
}

const KEY = /^([a-z][a-z0-9-]{0,31}):(.+)#(\d+)$/u;
const SAFE = /^[A-Za-z0-9._-]+$/u;

function keySegments(key: string): string {
  const match = KEY.exec(key);
  if (!match) return encodeURIComponent(key);
  const [, server, repo, number] = match;
  return [server, ...repo!.split("/").map((part) => (SAFE.test(part) ? part : encodeURIComponent(part))), number].join("/");
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function keyFromSegments(segments: string[]): string | null {
  if (segments.length < 3) return null;
  const server = segments[0]!;
  const number = segments.at(-1)!;
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(server) || !/^\d+$/u.test(number)) return null;
  try {
    return `${server}:${segments.slice(1, -1).map((part) => decodeURIComponent(part)).join("/")}#${number}`;
  } catch {
    // A hand-edited URL with a stray "%": show no selection rather than a broken page.
    return null;
  }
}
