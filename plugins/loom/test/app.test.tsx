// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot, type PluginRpcTestHandlers, type PluginSdkTestFakes, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps, PluginSidebarThread, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { Attempt, ChecksItem, HomeProject, NextStep, PlanningSession, ProjectSummary, SentNote, ThreadInfo, rpcContract } from "../src/contract";
import { notesMessage } from "../src/prompts";
import { ConfirmButton, MoreMenu } from "../src/ui/common";
import { questionsOf } from "../src/ui/questions";
import { HOUR, NOW, agent, attempt, card, feedRow, health, homeProject, homeView, metrics, overview, projectView, specVersionView, ticketDetail, timeline } from "./fixtures";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const handlers = (over: Partial<Handlers> = {}): Handlers => ({
  projects: unexpected,
  home: unexpected,
  metrics: unexpected,
  project: unexpected,
  ticket: unexpected,
  runOutput: unexpected,
  feed: unexpected,
  timeline: () => timeline(),
  threadInfo: () => null,
  reply: unexpected,
  ticketAction: unexpected,
  control: unexpected,
  startPlanning: unexpected,
  planning: () => [],
  planningSession: () => null,
  specVersion: unexpected,
  sendNotes: unexpected,
  ...over,
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
});

describe("registration", () => {
  it("lists Loom in the left navigation with the Layers icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map(({ id, title, icon, path }) => ({ id, title, icon, path }))).toEqual([{ id: "loom", title: "Loom", icon: "Layers", path: "loom" }]);
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "ticket", title: "Loom" }]);
    expect(app.contentScripts.map(({ id }) => id)).toEqual(["rail-badge"]);
  });

  it("is declared as the plugin's app entry", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(manifest.bb).toMatchObject({ server: "./server.ts", app: "./app.tsx", host: "./host.ts" });
  });
});

describe("thread header chip", () => {
  const mountChip = async (info: ThreadInfo | null, props: Partial<PluginThreadHeaderActionProps> = {}) => {
    const app = await loadPluginApp(() => import("../app"));
    const threadInfo = (input: { threadId: string }) => (input.threadId === "thr_known" ? info : null);
    const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(app.threadHeaderActions[0]!, { threadId: "thr_known", projectId: "proj_1", isCompactViewport: false, ...props }, { pluginId: "loom", rpc: handlers({ threadInfo }) });
    mounts.push(slot);
    return slot;
  };

  it("shows the ticket and its state for a worker thread", async () => {
    const slot = await mountChip({ role: "worker", slug: "csv", key: "CSV-3", state: "review" });
    expect((await slot.findByRole("button", { name: "Open CSV-3 in Loom" })).textContent).toBe("CSV-3 · review");
    expect(slot.inspection.rpcCalls).toEqual([{ method: "threadInfo", input: { threadId: "thr_known" } }]);
  });

  it("shows the ticket for a reviewer and the project for a planner", async () => {
    const reviewer = await mountChip({ role: "reviewer", slug: "csv", key: "CSV-3", state: "review" });
    expect((await reviewer.findByRole("button")).textContent).toBe("CSV-3 · review");
    document.body.replaceChildren();
    const planner = await mountChip({ role: "planner", slug: "csv", key: null, state: "running" });
    expect((await planner.findByRole("button", { name: "Open csv in Loom" })).textContent).toBe("csv");
  });

  it("shows nothing for a thread that is not a Loom thread", async () => {
    const slot = await mountChip(null, { threadId: "thr_other" });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.container.textContent).toBe("");
  });

  it("shows nothing on a compact viewport, and does not ask", async () => {
    const slot = await mountChip({ role: "worker", slug: "csv", key: "CSV-3", state: "review" }, { isCompactViewport: true });
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  it("opens the ticket on the page when clicked, and the project for a planner", async () => {
    const worker = await mountChip({ role: "worker", slug: "csv", key: "CSV-3", state: "review" });
    fireEvent.click(await worker.findByRole("button"));
    expect(worker.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-3" } }]);
    document.body.replaceChildren();
    const planner = await mountChip({ role: "planner", slug: "csv", key: null, state: "running" });
    fireEvent.click(await planner.findByRole("button"));
    expect(planner.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv" } }]);
  });

  it("shows Planning for a planning conversation that has no spec yet, and opens it on the page", async () => {
    const slot = await mountChip({ role: "planner", slug: null, key: null, state: "planning" });
    const chip = await slot.findByRole("button", { name: "Open this planning conversation in Loom" });
    expect(chip.textContent).toBe("Planning");
    fireEvent.click(chip);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "_plan/thr_known" } }]);
  });

  it("asks again on any project's change while it shows a planning conversation, which becomes a project when it proposes", async () => {
    let info: ThreadInfo = { role: "planner", slug: null, key: null, state: "planning" };
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(app.threadHeaderActions[0]!, { threadId: "thr_known", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "loom",
      rpc: handlers({ threadInfo: () => info }),
    });
    mounts.push(slot);
    expect((await slot.findByRole("button")).textContent).toBe("Planning");
    info = { role: "planner", slug: "csv", key: null, state: "draft" };
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(slot.getByRole("button", { name: "Open csv in Loom" }).textContent).toBe("csv"));
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("asks again when its project changes, so the state stays current", async () => {
    let state = "review";
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(app.threadHeaderActions[0]!, { threadId: "thr_known", projectId: "proj_1", isCompactViewport: false }, {
      pluginId: "loom",
      rpc: handlers({ threadInfo: () => ({ role: "worker", slug: "csv", key: "CSV-3", state }) }),
    });
    mounts.push(slot);
    expect((await slot.findByRole("button")).textContent).toBe("CSV-3 · review");
    state = "approved";
    await slot.emitRealtime("loom:changed", { slug: "other" });
    expect(slot.inspection.rpcCalls).toHaveLength(1);
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(slot.getByRole("button").textContent).toBe("CSV-3 · approved"));
  });

  describe("a response that arrives after the thread changed", () => {
    const worker = (key: string): ThreadInfo => ({ role: "worker", slug: "csv", key, state: "working" });
    const mountSwitching = async () => {
      const app = await loadPluginApp(() => import("../app"));
      const late: Array<(info: ThreadInfo | null) => void> = [];
      let reads = 0;
      const threadInfo = ({ threadId }: { threadId: string }): ThreadInfo | null | Promise<ThreadInfo | null> => {
        if (threadId === "thr_other") return null;
        if (threadId === "thr_next") return worker("CSV-2");
        reads += 1;
        return reads === 1 ? worker("CSV-1") : new Promise((resolve) => late.push(resolve));
      };
      const slot = renderSlot<PluginThreadHeaderActionProps, typeof rpcContract>(app.threadHeaderActions[0]!, { threadId: "thr_loom", projectId: "proj_1", isCompactViewport: false }, { pluginId: "loom", rpc: handlers({ threadInfo }) });
      mounts.push(slot);
      await slot.findByRole("button", { name: "Open CSV-1 in Loom" });
      await slot.emitRealtime("loom:changed", { slug: "csv" });
      const Chip = app.threadHeaderActions[0]!.component;
      const switchTo = (threadId: string) => slot.lifecycle.rerender(<Chip threadId={threadId} projectId="proj_1" isCompactViewport={false} />);
      return { slot, late, switchTo };
    };

    it("does not show the previous thread's chip on a thread that is not a Loom thread", async () => {
      const { slot, late, switchTo } = await mountSwitching();
      switchTo("thr_other");
      await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({ threadId: "thr_other" }));
      await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
      await act(async () => late[0]!(worker("CSV-1")));
      expect(slot.queryByRole("button")).toBeNull();
    });

    it("does not replace the new thread's chip with the previous thread's", async () => {
      const { slot, late, switchTo } = await mountSwitching();
      switchTo("thr_next");
      await slot.findByRole("button", { name: "Open CSV-2 in Loom" });
      await act(async () => late[0]!(worker("CSV-1")));
      expect(slot.getByRole("button").textContent).toBe("CSV-2 · working");
    });
  });
});

describe("rail badge", () => {
  let body: unknown;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => body }) as unknown as Response);
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  const mountBadge = async (first: unknown) => {
    body = first;
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = '<nav><span data-nav-rail-item="loom/loom"><button aria-label="Loom"></button></span></nav>';
    const app = await loadPluginApp(() => import("../app"));
    const scripts = await mountPluginContentScripts(app, { pluginId: "loom" });
    disposers.push(() => scripts.lifecycle.dispose());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    return { scripts, button: () => document.querySelector<HTMLElement>('[data-nav-rail-item="loom/loom"] button')! };
  };
  const badge = (button: HTMLElement) => button.querySelector<HTMLElement>("[data-loom-badge]");
  const pollNow = () => document.dispatchEvent(new Event("visibilitychange"));

  it("draws the route's count on the Loom rail button, as 9+ above 9, and nothing at 0", async () => {
    const { button } = await mountBadge({ count: 2, label: "2 things need you in Loom" });
    await waitFor(() => expect(badge(button())?.textContent).toBe("2"));
    expect(badge(button())!.getAttribute("aria-hidden")).toBe("true");
    expect(button().getAttribute("aria-description")).toBe("2 things need you in Loom");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/plugins/loom/http/badge", expect.anything());

    body = { count: 12, label: "12 things need you in Loom" };
    pollNow();
    await waitFor(() => expect(badge(button())?.textContent).toBe("9+"));

    body = { count: 0, label: "Nothing needs you in Loom" };
    pollNow();
    await waitFor(() => expect(badge(button())).toBeNull());
    expect(button().hasAttribute("aria-description")).toBe(false);
  });

  it("keeps the last count when the route fails, and draws it again when the rail re-renders", async () => {
    const { button } = await mountBadge({ count: 3, label: "3 things need you in Loom" });
    await waitFor(() => expect(badge(button())?.textContent).toBe("3"));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    pollNow();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(badge(button())?.textContent).toBe("3");

    document.querySelector("[data-nav-rail-item]")!.replaceChildren(document.createElement("button"));
    await waitFor(() => expect(badge(button())?.textContent).toBe("3"));
  });

  it("removes the count, its description and the inline position when disposed", async () => {
    const { scripts, button } = await mountBadge({ count: 2, label: "2 things need you in Loom" });
    await waitFor(() => expect(badge(button())?.textContent).toBe("2"));
    expect(button().style.position).toBe("relative");
    await scripts.lifecycle.dispose();
    expect(badge(button())).toBeNull();
    expect(button().hasAttribute("aria-description")).toBe(false);
    expect(button().style.position).toBe("");
  });
});

// The question plugin's wire format: q1 as bb's built-in Ask User Question sends it, q2 with Better Ask's extra fields.
const singleSelect = {
  id: "q1",
  prompt: "How should finished tickets merge?",
  shortLabel: "Merge plan",
  multiSelect: false,
  allowFreeText: false,
  options: [
    { value: "o1", label: "Integration branch", description: "One branch, landed at the end" },
    { value: "o2", label: "PR per ticket" },
  ],
};
const multiSelect = {
  id: "q2",
  prompt: "Which checks must pass?",
  shortLabel: "Checks",
  multiSelect: true,
  allowFreeText: true,
  allowNotes: true,
  allowSkip: true,
  context: "Each runs in the ticket's worktree.",
  options: [
    { value: "o1", label: "npm test" },
    { value: "o2", label: "npm run typecheck", recommended: true },
    { value: "o3", label: "npm run build", preview: "tsc && vite build" },
  ],
};

describe("questionsOf", () => {
  it("returns the questions of a built-in and a Better Ask payload", () => {
    expect(questionsOf({ questions: [singleSelect] })).toEqual([singleSelect]);
    expect(questionsOf({ questions: [singleSelect, multiSelect] })).toEqual([singleSelect, multiSelect]);
  });

  it("is null for a payload it cannot draw", () => {
    expect(questionsOf(null)).toBeNull();
    expect(questionsOf("How should it merge?")).toBeNull();
    expect(questionsOf({})).toBeNull();
    expect(questionsOf({ questions: [] })).toBeNull();
    expect(questionsOf({ questions: [{ ...singleSelect, options: [{ label: "No value" }] }] })).toBeNull();
    expect(questionsOf({ questions: [{ ...singleSelect, options: [{ value: 1, label: "Number" }] }] })).toBeNull();
    const { multiSelect: _, ...noMultiSelect } = singleSelect;
    expect(questionsOf({ questions: [noMultiSelect] })).toBeNull();
    expect(questionsOf({ questions: [{ ...singleSelect, multiSelect: "no" }] })).toBeNull();
    expect(questionsOf({ questions: [{ ...multiSelect, context: 3 }] })).toBeNull();
  });
});

// ---------------------------------------------------------------- the page

async function mountPage(subPath: string, rpc: Partial<Handlers> = {}, options: Pick<RenderSlotOptions<typeof rpcContract>, "sdk" | "sidebarThreads"> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath }, { pluginId: "loom", rpc: handlers(rpc), ...options });
  mounts.push(slot);
  const Panel = app.navPanels[0]!.component;
  const goTo = (next: string) => slot.lifecycle.rerender(<Panel subPath={next} />);
  return { slot, goTo };
}
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "loom", options: { subPath } });

describe("project list", () => {
  afterEach(() => localStorage.clear());
  const two: HomeProject[] = [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "paused", reason: "The token budget is used up: 900 of 900 tokens.", strategy: "pr", branch: null, ticketCount: 3, ticketCounts: { queued: 3 } })];
  const home = () => homeView({ projects: two });

  it("lists every project with its state, strategy, counts and the reason the plugin paused it", async () => {
    const { slot } = await mountPage("", { home });
    await slot.findByText("CSV export");
    const rows = [...slot.container.querySelectorAll("[data-project-row]")];
    expect(rows.map((row) => row.getAttribute("data-project-row"))).toEqual(["csv", "docs"]);
    expect(rows[0]!.querySelector("[data-state-badge]")!.textContent).toBe("running");
    expect(rows[1]!.querySelector("[data-state-badge]")!.textContent).toBe("paused");
    expect(rows[0]!.textContent).toContain("integration branch loom/csv");
    expect(rows[0]!.textContent).toContain("2 queued");
    expect(rows[0]!.textContent).toContain("1 working");
    expect(rows[1]!.textContent).toContain("one pull request per ticket");
    expect(rows[1]!.textContent).toContain("The token budget is used up");
  });

  it("shows the guide when there are no projects and no planning conversations, and its button opens New project", async () => {
    const { slot } = await mountPage("", { home: () => homeView({ projects: [], needsYou: [] }) });
    expect(await slot.findByRole("heading", { name: "Welcome to Loom" })).toBeTruthy();
    const guide = slot.container.querySelector("[data-guide]")!;
    expect([...guide.querySelectorAll("[data-guide-step]")].map((step) => step.querySelector("b")!.textContent)).toEqual(["Plan.", "Approve.", "Start.", "Check and review.", "Merge and land."]);
    expect(guide.textContent).toContain("Who does what");
    expect(guide.textContent).toContain("A ticket's life");
    expect(guide.textContent).toContain("bb loom approve <slug>");
    fireEvent.click(slot.getByRole("button", { name: "Start your first project" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_new")]);
  });

  it("opens a project on its address when its row is clicked", async () => {
    const { slot } = await mountPage("", { home });
    fireEvent.click(await slot.findByRole("button", { name: /Docs site/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("docs")]);
  });

  describe("search and the finished switch", () => {
    const three = () => homeView({ projects: [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "done" }), homeProject({ slug: "old", name: "Old importer", key: "LEGACY", state: "archived" })] });
    const slugs = (slot: Slot) => [...slot.container.querySelectorAll("[data-project-row]")].map((row) => row.getAttribute("data-project-row"));
    const toggle = (slot: Slot) => slot.getByRole("checkbox", { name: "Hide done and archived" }) as HTMLInputElement;

    it("hides done and archived projects with a switch it remembers", async () => {
      const { slot } = await mountPage("", { home: three });
      await slot.findByText("CSV export");
      expect(slugs(slot)).toEqual(["csv", "docs", "old"]);
      fireEvent.click(toggle(slot));
      expect(slugs(slot)).toEqual(["csv"]);
      expect(localStorage.getItem("loom.home.hideFinished")).toBe("true");
      slot.lifecycle.unmount();

      const { slot: again } = await mountPage("", { home: three });
      await again.findByText("CSV export");
      expect(slugs(again)).toEqual(["csv"]);
      expect(toggle(again).checked).toBe(true);
      fireEvent.click(toggle(again));
      expect(slugs(again)).toEqual(["csv", "docs", "old"]);
      expect(localStorage.getItem("loom.home.hideFinished")).toBe("false");
    });

    it("filters the table by name, key or slug as the human types", async () => {
      const { slot } = await mountPage("", { home: three });
      await slot.findByText("CSV export");
      const search = slot.getByRole("searchbox", { name: "Search projects" });
      for (const [query, shown] of [["importer", ["old"]], ["legacy", ["old"]], ["docs", ["docs"]], ["  CSV ", ["csv"]]] as const) {
        fireEvent.change(search, { target: { value: query } });
        expect(slugs(slot), query).toEqual(shown);
      }
      fireEvent.change(search, { target: { value: "zzz" } });
      expect(slugs(slot)).toEqual([]);
      expect(slot.container.querySelector("[data-projects-empty]")!.textContent).toBe('No project matches "zzz".');
    });

    it("says so when the switch hides every project", async () => {
      const { slot } = await mountPage("", { home: () => homeView({ projects: [homeProject({ state: "done" })] }) });
      await slot.findByText("CSV export");
      fireEvent.click(toggle(slot));
      expect(slot.container.querySelector("[data-projects-empty]")!.textContent).toBe("Every project is done or archived.");
    });
  });

  it("reads the list again when any project changes", async () => {
    const { slot } = await mountPage("", { home });
    await slot.findByText("CSV export");
    await slot.emitRealtime("loom:changed", { slug: "docs" });
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(2));
  });
});

