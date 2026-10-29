import type { PrView } from "../contract";
import { SORT_LABELS, type SortKey } from "./sort";

export const BOARD_SORT_LABELS = {
  saved: "Saved order",
  ...SORT_LABELS,
  closed: "Recently merged or closed",
} as const;
export type BoardSort = "saved" | SortKey;

export const BOARD_GROUP_LABELS = {
  none: "No grouping",
  status: "Status",
  repo: "Repository",
  server: "Server",
  author: "Author",
} as const;
export type BoardGrouping = keyof typeof BOARD_GROUP_LABELS;

export interface BoardViewPrefs {
  sort: BoardSort;
  group: BoardGrouping;
}
export const DEFAULT_BOARD_VIEW: BoardViewPrefs = { sort: "saved", group: "none" };

const STATES: readonly PrView["state"][] = ["open", "draft", "merged", "closed"];
const STATE_LABELS: Record<PrView["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

interface BoardPrGroup {
  key: string;
  title: string;
  prs: PrView[];
}

export function groupBoardPrs(prs: readonly PrView[], grouping: BoardGrouping): BoardPrGroup[] {
  if (grouping === "none") return [];
  if (grouping === "status") {
    return STATES.map((state) => ({ key: state, title: STATE_LABELS[state], prs: prs.filter((pr) => pr.state === state) })).filter((group) => group.prs.length > 0);
  }
  const servers = new Map(prs.map((pr) => [pr.server, pr.serverName]));
  const serverName = (pr: PrView) => [...servers].some(([id, name]) => id !== pr.server && name === pr.serverName)
    ? `${pr.serverName} (${pr.server})` : pr.serverName;
  const groups = new Map<string, BoardPrGroup>();
  for (const pr of prs) {
    const key = JSON.stringify(grouping === "server" ? [pr.server] : [pr.server, grouping === "repo" ? pr.repo : pr.author]);
    const title = grouping === "server" ? serverName(pr)
      : grouping === "repo" ? `${pr.repo} · ${serverName(pr)}`
      : servers.size > 1 ? `${pr.author} · ${serverName(pr)}` : pr.author;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, title, prs: [pr] });
    else group.prs.push(pr);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
}
