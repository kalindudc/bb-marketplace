// A project's five views, which one each project was last left on, and the parts inside Ship and History.
import { createStoredMap } from "./remember";

export const VIEWS = [
  { view: "work", label: "Work" },
  { view: "spec", label: "Spec" },
  { view: "planner", label: "Planner" },
  { view: "ship", label: "Ship" },
  { view: "history", label: "History" },
] as const;

export type View = (typeof VIEWS)[number]["view"];
export type ShipPart = "changes" | "merge" | "rollout";
export type HistoryPart = "rewind" | "insights" | "agents";

const VIEW_NAMES: readonly string[] = VIEWS.map((entry) => entry.view);
const isView = (value: unknown): value is View => typeof value === "string" && VIEW_NAMES.includes(value);

/** The view each project was last left on. */
export const projectViews = createStoredMap<View>("projectView", 50, isView);
export const shipParts = createStoredMap<ShipPart>("shipPart", 50, (value): value is ShipPart => value === "changes" || value === "merge" || value === "rollout");
export const historyParts = createStoredMap<HistoryPart>("historyPart", 50, (value): value is HistoryPart => value === "rewind" || value === "insights" || value === "agents");

// Before the five views, each project remembered one of eight tabs; each maps onto the view that now holds it.
const LEGACY: Record<string, { view: View; ship?: ShipPart; history?: HistoryPart }> = {
  board: { view: "work" },
  spec: { view: "spec" },
  planner: { view: "planner" },
  changes: { view: "ship", ship: "changes" },
  merge: { view: "ship", ship: "merge" },
  rollout: { view: "ship", ship: "rollout" },
  insights: { view: "history", history: "insights" },
  agents: { view: "history", history: "agents" },
};
const legacyTabs = createStoredMap<string>("projectTab", 50, (value): value is string => typeof value === "string" && value in LEGACY);

/** The view a project opens on: where it was left, then the tab an older Loom left it on, then Work. */
export function viewOf(slug: string): View {
  const view = projectViews.get()[slug];
  if (view !== undefined) return view;
  const legacy = legacyTabs.get()[slug];
  return legacy === undefined ? "work" : LEGACY[legacy]!.view;
}

export function shipPartOf(slug: string): ShipPart | undefined {
  const legacy = legacyTabs.get()[slug];
  return shipParts.get()[slug] ?? (legacy === undefined ? undefined : LEGACY[legacy]!.ship);
}

export function historyPartOf(slug: string): HistoryPart | undefined {
  const legacy = legacyTabs.get()[slug];
  return historyParts.get()[slug] ?? (legacy === undefined ? undefined : LEGACY[legacy]!.history);
}