describe("home", () => {
  const session = (over: Partial<PlanningSession> = {}): PlanningSession => ({ threadId: "thr_p1", title: "Rate limits for the public API", startedAt: Date.now() - 4 * 60_000, slug: null, projectState: null, ...over });
  const homeTile = (slot: Slot, name: string) => slot.container.querySelector<HTMLElement>(`[data-home-tile="${name}"]`)!;

  it("reads the overview and the planning conversations, not the project list", async () => {
    const { slot } = await mountPage("", { home: () => homeView() });
    await slot.findByText("CSV export");
    await waitFor(() => expect(calls(slot, "planning")).toHaveLength(1));
    expect(calls(slot, "home")).toEqual([{ method: "home", input: null }]);
    expect(calls(slot, "projects")).toEqual([]);
  });

  it("shows five tiles: running projects, agents against the slots, done in 7 days, what needs you, and tokens", async () => {
    const { slot } = await mountPage("", { home: () => homeView() });
    await slot.findByText("CSV export");
    expect([...slot.container.querySelectorAll("[data-home-tile]")].map((tile) => tile.getAttribute("data-home-tile"))).toEqual(["running", "agents", "done", "needs", "tokens"]);
    expect(homeTile(slot, "running").textContent).toContain("2");
    expect(homeTile(slot, "running").textContent).toContain("of 4 projects · 1 paused");
    expect(homeTile(slot, "agents").textContent).toContain("5 / 8 slots");
    expect(homeTile(slot, "agents").textContent).toContain("3 workers · 2 reviewers");
    expect(homeTile(slot, "done").querySelector("[data-tile-value]")!.textContent).toBe("14");
    expect(homeTile(slot, "done").querySelector("svg[aria-label]")).not.toBeNull();
    expect(homeTile(slot, "needs").querySelector("[data-tile-value]")!.textContent).toBe("4");
    expect(homeTile(slot, "tokens").textContent).toContain("Tokens (sampled)");
    expect(homeTile(slot, "tokens").textContent).toContain("3,100,000");
    expect(homeTile(slot, "tokens").textContent).toContain("220,000 per done ticket");

    const { slot: one } = await mountPage("", { home: () => ({ ...homeView(), totals: { ...homeView().totals, projects: 1, running: 1, paused: 0, workers: 1, reviewers: 1, slots: 4 } }) });
    await one.findByText("CSV export");
    expect(homeTile(one, "running").textContent).toContain("of 1 project · 0 paused");
    expect(homeTile(one, "agents").textContent).toContain("1 worker · 1 reviewer");
  });

  it("lists what needs you in order, each with one button that opens its ticket or project", async () => {
    const needsYou = [...homeView().needsYou.slice(0, 2), { kind: "pending" as const, slug: "csv", project: "CSV export", key: null, text: "spec v2 waits for your approval", at: NOW - 20 * 60_000 }, ...homeView().needsYou.slice(2)];
    const { slot } = await mountPage("", { home: () => homeView({ needsYou, projects: [homeProject({ pendingVersion: 2 })] }) });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-need]")).toHaveLength(5));
    const items = [...slot.container.querySelectorAll<HTMLElement>("[data-need]")];
    expect(items.map((item) => item.getAttribute("data-need"))).toEqual(["blocked", "approve", "pending", "land", "paused"]);
    expect(items[0]!.textContent).toContain("CSV-7 is blocked · CSV export · needs the staging DB credentials");
    expect(items[1]!.textContent).toContain("Audit log has a draft spec v1 with 9 tickets");
    expect(items.map((item) => item.querySelector("button")!.textContent)).toEqual(["Open ticket", "Review and approve", "Approve v2", "Land", "Open"]);
    for (const item of items) fireEvent.click(item.querySelector("button")!);
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-7"), pushed("audit"), pushed("csv"), pushed("srch"), pushed("bill")]);
  });

  it("shows each project's progress, live agents, 14-day throughput, tokens against its budget and its last event", async () => {
    const projects = [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "draft", progress: { done: 0, total: 0, inFlight: 0, blocked: 0 }, agents: 1, tokens: 800, maxTokens: null, lastEventAt: null })];
    const { slot } = await mountPage("", { home: () => homeView({ projects }) });
    await slot.findByText("CSV export");
    const row = (slug: string) => slot.container.querySelector<HTMLElement>(`[data-project-row="${slug}"]`)!;
    expect(row("csv").querySelector("div[role=img]")!.getAttribute("aria-label")).toBe("Progress: 1 of 4 done, 1 in flight, 2 queued");
    expect(row("csv").querySelector("[data-project-agents]")!.textContent).toBe("3");
    expect(row("csv").querySelector("svg[aria-label]")!.getAttribute("aria-label")).toBe("CSV export: tickets done per day, last 14 days");
    expect(row("csv").querySelector("[data-project-tokens]")!.textContent).toBe("12,000 / 50,000");
    expect(row("csv").textContent).toContain("2m ago");
    expect(row("docs").querySelector("div[role=img]")).toBeNull();
    expect(row("docs").querySelector("[data-project-tokens]")!.textContent).toBe("800");
    expect(row("docs").textContent).not.toContain("ago");
  });

  it("reads the overview again on any change", async () => {
    const { slot } = await mountPage("", { home: () => homeView() });
    await slot.findByText("CSV export");
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(2));
    await slot.emitRealtime("loom:changed", { slug: null });
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(3));
  });

  it("lists the projects and only the conversations that have no project yet, and Continue opens one", async () => {
    const planning = () => [session(), session({ threadId: "thr_p2", title: "CSV export plan", slug: "csv", projectState: "draft" })];
    const { slot } = await mountPage("", { home: () => homeView(), planning });
    await slot.findByText("Rate limits for the public API");
    expect([...slot.container.querySelectorAll("[data-project-row]")].map((row) => row.getAttribute("data-project-row"))).toEqual(["csv"]);
    const rows = [...slot.container.querySelectorAll("[data-planning-row]")];
    expect(rows.map((row) => row.getAttribute("data-planning-row"))).toEqual(["thr_p1"]);
    expect(rows[0]!.textContent).toContain("planner is asking questions · started 4m");
    expect(slot.container.querySelector("[data-guide]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Continue" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p1")]);
  });

  it("shows a conversation instead of the guide when it is the only thing there is", async () => {
    const { slot } = await mountPage("", { home: () => homeView({ projects: [], needsYou: [] }), planning: () => [session()] });
    await slot.findByText("Rate limits for the public API");
    expect(slot.container.querySelector("[data-guide]")).toBeNull();
    expect(slot.container.querySelector("[data-projects-empty]")).toBeNull();
  });

  it("opens the guide from How Loom works and New project from its button, and _guide shows the guide", async () => {
    const { slot, goTo } = await mountPage("", { home: () => homeView() });
    fireEvent.click(await slot.findByRole("button", { name: "How Loom works" }));
    fireEvent.click(slot.getByRole("button", { name: "New project" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_guide"), pushed("_new")]);
    goTo("_guide");
    expect(await slot.findByRole("heading", { name: "Welcome to Loom" })).toBeTruthy();
    expect(slot.getByRole("navigation", { name: "Loom" }).textContent).toContain("How Loom works");
    expect(calls(slot, "project")).toEqual([]);
  });

  it("reads the planning conversations again on a change outside any project", async () => {
    const { slot } = await mountPage("", { home: () => homeView() });
    await slot.findByText("CSV export");
    await waitFor(() => expect(calls(slot, "planning")).toHaveLength(1));
    await slot.emitRealtime("loom:changed", { slug: null });
    await waitFor(() => expect(calls(slot, "planning")).toHaveLength(2));
  });
});

describe("new project", () => {
  const SAVED = "loom.newProject.projectId";
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  const typeGoal = (slot: Slot, text: string) => fireEvent.change(slot.getByTestId("bb-new-thread-composer-input"), { target: { value: text } });
  const seed = (slot: Slot) => slot.getByTestId("bb-new-thread-composer").getAttribute("data-default-project-id");
  const request = (text: string, projectId = "project-test") => ({ projectId, providerId: "codex", model: "gpt-5", reasoningLevel: "medium", permissionMode: "full", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text, mentions: [] }] });

  it("starts planning with the composer's request and the answers given up front, then opens the conversation", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", { startPlanning });
    expect(await slot.findByRole("heading", { name: "What should exist when the project is done?" })).toBeTruthy();
    expect(slot.getByRole("navigation", { name: "Loom" }).textContent).toContain("New project");
    expect(slot.container.querySelectorAll("[data-guide-step]")).toHaveLength(5);
    expect(slot.getByTestId("bb-new-thread-composer").getAttribute("data-default-permission-mode")).toBe("full");
    typeGoal(slot, "Let people export their orders as CSV.");
    fireEvent.click(slot.getByRole("button", { name: "Integration branch" }));
    expect(slot.getByRole("button", { name: "Integration branch" }).getAttribute("aria-pressed")).toBe("true");
    expect(slot.getByRole("button", { name: "Ask me" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(slot.getByRole("textbox", { name: "Reviewer model" }), { target: { value: "codex, gpt-5" } });
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p7")]));
    expect(startPlanning).toHaveBeenCalledTimes(1);
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Let people export their orders as CSV."), merge: "integration", reviewer: "codex, gpt-5", confirm: true });
  });

  it("asks the planner about the merge by default, and shows a refusal without leaving the page", async () => {
    const startPlanning = vi.fn((): { threadId: string } => {
      throw new Error("Loom needs a bb project with a git checkout. Pick a project in the composer.");
    });
    const { slot } = await mountPage("_new", { startPlanning });
    await slot.findByTestId("bb-new-thread-composer-input");
    expect(slot.getByRole("button", { name: "Ask me" }).getAttribute("aria-pressed")).toBe("true");
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    expect((await slot.findByRole("alert")).textContent).toContain("git checkout");
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site."), merge: "ask", reviewer: "", confirm: true });
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(localStorage.getItem(SAVED)).toBeNull();
  });

  it("starts the composer on no particular project the first time, then on the project of the last planning it started", async () => {
    const first = await mountPage("_new", { startPlanning: () => ({ threadId: "thr_p7" }) });
    await first.slot.findByTestId("bb-new-thread-composer-input");
    expect(seed(first.slot)).toBe("");
    typeGoal(first.slot, "Let people export their orders as CSV.");
    fireEvent.click(first.slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(localStorage.getItem(SAVED)).toBe("project-test"));
    first.slot.lifecycle.unmount();

    localStorage.setItem(SAVED, "proj_shop");
    const startPlanning = vi.fn(() => ({ threadId: "thr_p8" }));
    const { slot } = await mountPage("_new", { startPlanning });
    await slot.findByTestId("bb-new-thread-composer-input");
    expect(seed(slot)).toBe("proj_shop");
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site.", "proj_shop"), merge: "ask", reviewer: "", confirm: true }));
  });

  it("still starts planning when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { slot } = await mountPage("_new", { startPlanning: () => ({ threadId: "thr_p7" }) });
    await slot.findByTestId("bb-new-thread-composer-input");
    expect(seed(slot)).toBe("");
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p7")]));
  });
});

describe("planning conversation", () => {
  const session = (over: Partial<PlanningSession> = {}): PlanningSession => ({ threadId: "thr_p1", title: "Export orders as CSV", startedAt: Date.now(), slug: null, projectState: null, ...over });
  const chat = (slot: Slot) => slot.getByTestId("bb-thread-chat");

  it("shows the planner's chat, and says there is no draft yet while the thread has not proposed", async () => {
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session() });
    expect(await slot.findByText(/No draft yet/)).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Export orders as CSV" })).toBeTruthy();
    expect(chat(slot).getAttribute("data-thread-id")).toBe("thr_p1");
    expect(chat(slot).getAttribute("data-variant")).toBe("compact");
    expect(chat(slot).getAttribute("data-layout")).toBe("contained");
    expect(calls(slot, "planningSession")[0]!.input).toEqual({ threadId: "thr_p1" });
    expect(slot.getByRole("navigation", { name: "Loom" }).textContent).toContain("Planning");
    const bar = slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    expect(bar.textContent).toContain("Next: answer the planner.");
    expect(bar.querySelector('[aria-current="step"]')!.getAttribute("data-stage")).toBe("Plan");
    expect(calls(slot, "project")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open as thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_p1" }]);
  });

  it("fills in the draft card once the planner proposes, approves it from the bar after a second click, and opens the project", async () => {
    let current = session();
    const approveStep: NextStep = { stage: 1, tone: "normal", title: "Next: review draft v1.", text: "Approving creates 2 tickets on the board.", action: { control: "approve", version: 1, label: "Approve v1 · create 2 tickets", confirm: "Click again to approve v1" } };
    const startStep: NextStep = { stage: 3, tone: "normal", title: "Next: start the project.", text: "Loom starts 1 worker right away, on CSV-1.", action: { control: "start", label: "Start project · 1 worker", confirm: "Click again to start 1 worker" } };
    const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: approveStep });
    const control = vi.fn(() => projectView({ overview: overview({ state: "ready" }), next: startStep }));
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => current, project: () => draft, control });
    await slot.findByText(/No draft yet/);
    current = session({ slug: "csv", projectState: "draft" });
    await slot.emitRealtime("loom:changed", { slug: null });
    await waitFor(() => expect(slot.container.querySelector("[data-draft-card]")).not.toBeNull());
    const card = () => slot.container.querySelector<HTMLElement>("[data-draft-card]")!;
    await waitFor(() => expect(card().textContent).toContain("CSV export"));
    expect(calls(slot, "project")[0]!.input).toEqual({ slug: "csv" });
    expect(card().querySelector("[data-state-badge]")!.textContent).toBe("draft");
    expect(card().textContent).toContain("2 tickets · checks: npm test · reviewer codex / gpt-5");
    expect([...card().querySelectorAll("[data-draft-ticket]")].map((row) => row.textContent)).toEqual(["csv-modelOrder rows", "csv-exportExport endpointafter csv-model"]);
    expect(slot.queryByText(/No draft yet/)).toBeNull();
    expect(within(card()).queryByRole("button", { name: /Approve|Start/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Approve v1 · create 2 tickets" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Click again to approve v1" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 1, confirm: true }));
    expect(await slot.findByRole("button", { name: "Start project · 1 worker" })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: /Start/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open project" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
  });

  it("shows only the first five tickets of a long draft", async () => {
    const tickets = Array.from({ length: 7 }, (_, index) => ({ ref: `t-${index + 1}`, title: `Ticket ${index + 1}`, dependsOn: [] }));
    const draft = projectView({ overview: overview({ state: "draft" }), spec: { ...projectView().spec, summary: { ...projectView().spec.summary, tickets } } });
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session({ slug: "csv", projectState: "draft" }), project: () => draft });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-draft-ticket]")).toHaveLength(5));
    expect(slot.container.querySelector("[data-draft-card]")!.textContent).toContain("+2 more");
  });

  it("says so when the thread is not a Loom planning thread", async () => {
    const { slot } = await mountPage("_plan/thr_other");
    expect(await slot.findByText("This thread is not a Loom planning thread.")).toBeTruthy();
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
  });

  it("gives a project with a planner thread a Planner tab with its chat, and a project without one no such tab", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    await slot.findByRole("tab", { name: "Board" });
    expect([...slot.container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toEqual(["Board", "Agents", "Feed", "Metrics", "Spec", "Planner"]);
    fireEvent.click(slot.getByRole("tab", { name: "Planner" }));
    expect(chat(slot).getAttribute("data-thread-id")).toBe("thr_plan");
    slot.lifecycle.unmount();

    const none = await mountPage("csv", { project: () => projectView({ overview: overview({ plannerThreadId: null }) }) });
    await none.slot.findByRole("tab", { name: "Board" });
    expect(none.slot.queryByRole("tab", { name: "Planner" })).toBeNull();
  });
});

