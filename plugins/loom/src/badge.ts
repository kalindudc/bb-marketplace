// What the badge on Loom's rail button counts, from Loom's side: Home's Needs you items, and the threads that count when bb
// says they wait on the human, from the same homeView. ui/badge.ts adds those threads from bb's live thread state, as Home's
// queue does (ui/needs.ts).
import type { BadgeView } from "./contract";
import type { Store } from "./db/store";
import { homeView, type CardsOf } from "./home";
import type { Projects } from "./projects";

export function badgeView(a: { store: Store; projects: Projects; now: number; cards: CardsOf }): BadgeView {
  const view = homeView(a);
  return { needsYou: view.needsYou.length, blocked: view.needsYou.some((need) => need.kind === "blocked"), threadIds: [...new Set(view.threads.map((thread) => thread.threadId))] };
}
