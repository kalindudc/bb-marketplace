// @vitest-environment jsdom
// Phase 4's screens: Ship's Do next over the merge order and the rollout, the ticket's Confirm merge in Ship's words,
// Insights across projects with its scope, window and day range, and History's way to it.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { InsightsAllView, ProjectView, rpcContract } from "../src/contract";
import { insightsAll, type InsightsRows } from "../src/insights-all";
import type { EventRow, ProjectRow, ThreadRow, TicketRow } from "../src/db/store";
import { reloadRemembered } from "../src/ui/remember";
import { keysSheet, palette, rewind } from "../src/ui/dispatch";
import { card, overview, projectView, repoOverview, ticketDetail, timeline } from "./fixtures";
import { csvShip, laneHeld, laneRollout, laneShip } from "./ship-fixtures";
import { stepCanGo } from "../src/ui/ship-readiness";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const handlers = (over: Partial<Handlers> = {}): Handlers => ({
  projects: unexpected,
  home: () => ({ projects: [], needsYou: [], threads: [], totals: { tokens: 0, doneWeek: 0, agents: 0 } }) as never,
  badge: () => ({ needsYou: 0, blocked: false, threadIds: [] }),
  project: unexpected,
  ticket: unexpected,
  runOutput: unexpected,
  insights: unexpected,
  timeline: () => timeline(),
  insightsAll: unexpected,
  threadInfo: () => null,
  threadInfos: () => ({}),
  homeFeed: () => ({ rows: [], counts: { shipped: 0, sentBack: 0, blocked: 0, asks: 0, phase: 0, you: 0 }, matched: 0, partial: [] }),
  reply: unexpected,
  ticketAction: unexpected,
  confirmMerge: unexpected,
  releaseDraft: unexpected,
  control: unexpected,
  startPlanning: unexpected,
  bbProjects: () => [],
  planning: () => [],
  planningSession: () => null,
  plannerView: () => null,
  messagePlanner: unexpected,
  dismissAsk: unexpected,
  askStepDone: unexpected,
  ackBadge: unexpected,
  syncPullRequests: unexpected,
  markLive: unexpected,
  specVersion: unexpected,
  sendNotes: unexpected,
  changes: () => ({ slug: "lane", branch: null, base: "main", unavailable: null, sources: [], repos: [] }) as never,
  changePatch: unexpected,
  forgeProfiles: () => [],
  saveForgeProfile: unexpected,
  deleteForgeProfile: unexpected,
  testForgeProfile: unexpected,
  exportForgeProfiles: () => ({ toml: "" }),
  importForgeProfiles: unexpected,
  ...over,
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const mock of [toast.success, toast.warning, toast.error, toast.info]) vi.mocked(mock).mockClear();
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
  palette.set(false);
  keysSheet.set(false);
  rewind.set(null);
  localStorage.clear();
  reloadRemembered();
});

async function mountPage(subPath: string, rpc: Partial<Handlers> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const Panel = app.navPanels[0]!.component;
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: Panel }, { subPath }, { pluginId: "loom", rpc: handlers(rpc) });
  mounts.push(slot);
  return slot;
}
async function mountSidebar(subPath: string) {
  const app = await loadPluginApp(() => import("../app"));
  const Sidebar = app.navPanels[0]!.experimental_sidebar!;
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: Sidebar }, { subPath }, { pluginId: "loom", rpc: handlers() });
  mounts.push(slot);
  return slot;
}
/** Waits for an element to appear: waitFor retries only on a throw. */
const element = (slot: Slot, selector: string) =>
  waitFor(() => {
    const found = slot.container.querySelector<HTMLElement>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "loom", options: { subPath } });
async function openShip(slot: Slot) {
  fireEvent.click(await slot.findByRole("tab", { name: /^Ship/ }));
  return slot.findByRole("region", { name: "Do next" });
}
const stepRow = (scope: HTMLElement, id: string) => scope.querySelector<HTMLElement>(`[data-do-step="${id}"]`)!;