describe("spec dashboard", () => {
  const session = (over: Partial<PlanningSession> = {}): PlanningSession => ({ threadId: "thr_p1", title: "Export orders as CSV", startedAt: Date.now(), slug: "csv", projectState: "draft", ...over });
  const draft = () => projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [] });
  const dashboard = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-spec-dashboard]")!;
  const mountDashboard = async (rpc: Partial<Handlers> = {}) => {
    const mounted = await mountPage("_plan/thr_p1", { planningSession: () => session(), project: () => draft(), specVersion: () => specVersionView(), ...rpc });
    await waitFor(() => expect(mounted.slot.container.querySelector("[data-spec-tile]")).not.toBeNull());
    return mounted;
  };

  it("shows the versions, what the newest one changed, the summary strip and the raw spec under the planner's chat", async () => {
    const { slot } = await mountDashboard();
    const versions = slot.getByRole("group", { name: "Spec versions" });
    expect(within(versions).getByRole("button", { name: "v1 superseded" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(versions).getByRole("button", { name: "v2 draft" }).getAttribute("aria-pressed")).toBe("true");
    expect(dashboard(slot).textContent).toContain("v2 changes 1 ticket and 1 setting from v1");
    const tiles = [...slot.container.querySelectorAll("[data-spec-tile]")].map((tile) => [tile.querySelector("dt")!.textContent, tile.querySelector("dd")!.textContent]);
    expect(tiles).toEqual([
      ["Tickets", "2"],
      ["Waves", "2"],
      ["Checks", "1"],
      ["Own verify", "0/2"],
      ["Review", "codex / gpt"],
      ["Warnings", "0"],
    ]);
    expect([...within(dashboard(slot)).getAllByRole("tab")].map((tab) => tab.textContent)).toEqual(["Tickets", "Files", "Checks & review", "Project & limits"]);
    expect(slot.container.querySelector("[data-spec-raw]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Read the raw spec" }));
    expect(slot.container.querySelector("[data-spec-raw]")!.textContent).toContain('slug = "csv"');
    expect(calls(slot, "specVersion")[0]!.input).toEqual({ slug: "csv" });
    expect(slot.container.querySelector("[data-draft-card]")).not.toBeNull();
  });

  it("leaves the raw spec, the warnings and Approve to the dashboard and the bar, so each shows once", async () => {
    const warnings = [draft().spec.summary.warnings[0]!];
    const approve: NextStep = { stage: 1, tone: "normal", title: "Next: review draft v2.", text: "Approving creates 2 tickets on the board.", action: { control: "approve", version: 2, label: "Approve v2 · create 2 tickets", confirm: "Click again to approve v2" } };
    const { slot } = await mountDashboard({ project: () => ({ ...draft(), next: approve }), specVersion: () => specVersionView({ warnings }) });
    await waitFor(() => expect(slot.container.querySelector("[data-draft-card]")).not.toBeNull());
    expect(slot.queryAllByText(/^Read the (raw )?spec$/)).toHaveLength(1);
    expect(slot.queryAllByText(warnings[0]!)).toHaveLength(1);
    expect(slot.container.querySelector("[data-spec-warnings]")!.textContent).toContain(warnings[0]);
    expect(slot.getAllByRole("button", { name: /^Approve/ }).map((button) => button.textContent)).toEqual(["Approve v2 · create 2 tickets"]);
  });

  it("reads an older version from the switcher, says what each later version changed, and Back reads the newest again", async () => {
    const versions = [
      { version: 1, status: "superseded" as const },
      { version: 2, status: "superseded" as const },
      { version: 3, status: "draft" as const },
    ];
    const specVersion = ({ version }: { slug: string; version?: number }) =>
      version === 1
        ? specVersionView({ version: 1, status: "superseded", changes: null, versions })
        : version === 2
          ? specVersionView({ status: "superseded", changes: { changed: ["project.goal"], removed: ["csv-docs"] }, versions })
          : specVersionView({ version: 3, changes: { changed: [], removed: ["csv-docs"] }, versions });
    const { slot } = await mountDashboard({ specVersion });
    fireEvent.click(slot.getByRole("button", { name: "v1 superseded" }));
    await waitFor(() => expect(dashboard(slot).textContent).toContain("You are reading v1 (superseded)"));
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", version: 1 });
    expect(slot.getByRole("button", { name: "v1 superseded" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Back to v3" }));
    await waitFor(() => expect(dashboard(slot).textContent).toContain("v3 removes csv-docs from v2."));
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv" });
    fireEvent.click(slot.getByRole("button", { name: "v2 superseded" }));
    await waitFor(() => expect(dashboard(slot).textContent).toContain("You are reading v2 (superseded)"));
    expect(dashboard(slot).textContent).toContain("v2 changes 1 setting from v1, and removes csv-docs.");
  });

  const card = (slot: Slot, ref: string) => slot.container.querySelector<HTMLElement>(`[data-spec-card="${ref}"]`)!;
  const target = (slot: Slot, path: string) => slot.container.querySelector<HTMLElement>(`[data-note-target="${path}"]`);
  const inspector = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-spec-inspector]")!;
  const waveList = (slot: Slot) => [...slot.container.querySelectorAll("[data-spec-wave]")].map((wave) => [wave.querySelector("h4")!.textContent, [...wave.querySelectorAll("[data-spec-card]")].map((entry) => entry.getAttribute("data-spec-card"))]);
  const chain = () =>
    specVersionView({}, (doc) => {
      doc.ticket.push(
        { ref: "csv-docs", title: "Export docs", body: "Document the export.", acceptance: ["WHEN the docs are read THE SYSTEM SHALL name every column"], scope: ["docs/export.md"], depends_on: ["csv-export"] },
        { ref: "csv-icons", title: "Export icon", body: "Draw the icon.", acceptance: ["WHEN the admin page loads THE SYSTEM SHALL show the export icon"], scope: ["assets/export.svg"] },
      );
    });

  it("lays the waves out top to bottom with what each ticket waits for, and marks a changed ticket and one with only the checks", async () => {
    const { slot } = await mountDashboard();
    expect(waveList(slot)).toEqual([
      ["Wave 1 · starts right away", ["csv-model"]],
      ["Wave 2 · after wave 1", ["csv-export"]],
    ]);
    expect(dashboard(slot).textContent).toContain("2 tickets in 2 waves. Up to 2 workers run at a time; a ticket starts when everything it waits for is done.");
    expect(slot.container.querySelector("[data-edge]")).toBeNull();
    expect(slot.container.querySelector("[data-spec-dashboard] [role=tabpanel] svg")).toBeNull();
    expect(slot.container.querySelector("[data-spec-dashboard] [role=tabpanel] .overflow-x-auto")).toBeNull();
    expect(card(slot, "csv-export").textContent).toContain("after csv-model");
    expect(card(slot, "csv-model").textContent).not.toContain("after");
    expect(card(slot, "csv-export").textContent).toContain("checks only");
    expect(card(slot, "csv-export").textContent).toContain("changed");
    expect(card(slot, "csv-model").textContent).not.toContain("changed");
    expect(card(slot, "csv-model").textContent).not.toContain("overlap");
    expect(dashboard(slot).textContent).toContain("No warnings in v2.");

    const { slot: own } = await mountDashboard({ specVersion: () => specVersionView({}, (doc) => (doc.ticket[0].verify = ["npm run lint"])) });
    expect(card(own, "csv-model").textContent).toContain("own verify");
    const ownVerify = [...own.container.querySelectorAll("[data-spec-tile]")].find((tile) => tile.querySelector("dt")!.textContent === "Own verify")!;
    expect(ownVerify.textContent).toContain("1 relies on the checks only");
  });

  it("highlights what a selected ticket waits for and unblocks, all the way, and a second click or Show all clears it", async () => {
    const { slot } = await mountDashboard({ specVersion: chain });
    expect(waveList(slot)).toEqual([
      ["Wave 1 · starts right away", ["csv-model", "csv-icons"]],
      ["Wave 2 · after wave 1", ["csv-export"]],
      ["Wave 3 · after wave 2", ["csv-docs"]],
    ]);
    expect(dashboard(slot).textContent).toContain("4 tickets in 3 waves.");
    expect(card(slot, "csv-docs").textContent).toContain("after csv-export");
    const marks = () => Object.fromEntries([...slot.container.querySelectorAll("[data-spec-card]")].map((entry) => [entry.getAttribute("data-spec-card"), entry.getAttribute("data-chain") ?? (entry.hasAttribute("data-dimmed") ? "dimmed" : "")]));
    const focus = () => slot.container.querySelector("[data-spec-focus]")?.textContent ?? null;
    expect(marks()).toEqual({ "csv-model": "", "csv-icons": "", "csv-export": "", "csv-docs": "" });
    expect(focus()).toBeNull();

    fireEvent.click(card(slot, "csv-export"));
    expect(marks()).toEqual({ "csv-model": "up", "csv-icons": "dimmed", "csv-export": "self", "csv-docs": "down" });
    expect(focus()).toContain("csv-export waits for csv-model, and unblocks csv-docs.");
    expect(inspector(slot).textContent).toContain("Export endpoint");

    fireEvent.click(card(slot, "csv-docs"));
    expect(marks()).toEqual({ "csv-model": "up", "csv-icons": "dimmed", "csv-export": "up", "csv-docs": "self" });
    expect(focus()).toContain("csv-docs waits for csv-model and csv-export, and unblocks nothing.");

    fireEvent.click(card(slot, "csv-docs"));
    expect(marks()).toEqual({ "csv-model": "", "csv-icons": "", "csv-export": "", "csv-docs": "" });
    expect(focus()).toBeNull();
    expect(card(slot, "csv-docs").getAttribute("aria-pressed")).toBe("true");
    expect(inspector(slot).textContent).toContain("Export docs");

    fireEvent.click(card(slot, "csv-model"));
    expect(focus()).toContain("csv-model starts right away and unblocks csv-export and csv-docs.");
    expect(marks()).toEqual({ "csv-model": "self", "csv-icons": "dimmed", "csv-export": "down", "csv-docs": "down" });
    fireEvent.click(slot.getByRole("button", { name: "Show all" }));
    expect(focus()).toBeNull();
    expect(slot.container.querySelector("[data-spec-card][data-dimmed]")).toBeNull();
  });

  it("marks both tickets of an overlap and lists the warnings", async () => {
    const warnings = ["ticket[0] and ticket[1] have overlapping scope and no dependency between them, so they will run one at a time."];
    const { slot } = await mountDashboard({ specVersion: () => specVersionView({ overlaps: [{ a: "csv-model", b: "csv-export", paths: ["src/model/**"] }], warnings }) });
    expect(card(slot, "csv-model").textContent).toContain("overlap");
    expect(card(slot, "csv-export").textContent).toContain("overlap");
    expect(slot.container.querySelector("[data-spec-warnings]")!.textContent).toContain(warnings[0]);
  });

  it("inspects the first ticket, and selects another from the inspector", async () => {
    const { slot } = await mountDashboard();
    expect(inspector(slot).textContent).toContain("Order rows");
    expect(card(slot, "csv-model").getAttribute("aria-pressed")).toBe("true");
    expect(target(slot, "ticket[csv-model].depends_on")!.textContent).toContain("Waits for");
    expect(target(slot, "ticket[csv-model].depends_on")!.textContent).toContain("none");
    expect(inspector(slot).querySelector("[data-spec-unblocks]")!.textContent).toContain("csv-export");

    const main = slot.container.querySelector<HTMLElement>("[data-spec-main]")!;
    expect(main.contains(inspector(slot))).toBe(true);
    expect(main.contains(pane(slot))).toBe(true);
    expect(pane(slot).compareDocumentPosition(inspector(slot)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const aside = slot.container.querySelector<HTMLElement>("[data-spec-dashboard] aside")!;
    expect(aside.contains(inspector(slot))).toBe(false);
    expect(aside.querySelector("[data-notes-tray]")).not.toBeNull();
    expect(within(target(slot, "ticket[csv-model].body")!).getByTestId("bb-markdown").textContent).toBe("Build the row mapper.");

    fireEvent.click(within(inspector(slot)).getByRole("button", { name: "csv-export" }));
    expect(card(slot, "csv-export").getAttribute("aria-pressed")).toBe("true");
    expect(card(slot, "csv-model").getAttribute("aria-pressed")).toBe("false");
    expect(inspector(slot).textContent).toContain("Export endpoint");
    const criteria = [...inspector(slot).querySelectorAll('[data-note-target^="ticket[csv-export].acceptance["]')].map((entry) => entry.textContent!.slice(0, 3));
    expect(criteria).toEqual(["1. ", "2. "]);
    expect(target(slot, "ticket[csv-export].scope[0]")!.textContent).toContain("src/export/**");
    expect(target(slot, "ticket[csv-export].verify")!.textContent).toContain("No command of its own; only npm test runs.");
    expect(target(slot, "ticket[csv-export].acceptance[1]")!.hasAttribute("data-changed")).toBe(true);
    expect(target(slot, "ticket[csv-export].acceptance[0]")!.hasAttribute("data-changed")).toBe(false);
    fireEvent.click(within(target(slot, "ticket[csv-export].depends_on")!).getByRole("button", { name: "csv-model" }));
    expect(card(slot, "csv-model").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the first part of a long brief, with Show the whole brief and Show less", async () => {
    const parts = ["First part.", "Second part.", "Third part."].map((lead) => `${lead} ${"Keep the rows in order. ".repeat(20)}`.trim());
    const whole = parts.join("\n\n");
    const { slot } = await mountDashboard({ specVersion: () => specVersionView({}, (doc) => (doc.ticket[0].body = whole)) });
    const brief = () => within(inspector(slot)).getByTestId("bb-markdown").textContent!;
    expect(whole.length).toBeGreaterThan(1200);
    expect(brief()).toBe(parts.slice(0, 2).join("\n\n"));
    fireEvent.click(within(inspector(slot)).getByRole("button", { name: "Show the whole brief" }));
    expect(brief()).toBe(whole);
    fireEvent.click(within(inspector(slot)).getByRole("button", { name: "Show less" }));
    expect(brief()).not.toContain("Third part.");
    fireEvent.click(card(slot, "csv-export"));
    expect(brief()).toBe("Serve the file.");
    expect(within(inspector(slot)).queryByRole("button", { name: "Show the whole brief" })).toBeNull();
  });

  it("wraps long URLs and paths in the brief and in every code chip, so nothing runs past the ticket card", async () => {
    const long = `https://example.com/${"orders/".repeat(30)}export.csv`;
    const { slot } = await mountDashboard({
      specVersion: () =>
        specVersionView({}, (doc) => {
          doc.ticket[0].body = `Read ${long} first.\n\n\`\`\`\n${long}\n\`\`\``;
          doc.ticket[0].scope = [`src/${"very-long-folder-name/".repeat(6)}**`];
          doc.ticket[0].verify = [`npm test -- ${long}`];
        }),
    });
    const brief = within(inspector(slot)).getByTestId("bb-markdown");
    expect(brief.className).toContain("[overflow-wrap:anywhere]");
    expect(brief.className).toContain("[&_pre]:whitespace-pre-wrap");
    const codes = [...slot.container.querySelectorAll("[data-spec-dashboard] code")];
    expect(codes.length).toBeGreaterThan(1);
    for (const code of codes) expect(code.className).toContain("[overflow-wrap:anywhere]");
  });

  const pane = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-spec-dashboard] [role=tabpanel]")!;
  const inPane = (slot: Slot, path: string) => pane(slot).querySelector<HTMLElement>(`[data-note-target="${path}"]`);
  const openTab = (slot: Slot, name: string) => fireEvent.click(within(dashboard(slot)).getByRole("tab", { name }));
  const guarded = () =>
    specVersionView({ overlaps: [{ a: "csv-model", b: "csv-export", paths: ["src/model/**", "src/model/export.ts"] }] }, (doc) => {
      doc.scope = { protected: ["package-lock.json"] };
      doc.ticket[1].scope = ["src/export/**", "src/model/export.ts"];
    });

  const sharing = () =>
    specVersionView({ overlaps: [{ a: "csv-model", b: "csv-docs", paths: ["src/model/**", "src/model/README.md"] }], changes: { changed: ["ticket[csv-export].scope[1]"], removed: [] } }, (doc) => {
      doc.scope = { protected: ["package-lock.json", ".github/**"] };
      doc.ticket[0].scope = ["src/model/**", "src/shared/types.ts"];
      doc.ticket[1].scope = ["src/export/**", "src/shared/types.ts", "package.json"];
      doc.ticket.push({ ref: "csv-docs", title: "Export docs", body: "Document the export.", acceptance: ["WHEN the docs are read THE SYSTEM SHALL name every column"], scope: ["src/model/README.md", "docs/export.md"] });
    });
  const folders = (slot: Slot) => [...pane(slot).querySelectorAll("[data-folder]")].map((folder) => [folder.getAttribute("data-folder"), [...folder.querySelectorAll("[data-file]")].map((row) => row.getAttribute("data-file"))]);
  const chips = (row: Element) => [...row.querySelectorAll("[data-ticket-chip]")].map((chip) => chip.textContent);

  it("lists the shared files first, with their tickets and whether they run in order, and needs no sideways scrolling", async () => {
    const { slot } = await mountDashboard({ specVersion: sharing });
    openTab(slot, "Files");
    expect(pane(slot).querySelector("[data-scope-map], table, .overflow-x-auto, .whitespace-nowrap")).toBeNull();
    const shared = [...pane(slot).querySelectorAll("[data-shared]")].map((row) => {
      const order = row.querySelector("[data-order]")!;
      return [row.getAttribute("data-shared"), chips(row), order.textContent, order.hasAttribute("data-unordered")];
    });
    expect(shared).toEqual([
      ["src/model/**", ["csv-model", "csv-docs"], "no order between them, so they run one at a time", true],
      ["src/model/README.md", ["csv-model", "csv-docs"], "no order between them, so they run one at a time", true],
      ["src/shared/types.ts", ["csv-model", "csv-export"], "in order: csv-model, then csv-export", false],
    ]);
    const types = inPane(slot, "ticket[csv-model].scope[1]")!;
    expect(types.closest("[data-shared]")!.getAttribute("data-shared")).toBe("src/shared/types.ts");
    expect(types.hasAttribute("data-changed")).toBe(true);
    expect(inPane(slot, "ticket[csv-model].scope[0]")!.closest("[data-shared]")!.getAttribute("data-shared")).toBe("src/model/**");
    fireEvent.click(slot.getByRole("button", { name: "Add a note on shared path src/shared/types.ts" }));
    expect(dashboard(slot).textContent).toContain("Note on shared path src/shared/types.ts");

    fireEvent.click(within(pane(slot).querySelector('[data-shared="src/shared/types.ts"]')!).getByRole("button", { name: "csv-export" }));
    expect(inspector(slot).textContent).toContain("Export endpoint");

    const mixed = (extra: string[]) =>
      specVersionView({}, (doc) => {
        doc.ticket[0].scope = ["src/shared/types.ts"];
        doc.ticket[1].scope = ["src/shared/types.ts"];
        for (const ref of extra) doc.ticket.push({ ref, title: ref, body: "Use the shared types.", acceptance: ["WHEN the types load THE SYSTEM SHALL compile"], scope: ["src/shared/types.ts"] });
      });
    const orderOf = async (extra: string[]) => {
      const { slot: one } = await mountDashboard({ specVersion: () => mixed(extra) });
      openTab(one, "Files");
      return one.container.querySelector('[data-shared="src/shared/types.ts"] [data-order]')!.textContent;
    };
    expect(await orderOf(["csv-docs"])).toBe("no order between csv-model and csv-docs, or csv-docs and csv-export, so those run one at a time");
    expect(await orderOf(["csv-docs", "csv-icons"])).toBe("5 pairs have no order between them, such as csv-model and csv-docs, so those run one at a time");

    const { slot: alone } = await mountDashboard();
    openTab(alone, "Files");
    expect(alone.container.querySelector("[data-shared]")).toBeNull();
    expect(pane(alone).textContent).toContain("No two tickets share a path, so none of them waits for another to finish with a file.");
  });

  it("groups every path by folder with its tickets, filters to the shared ones and highlights a selected ticket's rows", async () => {
    const { slot } = await mountDashboard({ specVersion: sharing });
    openTab(slot, "Files");
    expect(folders(slot)).toEqual([
      ["", ["package.json"]],
      ["docs", ["docs/export.md"]],
      ["src/export", ["src/export/**"]],
      ["src/model", ["src/model/**", "src/model/README.md"]],
      ["src/shared", ["src/shared/types.ts"]],
    ]);
    const folder = (path: string) => pane(slot).querySelector<HTMLElement>(`[data-folder="${path}"]`)!;
    expect(folder("src/model").querySelector("h5")!.textContent).toBe("src/model · 2");
    expect(folder("").querySelector("h5")!.textContent).toBe("Top level · 1");
    const row = (path: string) => pane(slot).querySelector<HTMLElement>(`[data-file="${path}"]`)!;
    expect(row("src/shared/types.ts").textContent).toContain("types.ts");
    expect(chips(row("src/shared/types.ts"))).toEqual(["csv-model", "csv-export"]);
    expect(chips(row("src/model/README.md"))).toEqual(["csv-docs"]);
    expect(inPane(slot, "ticket[csv-export].scope")!.textContent).toContain("3 paths");

    const filter = within(pane(slot)).getByRole("group", { name: "Which files" });
    expect(within(filter).getByRole("button", { name: "All files" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(filter).getByRole("button", { name: "Shared only" }));
    expect(within(filter).getByRole("button", { name: "Shared only" }).getAttribute("aria-pressed")).toBe("true");
    expect(folders(slot)).toEqual([
      ["src/model", ["src/model/**", "src/model/README.md"]],
      ["src/shared", ["src/shared/types.ts"]],
    ]);
    fireEvent.click(within(filter).getByRole("button", { name: "All files" }));

    const highlighted = () => [...pane(slot).querySelectorAll("[data-file][data-highlighted]")].map((entry) => entry.getAttribute("data-file"));
    expect(highlighted()).toEqual([]);
    fireEvent.click(within(row("docs/export.md")).getByRole("button", { name: "csv-docs" }));
    expect(highlighted()).toEqual(["docs/export.md", "src/model/README.md"]);
    expect(inspector(slot).textContent).toContain("Export docs");
    fireEvent.click(slot.getByRole("button", { name: "Show all" }));
    expect(highlighted()).toEqual([]);

    openTab(slot, "Tickets");
    fireEvent.click(card(slot, "csv-export"));
    openTab(slot, "Files");
    expect(highlighted()).toEqual(["package.json", "src/export/**", "src/shared/types.ts"]);
  });

  it("shows the protected paths with the enforce setting, each with its note", async () => {
    const { slot } = await mountDashboard({ specVersion: sharing });
    openTab(slot, "Files");
    expect(inPane(slot, "scope.enforce")!.textContent).toContain("enforce: warn");
    expect(inPane(slot, "scope.protected[0]")!.textContent).toContain("package-lock.json");
    expect(inPane(slot, "scope.protected[1]")!.textContent).toContain(".github/**");
    expect(inPane(slot, "ticket[csv-model].scope")).not.toBeNull();
    expect(inPane(slot, "ticket[csv-docs].scope")).not.toBeNull();

    const { slot: open } = await mountDashboard({ specVersion: guarded });
    openTab(open, "Files");
    expect(inPane(open, "scope.protected[0]")!.textContent).toContain("package-lock.json");
  });

  it("lists the checks, each ticket's own verify commands and the review rules", async () => {
    const { slot } = await mountDashboard();
    openTab(slot, "Checks & review");
    expect(inPane(slot, "checks.commands[0]")!.textContent).toContain("npm test");
    expect(inPane(slot, "checks.timeout_minutes")!.textContent).toContain("15 minutes");
    expect(inPane(slot, "checks.after_merge[0]")).toBeNull();
    expect(inPane(slot, "ticket[csv-model].verify")!.textContent).toContain("none: only the project checks run");
    expect(inPane(slot, "ticket[csv-export].verify")!.textContent).toContain("none: only the project checks run");
    expect(inPane(slot, "review.approvals")!.textContent).toContain("1 approval needed, up to 3 rounds, reviewer codex / gpt");
    expect(inPane(slot, "checks.commands[0]")!.hasAttribute("data-changed")).toBe(true);
  });

  it("shows the goal, the merge plan, the agents and the limits", async () => {
    let view = specVersionView();
    const { slot } = await mountDashboard({ specVersion: () => view });
    openTab(slot, "Project & limits");
    expect(inPane(slot, "project.goal")!.textContent).toContain("Let people export their orders as a CSV file from the admin page.");
    expect(inPane(slot, "merge")!.textContent).toContain("Approved work merges into loom/csv from main; you land it as one pull request with bb loom land, or straight onto main with bb loom land --direct.");
    expect(inPane(slot, "agents.worker")!.textContent).toContain("Workers: claude / sonnet, up to 2 at a time, 120 minutes per ticket");
    expect(inPane(slot, "agents.reviewer")!.textContent).toContain("Reviewers: codex / gpt, up to 2 at a time");
    expect(inPane(slot, "budget.max_attempts")!.textContent).toContain("A ticket blocks after 3 failed attempts or 5 failed check runs");
    expect(inPane(slot, "budget.max_tokens")).toBeNull();
    expect(inPane(slot, "budget.deadline")).toBeNull();

    view = specVersionView({}, (doc) => {
      doc.merge = { strategy: "pr" };
      doc.budget = { max_tokens: 4_000_000, deadline: "2026-11-15" };
    });
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(inPane(slot, "merge")!.textContent).toContain("Each approved ticket opens its own pull request against main."));
    expect(inPane(slot, "budget.max_tokens")!.textContent).toContain("4,000,000");
    expect(inPane(slot, "budget.deadline")!.textContent).toContain("2026-11-15");
  });

  describe("notes", () => {
    beforeEach(() => localStorage.clear());
    const tray = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-notes-tray]")!;
    const note = { version: 2, paths: ["ticket[csv-export].acceptance[1]"], body: "Say what the header row holds." };
    const stored = { ...note, label: "csv-export › criterion 2" };

    it("collects a note on one part, keeps it across a remount, previews the message and removes it", async () => {
      const { slot } = await mountDashboard();
      expect(tray(slot).textContent).toContain("0 to send");
      fireEvent.click(within(inspector(slot)).getByRole("button", { name: "csv-export" }));
      fireEvent.click(slot.getByRole("button", { name: "Add a note on csv-export › criterion 2" }));
      expect(dashboard(slot).textContent).toContain("Note on csv-export › criterion 2");
      expect(slot.getByRole("button", { name: "Add note" }).hasAttribute("disabled")).toBe(true);
      fireEvent.change(slot.getByRole("textbox", { name: "Note text" }), { target: { value: "  Say what the header row holds. " } });
      fireEvent.click(slot.getByRole("button", { name: "Add note" }));
      expect(slot.queryByRole("textbox", { name: "Note text" })).toBeNull();
      expect(tray(slot).textContent).toContain("1 to send");
      expect(tray(slot).textContent).toContain("csv-export › criterion 2");
      expect(JSON.parse(localStorage.getItem("loom.notes.csv")!)).toEqual([stored]);
      expect(card(slot, "csv-export").textContent).toContain("1 note");
      expect(target(slot, "ticket[csv-export].acceptance[1]")!.hasAttribute("data-noted")).toBe(true);
      fireEvent.click(slot.getByRole("button", { name: "Preview message" }));
      expect(slot.container.querySelector("[data-notes-preview]")!.textContent).toBe(notesMessage({ slug: "csv", version: 2, status: "draft", notes: [note] }));

      slot.lifecycle.unmount();
      const again = await mountDashboard();
      expect(tray(again.slot).textContent).toContain("1 to send");
      fireEvent.click(again.slot.getByRole("button", { name: "Remove the note on csv-export › criterion 2" }));
      expect(tray(again.slot).textContent).toContain("0 to send");
      expect(localStorage.getItem("loom.notes.csv")).toBeNull();
    });

    it("sends the notes to the planner and empties the tray, and keeps them when the send is refused", async () => {
      localStorage.setItem("loom.notes.csv", JSON.stringify([stored]));
      let refuse = true;
      const sendNotes = () => {
        if (refuse) throw new Error("Project csv has no planner thread to send notes to.");
        return specVersionView({ notes: [{ ...note, sentAt: NOW, answeredIn: null, changed: false }] });
      };
      const { slot } = await mountDashboard({ sendNotes });
      fireEvent.click(slot.getByRole("button", { name: "Send 1 note to the planner" }));
      expect((await within(tray(slot)).findByRole("alert")).textContent).toContain("no planner thread");
      expect(tray(slot).textContent).toContain("1 to send");
      expect(localStorage.getItem("loom.notes.csv")).not.toBeNull();

      refuse = false;
      fireEvent.click(slot.getByRole("button", { name: "Send 1 note to the planner" }));
      await waitFor(() => expect(tray(slot).textContent).toContain("0 to send"));
      expect(calls(slot, "sendNotes").at(-1)!.input).toEqual({ slug: "csv", notes: [note], confirm: true });
      expect(localStorage.getItem("loom.notes.csv")).toBeNull();
      expect(tray(slot).querySelector("[data-sent-note]")!.textContent).toContain("Waiting for the planner's next version");
    });

    it("says what the planner's next version did with each sent note", async () => {
      const sent = (over: Partial<SentNote>): SentNote => ({ version: 2, paths: ["project.goal"], body: "Shorter.", sentAt: NOW, answeredIn: null, changed: false, ...over });
      const view = specVersionView({ notes: [sent({}), sent({ version: 1, answeredIn: 2, changed: true }), sent({ version: 1, answeredIn: 2, paths: ["checks.commands[0]"] })] });
      const { slot } = await mountDashboard({ specVersion: () => view });
      const rows = [...tray(slot).querySelectorAll("[data-sent-note]")].map((row) => row.textContent);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("Waiting for the planner's next version");
      expect(rows[1]).toContain("v2 changes this");
      expect(rows[2]).toContain("checks.commands[0]");
      expect(rows[2]).toContain("v2 leaves this as it was; the planner may have answered in its chat");
    });

    it("asks a second time before it sends notes written on a version older than the newest", async () => {
      localStorage.setItem("loom.notes.csv", JSON.stringify([stored]));
      let view = specVersionView();
      const sendNotes = vi.fn(() => view);
      const { slot } = await mountDashboard({ specVersion: () => view, sendNotes });
      expect(tray(slot).textContent).not.toContain("is newer");
      view = specVersionView({ version: 3, versions: [{ version: 1, status: "superseded" }, { version: 2, status: "superseded" }, { version: 3, status: "draft" }] });
      await slot.emitRealtime("loom:changed", { slug: "csv" });
      await waitFor(() => expect(tray(slot).textContent).toContain("Written on v2; v3 is newer"));
      fireEvent.click(slot.getByRole("button", { name: "Send 1 note to the planner" }));
      expect(sendNotes).not.toHaveBeenCalled();
      fireEvent.click(slot.getByRole("button", { name: "Click again to send 1 note to the planner" }));
      await waitFor(() => expect(sendNotes).toHaveBeenCalled());
      expect(calls(slot, "sendNotes")[0]!.input).toEqual({ slug: "csv", notes: [note], includeOlder: true, confirm: true });
    });
  });

  it("is not shown while the conversation has no draft", async () => {
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session({ slug: null, projectState: null }) });
    await slot.findByText(/No draft yet/);
    expect(slot.container.querySelector("[data-spec-dashboard]")).toBeNull();
    expect(calls(slot, "specVersion")).toEqual([]);
  });
});

describe("planner questions", () => {
  const session = (): PlanningSession => ({ threadId: "thr_p1", title: "Export orders as CSV", startedAt: Date.now(), slug: null, projectState: null });
  const sidebar = (threadId: string, hasPendingInteraction: boolean) => ({ threads: [{ id: threadId, hasPendingInteraction } as PluginSidebarThread] });
  const pending = { threadId: "thr_p1", turnId: null, expiresAt: null, status: "pending", statusReason: null, resolution: null, resolvedAt: null };
  const asked = (id: string, over: Record<string, unknown> = {}) => ({
    ...pending,
    id,
    createdAt: 1,
    origin: { kind: "plugin", pluginId: "better-ask", rendererId: "ask-user-question" },
    payload: { kind: "plugin", title: "The planner asks", data: { questions: [singleSelect, multiSelect] } },
    ...over,
  });
  const providerApproval = {
    ...pending,
    id: "int_provider",
    createdAt: 1,
    origin: { kind: "provider", providerId: "codex", providerRequestId: "req_1", providerThreadId: "pt_1" },
    payload: { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject: { kind: "command", command: "rm -rf dist" } },
  };
  const mountQuestions = async (rows: () => unknown[], respond: (args: unknown) => Promise<unknown> = async () => ({}), waiting = true) => {
    const list = vi.fn(async () => rows());
    const answer = vi.fn(respond);
    const sdk = { threads: { interactions: { list, respond: answer } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session() }, { sdk, sidebarThreads: sidebar("thr_p1", waiting) });
    await slot.findByText(/No draft yet/);
    return { slot, list, answer };
  };
  const card = (slot: Slot, id = "int_1") => slot.container.querySelector<HTMLElement>(`[data-question-card="${id}"]`);

  it("shows the planner's questions above its chat, and sends the answers as the question plugin's own form does", async () => {
    let rows = [asked("int_1")];
    const { slot, list, answer } = await mountQuestions(() => rows);
    await waitFor(() => expect(card(slot)).not.toBeNull());
    const form = within(card(slot)!);
    expect(form.getByText("The planner asks")).toBeTruthy();
    expect(form.getByText("How should finished tickets merge?")).toBeTruthy();
    expect(form.getByText("Which checks must pass?")).toBeTruthy();
    expect(form.getByText("Each runs in the ticket's worktree.")).toBeTruthy();
    expect(form.getByText("One branch, landed at the end")).toBeTruthy();
    expect(form.getByRole("button", { name: /npm run typecheck/ }).textContent).toContain("Recommended");
    expect(form.getAllByRole("textbox", { name: "Or type your own answer" })).toHaveLength(1);
    expect(card(slot)!.compareDocumentPosition(slot.getByTestId("bb-thread-chat")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const send = form.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    const option = (name: RegExp) => form.getByRole("button", { name });
    expect(send.disabled).toBe(true);
    fireEvent.click(option(/PR per ticket/));
    fireEvent.click(option(/Integration branch/));
    expect(option(/Integration branch/).getAttribute("aria-pressed")).toBe("true");
    expect(option(/PR per ticket/).getAttribute("aria-pressed")).toBe("false");
    expect(send.disabled).toBe(true);
    fireEvent.click(option(/npm run typecheck/));
    fireEvent.click(option(/npm run build/));
    fireEvent.change(form.getByRole("textbox", { name: "Or type your own answer" }), { target: { value: "  and docs " } });
    expect(send.disabled).toBe(false);

    rows = [];
    fireEvent.click(send);
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ threadId: "thr_p1", interactionId: "int_1", value: { answers: { q1: { selected: ["o1"] }, q2: { selected: ["o2", "o3"], freeText: "and docs" } } } }));
    await waitFor(() => expect(card(slot)).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ threadId: "thr_p1" });
  });

  it("shows why an answer failed, and sends a question it cannot draw to the thread", async () => {
    const other = asked("int_2", { createdAt: 0, origin: { kind: "plugin", pluginId: "colors", rendererId: "color-picker" }, payload: { kind: "plugin", title: "Pick a color", data: { questions: [singleSelect] } } });
    const unreadable = asked("int_3", { createdAt: 2, payload: { kind: "plugin", title: "A newer question form", data: { questions: "?" } } });
    const { slot } = await mountQuestions(
      () => [unreadable, asked("int_1"), other],
      async () => {
        throw new Error("The question was already answered.");
      },
    );
    await waitFor(() => expect(card(slot)).not.toBeNull());
    expect([...slot.container.querySelectorAll("[data-question-card]")].map((entry) => entry.getAttribute("data-question-card"))).toEqual(["int_2", "int_1", "int_3"]);

    const form = within(card(slot)!);
    fireEvent.click(form.getByRole("button", { name: /PR per ticket/ }));
    fireEvent.click(form.getByRole("button", { name: /npm test/ }));
    fireEvent.click(form.getByRole("button", { name: "Send answer" }));
    expect((await form.findByRole("alert")).textContent).toBe("The question was already answered.");
    expect((form.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(false);

    expect(card(slot, "int_2")!.textContent).toContain("Pick a color");
    expect(card(slot, "int_3")!.textContent).toContain("A newer question form");
    fireEvent.click(within(card(slot, "int_2")!).getByRole("button", { name: "Answer in the thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_p1" }]);
  });

  it("shows no card for a provider's own question or approval, and does not list a thread that is not waiting", async () => {
    const provider = await mountQuestions(() => [providerApproval]);
    await waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
    expect(provider.slot.container.querySelector("[data-question-card]")).toBeNull();
    provider.slot.lifecycle.unmount();

    const idle = await mountQuestions(() => [asked("int_1")], undefined, false);
    expect(idle.slot.container.querySelector("[data-question-card]")).toBeNull();
    expect(idle.list).not.toHaveBeenCalled();
  });

  it("shows the questions on the project's Planner tab too", async () => {
    const list = vi.fn(async () => [asked("int_1", { threadId: "thr_plan" })]);
    const sdk = { threads: { interactions: { list } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("csv", { project: () => projectView() }, { sdk, sidebarThreads: sidebar("thr_plan", true) });
    fireEvent.click(await slot.findByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(card(slot)).not.toBeNull());
    expect(list).toHaveBeenCalledWith({ threadId: "thr_plan" });
  });
});

describe("routing", () => {
  it("shows a project for <slug> and asks for it by slug", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    expect((await slot.findByRole("heading", { name: "CSV export" })).textContent).toBe("CSV export");
    expect(calls(slot, "project")[0]!.input).toEqual({ slug: "csv" });
    expect(calls(slot, "projects")).toEqual([]);
  });

  it("shows a ticket for <slug>/<KEY> and asks for it by key", async () => {
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => ticketDetail() });
    await waitFor(() => expect(calls(slot, "ticket")).toHaveLength(1));
    expect(calls(slot, "ticket")[0]!.input).toEqual({ key: "CSV-2" });
    expect(calls(slot, "project")).toEqual([]);
  });

  it("moves between the list, a project and a ticket when the address changes", async () => {
    const { slot, goTo } = await mountPage("", { home: () => homeView(), project: () => projectView(), ticket: () => ticketDetail() });
    await slot.findByText("CSV export");
    goTo("csv");
    await slot.findByRole("heading", { name: "CSV export" });
    goTo("csv/CSV-2");
    await waitFor(() => expect(calls(slot, "ticket")).toHaveLength(1));
    goTo("");
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(2));
  });

  it("has breadcrumbs that go back up", async () => {
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => ticketDetail() });
    fireEvent.click(await slot.findByRole("button", { name: "csv" }));
    fireEvent.click(slot.getByRole("button", { name: "Loom" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv"), pushed("")]);
  });
});

