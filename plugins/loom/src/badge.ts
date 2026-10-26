// What the badge on Loom's rail button counts, from Loom's side: the home page's Needs you items, and the threads that count
// when bb says they wait on the human. ui/badge.ts adds those threads from bb's live thread state.
import type { BadgeView } from "./contract";
import type { Store } from "./db/store";
import { homeView } from "./home";
import type { Projects } from "./projects";

export function badgeView(a: { store: Store; projects: Projects; now: number }): BadgeView {
  const needs = homeView(a).needsYou;
  const live = a.store.threads({ states: ["active"] }).flatMap((row) => (row.thread_id === null ? [] : [row.thread_id]));
  return { needsYou: needs.length, blocked: needs.some((need) => need.kind === "blocked"), threadIds: [...new Set([...live, ...a.store.openPlanning().map((row) => row.thread_id)])] };
}