// The first page a file mounts imports the whole app: module loading, not what a test checks. Beside a full run that
// import alone took 2.2 to 5.4 s, inside the first mounting test's 5 s, so it loads once here under its own deadline.
// Importing renders nothing, so the ruler test below still sees React's one NaN report.
beforeAll(async () => {
  await loadPluginApp(() => import("../app"));
}, 60_000);

// First in the file: React reports a NaN attribute only once per run, so a later test could not see it.
describe("the time ruler before it knows its width", () => {
  it("draws no tick at a NaN position", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
      original(...args);
    };
    try {
      const slot = await mountPage("lane", { project: () => laneShip() });
      await openShip(slot);
    } finally {
      console.error = original;
    }
    expect(errors.filter((error) => error.includes("NaN"))).toEqual([]);
  });
});

describe("Ship's Do next", () => {
  it("lists the merges both the merge order and the rollout allow, and opens each pull request", async () => {
    const slot = await mountPage("lane", { project: () => laneShip() });
    const next = await openShip(slot);
    expect([...next.querySelectorAll("[data-do-step]")].map((row) => row.getAttribute("data-do-step"))).toEqual(["merge:LANE-6", "merge:LANE-7,LANE-10,LANE-11"]);
    const lane6 = stepRow(next, "merge:LANE-6");
    expect(lane6.textContent).toContain("Merge · #6 · checks 4/4 · approved");
    expect(lane6.querySelector("[data-do-then]")!.textContent).toBe("Then LANE-17 stops waiting on LANE-6 and is next to merge");
    fireEvent.click(within(lane6).getByRole("button", { name: "Open LANE-6's pull request #6" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "https://github.com/acme/shop/pull/6" });
    // Three pull requests that merge in any order share one row, and its button lists each one.
    const group = stepRow(next, "merge:LANE-7,LANE-10,LANE-11");
    fireEvent.click(within(group).getByRole("button", { name: "3 PRs" }));
    const list = await slot.findByRole("dialog", { name: "3 pull requests" });
    fireEvent.click(within(list).getAllByRole("button")[1]!);
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "https://github.com/acme/shop/pull/10" });
    fireEvent.click(within(group).getByRole("button", { name: "Open LANE-10" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("lane/LANE-10"));
  });

  it("names every hold of the rest, the merge order's and the rollout's, and folds the smaller groups", async () => {
    const slot = await mountPage("lane", { project: () => laneShip() });
    const next = await openShip(slot);
    const held = next.querySelector<HTMLElement>("[data-do-held]")!;
    expect(held.querySelector("h3")!.textContent).toBe("Held8");
    expect([...held.querySelectorAll("[data-held-why]")].map((row) => row.getAttribute("data-held-why"))).toEqual(["Payments freeze is on until Jan 13", "Expand is not all live · Payments freeze is on until Jan 13", "final review held", "blocked"]);
    fireEvent.click(within(held).getByRole("button", { name: "2 more reasons" }));
    expect(within(held).getByText("stacked on LANE-35 · 1 check failing")).toBeTruthy();
    expect(within(held).getByRole("button", { name: "Fewer" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(held).getByRole("button", { name: "Open LANE-36" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("lane/LANE-36"));
  });

  it("marks a step live in one click and keeps Undo live beside it", async () => {
    const markLive = vi.fn(() => ({ ok: true }) as never);
    const slot = await mountPage("lane", { project: () => laneShip({ rollout: laneRollout({ windows: [] }) }), markLive });
    const next = await openShip(slot);
    fireEvent.click(within(stepRow(next, "live:LANE-4")).getByRole("button", { name: "Mark live" }));
    await waitFor(() => expect(calls(slot, "markLive").map((call) => call.input)).toEqual([{ slug: "lane", target: "LANE-4", confirm: true }]));
    const marked = await waitFor(() => next.querySelector<HTMLElement>('[data-do-marked="LANE-4"]')!);
    fireEvent.click(within(marked).getByRole("button", { name: "Undo live" }));
    await waitFor(() => expect(calls(slot, "markLive").at(-1)!.input).toEqual({ slug: "lane", target: "LANE-4", undo: true, confirm: true }));
    await waitFor(() => expect(next.querySelector('[data-do-marked="LANE-4"]')).toBeNull());
  });

  it("says in the rollout's next step what Do next says, when the merge order holds it", async () => {
    const slot = await mountPage("lane", { project: () => laneShip() });
    await openShip(slot);
    fireEvent.click(await slot.findByRole("tab", { name: /^Rollout/ }));
    const card = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-rollout-next]") ?? slot.getByText(/cannot merge yet/));
    expect(slot.getByText("LANE-36 cannot merge yet: stacked on LANE-35 · 1 check failing")).toBeTruthy();
    expect(card).toBeTruthy();
    expect(slot.queryByText("Merge LANE-36, then deploy it")).toBeNull();
  });

  it("confirms a merge in place with its commit, and releases a held draft, where the person confirms merges", async () => {
    const confirmMerge = vi.fn(() => ticketDetail({ key: "CSV-12", state: "done" }));
    const releaseDraft = vi.fn(() => ticketDetail({ key: "CSV-3", state: "pr_open" }));
    const slot = await mountPage("csv", { project: () => csvShip(), confirmMerge, releaseDraft });
    const next = await openShip(slot);
    const confirm = stepRow(next, "confirm:CSV-12");
    expect(confirm.textContent).toContain("Confirm merge · #418 · 9f3c2e1 · checks 6/6 · approved");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm merge" }));
    fireEvent.click(within(confirm).getByRole("button", { name: "Yes, merge 9f3c2e1" }));
    await waitFor(() => expect(calls(slot, "confirmMerge").map((call) => call.input)).toEqual([{ key: "CSV-12", prUrl: "https://github.com/acme/shop/pull/418", sha: "9f3c2e1a7b4d5e6f8091a2b3c4d5e6f708192a3b", confirm: true }]));
    const draft = stepRow(next, "release:CSV-3");
    fireEvent.click(within(draft).getByRole("button", { name: "Open CSV-3's pull request #403" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "https://github.com/acme/shop/pull/403" });
    fireEvent.click(within(draft).getByRole("button", { name: "Release draft" }));
    fireEvent.click(within(draft).getByRole("button", { name: "Yes, mark it ready for review" }));
    await waitFor(() => expect(calls(slot, "releaseDraft").map((call) => call.input)).toEqual([{ key: "CSV-3", prUrl: "https://github.com/acme/shop/pull/403", confirm: true }]));
  });

  it("says when there is nothing to do, and shows no Do next for an integration project", async () => {
    const empty = projectView({ overview: overview({ strategy: "pr", branch: null }), board: [], mergeOrder: { repos: [null], steps: 0, entries: [], counts: { open: 0, first: 0, ready: 0, wrong: 0 } } });
    const slot = await mountPage("csv", { project: () => empty });
    const next = await openShip(slot);
    expect(next.querySelector("[data-do-empty]")!.textContent).toBe("Nothing to merge or mark live now");
    cleanup();
    const integration = projectView({ overview: overview({ strategy: "integration", branch: "loom/csv", state: "running" }) });
    const other = await mountPage("csv", { project: () => integration });
    fireEvent.click(await other.findByRole("tab", { name: /^Ship/ }));
    await other.findByRole("tablist", { name: "Ship" });
    expect(other.queryByRole("region", { name: "Do next" })).toBeNull();
  });
});

describe("every Ship surface reads one readiness", () => {
  const HELD = ["LANE-35", "LANE-36", "LANE-37", "LANE-38"];
  const PROMISE = /can (merge|go)|Ready to merge|Merge now|Merge, then deploy|Deploy now|(Merge|Ready|Deploy) after/;
  // Each clause that promises a merge or a deploy, with the ticket a merge frees it from taken out of it.
  const promises = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("p, li, h3, [data-merge-verdict], [data-rollout-status], [data-do-then]")]
      .flatMap((element) => (element.textContent ?? "").split(/(?<=\.)\s+|\s·\s/))
      .filter((clause) => PROMISE.test(clause))
      .map((clause) => clause.replace(/stops waiting on LANE-\d+/g, ""));

  for (const freeze of [false, true]) {
    it(`promises no merge or deploy for a held ticket on Do next, the merge order, its graph or the rollout${freeze ? ", during a freeze" : ""}`, async () => {
      const slot = await mountPage("lane", { project: () => laneHeld({ freeze }) });
      const next = await openShip(slot);
      expect([...next.querySelectorAll("[data-do-step]")].map((row) => row.getAttribute("data-do-step")).filter((id) => HELD.some((key) => id!.includes(key)))).toEqual([]);
      const seen: string[] = promises(next);
      fireEvent.click(await slot.findByRole("tab", { name: /^Merge order/ }));
      const order = await element(slot, "[data-merge-order]");
      expect(order.querySelector("[data-merge-lead]")!.textContent).not.toMatch(/\d+ (is|are) ready to merge now/);
      seen.push(...promises(order));
      for (const key of HELD) expect(order.querySelector(`[data-merge-row="${key}"] [data-merge-verdict]`)?.textContent ?? "", key).not.toBe("✓ Ready to merge");
      fireEvent.click(within(order).getByRole("button", { name: "By repo" }));
      const graph = await element(slot, "[data-merge-graph]");
      seen.push(...promises(graph));
      // A node's chips wrap inside it: no chip in the graph may keep the no-wrap utility, which wins over a wrapping one.
      const chips = [...graph.querySelectorAll<HTMLElement>("[data-merge-card] [data-merge-chip]")];
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) expect(chip.className.split(" "), chip.textContent!).not.toContain("whitespace-nowrap");
      fireEvent.click(await slot.findByRole("tab", { name: /^Rollout/ }));
      const rollout = await element(slot, "[data-rollout]");
      seen.push(...promises(rollout));
      for (const clause of seen) for (const key of HELD) expect(clause, clause).not.toContain(key);
      for (const key of HELD) expect(rollout.querySelector(`[data-rollout-row="${key}"] [data-rollout-status]`)!.getAttribute("data-rollout-status"), key).not.toBe("merge");
      // The free one still reads as free, so the check above is not passing on silence.
      expect(rollout.querySelector("[data-rollout-then]")!.textContent).toContain("LANE-6 can go now too. LANE-35, LANE-38 and LANE-37 are next in order too, still held.");
      // The next step's card says what holds its merge, and leaves Mark live to the step's own tile while it is unmerged.
      const card = rollout.querySelector<HTMLElement>("[data-rollout-next]")!;
      expect(card.querySelector("[data-rollout-merge-hold]")!.textContent).toBe(freeze ? "Not yet: stacked on LANE-35 · Payments freeze is on until Jan 13 · it needs LANE-4 live first." : "Not yet: stacked on LANE-35 · it needs LANE-4 live first.");
      expect(within(card).queryByRole("button", { name: "Mark LANE-36 live" })).toBeNull();
    });
  }

  // A status that waits for the rollout promises its step only when that wait is all that holds it.
  const CONDITIONAL = /(Merge|Ready|Deploy) after|Merge now|Merge, then deploy/;
  const variants = [
    { name: "when Expand's soak is all that holds LANE-37", over: { freeze: false }, lane37: "Merge after expand merging deploys it" },
    { name: "when a freeze outlasts the soak", over: { freeze: true }, lane37: "Not yet after expand, still held: Payments freeze is on until Jan 13" },
    { name: "when a review is still owed after the soak", over: { freeze: false, reviewOwed: true }, lane37: "Not yet after expand, still held: needs review" },
  ];
  for (const variant of variants) {
    it(`promises a step after its stage or a requirement, on its tile and its stage's bar, only when nothing else holds it, ${variant.name}`, async () => {
      const view = laneHeld(variant.over);
      const slot = await mountPage("lane", { project: () => view });
      await openShip(slot);
      fireEvent.click(await slot.findByRole("tab", { name: /^Rollout/ }));
      const rollout = await element(slot, "[data-rollout]");
      const steps = view.rollout!.stages.flatMap((stage) => stage.steps);
      const said = [
        ...steps.map((one) => [one.key, rollout.querySelector(`[data-rollout-row="${one.key}"] [data-rollout-status]`)?.textContent ?? ""] as const),
        ...[...rollout.querySelectorAll<HTMLElement>("i[title]")].map((bar) => bar.title.split(": ") as [string, string]),
      ];
      expect(said.filter(([, text]) => text !== "").length).toBeGreaterThan(steps.length);
      for (const [key, text] of said) {
        const one = steps.find((each) => each.key === key);
        if (one === undefined || one.live !== null || one.merge === "merged" || !CONDITIONAL.test(text)) continue;
        expect(stepCanGo(key, view.mergeOrder, view.rollout!, { soaked: true, live: one.requires.map((need) => need.target) }), `${key}: ${text}`).toBe(true);
      }
      expect(rollout.querySelector('[data-rollout-row="LANE-37"] [data-rollout-status]')!.textContent).toBe(variant.lane37);
    });
  }

  for (const freeze of [false, true]) {
    it(`advises deploying a merged step only when no freeze is on, on Do next, its tile, its stage's bar and the next step's card${freeze ? ", during a freeze" : ""}`, async () => {
      const rollout = laneRollout({ ...(freeze ? {} : { windows: [] }), next: { kind: "deploy", keys: ["LANE-4"], stage: "expand", until: null, text: "Deploy LANE-4." } });
      const slot = await mountPage("lane", { project: () => laneShip({ rollout }) });
      const next = await openShip(slot);
      expect(next.querySelector('[data-do-step="live:LANE-4"]') === null).toBe(freeze);
      if (freeze) expect(within(next.querySelector<HTMLElement>("[data-do-held]")!).getByText("Payments freeze is on until Jan 13")).toBeTruthy();
      fireEvent.click(await slot.findByRole("tab", { name: /^Rollout/ }));
      const tab = await element(slot, "[data-rollout]");
      const card = tab.querySelector<HTMLElement>('[data-rollout-next="deploy"]')!;
      expect(card.querySelector("h3")!.textContent).toBe(freeze ? "LANE-4 cannot deploy yet: Payments freeze is on until Jan 13" : "Deploy LANE-4");
      expect(card.querySelector("[data-rollout-deploy-hold]")?.textContent ?? null).toBe(freeze ? "Not yet: Payments freeze is on until Jan 13." : null);
      expect(within(card).queryByRole("button", { name: "Mark LANE-4 live" }) === null).toBe(freeze);
      const said = (key: string) => tab.querySelector(`[data-rollout-row="${key}"] [data-rollout-status]`)!.textContent!.replace(/\s+/g, " ").trim();
      expect(said("LANE-4")).toBe(freeze ? "Not yet Payments freeze is on until Jan 13" : "Deploy now");
      expect(said("LANE-31")).toBe(freeze ? "Deploy after expand then still held: Payments freeze is on until Jan 13" : "Deploy after expand");
      const bars = [...tab.querySelectorAll<HTMLElement>("i[title]")].map((bar) => bar.title);
      expect(bars).toContain(freeze ? "LANE-4: Not yet" : "LANE-4: Deploy now");
      // With the freeze on, nothing on the page tells the person to deploy LANE-4 now.
      if (freeze) for (const text of [...slot.container.querySelectorAll<HTMLElement>("h3, p, li, [data-rollout-status], [data-do-step]")].map((one) => one.textContent ?? "")) expect(text, text).not.toMatch(/Deploy (now|LANE-4)|LANE-4[^.]* can go now/);
    });
  }

  it("keeps a freeze in Confirm merge's Then and in Do next's, for a ticket the merge frees from its wait", async () => {
    const view = csvShip({ rollout: laneRollout({ stages: [{ ...laneRollout().stages[0]!, steps: [{ ...laneRollout().stages[0]!.steps[1]!, key: "CSV-15", onMerge: true }] }], next: { kind: "done", keys: [], stage: null, until: null, text: "" } }) });
    const slot = await mountPage("csv", { project: () => view });
    const next = await openShip(slot);
    expect(stepRow(next, "confirm:CSV-12").querySelector("[data-do-then]")!.textContent).toBe("Then CSV-15 stops waiting on CSV-12, but 1 check failing and Payments freeze is on until Jan 13 still hold it · CSV-16 stops waiting on CSV-12 and is next to merge");
  });
});

describe("the ticket's Confirm merge", () => {
  it("warns, as Do next holds it, when merging deploys the change during a freeze", async () => {
    const view = laneShip();
    const confirm = { prUrl: "https://github.com/acme/shop/pull/26", sha: "b".repeat(40), ready: true, waiting: null, confirmed: false, requested: null };
    view.board = view.board.map((one) => (one.key === "LANE-26" ? { ...one, mergeConfirm: confirm } : one));
    const slot = await mountPage("lane/LANE-26", { project: () => view, ticket: ({ key }) => ticketDetail({ key, state: "pr_open", prUrl: confirm.prUrl, mergeConfirm: confirm }) });
    const hold = await element(slot, "[data-merge-hold]");
    expect(hold.textContent).toBe("Hold off: merging deploys it, and Payments freeze is on until Jan 13.");
    expect(slot.getByRole("button", { name: "Confirm merge" })).toBeTruthy();
  });
});

// ---- Insights across projects, from the pure calculation over a few projects' rows

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 14, 40);
function rowsOf(id: number, slug: string, key: string, done: Array<[start: number, end: number]>, state: ProjectRow["state"] = "running"): InsightsRows {
  const project = { id, slug, key, name: `${key} project`, state, bb_project_id: `proj_${id}` } as ProjectRow;
  const tickets = done.map((_, n) => ({ id: id * 100 + n, key: `${key}-${n + 1}`, repo: null, state: "done", review_round: 1 }) as TicketRow);
  const events: EventRow[] = done.flatMap(([start, end], n) => [
    { id: n * 2 + 1, project_id: id, ticket_id: id * 100 + n, at: NOW - start * DAY, kind: "ticket.state", actor: "loom", data_json: JSON.stringify({ from: "queued", to: "working" }) },
    { id: n * 2 + 2, project_id: id, ticket_id: id * 100 + n, at: NOW - end * DAY, kind: "ticket.state", actor: "loom", data_json: JSON.stringify({ from: "review", to: "done" }) },
  ]);
  const threads = done.map(([start], n) => ({ id: id * 1000 + n, thread_id: `thr_${id}_${n}`, ticket_id: id * 100 + n, role: "worker", started_at: NOW - start * DAY, tokens: 1_000_000, model: n % 2 === 0 ? "claude / opus" : null }) as ThreadRow);
  return { project, tickets, events, threads, reviews: [] };
}
const ROWS = [rowsOf(1, "csv", "CSV", [[3, 2], [10, 8], [15, 14]]), rowsOf(2, "lane", "LANE", [[20, 1]]), rowsOf(3, "old", "OLD", [[6, 5]], "done"), rowsOf(4, "older", "OLDER", [[9, 9]], "archived")];
const serve = (input: { weeks: 4 | 12; from?: number; to?: number; slugs?: string[] }): InsightsAllView => insightsAll(ROWS, { now: NOW, weeks: input.weeks, range: input.from === undefined || input.to === undefined ? null : { from: input.from, to: input.to }, slugs: input.slugs });

describe("Insights across projects", () => {
  it("is in the sidebar under Home, and in the palette", async () => {
    const sidebar = await mountSidebar("_home");
    fireEvent.click(await sidebar.findByRole("button", { name: "Insights" }));
    expect(sidebar.inspection.navigateCalls.at(-1)).toEqual(pushed("_insights"));
    cleanup();
    const on = await mountSidebar("_insights");
    expect((await on.findByRole("button", { name: "Insights" })).getAttribute("aria-current")).toBe("page");
  });

  it("shows five figures, done per week as one labelled row per project on one scale, and the tables", async () => {
    const insightsAllRpc = vi.fn((input: Parameters<typeof serve>[0]) => serve(input));
    const slot = await mountPage("_insights", { insightsAll: insightsAllRpc as never });
    const figures = await element(slot, "[data-insights-figures]");
    expect([...figures.querySelectorAll("[data-figure]")].map((one) => one.getAttribute("data-figure"))).toEqual(["Done", "Median cycle", "Review rounds", "Blocked", "Tokens, threads started"]);
    expect(figures.querySelector('[data-figure="Done"] dd')!.textContent).toBe("6");
    expect(figures.querySelector("[data-cost-unrecorded]")!.textContent).toContain("cost not recorded yet");
    // Tokens are named for what they are, a start cohort, and a thread with no report is counted apart, never as 0.
    expect(slot.container.querySelector("[data-tokens-note]")!.textContent).toContain("not what a stretch used");
    // Each series sits in its own row with its name beside it, so no two are told apart by a shade (defect A7).
    expect([...slot.container.querySelectorAll("[data-multiple]")].map((one) => one.getAttribute("data-multiple"))).toEqual(["CSV", "LANE", "Finished"]);
    const projects = slot.container.querySelector<HTMLElement>("[data-insights-projects]")!;
    expect([...projects.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")!.textContent)).toEqual(["CSV", "LANE", "Finished · 2"]);
    fireEvent.click(within(projects).getByRole("button", { name: "LANE" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("lane"));
    const models = slot.container.querySelector<HTMLElement>("[data-insights-models]")!;
    expect([...models.querySelectorAll("[data-model-row]")].map((row) => row.getAttribute("data-model-row"))).toEqual(["claude / opus", "unrecorded"]);
    expect(slot.container.querySelector("[data-model-unrecorded]")!.textContent).toBe("1 thread started before Loom recorded models, or are planners");
  });

  it("narrows to the projects chosen, finished ones as one choice, keeps the choice on the device, and reads 12 weeks", async () => {
    const insightsAllRpc = vi.fn((input: Parameters<typeof serve>[0]) => serve(input));
    const slot = await mountPage("_insights", { insightsAll: insightsAllRpc as never });
    const scope = await slot.findByRole("group", { name: "Projects" });
    expect(within(scope).getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "CSV", "LANE", "Finished2"]);
    fireEvent.click(within(scope).getByRole("button", { name: "LANE" }));
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 4, slugs: ["lane"] }));
    expect(within(scope).getByRole("button", { name: "LANE" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(scope).getByRole("button", { name: /^Finished/ }));
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 4, slugs: ["lane", "old", "older"] }));
    expect(JSON.parse(localStorage.getItem("loom.insightsScope")!)).toEqual(["lane", "old", "older"]);
    fireEvent.click(within(scope).getByRole("button", { name: "All" }));
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 4 }));
    fireEvent.click(within(await slot.findByRole("group", { name: "Window" })).getByRole("button", { name: "12 weeks" }));
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 12 }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-day]")).toHaveLength(84));
  });

  it("counts a stretch of days picked with the keys, says so, and clears it with Escape or its ×", async () => {
    const insightsAllRpc = vi.fn((input: Parameters<typeof serve>[0]) => serve(input));
    const slot = await mountPage("_insights", { insightsAll: insightsAllRpc as never });
    const chart = await element(slot, "[data-daily-chart]");
    const days = serve({ weeks: 4 }).dayStarts;
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    fireEvent.keyDown(chart, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(chart, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(chart, { key: "Enter" });
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 4, from: days[25], to: NOW }));
    const counting = await element(slot, "[data-insights-counting]");
    expect(counting.textContent).toContain("Counting Nov 8 to Nov 10");
    expect(slot.container.querySelector('[data-figure="Done"] dd')!.textContent).toBe("2");
    fireEvent.keyDown(chart, { key: "Escape" });
    await waitFor(() => expect(insightsAllRpc).toHaveBeenLastCalledWith({ weeks: 4 }));
    fireEvent.keyDown(chart, { key: "Home" });
    fireEvent.keyDown(chart, { key: "Enter" });
    await waitFor(() => expect(slot.container.querySelector("[data-insights-counting]")).not.toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Count the whole window" }));
    await waitFor(() => expect(slot.container.querySelector("[data-insights-counting]")).toBeNull());
  });

  it("shows a token figure with no report as not recorded, and counts the unreported threads beside a partial one", async () => {
    const unreported = (input: Parameters<typeof serve>[0]) => {
      const view = serve(input);
      const [first, ...rest] = view.projects;
      return {
        ...view,
        totals: { ...view.totals, tokens: 6_000_000, threads: 8, unreported: 2 },
        projects: [{ ...first!, tokens: 0, threads: 2, unreported: 2, perDone: null }, ...rest.map((row) => ({ ...row, threads: 6, unreported: 0 }))],
        byRepo: view.byRepo.map((row, n) => ({ ...row, threads: 2, unreported: n === 0 ? 1 : 0 })),
      };
    };
    const slot = await mountPage("_insights", { insightsAll: ((input: Parameters<typeof serve>[0]) => unreported(input)) as never });
    const figure = await element(slot, '[data-figure="Tokens, threads started"]');
    expect(figure.querySelector("dd")!.textContent).toBe("6.0M");
    expect(figure.querySelector("[data-tokens-unreported]")!.textContent).toBe("2 of 8 threads unreported · ");
    const projects = slot.container.querySelector<HTMLElement>("[data-insights-projects]")!;
    const first = projects.querySelector("tbody tr")!;
    expect(first.querySelector("[data-tokens-cell]")!.textContent).toBe("not recorded");
    expect(slot.container.querySelector("[data-insights-repos] [data-tokens-cell]")!.textContent).toMatch(/1 unreported$/);
    // With no thread reporting at all, the figure says so rather than 0.
    cleanup();
    const none = await mountPage("_insights", { insightsAll: ((input: Parameters<typeof serve>[0]) => ({ ...serve(input), totals: { ...serve(input).totals, tokens: 0, threads: 3, unreported: 3, perDone: null } })) as never });
    expect((await element(none, '[data-figure="Tokens, threads started"]')).querySelector("dd")!.textContent).toBe("not recorded");
  });

  it("folds the repos past six, and says when nothing happened in the window", async () => {
    const many = (input: Parameters<typeof serve>[0]) => {
      const view = serve(input);
      return { ...view, byRepo: Array.from({ length: 9 }, (_, n) => ({ repo: `r${n}`, name: `repo-${n}`, slug: "csv", key: "CSV", tokens: 9 - n, threads: 1, unreported: 0, done: 1, total: 2 })) };
    };
    const slot = await mountPage("_insights", { insightsAll: ((input: Parameters<typeof serve>[0]) => many(input)) as never });
    const repos = await element(slot, "[data-insights-repos]");
    expect(repos.querySelectorAll("[data-repo-row]")).toHaveLength(6);
    fireEvent.click(slot.getByRole("button", { name: "3 more" }));
    expect(repos.querySelectorAll("[data-repo-row]")).toHaveLength(9);
    cleanup();
    const quiet = await mountPage("_insights", { insightsAll: (() => insightsAll([rowsOf(9, "new", "NEW", [])], { now: NOW, weeks: 4 })) as never });
    expect((await element(quiet, "[data-insights-empty]")).textContent).toBe("No ticket done and no agent thread started in the last 4 weeks");
  });

  it("says what failed and retries", async () => {
    let fail = true;
    const slot = await mountPage("_insights", {
      insightsAll: (() => {
        if (fail) throw new Error("OTLP's events could not be read");
        return serve({ weeks: 4 });
      }) as never,
    });
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("Insights did not load");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.container.querySelector("[data-insights-figures]")).not.toBeNull());
  });

  it("is reached from a project's History Insights", async () => {
    const view = projectView({ overview: overview({ repos: [repoOverview()] }), board: [card()] });
    const slot = await mountPage("csv", { project: () => view, insights: unexpected });
    fireEvent.click(await slot.findByRole("tab", { name: "History" }));
    fireEvent.click(await slot.findByRole("tab", { name: "Insights" }));
    fireEvent.click(await slot.findByRole("button", { name: "Across projects" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("_insights"));
    expect(calls(slot, "insightsAll")).toHaveLength(0);
  });
});

export type { ProjectView };
