import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { SnoozeEntry, SortMode } from "./layout";
import { STATE_ORDER, worstState } from "./status";
import type { TreeNode } from "./tree";

const DAY = 86_400_000;

export function lastActivity(thread: PluginSidebarThread): number {
  return Math.max(thread.latestAttentionAt ?? 0, thread.updatedAt);
}

export function isStale(node: TreeNode, now: number, staleDays: number): boolean {
  return staleDays > 0 && node.state === "idle" && !node.thread.isPinned &&
    !node.descendants.failed && !node.descendants.needs && !node.descendants.running &&
    now - lastActivity(node.thread) > staleDays * DAY;
}

export function canSnooze(node: TreeNode): boolean {
  return (node.state === "idle" || node.state === "unread") && node.children.every(canSnooze);
}

export function isSnoozed(node: TreeNode, entry: SnoozeEntry | undefined, now: number): boolean {
  if (!entry || now >= entry.until || !canSnooze(node)) return false;
  const unchanged = (current: TreeNode): boolean =>
    (current.thread.latestAttentionAt ?? 0) <= entry.at && current.children.every(unchanged);
  return unchanged(node);
}

export function nextWake(now: number, hour: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

export function wakeLabel(until: number, now: number): string {
  const date = new Date(until);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sameDay = date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() && date.getDate() === tomorrow.getDate();
  const day = sameDay ? "tomorrow" : new Intl.DateTimeFormat("en", { weekday: "short" }).format(date);
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function sortRoots(roots: readonly TreeNode[], mode: SortMode): TreeNode[] {
  const result = [...roots];
  if (mode === "recent") result.sort((a, b) =>
    lastActivity(b.thread) - lastActivity(a.thread) || b.thread.createdAt - a.thread.createdAt);
  if (mode === "status") result.sort((a, b) =>
    STATE_ORDER.indexOf(worstState([a.state, a.worstDescendant])) -
    STATE_ORDER.indexOf(worstState([b.state, b.worstDescendant])));
  return result;
}
