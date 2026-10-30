import type { InboxRule, PrView } from "../contract";

/** `shop/world#2261179`: the key without its server. */
export const shortKey = (pr: Pick<PrView, "repo" | "sep" | "number">) => `${pr.repo}${pr.sep}${pr.number}`;

/** `world#2261179`: the repository's last part and the number, for tight rows and titles. */
export const tinyKey = (pr: Pick<PrView, "repo" | "sep" | "number">) => `${pr.repo.split("/").at(-1)}${pr.sep}${pr.number}`;

/** `world#2261179` from `delta:shop/world#2261179`. */
export const tinyOfKey = (key: string) => keyLabel(key).split("/").at(-1)!;

/** `shop/world#2261179` from `delta:shop/world#2261179`, without a request. */
export const keyLabel = (key: string) => key.slice(key.indexOf(":") + 1);

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/** "3h": how long, without "ago". */
export function span(ms: number): string {
  const minutes = Math.max(0, ms) / 60_000;
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** "3h" since a time. */
export const age = (at: number, now = Date.now()) => span(now - at);

export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** 9:00 in the user's time zone, `days` after the day of `now`. */
export function atNine(now: number, days: number): number {
  const at = new Date(now);
  at.setDate(at.getDate() + days);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
}

/** "9:00 AM", in the user's own format. */
export const timeOfDay = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "11:38 AM" today, "Oct 25, 12:53 PM" on another day. */
export function clock(at: number, now = Date.now()): string {
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString() ? timeOfDay(at) : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${timeOfDay(at)}`;
}

/** "today, 3:00 PM", "tomorrow, 9:00 AM", "Monday, 9:00 AM" within a week, else "Nov 12, 9:00 AM". */
export function when(at: number, now = Date.now()): string {
  const day = (ms: number) => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days === 0) return `today, ${timeOfDay(at)}`;
  if (days === 1) return `tomorrow, ${timeOfDay(at)}`;
  if (days > 1 && days < 7) return `${new Date(at).toLocaleDateString(undefined, { weekday: "long" })}, ${timeOfDay(at)}`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${timeOfDay(at)}`;
}

/** An Inbox rule in words: "PRs by @x", "PRs from owner/repo" or "Mentions in owner/repo, when you are not asked to review". */
export function ruleText(rule: Pick<InboxRule, "kind" | "value">): string {
  switch (rule.kind) {
    case "author": return `PRs by @${rule.value}`;
    case "repo": return `PRs from ${rule.value}`;
    case "mention": return `Mentions in ${rule.value}, when you are not asked to review`;
  }
}

/** "6.1s" or "1m 17s". */
export function seconds(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total < 10 ? total.toFixed(1) : Math.round(total)}s`;
  return `${Math.floor(total / 60)}m ${Math.round(total % 60)}s`;
}

/** A median such as "41m", "7.5h" or "2.6d"; null shows a dash. */
export function duration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

export const percent = (share: number) => `${Math.round(share * 100)}%`;

/** S under 50 changed lines, M under 300, L under 1000, XL above; null when the server did not say. */
export function sizeOf(pr: Pick<PrView, "additions" | "deletions">): "S" | "M" | "L" | "XL" | null {
  if (pr.additions === null || pr.deletions === null) return null;
  const lines = pr.additions + pr.deletions;
  return lines < 50 ? "S" : lines < 300 ? "M" : lines < 1000 ? "L" : "XL";
}

/** "GH" for GitHub, "De" for Delta: what a server badge shows. */
export function initials(name: string): string {
  const capitals = name.replace(/[^A-Z]/gu, "");
  if (capitals.length >= 2) return capitals.slice(0, 2);
  const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.slice(0, 2).replace(/^./u, (first) => first.toUpperCase());
}

export const settingsHref = (pluginId: string) => `/settings/plugins/${encodeURIComponent(pluginId)}`;

/** A check item's body is "<check name> failed"; its name is what comes before. */
export const checkName = (body: string) => body.replace(/ failed$/u, "") || body;
