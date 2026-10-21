// The count on Loom's rail icon: the home page's Needs you items, and Loom threads waiting on a question or an approval.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./db/store";
import { homeView } from "./home";
import type { BbPort } from "./ports";
import type { Projects } from "./projects";

export interface Badge {
  count: number;
  label: string;
}

const labelOf = (count: number) => (count === 0 ? "Nothing needs you in Loom" : count === 1 ? "1 thing needs you in Loom" : `${count} things need you in Loom`);

/** A thread that is both a live Loom thread and an open planning conversation counts once. */
export async function badgeOf(a: { store: Store; projects: Projects; bb: BbPort; now: number }): Promise<Badge> {
  const { store } = a;
  const live = store.threads({ states: ["active"] }).flatMap((row) => (row.thread_id === null ? [] : [row.thread_id]));
  const threadIds = new Set([...live, ...store.openPlanning().map((row) => row.thread_id)]);
  const count = homeView(a).needsYou.length + (await a.bb.waitingOnUser([...threadIds])).length;
  return { count, label: labelOf(count) };
}

export function registerBadge(bb: BbPluginApi, deps: { store: Store; projects: Projects; port: BbPort; now: () => number }): void {
  bb.http.route("GET", "/badge", async (c) => c.json(await badgeOf({ store: deps.store, projects: deps.projects, bb: deps.port, now: deps.now() })));
}
