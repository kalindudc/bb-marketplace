import { USAGE_RANGES, type UsageRange } from "../contract";
import { isDay } from "../period";
export const SOURCES = ["all", "asked", "team", "mentioned", "tracked"] as const;
export type Source = (typeof SOURCES)[number];
/** The Inbox's own tab has no name in the route; Reviewing, Snoozed and Dismissed ride on it as "inbox~snoozed". */
export const INBOX_TABS = ["reviewing", "snoozed", "dismissed"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export type Route =
  | { view: "inbox"; tab?: InboxTab; key: string | null }
  | { view: "mine"; key: string | null }
  | { view: "done"; key: string | null }
  | { view: "reviews"; source: Source; key: string | null }
  /** Other people's PRs you reviewed, open, merged and closed. */
  | { view: "reviewed"; key: string | null }
  | { view: "boards"; tab: "active" | "archived" }
  | { view: "board"; id: string; key: string | null }
  /** `period` only on the Usage tab, and only when it is not the newest 7 days. */
  | { view: "insights"; tab: InsightsTab; period?: UsagePeriod; key?: string | null; reference?: string }
  | { view: "pr"; key: string }
  /** Words to find among the PRs Shuttle has; "" before the user types any. */
  | { view: "search"; query: string; key: string | null };

export const INSIGHTS_TABS = ["overview", "usage", "autopost", "references", "log", "sync"] as const;
export type InsightsTab = (typeof INSIGHTS_TABS)[number];

/** What the Usage tab shows: a range ending on `end`, or ending now when `end` is null. */
export interface UsagePeriod {
  range: UsageRange;
  end: string | null;
}
export const DEFAULT_PERIOD: UsagePeriod = { range: "7d", end: null };
/** "today" is the one-day range, whichever day it shows. */
const PERIOD_PATHS: Record<UsageRange, string> = { today: "day", "7d": "7d", "30d": "30d", "90d": "90d" };

function periodOf(segments: readonly string[]): UsagePeriod | undefined {
  const range = USAGE_RANGES.find((item) => PERIOD_PATHS[item] === segments[0]);
  if (range === undefined) return undefined;
  const end = segments[1] !== undefined && isDay(segments[1]) ? segments[1] : null;
  return range === DEFAULT_PERIOD.range && end === null ? undefined : { range, end };
}

/** The newest period has no day in the address, so a page left open goes on following today. */
const periodPath = (period: UsagePeriod | undefined) => (period === undefined ? "" : `/${PERIOD_PATHS[period.range]}${period.end === null ? "" : `/${period.end}`}`);

/** A route that shows a list, with the PR selected in it. */
export type ListRoute = Exclude<Route, { view: "insights" | "pr" | "boards" }> | (Extract<Route, { view: "insights" }> & { tab: "references" });

/** The areas of the page; Merged and closed sits under My PRs, and Reviewed by me under Reviews. */
export type Area = "inbox" | "mine" | "reviews" | "boards" | "insights";

/** A looked-up PR and search results belong to no area. */
export function areaOf(route: Route): Area | null {
  if (route.view === "done") return "mine";
  if (route.view === "reviewed") return "reviews";
  if (route.view === "boards" || route.view === "board") return "boards";
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
 * The page's subPath: "inbox", "mine", "done", "reviews" and "reviewed" are their lists, each followed by a
 * selected PR's key as path segments, "insights", "insights/usage" (then a range and a day, such as "insights/usage/day/2026-11-05"), "insights/autopost", "insights/log" and "insights/sync", "pr/<key>" one looked-up PR, and
 * "search/<words>" the search results, the words percent-encoded as one segment, then a selected key.
 * The Inbox's Reviewing, Snoozed and Dismissed tabs are "inbox~reviewing", "inbox~snoozed" and "inbox~dismissed", the same way.
 * A Reviews source other than Everything rides on the area as "reviews~team": server ids are lowercase
 * words, so a "~" can never be mistaken for one. A key travels as plain segments: bb encodes the
 * subPath again, so a percent-encoded key would come back still encoded. "" also parses as the Inbox, but the
 * page opens there on the route it was last left on (see routeOf), so no link Shuttle makes is "".
 */
export function parseRoute(subPath: string): Route {
  const [first = "", ...rest] = subPath.replace(/^\/+|\/+$/gu, "").split("/");
  const key = rest.length === 0 ? null : keyFromSegments(rest);
  if (first === "" || first === "inbox") return { view: "inbox", key };
  const inbox = /^inbox~([a-z]+)$/u.exec(first);
  if (inbox) {
    const tab = INBOX_TABS.find((item) => item === inbox[1]);
    return tab === undefined ? { view: "inbox", key } : { view: "inbox", tab, key };
  }
  if (first === "mine" || first === "done" || first === "reviewed") return { view: first, key };
  if (first === "boards") return { view: "boards", tab: rest[0] === "archived" ? "archived" : "active" };
  if (first === "board") return rest.length === 0 ? { view: "boards", tab: "active" } : { view: "board", id: decoded(rest[0]!), key: rest.length > 1 ? keyFromSegments(rest.slice(1)) : null };
  if (first === "insights") {
    if (rest[0] === "references") {
      if (rest[1] === "ref" && /^[a-f0-9]{64}$/u.test(rest[2] ?? "") && rest.length === 3) return { view: "insights", tab: "references", reference: rest[2] };
      if (rest[1] === "pr") return { view: "insights", tab: "references", key: keyFromSegments(rest.slice(2)) };
      return { view: "insights", tab: "references" };
    }
    if (rest[0] === "usage" && rest.length > 1) {
      const period = periodOf(rest.slice(1));
      return period === undefined ? { view: "insights", tab: "usage" } : { view: "insights", tab: "usage", period };
    }
    const tab = INSIGHTS_TABS.find((item) => item !== "overview" && rest.length === 1 && item === rest[0]);
    return { view: "insights", tab: tab ?? "overview" };
  }
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
    case "boards": return route.tab === "active" ? "boards" : "boards/archived";
    case "board": return route.key === null ? `board/${encodeURIComponent(route.id)}` : `board/${encodeURIComponent(route.id)}/${keySegments(route.key)}`;
    case "insights": return route.tab === "references" ? `insights/references${route.reference ? `/ref/${route.reference}` : route.key ? `/pr/${keySegments(route.key)}` : ""}` : route.tab === "overview" ? "insights" : `insights/${route.tab}${route.tab === "usage" ? periodPath(route.period) : ""}`;
    case "inbox": {
      const area = route.tab === undefined ? "inbox" : `inbox~${route.tab}`;
      return route.key === null ? area : `${area}/${keySegments(route.key)}`;
    }
    case "mine":
    case "done":
    case "reviewed": return route.key === null ? route.view : `${route.view}/${keySegments(route.key)}`;
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