describe("project controls", () => {
  const withState = (state: ProjectSummary["state"], over: Partial<ProjectSummary> = {}) => projectView({ overview: overview({ state, ...over }) });
  const labels = async (view: ReturnType<typeof projectView>) => {
    const { slot } = await mountPage("csv", { project: () => view });
    await slot.findByRole("heading", { name: "CSV export" });
    const shown = [...slot.container.querySelectorAll("[data-controls] button")].map((button) => button.textContent);
    slot.lifecycle.unmount();
    return shown;
  };

  const bare = (state: ProjectSummary["state"], over: Partial<ProjectSummary> = {}) => ({ ...withState(state, over), next: null });
  const starting = (): NextStep => ({ stage: 3, tone: "normal", title: "Next: start the project.", text: "Loom starts 2 workers right away, on CSV-1 and CSV-3.", action: { control: "start", label: "Start project · 2 workers", confirm: "Click again to start 2 workers" } });

  it("shows the controls that fit the project's state, with Archive in the ⋯ menu", async () => {
    const none = { ticketCounts: { queued: 2 } };
    expect(await labels(bare("draft", { approvedVersion: null, ...none }))).toEqual(["Approve", "⋯"]);
    expect(await labels(bare("ready", none))).toEqual(["Start", "⋯"]);
    expect(await labels(bare("running", none))).toEqual(["Pause", "Pause now", "⋯"]);
    expect(await labels(bare("paused", none))).toEqual(["Resume", "⋯"]);
    expect(await labels(bare("done", none))).toEqual(["⋯"]);
    expect(await labels(bare("archived", none))).toEqual([]);
  });

  it("offers Land on an integration project with a done ticket, and Approve for a pending spec version", async () => {
    expect(await labels(bare("running", { ticketCounts: { done: 1 } }))).toEqual(["Pause", "Pause now", "Land", "Land to main", "⋯"]);
    expect(await labels(bare("running", { strategy: "pr", ticketCounts: { done: 1 } }))).toEqual(["Pause", "Pause now", "⋯"]);
    expect(await labels(bare("paused", { pendingVersion: 2, ticketCounts: {} }))).toEqual(["Approve v2", "Resume", "⋯"]);
  });

  it("lands to the base branch from the header after a second click", async () => {
    const control = vi.fn(() => bare("done", { ticketCounts: { done: 1 } }));
    const { slot } = await mountPage("csv", { project: () => bare("running", { ticketCounts: { done: 1 } }), control });
    fireEvent.click(await slot.findByRole("button", { name: "Land to main" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Click again to land to main" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "landDirect", confirm: true }));
  });

  it("leaves the next step's action out of the header", async () => {
    expect(await labels({ ...withState("ready", { ticketCounts: { queued: 2 } }), next: starting() })).toEqual(["⋯"]);
  });

  it("archives through the ⋯ menu after a second click", async () => {
    const control = vi.fn(() => withState("archived"));
    const { slot } = await mountPage("csv", { project: () => withState("running"), control });
    fireEvent.click(await slot.findByRole("button", { name: "More actions" }));
    fireEvent.click(slot.getByRole("button", { name: "Archive project" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Click again to archive project" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "archive", confirm: true }));
  });

  it("shows the next step over the tabs, yellow with the reason when tickets are blocked", async () => {
    const next: NextStep = { stage: 4, tone: "warning", title: "1 ticket is blocked.", text: "CSV-1: bb refused to start a worker.", action: null };
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("running"), next }) });
    await slot.findByRole("heading", { name: "CSV export" });
    const bar = slot.container.querySelector<HTMLElement>('[data-next-step][data-tone="warning"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Next step");
    expect(bar.textContent).toContain("1 ticket is blocked.");
    expect(bar.textContent).toContain("CSV-1: bb refused to start a worker.");
    expect([...bar.querySelectorAll("[data-stage]")].map((stage) => [stage.getAttribute("data-stage"), stage.getAttribute("data-stage-state")])).toEqual([
      ["Plan", "done"],
      ["Review draft", "done"],
      ["Approve", "done"],
      ["Start", "done"],
      ["Work", "current"],
      ["Land", "todo"],
    ]);
    expect(bar.querySelector('[aria-current="step"]')!.getAttribute("data-stage")).toBe("Work");
    expect(bar.querySelector("button")).toBeNull();
  });

  it("acts from the bar's button after a second click", async () => {
    const control = vi.fn(() => withState("running"));
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("ready"), next: starting() }), control });
    const bar = () => slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(await slot.findByRole("button", { name: "Start project · 2 workers" }));
    expect(bar().getAttribute("data-tone")).toBe("normal");
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(within(bar()).getByRole("button", { name: "Click again to start 2 workers" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "start", confirm: true }));
  });

  it("asks twice before it acts, then calls control with confirm: true and shows the refreshed project", async () => {
    const control = vi.fn(() => projectView({ overview: overview({ state: "running" }) }));
    const { slot } = await mountPage("csv", { project: () => withState("ready"), control });
    fireEvent.click(await slot.findByRole("button", { name: "Start" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Click again to start" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "start", confirm: true }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Start" })).toBeNull());
    expect(slot.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("goes back to the plain label after five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { slot } = await mountPage("csv", { project: () => withState("ready") });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      fireEvent.click(slot.getByRole("button", { name: "Start" }));
      expect(slot.getByRole("button", { name: "Click again to start" })).toBeTruthy();
      act(() => void vi.advanceTimersByTime(4900));
      expect(slot.getByRole("button", { name: "Click again to start" })).toBeTruthy();
      act(() => void vi.advanceTimersByTime(200));
      expect(slot.getByRole("button", { name: "Start" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends Pause now and an approve version with their own actions", async () => {
    const control = vi.fn(() => withState("running", { pendingVersion: 2 }));
    const { slot } = await mountPage("csv", { project: () => withState("running", { pendingVersion: 2 }), control });
    fireEvent.click(await slot.findByRole("button", { name: "Pause now" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to pause now" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "pauseNow", confirm: true }));
    fireEvent.click(await slot.findByRole("button", { name: "Approve v2" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to approve v2" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("shows a refusal under the header", async () => {
    const control = () => {
      throw new Error("Project csv is ready; pause needs a running project.");
    };
    const { slot } = await mountPage("csv", { project: () => withState("ready"), control });
    fireEvent.click(await slot.findByRole("button", { name: "Start" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to start" }));
    expect((await slot.findByRole("alert")).textContent).toContain("pause needs a running project");
  });

});

describe("confirm button", () => {
  it("turns amber on the first click, with a bar that drains and a Cancel button, and acts on the second", () => {
    const onConfirm = vi.fn();
    const view = render(<ConfirmButton label="Start" onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: "Start" }));
    const armed = view.getByRole("button", { name: "Click again to start" });
    expect(armed.hasAttribute("data-confirming")).toBe(true);
    expect(armed.className).toContain("bg-warning");
    expect(armed.querySelector<HTMLElement>("[data-drain]")!.style.transform).toBe("scaleX(0)");
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(armed);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Start" }).hasAttribute("data-confirming")).toBe(false);
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("goes back to its label on Cancel without acting", () => {
    const onConfirm = vi.fn();
    const view = render(<ConfirmButton label="Archive project" danger onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: "Archive project" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.getByRole("button", { name: "Archive project" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says its own confirm label when it has one", () => {
    const view = render(<ConfirmButton primary label="Start project · 2 workers" confirmLabel="Click again to start 2 workers" onConfirm={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Start project · 2 workers" }));
    expect(view.getByRole("button", { name: "Click again to start 2 workers" }).className).toContain("h-9");
  });
});

describe("more menu", () => {
  it("shows its items when opened, and closes on a mousedown outside it", () => {
    const view = render(
      <div>
        <button type="button">Outside</button>
        <MoreMenu>
          <button type="button">Archive project</button>
        </MoreMenu>
      </div>,
    );
    const toggle = view.getByRole("button", { name: "More actions" });
    expect(toggle.textContent).toBe("⋯");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("button", { name: "Archive project" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(view.getByRole("button", { name: "Archive project" }));
    expect(view.getByRole("button", { name: "Archive project" })).toBeTruthy();
    fireEvent.mouseDown(view.getByRole("button", { name: "Outside" }));
    expect(view.queryByRole("button", { name: "Archive project" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("live updates", () => {
  it("asks for the project again when it changes, and ignores other projects", async () => {
    let state: ProjectSummary["state"] = "ready";
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ state }) }) });
    await slot.findByRole("button", { name: "Start" });
    state = "running";
    await slot.emitRealtime("loom:changed", { slug: "other" });
    expect(calls(slot, "project")).toHaveLength(1);
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(slot.getByRole("button", { name: "Pause" })).toBeTruthy());
    expect(calls(slot, "project")).toHaveLength(2);
  });
});

describe("spec tab", () => {
  it("shows the spec dashboard, and approves a pending version after a second click", async () => {
    const control = vi.fn(() => projectView());
    const view = projectView({ spec: { ...projectView().spec, toml: '[project]\nslug = "csv"\n', version: 1, pendingVersion: 2 }, overview: overview({ pendingVersion: 2 }) });
    const { slot } = await mountPage("csv", { project: () => view, control, specVersion: () => specVersionView() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-dashboard]")).not.toBeNull());
    expect(calls(slot, "specVersion")[0]!.input).toEqual({ slug: "csv" });
    const approve = slot.container.querySelector("[data-spec-pending] button")!;
    fireEvent.click(approve);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.container.querySelector("[data-spec-pending] button")!);
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("leaves a pending version's Approve to the next-step bar when the bar carries it", async () => {
    const next: NextStep = { stage: 4, tone: "normal", title: "Next: approve v2.", text: "The planner proposed spec v2.", action: { control: "approve", version: 2, label: "Approve v2", confirm: "Click again to approve v2" } };
    const control = vi.fn(() => projectView());
    const view = projectView({ spec: { ...projectView().spec, pendingVersion: 2 }, overview: overview({ pendingVersion: 2 }), next });
    const { slot } = await mountPage("csv", { project: () => view, control, specVersion: () => specVersionView() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-dashboard]")).not.toBeNull());
    expect(slot.container.querySelector("[data-spec-pending]")!.textContent).toContain("Pending v2");
    expect(slot.container.querySelector("[data-spec-pending] button")).toBeNull();
    expect(slot.getAllByRole("button", { name: /^Approve v2/ })).toHaveLength(1);
    expect(slot.getByRole("button", { name: "More actions" })).toBeTruthy();
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-next-step]")!).getByRole("button", { name: "Approve v2" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("keeps the chosen tab across a change of the project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), specVersion: () => specVersionView() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(calls(slot, "project")).toHaveLength(2));
    expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("board", () => {
  const cards = [
    card({ key: "CSV-1", title: "Order rows", state: "done", ready: false }),
    card({ key: "CSV-2", title: "Export endpoint", state: "working", attempt: 2, ready: false, threadId: "thr_w1" }),
    card({ key: "CSV-3", title: "Docs", state: "queued", ready: true }),
    card({ key: "CSV-4", title: "Guide", state: "queued", ready: false, deps: ["CSV-2"], waitingOn: ["CSV-2", "CSV-3"] }),
    card({ key: "CSV-5", title: "Fix flaky test", state: "blocked", ready: false, blockedReason: "Needs a decision." }),
    card({ key: "CSV-6", title: "Old idea", state: "cancelled", ready: false }),
    card({ key: "CSV-7", title: "Review me", state: "review", ready: false, reviewRound: 2, threadId: "thr_r1" }),
    card({ key: "CSV-8", title: "Merge me", state: "merging", ready: false }),
    card({ key: "CSV-9", title: "Open PR", state: "pr_open", ready: false, prUrl: "https://github.com/acme/shop/pull/9" }),
  ];
  const lane = (slot: Slot, state: string) => slot.container.querySelector<HTMLElement>(`[data-lane="${state}"]`)!;
  const mountBoard = async (strategy: "integration" | "pr" = "integration") => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ strategy, branch: strategy === "pr" ? null : "loom/csv" }), board: cards.map((entry) => ({ ...entry, stateAt: projectView().now - 5 * HOUR })) }) });
    await slot.findByRole("tab", { name: "Board" });
    return slot;
  };

  it("has one lane per ticket state, in order, with the cancelled lane collapsed", async () => {
    const slot = await mountBoard();
    expect([...slot.container.querySelectorAll("[data-lane]")].map((node) => node.getAttribute("data-lane"))).toEqual(["queued", "working", "checking", "review", "approved", "done", "blocked", "cancelled"]);
    expect(lane(slot, "approved").textContent).toContain("Approved and merging");
    expect(lane(slot, "approved").textContent).toContain("Merge me");
    expect(lane(slot, "cancelled").textContent).not.toContain("Old idea");
    fireEvent.click(lane(slot, "cancelled").querySelector("button[aria-expanded]")!);
    expect(lane(slot, "cancelled").textContent).toContain("Old idea");
  });

  it("shows the PR open lane only for the pull request strategy", async () => {
    const pr = await mountBoard("pr");
    expect([...pr.container.querySelectorAll("[data-lane]")].map((node) => node.getAttribute("data-lane"))).toEqual(["queued", "working", "checking", "review", "approved", "pr_open", "done", "blocked", "cancelled"]);
    expect(lane(pr, "pr_open").textContent).toContain("Open PR");
  });

  it("splits the queue into ready tickets and tickets that wait, and names what they wait on", async () => {
    const slot = await mountBoard();
    const queued = lane(slot, "queued");
    expect(queued.querySelector('[data-queue-group="ready"]')!.textContent).toContain("Docs");
    expect(queued.querySelector('[data-queue-group="ready"]')!.textContent).not.toContain("Guide");
    expect(queued.querySelector('[data-queue-group="waiting"]')!.textContent).toContain("Guide");
    expect(queued.textContent).toContain("Waiting on CSV-2, CSV-3");
  });

  it("shows each card's age in its state, attempt and review round", async () => {
    const slot = await mountBoard();
    const working = lane(slot, "working").querySelector('[data-card="CSV-2"]')!;
    expect(working.textContent).toContain("Export endpoint");
    expect(working.textContent).toContain("5h in working");
    expect(working.textContent).toContain("attempt 2");
    expect(lane(slot, "review").querySelector('[data-card="CSV-7"]')!.textContent).toContain("round 2");
    expect(lane(slot, "blocked").textContent).toContain("Needs a decision.");
  });

  it("opens a ticket on the page from its card, and its thread from the thread link", async () => {
    const slot = await mountBoard();
    fireEvent.click(lane(slot, "working").querySelector('[data-card="CSV-2"] button[data-open-ticket]')!);
    fireEvent.click(slot.getByRole("button", { name: "Open thread for CSV-2" }));
    fireEvent.click(slot.getByRole("button", { name: "Open thread for CSV-7" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-2"), { method: "toThread", threadId: "thr_w1" }, { method: "toThread", threadId: "thr_r1" }]);
    expect(slot.queryByRole("button", { name: "Open thread for CSV-3" })).toBeNull();
  });

  it("opens a pull request from its card", async () => {
    const slot = await mountBoard("pr");
    fireEvent.click(slot.getByRole("button", { name: "Open the pull request for CSV-9" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://github.com/acme/shop/pull/9" }]);
  });

  it("scrolls sideways on a narrow screen", async () => {
    const slot = await mountBoard();
    expect(slot.container.querySelector("[data-board]")!.className).toContain("overflow-x-auto");
  });

  it("shows a draft's tickets as dashed cards under a note, with no ticket link", async () => {
    const draft = projectView({
      overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }),
      board: [card({ key: "CSV-1", title: "Order rows" }), card({ key: "CSV-2", title: "Export endpoint", ready: false, deps: ["CSV-1"], waitingOn: ["CSV-1"] })],
    });
    const { slot } = await mountPage("csv", { project: () => draft });
    await slot.findByRole("tab", { name: "Board" });
    expect(slot.container.querySelector("[data-draft-note]")!.textContent).toBe("Draft v1: approving creates these 2 tickets. Dashed cards are not on the board yet.");
    const { slot: one } = await mountPage("csv", { project: () => ({ ...draft, board: draft.board.slice(0, 1) }) });
    await one.findByRole("tab", { name: "Board" });
    expect(one.container.querySelector("[data-draft-note]")!.textContent).toBe("Draft v1: approving creates this ticket. Its dashed card is not on the board yet.");
    const queued = lane(slot, "queued");
    const ready = queued.querySelector<HTMLElement>('[data-queue-group="ready"] [data-card="CSV-1"]')!;
    const waiting = queued.querySelector<HTMLElement>('[data-queue-group="waiting"] [data-card="CSV-2"]')!;
    expect(ready.hasAttribute("data-draft")).toBe(true);
    expect(ready.className).toContain("border-dashed");
    expect(ready.textContent).toContain("CSV-1 · draft");
    expect(ready.textContent).toContain("Order rows");
    expect(waiting.textContent).toContain("Waits on CSV-1");
    expect(slot.container.querySelector("[data-open-ticket]")).toBeNull();
  });

  it("shows no draft note on a project that is running", async () => {
    const slot = await mountBoard();
    expect(slot.container.querySelector("[data-draft-note]")).toBeNull();
    expect(slot.container.querySelector("[data-draft]")).toBeNull();
  });
});

describe("ticket", () => {
  type CheckStep = ChecksItem["steps"][number];
  type Item = Attempt["items"][number];
  const posts = [
    { id: 1, parentId: null, depth: 0, authorKind: "planner" as const, authorThreadId: "thr_plan", kind: "brief" as const, body: "Serve the file.\n\nAcceptance criteria:\n1. Streams a CSV", at: 1 },
    { id: 2, parentId: 1, depth: 1, authorKind: "human" as const, authorThreadId: null, kind: "reply" as const, body: "Use the v2 API", at: 2 },
    { id: 3, parentId: 2, depth: 2, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "note" as const, body: "On it.", at: 3 },
    { id: 5, parentId: 3, depth: 9, authorKind: "human" as const, authorThreadId: null, kind: "reply" as const, body: "Deep", at: 5 },
    { id: 4, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "claim" as const, body: "Worker attempt 1 is starting.", at: 4 },
  ];
  const brief = { postId: 1, at: 1, edits: 0, fields: [] };
  const withItems = (items: Item[], over: Partial<Attempt> = {}) => ({ brief, before: [], attempts: [attempt({ claimPostId: 4, items, ...over })] });
  const mountTicket = async (over: Parameters<typeof ticketDetail>[0] = {}, rpc: Partial<Handlers> = {}) => {
    const view = ticketDetail({ posts, activity: withItems([]), ...over });
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => view, ...rpc });
    await slot.findByRole("heading", { name: /Export endpoint/ });
    return slot;
  };
  const post = (slot: Slot, id: number) => slot.container.querySelector<HTMLElement>(`[data-post="${id}"]`)!;
  const step = (over: Partial<CheckStep> = {}): CheckStep => ({ label: "npm test", kind: "command", ok: true, exitCode: 0, timedOut: false, durationMs: 1200, running: false, runId: null, outputChars: 0, output: null, startedAt: null, ...over });
  const checks = (over: Partial<ChecksItem> = {}): ChecksItem => ({ type: "checks", postId: null, at: Date.now() - HOUR, afterMerge: false, status: "passed", steps: [step()], outside: [], changed: null, ...over });
  const stepOf = (slot: Slot, label: string) => [...slot.container.querySelectorAll<HTMLElement>("[data-check-step]")].find((node) => node.textContent!.includes(label))!;
  // An unfinished pipeline, a failed one and a running one, oldest first.
  const pipelines = (): Item[] => [
    checks({ status: "unfinished", steps: [step({ label: "npm run e2e", ok: null, exitCode: null, durationMs: null, runId: 3, outputChars: 41 })] }),
    checks({ status: "failed", steps: [step({ label: "git commit", kind: "git", exitCode: null, durationMs: 40, runId: 4 }), step({ label: "npm test", ok: false, exitCode: 2, durationMs: 300, runId: 1, outputChars: 10 })] }),
    checks({ status: "running", steps: [step({ label: "npm run lint", ok: null, exitCode: null, durationMs: null, running: true, runId: 2, startedAt: Date.now() - 40_000 })] }),
  ];

  it("wraps a long branch name and a long step title on the ticket page", async () => {
    const slot = await mountTicket({ branch: `loom/${"a-very-long-branch-name-".repeat(8)}`, activity: withItems([checks({ status: "failed", steps: [step({ label: `npm test -- ${"src/".repeat(40)}` })] })]) });
    expect(slot.container.querySelector("[data-ticket-branch]")!.className).toContain("[overflow-wrap:anywhere]");
    expect(slot.container.querySelector("[data-check-step] .font-mono")!.className).toContain("[overflow-wrap:anywhere]");
  });

  it("shows the ticket's key, title, state, attempt, branch, acceptance criteria, pull request and thread", async () => {
    const slot = await mountTicket({ reviewRound: 2, prUrl: "https://github.com/acme/shop/pull/2" });
    const header = slot.container.querySelector<HTMLElement>("[data-ticket-header]")!;
    expect(header.textContent).toContain("CSV-2");
    expect(slot.getByRole("heading", { level: 1 }).textContent).toBe("Export endpoint");
    expect(header.querySelector("[data-state-badge]")!.textContent).toBe("working");
    expect(header.textContent).toContain("1 attempt");
    expect(header.textContent).toContain("2 review rounds");
    expect(header.querySelector("[data-ticket-branch]")!.textContent).toContain("loom/csv-2");
    expect(within(header).getByRole("button", { name: "CSV-1" })).toBeTruthy();
    expect([...header.querySelectorAll("[data-stage]")].map((node) => node.getAttribute("data-mark"))).toEqual(["done", "now", "todo", "todo", "todo", "todo"]);
    expect(slot.container.querySelector("[data-ticket-side] [data-ac]")!.textContent).toContain("WHEN the endpoint is called THE SYSTEM SHALL stream a CSV");
    fireEvent.click(within(header).getByRole("button", { name: "Open worker thread" }));
    fireEvent.click(slot.getByRole("button", { name: "Open the pull request" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_w1" }, { method: "openUrl", url: "https://github.com/acme/shop/pull/2" }]);
  });

  it("lists every thread with its attempt or round and how it ended", async () => {
    const slot = await mountTicket({
      threads: [
        { threadId: "thr_old", role: "worker", attempt: null, reviewRound: 0, state: "ended", startedAt: 1_000, endedAt: 61_000, endReason: "abandoned" },
        { threadId: "thr_w1", role: "worker", attempt: 2, reviewRound: 0, state: "active", startedAt: Date.now() - 5 * 60_000, endedAt: null, endReason: null },
        { threadId: null, role: "reviewer", attempt: null, reviewRound: 1, state: "ended", startedAt: 0, endedAt: 0, endReason: "failed" },
        { threadId: "thr_r2", role: "reviewer", attempt: null, reviewRound: 2, state: "ended", startedAt: 0, endedAt: 90_000, endReason: "verdict" },
        { threadId: "thr_r3", role: "reviewer", attempt: null, reviewRound: 2, state: "ended", startedAt: 0, endedAt: 30_000, endReason: "superseded" },
      ],
      reviews: [{ id: 7, round: 2, verdict: "approved", status: "approved", summary: "Fine", findings: [], threadId: "thr_r2", at: 1 }],
    });
    const row = (id: string) => slot.container.querySelector<HTMLElement>(`[data-ticket-side] [data-ticket-threads] [data-thread-row="${id}"]`)!;
    expect(row("thr_old").textContent).toContain("Worker · attempt 1");
    expect(row("thr_old").textContent).toContain("idle twice");
    expect(row("thr_old").textContent).toContain("1m");
    expect(row("thr_w1").textContent).toContain("Worker · attempt 2");
    expect(row("thr_w1").textContent).toContain("working");
    expect(row("thr_w1").textContent).toContain("5m");
    expect(row("reviewer").textContent).toContain("Reviewer · round 1");
    expect(row("reviewer").textContent).toContain("could not start");
    expect(row("reviewer").textContent).not.toContain("0s");
    expect(row("thr_r2").textContent).toContain("Reviewer · round 2");
    expect(row("thr_r2").textContent).toContain("approved");
    expect(row("thr_r3").textContent).toContain("superseded by a newer round");
    expect(within(row("reviewer")).queryByRole("button")).toBeNull();
    fireEvent.click(within(row("thr_r2")).getByRole("button", { name: "Open reviewer thread (round 2)" }));
    fireEvent.click(slot.getByRole("button", { name: "Open worker thread (attempt 1)" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_r2" },
      { method: "toThread", threadId: "thr_old" },
    ]);
  });

  it("indents each reply by its depth, 16px a level and no deeper than six levels", async () => {
    const slot = await mountTicket();
    expect([...slot.container.querySelectorAll("[data-post]")].map((node) => node.getAttribute("data-post"))).toEqual(["1", "2", "3", "5"]);
    expect(post(slot, 1).style.marginLeft).toBe("0px");
    expect(post(slot, 2).style.marginLeft).toBe("16px");
    expect(post(slot, 3).style.marginLeft).toBe("32px");
    expect(post(slot, 5).style.marginLeft).toBe("96px");
    expect(post(slot, 2).textContent).toContain("You");
    expect(post(slot, 3).textContent).toContain("Worker · attempt 1");
    expect(post(slot, 3).textContent).toContain("note");
    const body = post(slot, 2).querySelector<HTMLElement>("[data-post-body]")!;
    expect(within(body).getByTestId("bb-markdown").textContent).toBe("Use the v2 API");
    expect(within(body).getByTestId("bb-markdown").className).toContain("[overflow-wrap:anywhere]");
  });

  it("sends a reply to a post with its parentId and shows the refreshed thread", async () => {
    const refreshed = [...posts.slice(0, 4), { id: 6, parentId: 3, depth: 3, authorKind: "human" as const, authorThreadId: null, kind: "reply" as const, body: "Thanks", at: 6 }, posts[4]!];
    const reply = vi.fn(() => ticketDetail({ posts: refreshed, activity: withItems([]) }));
    const slot = await mountTicket({}, { reply });
    fireEvent.click(slot.getByRole("button", { name: "Reply to #3" }));
    expect(post(slot, 3).querySelector("[data-reply-hint]")!.textContent).toBe("The worker gets this now.");
    fireEvent.change(slot.getByRole("textbox", { name: "Reply text for #3" }), { target: { value: "Thanks" } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply to #3" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({ key: "CSV-2", body: "Thanks", parentId: 3, confirm: true }));
    await waitFor(() => expect(post(slot, 6).style.marginLeft).toBe("48px"));
    expect(slot.queryByRole("textbox", { name: "Reply text for #3" })).toBeNull();
  });

  it("sends a new top-level reply from the box at the end, and not an empty one", async () => {
    const reply = vi.fn(() => ticketDetail({ posts }));
    const slot = await mountTicket({}, { reply });
    const box = slot.getByRole("textbox", { name: "New reply" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Write on CSV-2…");
    expect(slot.container.querySelector("[data-reply-hint]")!.textContent).toBe("The worker gets this now.");
    expect((slot.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  Please add a test.  " } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({ key: "CSV-2", body: "Please add a test.", confirm: true }));
    await waitFor(() => expect((slot.getByRole("textbox", { name: "New reply" }) as HTMLTextAreaElement).value).toBe(""));
  });

  it("shows Requeue only for a blocked ticket, and sends the action with the note after a second click", async () => {
    const working = await mountTicket();
    expect(working.queryByRole("button", { name: "Requeue" })).toBeNull();
    expect(working.container.querySelector("[data-blocked-callout]")).toBeNull();
    working.lifecycle.unmount();

    const block = { id: 6, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "block" as const, body: "Needs a decision. Which API?", at: 6 };
    const ticketAction = vi.fn(() => ticketDetail({ state: "queued", posts }));
    const blocked = { state: "blocked" as const, blockedReason: "Needs a decision. Which API?", replyTo: "planner" as const, stoppedFrom: "working" as const, posts: [...posts, block] };
    const slot = await mountTicket({ ...blocked, activity: withItems([{ type: "post", postId: 6 }], { outcome: "blocked", endedAt: Date.now() }) }, { ticketAction });
    const callout = slot.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
    expect(callout.hasAttribute("data-ticket-actions")).toBe(true);
    expect(callout.textContent).toContain("Blocked: the worker needs an answer");
    expect(callout.textContent).toContain("Needs a decision. Which API?");
    expect(callout.textContent).toContain("Or reply on the post: the planner gets it now and can requeue the ticket itself.");
    expect((within(callout).getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).placeholder).toBe("Your answer for the next worker (required)");
    expect((within(callout).getByRole("button", { name: "Requeue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "More actions" }));
    expect(slot.queryByRole("button", { name: "Block" })).toBeNull();
    expect(slot.getByRole("button", { name: "Cancel ticket" })).toBeTruthy();
    fireEvent.change(within(callout).getByRole("textbox", { name: "Note" }), { target: { value: "Use the v2 API" } });
    fireEvent.click(within(callout).getByRole("button", { name: "Requeue" }));
    expect(ticketAction).not.toHaveBeenCalled();
    fireEvent.click(within(callout).getByRole("button", { name: "Click again to requeue" }));
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-2", action: "requeue", note: "Use the v2 API", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-header] [data-state-badge]")!.textContent).toBe("queued"));
    slot.lifecycle.unmount();

    const refused = await mountTicket({ ...blocked, posts, replyTo: null, blockedReason: "bb refused to start a worker: HTTP 400" });
    const plain = refused.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
    expect(plain.textContent).toContain("Blocked");
    expect(plain.textContent).not.toContain("the worker needs an answer");
    expect(plain.textContent).not.toContain("Or reply on the post");
    expect(within(plain).queryByRole("button", { name: "Read the post that blocked it" })).toBeNull();
  });

  it("sends Block and Cancel with the reason from the ⋯ menu, and offers neither on a finished ticket", async () => {
    const ticketAction = vi.fn(() => ticketDetail({ posts }));
    const slot = await mountTicket({}, { ticketAction });
    fireEvent.click(slot.getByRole("button", { name: "More actions" }));
    const reason = () => slot.getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement;
    expect(reason().placeholder).toBe("Why (required)");
    expect(slot.container.querySelector("[data-more-menu]")!.textContent).toContain("Each needs a reason and a second click.");
    expect((slot.getByRole("button", { name: "Block" }) as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByRole("button", { name: "Cancel ticket" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(reason(), { target: { value: "Wrong approach" } });
    fireEvent.click(slot.getByRole("button", { name: "Block" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to block" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "block", note: "Wrong approach", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-more-menu]")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "More actions" }));
    expect(reason().value).toBe("");
    fireEvent.change(reason(), { target: { value: "Not needed" } });
    fireEvent.click(slot.getByRole("button", { name: "Cancel ticket" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to cancel ticket" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "cancel", note: "Not needed", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-more-menu]")).toBeNull());
    slot.lifecycle.unmount();

    const refused = await mountTicket({}, {
      ticketAction: () => {
        throw new Error("The ticket is checking.");
      },
    });
    fireEvent.click(refused.getByRole("button", { name: "More actions" }));
    fireEvent.change(refused.getByRole("textbox", { name: "Reason" }), { target: { value: "Wrong approach" } });
    fireEvent.click(refused.getByRole("button", { name: "Block" }));
    fireEvent.click(refused.getByRole("button", { name: "Click again to block" }));
    expect((await refused.findByRole("alert")).textContent).toContain("The ticket is checking.");
    expect((refused.getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement).value).toBe("Wrong approach");
    refused.lifecycle.unmount();

    for (const state of ["done", "cancelled"] as const) {
      const finished = await mountTicket({ state });
      expect(finished.queryByRole("button", { name: "More actions" })).toBeNull();
      expect(finished.queryByRole("button", { name: "Block" })).toBeNull();
      expect(finished.queryByRole("button", { name: "Cancel ticket" })).toBeNull();
      expect(finished.queryByRole("textbox", { name: "Reason" })).toBeNull();
      finished.lifecycle.unmount();
    }
  });

  it("shows a refusal under the header", async () => {
    const reply = () => {
      throw new Error("Post #99 is on another ticket or does not exist.");
    };
    const slot = await mountTicket({}, { reply });
    fireEvent.change(slot.getByRole("textbox", { name: "New reply" }), { target: { value: "x" } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain("another ticket");
    expect(slot.container.querySelector("[data-ticket-header]")!.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists the reviews with their findings", async () => {
    const note = { id: 7, parentId: null, depth: 0, authorKind: "reviewer" as const, authorThreadId: "thr_r2", kind: "note" as const, body: "Ran the export tests.", at: 7 };
    const review = { id: 8, parentId: null, depth: 0, authorKind: "reviewer" as const, authorThreadId: "thr_r2", kind: "review" as const, body: "Changes requested (round 2): Needs a fix", at: 8 };
    const slot = await mountTicket({
      state: "done",
      posts: [...posts, note, review],
      reviews: [
        { id: 1, round: 1, verdict: "pending", status: "reviewer could not start", summary: null, findings: [], threadId: null, at: 1 },
        { id: 2, round: 2, verdict: "changes_requested", status: "changes requested", summary: "Needs a fix", findings: [{ severity: "blocking", title: "Off by one", detail: "The loop skips the last order.", file: "src/a.ts", line: 12 }], threadId: "thr_r2", at: 1 },
      ],
      threads: [
        { threadId: "thr_w1", role: "worker", attempt: 1, reviewRound: 0, state: "ended", startedAt: NOW - 5 * HOUR, endedAt: NOW - HOUR, endReason: "merged" },
        { threadId: "thr_r2", role: "reviewer", attempt: null, reviewRound: 2, state: "ended", startedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR + 71_000, endReason: "verdict" },
      ],
      activity: withItems([{ type: "review", postId: 8, reviewId: 2, notePostIds: [7] }], { outcome: "ended", endedAt: NOW - HOUR }),
    });
    const card = slot.container.querySelector<HTMLElement>('[data-review-card="2"]')!;
    expect(card.textContent).toContain("Reviewer · round 2");
    expect(card.textContent).toContain("Changes requested");
    expect(card.textContent).toContain("took 1m 11s");
    expect(within(card).getAllByTestId("bb-markdown")[0]!.textContent).toBe("Needs a fix");
    const finding = card.querySelector("[data-finding]")!;
    expect(finding.textContent).toContain("blocking");
    expect(finding.textContent).toContain("Off by one");
    expect(finding.textContent).toContain("src/a.ts:12");
    expect(finding.textContent).toContain("The loop skips the last order.");
    expect(card.querySelector("details")!.textContent).toContain("The reviewer's notes");
    expect(card.querySelector('details [data-post="7"]')).toBeTruthy();
    expect(slot.container.querySelectorAll('[data-post="7"]')).toHaveLength(1);
    expect(within(card).getByRole("button", { name: "Reply to #8" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Open the thread of reviewer round 2" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_r2" }]);
  });

  it("shows the newest attempt open with its start, each check step's result and the live row", async () => {
    const runOutput = vi.fn(() => ({ output: "1 failing" }));
    const slot = await mountTicket({ activity: withItems(pipelines(), { startedAt: Date.now() - 7 * 60_000 }) }, { runOutput });
    const card = slot.container.querySelector<HTMLElement>('[data-attempt="1"]')!;
    expect(card.getAttribute("data-open")).toBe("true");
    expect(card.textContent).toContain("Worker attempt 1 started");
    expect([...card.querySelectorAll("[data-checks-card]")].map((node) => node.getAttribute("data-status"))).toEqual(["unfinished", "failed", "running"]);
    expect(stepOf(slot, "npm test").textContent).toContain("exit 2 · 0.3s");
    expect(stepOf(slot, "npm test").getAttribute("data-ok")).toBe("fail");
    expect(stepOf(slot, "git commit").getAttribute("data-ok")).toBe("pass");
    expect(stepOf(slot, "npm run lint").textContent).toContain("running, started 40s ago");
    expect(stepOf(slot, "npm run e2e").textContent).toContain("did not finish");
    expect(stepOf(slot, "npm run e2e").getAttribute("data-ok")).toBe("none");
    expect(slot.queryByRole("button", { name: "Show the output of npm run lint" })).toBeNull();
    expect(card.querySelector("[data-live-row]")!.textContent).toContain("The worker is working · for 7m");
    expect(within(card.querySelector<HTMLElement>("[data-live-row]")!).queryByRole("button")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open the thread of attempt 1" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_w1" }]);
  });

  it("loads a step's output when asked, and shows why it could not", async () => {
    const runOutput = vi.fn(({ id }: { id: number }) => {
      if (id === 3) throw new Error("The database is busy.");
      return { output: "1 failing\n  expected 2 to be 3" };
    });
    const slot = await mountTicket({ activity: withItems(pipelines()) }, { runOutput });
    await waitFor(() => expect(slot.container.querySelector("[data-run-output]")?.textContent).toBe("1 failing\n  expected 2 to be 3"));
    expect(runOutput).toHaveBeenCalledWith({ id: 1 });
    const hide = slot.getByRole("button", { name: "Hide the output of npm test" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(slot.getByRole("button", { name: "Show the output of npm test" }).getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector("[data-run-output]")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Show the output of npm run e2e" }));
    expect((await within(stepOf(slot, "npm run e2e")).findByRole("alert")).textContent).toContain("The database is busy.");
  });

  it("shows the criteria, files, verify command and agents beside the stream, and the brief in its own tab", async () => {
    const slot = await mountTicket({
      acceptance: ["WHEN the endpoint is called THE SYSTEM SHALL stream a CSV", "IF there are no orders THEN THE SYSTEM SHALL return a header row"],
      scope: ["src/export/**", "README.md"],
      verify: ["npm test -- export"],
      reviewRound: 2,
      reviews: [{ id: 2, round: 2, verdict: "approved", status: "approved", summary: "Fine", findings: [], threadId: "thr_r2", at: 1 }],
      body: "Serve the file.\n\n## Notes\nStream it.",
    });
    const side = slot.container.querySelector<HTMLElement>("[data-ticket-side]")!;
    const ac = side.querySelector<HTMLElement>("[data-ac]")!;
    expect([...ac.querySelectorAll("[data-ears]")].map((node) => node.textContent)).toEqual(["WHEN", "THE SYSTEM SHALL", "IF", "THEN", "THE SYSTEM SHALL"]);
    expect(ac.querySelector("[data-ears]")!.className).toContain("tracking-wider");
    expect(ac.querySelectorAll("li")[1]!.textContent).toBe("IF there are no orders THEN THE SYSTEM SHALL return a header row");
    expect(ac.textContent).toContain("approved, round 2");
    expect([...side.querySelectorAll("[data-scope-file]")].map((node) => node.textContent)).toEqual(["src/export/**", "README.md"]);
    expect(side.querySelector("[data-scope-file] .font-semibold")!.textContent).toBe("**");
    const verify = side.querySelector<HTMLElement>("[data-verify]")!;
    expect(verify.textContent).toContain("npm test -- export");
    fireEvent.click(within(verify).getByRole("button", { name: "Copy the verify command" }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "npm test -- export" }]));
    expect(side.querySelector("[data-ticket-threads]")).toBeTruthy();

    expect(slot.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-details]")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Details" }));
    expect(slot.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-details] [data-ac]")).toBeTruthy();
    expect(slot.container.querySelector("[data-ticket-details]")!.className).toContain("@4xl:hidden");
    fireEvent.click(slot.getByRole("tab", { name: "Brief" }));
    const pane = slot.container.querySelector<HTMLElement>("[data-ticket-brief]")!;
    expect(within(pane).getByTestId("bb-markdown").textContent).toBe("Serve the file.\n\n## Notes\nStream it.");
    expect(pane.textContent).toContain("This is the brief the next worker reads.");
    expect(slot.container.querySelector("[data-attempt]")).toBeNull();
  });

  it("shows the planning row and the reply box for a ticket with no attempt yet", async () => {
    const slot = await mountTicket({ state: "queued", attempt: 0, threads: [], replyTo: null, posts: [posts[0]!], activity: { brief: { ...brief, edits: 2, fields: ["scope", "body"] }, before: [], attempts: [] } });
    expect(slot.container.querySelector("[data-stream-toolbar]")!.textContent).toContain("No attempts yet");
    expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toBe("Waiting for a worker.");
    const planning = slot.container.querySelector<HTMLElement>("[data-planning]")!;
    expect(planning.textContent).toContain("The planner wrote the brief");
    expect(planning.textContent).toContain("edited 2 times since (scope, body)");
    expect(slot.getByRole("textbox", { name: "New reply" })).toBeTruthy();
    expect(slot.container.querySelector("[data-reply-hint]")!.textContent).toBe("It stays on the ticket for anyone who reads it.");
    expect(slot.container.querySelector("[data-ticket-side] [data-verify]")!.textContent).toContain("No command of its own; only the project's checks run.");
    fireEvent.click(within(planning).getByRole("button", { name: "Read the brief" }));
    expect(slot.getByRole("tab", { name: "Brief" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-brief]")!.textContent).toContain("Written by the planner, edited 2 times since (scope, body).");
  });

  it("says in the header what the ticket is doing", async () => {
    const now = Date.now();
    const marks = (slot: Slot) => [...slot.container.querySelectorAll("[data-stage]")].map((node) => [node.getAttribute("data-stage"), node.getAttribute("data-mark")]);
    const summary = (slot: Slot) => slot.container.querySelector("[data-ticket-summary]")?.textContent ?? null;
    const merge = { type: "merge" as const, postId: 9, at: now - 2 * HOUR, outcome: "merged" as const, into: "loom/csv", running: false, steps: [] };
    const done = await mountTicket({
      state: "done",
      posts: [...posts, { id: 9, parentId: null, depth: 0, authorKind: "loom", authorThreadId: null, kind: "merge", body: "Merged m1 into loom/csv.", at: now - 2 * HOUR }],
      stateAt: now - 2 * HOUR,
      attempt: 3,
      reviewRound: 2,
      deps: ["CSV-1", "CSV-3"],
      depsDone: ["CSV-1"],
      activity: {
        brief,
        before: [],
        attempts: [attempt({ n: 1, claimPostId: 4, startedAt: now - 3 * HOUR, outcome: "blocked" }), attempt({ n: 2, claimPostId: 10, outcome: "blocked" }), attempt({ n: 3, claimPostId: 11, outcome: "merged", items: [merge] })],
      },
    });
    expect(summary(done)).toBe("Merged into loom/csv 2h ago, after 3 attempts and 2 review rounds.");
    expect(marks(done).every(([, mark]) => mark === "done")).toBe(true);
    const header = done.container.querySelector<HTMLElement>("[data-ticket-header]")!;
    expect(header.textContent).toContain("3 attempts");
    expect(header.textContent).toContain("2 review rounds");
    expect(header.querySelector("[data-fact='time']")!.textContent).toBe("1h");
    expect(within(header).getByRole("button", { name: "CSV-1" }).parentElement!.textContent).toContain("✓");
    expect(within(header).queryByRole("button", { name: "Open worker thread" })).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "CSV-3" }));
    expect(done.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-3" } }]);
    fireEvent.click(within(header).getByRole("button", { name: "Copy the branch name" }));
    await waitFor(() => expect(done.inspection.experimental_clipboardWrites).toEqual([{ text: "loom/csv-2" }]));
    done.lifecycle.unmount();

    const working = await mountTicket({ activity: withItems([], { startedAt: now - 7 * 60_000 }) });
    expect(summary(working)).toBe("Worker attempt 1 is working for 7m.");
    expect(marks(working)).toEqual([
      ["queued", "done"],
      ["working", "now"],
      ["checking", "todo"],
      ["review", "todo"],
      ["merging", "todo"],
      ["done", "todo"],
    ]);
    expect(working.container.querySelector("[data-state-badge] .animate-pulse")).toBeTruthy();
    working.lifecycle.unmount();

    const blocked = await mountTicket({ state: "blocked", stoppedFrom: "working", blockedReason: "Needs a key.", activity: withItems([], { outcome: "blocked", endedAt: now }) });
    expect(summary(blocked)).toBeNull();
    expect(marks(blocked).map(([, mark]) => mark)).toEqual(["done", "stop", "todo", "todo", "todo", "todo"]);
    expect(blocked.container.querySelector("[data-stage='working']")!.textContent).toContain("Blocked");
    blocked.lifecycle.unmount();

    const open = await mountTicket({ state: "pr_open", prUrl: "https://github.com/acme/shop/pull/2" });
    expect(open.container.querySelector("[data-state-badge]")!.textContent).toBe("pr open");
    expect(summary(open)).toBe("The pull request is open; the ticket is done when it merges.");
    expect(marks(open).map(([, mark]) => mark)).toEqual(["done", "done", "done", "done", "now", "todo"]);
  });

  it("jumps from the blocked callout to the post that blocked it", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const block = { id: 9, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "block" as const, body: "Which API? The v1 one is gone.", at: 9 };
      const claim = { id: 10, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "claim" as const, body: "Worker attempt 2 is starting.", at: 10 };
      const slot = await mountTicket({
        state: "blocked",
        stoppedFrom: "working",
        blockedReason: "Which API? The v1 one is gone.",
        posts: [...posts, block, claim],
        activity: {
          brief,
          before: [],
          attempts: [
            attempt({ n: 1, claimPostId: 4, outcome: "blocked", endedAt: Date.now(), line: "Asked the planner: Which API?", items: [{ type: "post", postId: 9 }] }),
            attempt({ n: 2, claimPostId: 10, threadId: null, outcome: "blocked", endedAt: Date.now(), line: "The worker could not start." }),
          ],
        },
      });
      expect(slot.container.querySelector('[data-attempt="1"]')!.getAttribute("data-open")).toBe("false");
      expect(post(slot, 9)).toBeNull();
      fireEvent.click(slot.getByRole("tab", { name: "Brief" }));
      fireEvent.click(slot.getByRole("button", { name: "Read the post that blocked it" }));
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "center" }));
      expect(slot.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")).toBe("true");
      expect(slot.container.querySelector('[data-attempt="1"]')!.getAttribute("data-open")).toBe("true");
      expect(scroll.mock.contexts[0]).toBe(post(slot, 9));
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("folds older attempts to one line, newest first, and switches order and expands all", async () => {
    const claim = { id: 10, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "claim" as const, body: "Worker attempt 2 is starting.", at: 10 };
    const slot = await mountTicket({
      attempt: 2,
      posts: [...posts, claim],
      activity: {
        brief,
        before: [],
        attempts: [
          attempt({ n: 1, claimPostId: 4, outcome: "blocked", endedAt: Date.now(), line: "Asked the planner: Which API?", pipeline: { work: "fail", checks: [], review: [], merge: [] } }),
          attempt({ n: 2, claimPostId: 10, outcome: "in_progress", pipeline: { work: "pass", checks: ["fail", "pass"], review: ["running"], merge: [] } }),
        ],
      },
    });
    const order = () => [...slot.container.querySelectorAll("[data-attempt]")].map((node) => node.getAttribute("data-attempt"));
    const card = (n: number) => slot.container.querySelector<HTMLElement>(`[data-attempt="${n}"]`)!;
    const planning = () => slot.container.querySelector("[data-planning]")!;
    expect(slot.container.querySelector("[data-stream-toolbar]")!.textContent).toContain("2 attempts · 6 posts");
    expect(slot.getByRole("tab", { name: /Activity/ }).textContent).toContain("2 attempts");
    expect(order()).toEqual(["2", "1"]);
    expect(card(1).compareDocumentPosition(planning()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card(2).getAttribute("data-open")).toBe("true");
    expect(card(1).getAttribute("data-open")).toBe("false");
    expect(card(1).querySelector("[data-attempt-line]")!.textContent).toBe("Asked the planner: Which API?");
    expect(card(2).querySelector("[data-attempt-line]")).toBeNull();
    expect(card(2).querySelector("[data-pipeline]")!.textContent).toBe("Work ✓ → Checks ✗✓ → Review ●");
    expect(card(1).querySelector("[data-pipeline]")!.textContent).toBe("Work ✗");
    expect(card(1).textContent).toContain("Blocked");
    expect(card(2).textContent).toContain("In progress");

    const toggle = (n: number) => card(n).querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    fireEvent.click(toggle(1));
    expect(card(1).getAttribute("data-open")).toBe("true");
    expect(toggle(1).getAttribute("aria-expanded")).toBe("true");
    expect(card(1).querySelector("[data-attempt-line]")).toBeNull();
    fireEvent.click(toggle(1));
    fireEvent.click(toggle(2));
    expect([card(1).getAttribute("data-open"), card(2).getAttribute("data-open")]).toEqual(["false", "false"]);

    expect(slot.getByRole("button", { name: "Newest first" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Oldest first" }));
    expect(slot.getByRole("button", { name: "Oldest first" }).getAttribute("aria-pressed")).toBe("true");
    expect(order()).toEqual(["1", "2"]);
    expect(planning().compareDocumentPosition(card(1)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    expect([card(1).getAttribute("data-open"), card(2).getAttribute("data-open")]).toEqual(["true", "true"]);
  });

  it("lists a check's commands, an old check's failed output inline, and why an after-merge check failed", async () => {
    const runOutput = vi.fn(() => ({ output: "unused" }));
    const items: Item[] = [
      checks({ steps: [step({ label: "git commit", kind: "git", exitCode: null, durationMs: 40 }), step({ label: "npm run lint", durationMs: 1200 }), step({ label: "npm test", durationMs: 131_800 })] }),
      checks({ afterMerge: true, status: "failed", changed: "moved HEAD from aaa to bbb", steps: [step({ label: "npm run e2e", durationMs: 500 })] }),
      checks({ status: "failed", steps: [step({ label: "npm run lint" }), step({ label: "npm test", ok: false, exitCode: 1, durationMs: 300, output: "1 failing" })] }),
    ];
    const slot = await mountTicket({ activity: withItems(items) }, { runOutput });
    const cards = [...slot.container.querySelectorAll<HTMLElement>("[data-checks-card]")];
    expect(cards.map((node) => node.getAttribute("data-status"))).toEqual(["passed", "failed", "failed"]);

    expect(cards[0]!.textContent).toContain("Checks passed");
    expect(cards[0]!.textContent).toContain("2 commands · 2m 13s");
    expect(cards[0]!.querySelector("[data-check-step]")).toBeNull();
    const show = within(cards[0]!).getByRole("button", { name: "Show commands" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect([...cards[0]!.querySelectorAll("[data-check-step]")].map((node) => node.getAttribute("data-ok"))).toEqual(["pass", "pass", "pass"]);
    expect(cards[0]!.querySelector("[data-check-step] .font-mono")!.className).toContain("text-subtle-foreground");
    expect(within(cards[0]!).getByRole("button", { name: "Hide commands" }).getAttribute("aria-expanded")).toBe("true");

    expect(cards[1]!.textContent).toContain("Checks after the merge failed");
    const changed = cards[1]!.querySelector("[data-changed]")!;
    expect(changed.textContent).toBe("The command passed but changed the branch: moved HEAD from aaa to bbb.");
    expect(changed.className).toContain("text-destructive-text");

    expect(cards[2]!.textContent).toContain("Checks failed");
    expect(cards[2]!.textContent).toContain("1 of 2 passed · npm test failed");
    const failed = within(cards[2]!).getAllByRole("listitem").find((node) => node.textContent!.includes("npm test"))!;
    expect(failed.getAttribute("data-ok")).toBe("fail");
    expect(failed.textContent).toContain("exit 1 · 0.3s");
    expect(failed.textContent).toContain("Output (last part)");
    expect(failed.querySelector("[data-step-output]")!.textContent).toBe("1 failing");
    expect(runOutput).not.toHaveBeenCalled();
  });

  it("clamps a long post with Show all, and says who gets a reply", async () => {
    const long = { id: 6, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "note" as const, body: "word ".repeat(100).trim(), at: 6 };
    const slot = await mountTicket({ posts: [...posts, long], activity: withItems([{ type: "post", postId: 6 }]) });
    const body = () => post(slot, 6).querySelector<HTMLElement>("[data-post-body]")!;
    expect(body().className).toContain("max-h-[7.5em]");
    fireEvent.click(within(post(slot, 6)).getByRole("button", { name: "Show all" }));
    expect(body().className).not.toContain("max-h-[7.5em]");
    fireEvent.click(within(post(slot, 6)).getByRole("button", { name: "Show less" }));
    expect(body().className).toContain("max-h-[7.5em]");
    expect(post(slot, 2).querySelector("[data-post-body]")!.className).not.toContain("max-h-[7.5em]");
    expect(within(post(slot, 2)).queryByRole("button", { name: "Show all" })).toBeNull();
    slot.lifecycle.unmount();

    for (const [replyTo, hint] of [
      ["worker", "The worker gets this now."],
      ["planner", "The planner gets this now."],
      [null, "It stays on the ticket for anyone who reads it."],
    ] as const) {
      const one = await mountTicket({ replyTo });
      expect(one.container.querySelector("[data-reply-hint]")!.textContent).toBe(hint);
      one.lifecycle.unmount();
    }
  });

  it("totals a passed check's commands with a decimal under a minute", async () => {
    const items: Item[] = [
      checks({ steps: [step({ label: "git commit", kind: "git", exitCode: null, durationMs: 268 }), step({ durationMs: 191 }), step({ label: "npm run lint", durationMs: 170 })] }),
      checks({ steps: [step({ durationMs: 12_700 })] }),
    ];
    const slot = await mountTicket({ activity: withItems(items) });
    const cards = [...slot.container.querySelectorAll<HTMLElement>("[data-checks-card]")];
    expect(cards[0]!.textContent).toContain("2 commands · 0.4s");
    expect(cards[1]!.textContent).toContain("1 command · 12.7s");
  });

  it("draws the ⋯ menu above the stage tracker's circles", async () => {
    const slot = await mountTicket();
    fireEvent.click(slot.getByRole("button", { name: "More actions" }));
    const z = (node: Element) => Number(/(?:^|\s)z-(\d+)(?=\s|$)/.exec(node.className)?.[1] ?? 0);
    const circles = [...slot.container.querySelectorAll("[data-stage] > span[aria-hidden]")];
    expect(circles).toHaveLength(6);
    expect(z(slot.container.querySelector("[data-more-menu]")!)).toBeGreaterThan(Math.max(...circles.map(z)));
  });

  it("writes success text in the success foreground colour, which keeps its contrast on a pale tint in light themes", async () => {
    const review = { id: 8, parentId: null, depth: 0, authorKind: "reviewer" as const, authorThreadId: "thr_r1", kind: "review" as const, body: "Approved (round 1): Fine", at: 8 };
    const merged = { id: 9, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "merge" as const, body: "Merged m1 into loom/csv.", at: 9 };
    const slot = await mountTicket({
      state: "done",
      reviewRound: 1,
      depsDone: ["CSV-1"],
      posts: [...posts, review, merged],
      reviews: [{ id: 2, round: 1, verdict: "approved", status: "approved", summary: "Fine", findings: [], threadId: "thr_r1", at: 8 }],
      threads: [
        { threadId: "thr_w1", role: "worker", attempt: 1, reviewRound: 0, state: "ended", startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, endReason: "merged" },
        { threadId: "thr_r1", role: "reviewer", attempt: null, reviewRound: 1, state: "ended", startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, endReason: "verdict" },
      ],
      activity: withItems([checks(), { type: "review", postId: 8, reviewId: 2, notePostIds: [] }, { type: "merge", postId: 9, at: NOW - HOUR, outcome: "merged", into: "loom/csv", running: false, steps: [] }], {
        outcome: "merged",
        endedAt: NOW - HOUR,
        pipeline: { work: "pass", checks: ["pass"], review: ["pass"], merge: ["pass"] },
      }),
    });
    const checksCard = slot.container.querySelector<HTMLElement>("[data-checks-card]")!;
    fireEvent.click(within(checksCard).getByRole("button", { name: "Show commands" }));
    const page = slot.container.querySelector<HTMLElement>("[data-ticket]")!;
    const toned = (node: Element) => node.classList.contains("text-success-foreground");
    expect(page.querySelectorAll(".text-success")).toHaveLength(0);
    expect(toned(page.querySelector("[data-state-badge]")!)).toBe(true);
    expect(toned(within(page).getByText("Merged"))).toBe(true);
    expect(toned(within(page).getByText("Approved"))).toBe(true);
    expect(toned(within(checksCard).getByText("Checks passed"))).toBe(true);
    expect(toned(within(page.querySelector<HTMLElement>("[data-ac]")!).getByText(/approved, round 1/))).toBe(true);
    const agents = page.querySelector<HTMLElement>("[data-ticket-side] [data-ticket-threads]")!;
    expect(toned(within(agents).getByText("merged"))).toBe(true);
    expect(toned(within(agents).getByText("approved"))).toBe(true);
    expect(page.querySelectorAll("[data-pipeline] .text-success-foreground")).toHaveLength(4);
    expect(checksCard.querySelectorAll("[data-check-step] .text-success-foreground")).toHaveLength(1);
    expect(toned(within(page).getByRole("button", { name: "CSV-1" }).nextElementSibling!)).toBe(true);
  });

  it("caps the side column 16px above the bottom of the window, under its sticky top, once the page is laid out", async () => {
    const plain = await mountTicket();
    const plainSide = plain.container.querySelector<HTMLElement>("[data-ticket-side]")!;
    expect(plainSide.style.maxHeight).toBe("");
    expect(plainSide.className).toContain("@4xl:max-h-[calc(100dvh-6rem)]");
    plain.lifecycle.unmount();

    const height = Object.getOwnPropertyDescriptor(window, "innerHeight")!;
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const boxes = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.hasAttribute("data-loom-scroll") ? rect(48, 1000) : rect(0, 0);
    });
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
      const slot = await mountTicket();
      const side = slot.container.querySelector<HTMLElement>("[data-ticket-side]")!;
      expect(side.style.maxHeight).toBe("936px");
      side.style.top = "16px";
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(side.style.maxHeight).toBe("820px");
      const listener = added.mock.calls.find(([type]) => type === "resize")![1];
      slot.lifecycle.unmount();
      expect(removed).toHaveBeenCalledWith("resize", listener);
    } finally {
      Object.defineProperty(window, "innerHeight", height);
      boxes.mockRestore();
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it("drops the clamp and Show all from a long post or review that fits once laid out", async () => {
    const note = (id: number, word: string) => ({ id, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "note" as const, body: `${word} `.repeat(100).trim(), at: id });
    const review = { id: 8, parentId: null, depth: 0, authorKind: "reviewer" as const, authorThreadId: "thr_r1", kind: "review" as const, body: "Approved (round 1)", at: 8 };
    const clamped = (node: Element) => node.className.includes("max-h-[7.5em]");
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
    const client = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!;
    Object.defineProperty(Element.prototype, "scrollHeight", {
      configurable: true,
      get(this: Element) {
        return clamped(this) ? (this.textContent!.includes("fits") ? 120 : 300) : 0;
      },
    });
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get(this: Element) {
        return clamped(this) ? 120 : 0;
      },
    });
    try {
      const slot = await mountTicket({
        posts: [...posts, note(6, "fits"), note(7, "spills"), review],
        reviews: [{ id: 2, round: 1, verdict: "approved", status: "approved", summary: "fits ".repeat(100).trim(), findings: [], threadId: "thr_r1", at: 8 }],
        activity: withItems([
          { type: "post", postId: 6 },
          { type: "post", postId: 7 },
          { type: "review", postId: 8, reviewId: 2, notePostIds: [] },
        ]),
      });
      const body = (id: number) => post(slot, id).querySelector<HTMLElement>("[data-post-body]")!;
      expect(clamped(body(6))).toBe(false);
      expect(body(6).className).not.toContain("mask-image");
      expect(within(post(slot, 6)).queryByRole("button", { name: "Show all" })).toBeNull();
      expect(clamped(body(7))).toBe(true);
      expect(within(post(slot, 7)).getByRole("button", { name: "Show all" })).toBeTruthy();
      const card = slot.container.querySelector<HTMLElement>('[data-review-card="2"]')!;
      expect(card.querySelector(".max-h-\\[7\\.5em\\]")).toBeNull();
      expect(within(card).queryByRole("button", { name: "Show all" })).toBeNull();
    } finally {
      Object.defineProperty(Element.prototype, "scrollHeight", scroll);
      Object.defineProperty(Element.prototype, "clientHeight", client);
    }
  });

  it("says a worker that bb never started could not start, with no thread button and no running time", async () => {
    const refused = { id: 6, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "system" as const, body: "Could not start a worker: HTTP 400", at: 6 };
    const slot = await mountTicket({
      state: "queued",
      posts: [...posts, refused],
      threads: [{ threadId: null, role: "worker", attempt: 1, reviewRound: 0, state: "ended", startedAt: NOW - HOUR, endedAt: NOW - HOUR + 300, endReason: "failed" }],
      activity: withItems([{ type: "post", postId: 6 }], { threadId: null, outcome: "ended", endedAt: NOW - HOUR + 300, line: "The worker could not start.", pipeline: { work: "fail", checks: [], review: [], merge: [] } }),
    });
    const card = slot.container.querySelector<HTMLElement>('[data-attempt="1"]')!;
    expect(card.getAttribute("data-open")).toBe("true");
    expect(card.textContent).toContain("Worker attempt 1 could not start");
    expect(card.textContent).not.toContain("Worker attempt 1 started");
    expect(within(card).queryByRole("button", { name: "Open the thread of attempt 1" })).toBeNull();
    expect(card.querySelector("[data-attempt-time]")!.textContent).toMatch(/^[^·]+ ago$/);
    const row = slot.container.querySelector<HTMLElement>('[data-ticket-side] [data-thread-row="worker"]')!;
    expect(row.textContent).toBe("WWorker · attempt 1could not start");
  });

  it("asks for the ticket again when its project changes", async () => {
    const slot = await mountTicket();
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(calls(slot, "ticket")).toHaveLength(2));
  });
});

describe("health strip", () => {
  const part = (slot: Slot, name: string) => slot.container.querySelector<HTMLElement>(`[data-health="${name}"]`);

  it("shows progress, pace, the token budget, the deadline and capacity above the tabs", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    await slot.findByRole("tab", { name: "Board" });
    expect(part(slot, "progress")!.textContent).toContain("8 of 14 done");
    expect(part(slot, "progress")!.textContent).toContain("3 in flight");
    expect(part(slot, "progress")!.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Progress: 8 done, 3 in flight, 1 blocked, 2 queued");
    expect(part(slot, "pace")!.textContent).toContain("0.5/day");
    expect(part(slot, "pace")!.textContent).toContain("6 left: about 12 days at this pace");
    expect(part(slot, "budget")!.textContent).toContain("24%");
    expect(part(slot, "budget")!.textContent).toContain("12,000 of 50,000 (sampled)");
    expect(part(slot, "deadline")!.textContent).toContain("6 days");
    expect(part(slot, "deadline")!.textContent).toContain("2026-01-15");
    expect(part(slot, "capacity")!.textContent).toContain("1/2 workers");
    expect(part(slot, "capacity")!.textContent).toContain("1/2 reviewers · 1 ready ticket waiting for a slot");
    const strip = slot.container.querySelector("[data-health-strip]")!;
    expect(strip.compareDocumentPosition(slot.getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the budget and the deadline when the spec sets neither, and says when nothing was done to pace by", async () => {
    const view = projectView({ health: health({ budget: null, deadline: null, pace: { perDay: 0, remaining: 6, etaDays: null } }) });
    const { slot } = await mountPage("csv", { project: () => view });
    await slot.findByRole("tab", { name: "Board" });
    expect(part(slot, "progress")).not.toBeNull();
    expect(part(slot, "budget")).toBeNull();
    expect(part(slot, "deadline")).toBeNull();
    expect(part(slot, "pace")!.textContent).toContain("6 left; none done in the last 14 days");
    expect(slot.container.textContent).not.toContain("NaN");
  });

  it("is not shown for a draft", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ state: "draft", approvedVersion: null }), health: null }) });
    await slot.findByRole("tab", { name: "Board" });
    expect(slot.container.querySelector("[data-health-strip]")).toBeNull();
  });
});

describe("agents tab", () => {
  const agents = [
    agent(),
    agent({ threadId: "thr_r2", role: "reviewer", ticketKey: "CSV-1", ticketTitle: "Order rows", startedAt: NOW - 6 * 60_000, tokens: 400, rateLimitRetries: 0, reviewRound: 2, model: "codex / gpt-5", timeoutAt: null }),
    agent({ threadId: "thr_w0", state: "ended", startedAt: NOW - 9 * HOUR, endedAt: NOW - 7 * HOUR, endReason: "abandoned", timeoutAt: null }),
    agent({ threadId: "thr_r1", role: "reviewer", ticketKey: "CSV-1", state: "ended", startedAt: NOW - 8 * HOUR, endedAt: NOW - 7 * HOUR, endReason: "verdict", model: "codex / gpt-5", timeoutAt: null }),
    agent({ threadId: "thr_w9", state: "ended", startedAt: NOW - 8 * HOUR, endedAt: NOW - 6 * HOUR, endReason: "timeout", timeoutAt: null }),
  ];
  const openAgents = async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ agents }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
    return slot;
  };
  const row = (slot: Slot, threadId: string) => slot.container.querySelector<HTMLElement>(`[data-agent-row="${threadId}"]`)!;

  it("lists the live threads with their ticket, model, running time, timeout, tokens and retries, and opens a thread", async () => {
    const slot = await openAgents();
    const live = slot.container.querySelector("[data-agents-live]")!;
    expect([...live.querySelectorAll("[data-agent-row]")].map((entry) => entry.getAttribute("data-agent-row"))).toEqual(["thr_w1", "thr_r2"]);
    const worker = row(slot, "thr_w1");
    expect(worker.textContent).toContain("worker");
    expect(worker.textContent).toContain("CSV-2 · Export endpoint");
    expect(worker.textContent).toContain("claude / sonnet");
    expect(worker.textContent).toContain("5h · timeout at 6h");
    expect(worker.textContent).toContain("6,000");
    expect(worker.textContent).toContain("1 rate limit");
    expect(row(slot, "thr_r2").textContent).toContain("CSV-1 · round 2");
    fireEvent.click(within(worker).getByRole("button", { name: "Thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_w1" }]);
  });

  it("shares the tokens by role, counts how threads ended, and keeps the ended threads in a closed list", async () => {
    const slot = await openAgents();
    expect(slot.container.querySelector("[data-agents-tokens] [role=img]")!.getAttribute("aria-label")).toBe("Tokens by role: workers 8,000, reviewers 2,000, planner 2,000");
    const endings = Object.fromEntries([...slot.container.querySelectorAll("[data-ending]")].map((entry) => [entry.getAttribute("data-ending"), entry.textContent]));
    expect(endings).toEqual({ "idle twice": "idle twice1", "gave a verdict": "gave a verdict1", timeout: "timeout1" });
    const history = slot.container.querySelector<HTMLDetailsElement>("[data-agents-history]")!;
    expect(history.open).toBe(false);
    expect(history.querySelector("summary")!.textContent).toBe("Ended threads (3)");
    expect(row(slot, "thr_w0").textContent).toContain("idle twice");
    expect(row(slot, "thr_w0").textContent).toContain("2h");
  });

  it("reads tokens a provider does not report as not reported, and says how many threads report none", async () => {
    const silent = agent({ threadId: "thr_r3", role: "reviewer", ticketKey: "CSV-1", tokens: null, timeoutAt: null });
    const plannerSilent = agent({ threadId: "thr_plan", role: "planner", ticketKey: null, ticketTitle: null, tokens: null, model: null, timeoutAt: null });
    const view = projectView({ agents: [silent, plannerSilent, ...agents], metrics: metrics({ tokens: { ...metrics().tokens, unreported: 1 } }) });
    const { slot } = await mountPage("csv", { project: () => view });
    fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
    expect(row(slot, "thr_r3").textContent).toContain("not reported");
    expect(row(slot, "thr_w1").textContent).not.toContain("not reported");
    expect(slot.container.querySelector("[data-agents-planner]")!.textContent).toContain("Tokens not reported");
    expect(slot.container.querySelector("[data-agents-tokens]")!.textContent).toContain("1 thread reports no token usage");
  });

  it("says nothing about unreported tokens when every thread reports them", async () => {
    const slot = await openAgents();
    expect(slot.container.querySelector("[data-agents-tokens]")!.textContent).not.toContain("no token usage");
  });

  it("says so when no agent is working", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [] }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
    expect(await slot.findByText("No agent is working now.")).toBeTruthy();
    expect(slot.container.querySelector("[data-agents-history]")).toBeNull();
    expect(slot.container.querySelector("[data-agents-planner]")).toBeNull();
  });

  it("shows the planner on call in its own section, with its tokens and thread but no running time, and not as working", async () => {
    const planner = agent({ threadId: "thr_plan", role: "planner", ticketKey: null, ticketTitle: null, startedAt: NOW - 32 * 60_000, tokens: 2000, rateLimitRetries: 0, model: null, timeoutAt: null });
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [planner, ...agents] }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
    const live = slot.container.querySelector("[data-agents-live]")!;
    expect([...live.querySelectorAll("[data-agent-row]")].map((entry) => entry.getAttribute("data-agent-row"))).toEqual(["thr_w1", "thr_r2"]);
    const section = slot.container.querySelector<HTMLElement>("[data-agents-planner]")!;
    expect(within(section).getByRole("heading", { name: "Planner" })).toBeTruthy();
    expect(section.textContent).toContain("On call for triage rounds");
    expect(section.textContent).toContain("2,000");
    expect(section.textContent).not.toContain("32m");
    fireEvent.click(within(section).getByRole("button", { name: "Thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_plan" }]);
  });

  it("says no agent is working when only the planner is on call", async () => {
    const planner = agent({ threadId: "thr_plan", role: "planner", ticketKey: null, ticketTitle: null, model: null, timeoutAt: null });
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [planner] }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
    expect(await slot.findByText("No agent is working now.")).toBeTruthy();
    expect(slot.container.querySelector("[data-agents-planner]")!.textContent).toContain("On call for triage rounds");
  });
});

describe("metrics tab", () => {
  const openMetrics = async (over: Parameters<typeof metrics>[0] = {}) => {
    const { slot } = await mountPage("csv", { project: () => projectView({ metrics: metrics(over) }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Metrics" }));
    return slot;
  };
  const tile = (slot: Slot, name: string) => slot.container.querySelector<HTMLElement>(`[data-tile="${name}"]`)!;

  it("shows the flow tiles: work in progress, throughput, cycle time, lead time and work item age", async () => {
    const slot = await openMetrics();
    expect(tile(slot, "wip").textContent).toContain("Work in progress");
    expect(tile(slot, "wip").querySelector("[data-tile-value]")!.textContent).toBe("1");
    expect(tile(slot, "throughput").querySelector("[data-tile-value]")!.textContent).toBe("3");
    expect(tile(slot, "throughput").textContent).toContain("done in 14 days");
    expect(tile(slot, "cycle-time").textContent).toContain("p50 3h 12m");
    expect(tile(slot, "cycle-time").textContent).toContain("p85 5h");
    expect(tile(slot, "lead-time").textContent).toContain("p50 1d 2h");
    const age = slot.container.querySelector("[data-wip-age]")!;
    expect(age.textContent).toContain("CSV-2");
    expect(age.textContent).toContain("working");
    expect(age.textContent).toContain("5h");
  });

  it("shows the agent tiles, with tokens labelled as sampled", async () => {
    const slot = await openMetrics();
    expect(tile(slot, "first-pass").textContent).toContain("50%");
    expect(tile(slot, "first-pass").textContent).toContain("2 tickets");
    expect(tile(slot, "review-rounds").textContent).toContain("1.5");
    expect(tile(slot, "checks").textContent).toContain("1 of 4 failed");
    expect(tile(slot, "blocks").querySelector("[data-tile-value]")!.textContent).toBe("1");
    expect(tile(slot, "interventions").querySelector("[data-tile-value]")!.textContent).toBe("2");
    expect(tile(slot, "tokens").textContent).toContain("Tokens (sampled)");
    expect(tile(slot, "tokens").textContent).toContain("12,000");
    expect(tile(slot, "tokens").textContent).toContain("worker 8,000");
    expect(tile(slot, "active").textContent).toContain("7h");
    expect(tile(slot, "tokens").textContent).not.toContain("report no token usage");
  });

  it("says in the tokens tile how many threads report no token usage", async () => {
    const slot = await openMetrics({ tokens: { ...metrics().tokens, unreported: 2 } });
    expect(tile(slot, "tokens").textContent).toContain("2 threads report no token usage");
  });

  it("says so when nothing is measured yet", async () => {
    const slot = await openMetrics({
      wipAge: [],
      cycleTime: { p50: null, p85: null, n: 0 },
      leadTime: { p50: null, p85: null, n: 0 },
      firstPassApproval: { rate: null, n: 0 },
      reviewRounds: { mean: null, n: 0 },
      checks: { total: 0, failed: 0 },
      tokens: { total: 0, perDoneTicket: null, byRole: { planner: 0, worker: 0, reviewer: 0 }, unreported: 0 },
    });
    expect(tile(slot, "cycle-time").textContent).toContain("none yet");
    expect(tile(slot, "first-pass").textContent).toContain("none yet");
    expect(tile(slot, "checks").textContent).toContain("none run");
    expect(slot.container.querySelector("[data-wip-age]")).toBeNull();
    expect(slot.container.textContent).not.toContain("NaN");
  });

  it("draws the throughput bars, the cumulative flow and the WIP trend as labelled svg with a text table on hover", async () => {
    const slot = await openMetrics();
    const charts = [...slot.container.querySelector('[role="tabpanel"]')!.querySelectorAll("svg[aria-label]")];
    expect(charts.map((chart) => chart.getAttribute("aria-label"))).toEqual(["Work in progress over the last 14 days", "Throughput: tickets done per day, last 14 days", "Cumulative flow: tickets in each state at the end of each day"]);
    const bars = slot.container.querySelectorAll('svg[aria-label^="Throughput"] rect');
    expect(bars).toHaveLength(14);
    expect(bars[13]!.querySelector("title")!.textContent).toBe("2026-01-14: 1 done");
    const flow = slot.container.querySelector('svg[aria-label^="Cumulative flow"]')!;
    expect(flow.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(flow.querySelectorAll("path").length).toBeGreaterThanOrEqual(8);
    expect(flow.querySelector("[data-flow-day] title")!.textContent).toContain("2026-01-01");
    expect(flow.querySelector("[data-flow-day] title")!.textContent).toContain("queued");
  });

  it("switches the throughput and cumulative flow window, reading the metrics for 7 or 30 days and the project's own for 14", async () => {
    const days = (count: number) => Array.from({ length: count }, (_, index) => ({ day: `day-${index + 1}`, done: index === count - 1 ? 4 : 0 }));
    const windowed = vi.fn(({ days: count }: { slug: string; days: number }) => metrics({ throughput: days(count), cumulativeFlow: metrics().cumulativeFlow.slice(0, 1) }));
    const { slot } = await mountPage("csv", { project: () => projectView(), metrics: windowed });
    fireEvent.click(await slot.findByRole("tab", { name: "Metrics" }));
    const pressed = () => [...slot.container.querySelectorAll("[data-window] button")].map((button) => [button.textContent, button.getAttribute("aria-pressed")]);
    expect(pressed()).toEqual([
      ["7 days", "false"],
      ["14 days", "true"],
      ["30 days", "false"],
    ]);
    expect(calls(slot, "metrics")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(tile(slot, "throughput").textContent).toContain("done in 30 days"));
    expect(calls(slot, "metrics").map((call) => call.input)).toEqual([{ slug: "csv", days: 30 }]);
    expect(pressed()[2]).toEqual(["30 days", "true"]);
    fireEvent.click(slot.getByRole("button", { name: "14 days" }));
    await waitFor(() => expect(tile(slot, "throughput").textContent).toContain("done in 14 days"));
    expect(calls(slot, "metrics")).toHaveLength(1);
  });

  it("shows where the time goes, checks by command with the scope flags, review findings, tokens by ticket and reliability", async () => {
    const slot = await openMetrics();
    const section = (name: string) => slot.container.querySelector<HTMLElement>(`[data-section="${name}"]`)!;
    expect(section("time-in-state").querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Time in state: queued 20%, working 40%, checking 10%, review 30%");
    expect(section("time-in-state").textContent).toContain("Flow efficiency 40%");
    const checks = [...section("checks-by-command").querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(checks).toEqual([
      ["npm test", "3", "1 · 33%", "1m 40s"],
      ["npm run lint", "1", "0", "12s"],
    ]);
    expect(section("checks-by-command").textContent).toContain("1 check found files outside its ticket's scope; 0 found protected paths.");
    expect(section("findings").textContent).toContain("3findings in 3 rounds");
    expect(section("findings").textContent).toContain("1blocking");
    expect(section("findings").textContent).toContain("2should-fix");
    expect(section("findings").textContent).toContain("Changes requested in 1 of 3 rounds (33%).");
    expect([...section("tokens-by-ticket").querySelectorAll("[data-ticket-tokens]")].map((row) => row.textContent)).toEqual(["CSV-26,000", "CSV-12,000"]);
    const reliability = [...section("reliability").querySelectorAll("tr")].map((row) => row.textContent);
    expect(reliability).toEqual(["Worker attempts that failed1", "Rate-limit retries2", "Workers timed out1", "Merges sent back1"]);
  });

  it("says so in each new section when there is nothing to show yet", async () => {
    const slot = await openMetrics({
      timeInState: { ms: metrics().counts, flowEfficiency: null, n: 0 },
      checksByCommand: [],
      findings: { total: 0, blocking: 0, shouldFix: 0, rounds: 0, changesRequested: 0 },
      tokensByTicket: [],
    });
    const text = (name: string) => slot.container.querySelector(`[data-section="${name}"]`)!.textContent;
    expect(text("time-in-state")).toContain("No ticket is done yet.");
    expect(text("checks-by-command")).toContain("No check has run yet.");
    expect(text("findings")).toContain("No review has a verdict yet.");
    expect(text("tokens-by-ticket")).toContain("No ticket has used tokens yet.");
    expect(slot.container.textContent).not.toContain("NaN");
  });
});

describe("feed tab", () => {
  it("shows the events newest first and adds the new ones after a change, asking only for those after the last", async () => {
    const feed = vi.fn((input: { slug: string; afterId?: number }) =>
      input.afterId === undefined
        ? { rows: [feedRow({ id: 1, text: "CSV-1 was created." }), feedRow({ id: 2, text: "The project moved from ready to running." })], lastId: 2 }
        : { rows: [feedRow({ id: 3, text: "CSV-1 moved from queued to working: attempt 1.", kind: "ticket.state" })], lastId: 3 },
    );
    const { slot } = await mountPage("csv", { project: () => projectView(), feed });
    fireEvent.click(await slot.findByRole("tab", { name: "Feed" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-feed-row]")).toHaveLength(2));
    const texts = () => [...slot.container.querySelectorAll("[data-feed-row]")].map((row) => row.querySelector("[data-feed-text]")!.textContent);
    expect(texts()).toEqual(["The project moved from ready to running.", "CSV-1 was created."]);
    expect(feed).toHaveBeenCalledWith({ slug: "csv" });

    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(texts()).toHaveLength(3));
    expect(texts()[0]).toBe("CSV-1 moved from queued to working: attempt 1.");
    expect(feed).toHaveBeenLastCalledWith({ slug: "csv", afterId: 2 });

    await slot.emitRealtime("loom:changed", { slug: "other" });
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it("does not show an event twice when two reads overlap", async () => {
    const feed = vi.fn(() => ({ rows: [feedRow({ id: 1 })], lastId: 1 }));
    const { slot } = await mountPage("csv", { project: () => projectView(), feed });
    fireEvent.click(await slot.findByRole("tab", { name: "Feed" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-feed-row]")).toHaveLength(1));
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(feed.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(slot.container.querySelectorAll("[data-feed-row]")).toHaveLength(1);
  });

  it("opens the ticket an event is about, and says when there are no events", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), feed: () => ({ rows: [feedRow({ id: 1, ticketKey: "CSV-1" }), feedRow({ id: 2, ticketKey: null, text: "The project was created." })], lastId: 2 }) });
    fireEvent.click(await slot.findByRole("tab", { name: "Feed" }));
    fireEvent.click(await slot.findByRole("button", { name: "CSV-1" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-1")]);
    slot.lifecycle.unmount();

    const empty = await mountPage("csv", { project: () => projectView(), feed: () => ({ rows: [], lastId: 0 }) });
    fireEvent.click(await empty.slot.findByRole("tab", { name: "Feed" }));
    expect(await empty.slot.findByText("No events yet.")).toBeTruthy();
  });

  it("shows a failed read", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), feed: () => Promise.reject(new Error("db is closed")) });
    fireEvent.click(await slot.findByRole("tab", { name: "Feed" }));
    expect((await slot.findByRole("alert")).textContent).toContain("db is closed");
  });
});

describe("timeline", () => {
  afterEach(() => localStorage.clear());
  const PAST = NOW - 15 * 60_000;
  const project = (input: { slug: string; at?: number }) => (input.at === undefined ? projectView() : projectView({ at: input.at, now: PAST }));
  const open = async (slot: Slot) => {
    fireEvent.click(await slot.findByRole("button", { name: "Timeline" }));
    await waitFor(() => expect(slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  };
  const rewind = async (slot: Slot) => {
    await open(slot);
    fireEvent.click(slot.getByRole("button", { name: "Previous event" }));
    await slot.findByRole("button", { name: "Back to now" });
  };

  it("starts collapsed as a strip with a Play button", async () => {
    const { slot } = await mountPage("csv", { project });
    const toggle = await slot.findByRole("button", { name: "Timeline" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector("[data-timeline-mini]")).not.toBeNull();
    expect(slot.container.querySelector("[data-timeline-open]")).toBeNull();
    expect(slot.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(calls(slot, "timeline")[0]!.input).toEqual({ slug: "csv" });
  });

  it("opens, and stays open across a remount", async () => {
    const first = await mountPage("csv", { project });
    await open(first.slot);
    expect(first.slot.getByRole("button", { name: "Timeline" }).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("loom.timeline.open")).toBe("true");
    expect(first.slot.container.querySelector("[data-timeline-overview]")).not.toBeNull();
    expect(first.slot.container.querySelector("[data-timeline-lanes]")).not.toBeNull();
    expect(first.slot.getByText("event 3 of 3")).toBeTruthy();
    first.slot.lifecycle.unmount();
    const again = await mountPage("csv", { project });
    await waitFor(() => expect(again.slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  });

  it("rewinds the page to the previous event, with no controls, and Back to now returns it", async () => {
    const { slot } = await mountPage("csv", { project });
    await slot.findByRole("button", { name: "Pause" });
    await rewind(slot);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
    expect([...slot.container.querySelectorAll("[data-state-badge]")].map((badge) => badge.textContent)).toContain("rewound");
    expect(slot.container.querySelector("[data-rewind-bar]")!.textContent).toContain("nothing here can change it");
    expect(slot.container.querySelector("[data-next-step]")).toBeNull();
    expect(slot.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(slot.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(slot.getByText("event 2 of 3")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Back to now" }));
    await slot.findByRole("button", { name: "Pause" });
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
    expect(slot.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull();
  });

  it("seeks to the moment of one of your actions", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    fireEvent.click(slot.getByRole("button", { name: "You ran start" }));
    await waitFor(() => expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 }));
  });

  it("packs the bars into rows, and packs again for Trouble only and for agent sessions", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    const note = () => slot.container.querySelector("[data-timeline-note]")!.textContent;
    expect(note()).toBe("2 tickets in 2 rows");
    expect(slot.container.querySelectorAll("[data-timeline-bar]")).toHaveLength(2);
    fireEvent.click(slot.getByRole("checkbox", { name: "Trouble only" }));
    expect(note()).toBe("1 ticket in 1 row");
    expect([...slot.container.querySelectorAll("[data-timeline-bar]")].map((bar) => bar.getAttribute("data-timeline-bar"))).toEqual(["CSV-2"]);
    fireEvent.click(slot.getByRole("checkbox", { name: "Trouble only" }));
    fireEvent.click(slot.getByRole("button", { name: "Agent sessions" }));
    expect(note()).toBe("1 session in 1 row");
  });

  it("opens a ticket as it was at the rewound moment, with no reply box", async () => {
    const ticket = vi.fn((input: { key: string; at?: number }) => ticketDetail({ key: input.key, at: input.at ?? null, now: input.at === undefined ? NOW : PAST, replyTo: null }));
    const { slot, goTo } = await mountPage("csv", { project, ticket });
    await rewind(slot);
    goTo("csv/CSV-2");
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-rewound]")).not.toBeNull());
    expect(ticket).toHaveBeenCalledWith({ key: "CSV-2", at: 12 });
    expect(slot.container.querySelector("[data-ticket-rewound]")!.textContent).toContain("This is CSV-2 as it was then.");
    expect(slot.queryByRole("textbox", { name: "New reply" })).toBeNull();

    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-ticket-rewound]")!).getByRole("button", { name: "Back to now" }));
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-rewound]")).toBeNull());
    expect(ticket).toHaveBeenLastCalledWith({ key: "CSV-2" });
    expect(slot.getByRole("textbox", { name: "New reply" })).toBeTruthy();
  });

  it("hides the Planner tab while rewound, and shows the spec in force with no notes", async () => {
    const { slot } = await mountPage("csv", { project, specVersion: () => specVersionView({ version: 1, status: "approved", changes: null }) });
    expect(await slot.findByRole("tab", { name: "Planner" })).toBeTruthy();
    await rewind(slot);
    expect(slot.queryByRole("tab", { name: "Planner" })).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-dashboard]")).not.toBeNull());
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", version: 1 });
    expect(slot.container.querySelector("[data-spec-rewound]")!.textContent).toBe("At this moment, version 1 was the spec in force.");
    expect(slot.queryAllByRole("button", { name: /^Add a note on/ })).toEqual([]);
    expect(slot.container.querySelector("[data-spec-pending]")).toBeNull();
  });
});
