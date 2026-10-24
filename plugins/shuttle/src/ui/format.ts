import type { PrView } from "../contract";

/** `shop/world#2261179`: the key without its server. */
export const shortKey = (pr: Pick<PrView, "repo" | "sep" | "number">) => `${pr.repo}${pr.sep}${pr.number}`;

/** `shop/world#2261179` from `delta:shop/world#2261179`, without a request. */
export const keyLabel = (key: string) => key.slice(key.indexOf(":") + 1);

export const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

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

/** "GH" for GitHub, "De" for Delta: what a server badge shows. */
export function initials(name: string): string {
  const capitals = name.replace(/[^A-Z]/gu, "");
  if (capitals.length >= 2) return capitals.slice(0, 2);
  const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.slice(0, 2).replace(/^./u, (first) => first.toUpperCase());
}

export const settingsHref = (pluginId: string) => `/settings/plugins/${encodeURIComponent(pluginId)}`;
