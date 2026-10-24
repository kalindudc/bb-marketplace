// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, mountPluginContentScripts, renderSlot, type PluginRpcTestHandlers, type PluginSdkTestFakes, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useComposers, type NewThreadRequest, type PluginComposerApi, type PluginNavPanelProps, type PluginSidebarThread, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { Attempt, BbProjectChoice, ChangedFile, ChangeSource, ChangesView, ChecksItem, HomeProject, NextStep, PlannerView, PlanningSession, ProjectSummary, ProjectView, RepoOverview, SentNote, SpecVersionView, ThreadInfo, TicketDetail, rpcContract } from "../src/contract";
import type { TicketRow } from "../src/db/store";
import { repoOverviews } from "../src/projects";
import { notesMessage } from "../src/prompts";
import { parseSpec } from "../src/spec";
import { ConfirmButton, MoreMenu } from "../src/ui/common";
import { repoLand } from "../src/ui/next-step-bar";
import { questionsOf } from "../src/ui/questions";
import { HOUR, NOW, agent, attempt, card, changeRepo, feedRow, health, homeProject, homeView, metrics, overview, plannerViewOf, projectView, repoOverview, specV1, specVersionView, ticketDetail, timeline, withRepos } from "./fixtures";
import { specToml } from "./helpers";

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
  bbProjects: () => [],
  planning: () => [],
  planningSession: () => null,
  plannerView: () => null,
  messagePlanner: unexpected,
  dismissAsk: unexpected,
  specVersion: unexpected,
  sendNotes: unexpected,
  changes: unexpected,
  changePatch: unexpected,
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
  it("lists Loom in the left navigation with its spool icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map(({ id, title, icon, path }) => ({ id, title, icon, path }))).toEqual([{ id: "loom", title: "Loom", icon: "loom/loom", path: "loom" }]);
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "ticket", title: "Loom" }]);
    expect(app.contentScripts.map(({ id }) => id)).toEqual(["rail-badge"]);
  });

  it("is declared as the plugin's app entry", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(manifest.bb).toMatchObject({ server: "./server.ts", app: "./app.tsx", host: "./host.ts" });
  });

  it("brands the plugin with the spool and declares it for the page, the chip and the marketplace", () => {
    const root = join(__dirname, "..");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.bb.branding).toEqual({ icon: "./icons/loom.svg", experimental_icons: { loom: "./icons/loom.svg" } });
    const entry = JSON.parse(readFileSync(join(root, "../../entries/loom.json"), "utf8"));
    expect(entry.icon).toEqual({ url: "plugins/loom/icons/loom.svg" });
  });

  it("ships a monochrome 24px SVG that bb's icon validator accepts", () => {
    const path = join(__dirname, "..", "icons/loom.svg");
    expect(existsSync(path)).toBe(true);
    const svg = readFileSync(path, "utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/);
    expect(svg).not.toMatch(/<!DOCTYPE|<\?xml|<(script|style|image|foreignObject|a)\b|\son[a-z]+=|url\(|href=|fill="#|stroke="#/i);
    expect(Buffer.byteLength(svg)).toBeLessThan(32 * 1024);
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

  describe("search and the Finished group", () => {
    const three = () => homeView({ projects: [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "done" }), homeProject({ slug: "old", name: "Old importer", key: "LEGACY", state: "archived" })] });
    const slugs = (slot: Slot) => [...slot.container.querySelectorAll("[data-project-row]")].map((row) => row.getAttribute("data-project-row"));
    const finished = (slot: Slot) => within(slot.container.querySelector<HTMLElement>("[data-finished]")!).getByRole("button", { name: /Finished · 2/ });

    it("folds done and archived projects into a Finished group it remembers opening", async () => {
      const { slot } = await mountPage("", { home: three });
      await slot.findByText("CSV export");
      expect(slugs(slot)).toEqual(["csv"]);
      expect(finished(slot).getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(finished(slot));
      expect(slugs(slot)).toEqual(["csv", "docs", "old"]);
      expect(localStorage.getItem("loom.home.showFinished")).toBe("true");
      slot.lifecycle.unmount();

      const { slot: again } = await mountPage("", { home: three });
      await again.findByText("CSV export");
      expect(slugs(again)).toEqual(["csv", "docs", "old"]);
      expect(finished(again).getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(finished(again));
      expect(slugs(again)).toEqual(["csv"]);
      expect(localStorage.getItem("loom.home.showFinished")).toBe("false");
      expect(again.queryByRole("checkbox")).toBeNull();
    });

    it("keeps a finished project that still needs you among the active rows", async () => {
      const needsYou = [{ kind: "land" as const, slug: "docs", project: "Docs site", key: null, text: "finished all 3 tickets; land the integration branch", at: NOW }];
      const { slot } = await mountPage("", { home: () => ({ ...three(), needsYou }) });
      await slot.findByText("Docs site");
      expect(slugs(slot)).toEqual(["docs", "csv"]);
      expect(within(slot.container.querySelector<HTMLElement>("[data-finished]")!).getByRole("button", { name: /Finished · 1/ })).toBeTruthy();
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

    it("opens the Finished group and says so when every project is done or archived", async () => {
      const { slot } = await mountPage("", { home: () => homeView({ projects: [homeProject({ state: "done" })], needsYou: [] }) });
      await slot.findByText("CSV export");
      expect(slot.container.querySelector("[data-projects-empty]")!.textContent).toBe("Every project is done or archived.");
      expect(slugs(slot)).toEqual(["csv"]);
      expect(within(slot.container.querySelector<HTMLElement>("[data-finished]")!).queryByRole("button", { name: /Finished/ })).toBeNull();
      expect(slot.container.querySelector("[data-finished]")!.textContent).toContain("Finished · 1");
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

  describe("what needs you, in each project's row", () => {
    const pending = { kind: "pending" as const, slug: "csv", project: "CSV export", key: null, text: "spec v2 waits for your approval", at: NOW - 2 * 60_000 };
    // The server sends needs newest first, so the pending version comes before the blocked ticket.
    const needsYou = [pending, ...homeView().needsYou];
    const projects = [
      homeProject({ slug: "calm", name: "Calm one", key: "CALM" }),
      homeProject({ slug: "srch", name: "Search revamp", key: "SRCH" }),
      homeProject({ pendingVersion: 2 }),
      homeProject({ slug: "audit", name: "Audit log", key: "AUD", state: "draft" }),
      homeProject({ slug: "bill", name: "Billing API", key: "BILL", state: "paused" }),
    ];
    const rows = (slot: Slot) => [...slot.container.querySelectorAll<HTMLElement>("[data-project-row]")];
    const chips = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("[data-project-needs] button")];

    it("puts rows that need you first, most urgent first, each with its chips and a coloured edge", async () => {
      const { slot } = await mountPage("", { home: () => homeView({ needsYou, projects }) });
      await slot.findByText("Calm one");
      expect(rows(slot).map((row) => [row.getAttribute("data-project-row"), row.getAttribute("data-attention")])).toEqual([
        ["csv", "blocked"],
        ["bill", "paused"],
        ["audit", "approve"],
        ["srch", "land"],
        ["calm", null],
      ]);
      const [csv, bill, audit, srch, calm] = rows(slot);
      expect(chips(csv!).map((chip) => [chip.getAttribute("data-need"), chip.textContent])).toEqual([
        ["blocked", "!CSV-7 blocked"],
        ["pending", "✎Approve v2"],
      ]);
      expect(chips(csv!)[0]!.getAttribute("title")).toBe("CSV-7 is blocked: needs the staging DB credentials");
      expect(chips(bill!).map((chip) => chip.textContent)).toEqual(["⏸Paused by Loom"]);
      expect(chips(bill!)[0]!.getAttribute("title")).toBe("The token budget is used up: 900 of 900 tokens.");
      expect(chips(audit!).map((chip) => chip.textContent)).toEqual(["✎Review draft"]);
      expect(chips(srch!).map((chip) => chip.textContent)).toEqual(["↑Ready to land"]);
      expect(calm!.querySelector("[data-project-needs]")!.textContent).toBe("—");
      expect(csv!.querySelector("td")!.className).toContain("border-l-destructive");
      expect(srch!.querySelector("td")!.className).toContain("border-l-success");
      expect(audit!.querySelector("td")!.className).toContain("border-l-warning");
      expect(calm!.querySelector("td")!.className).toContain("border-l-transparent");
      expect(slot.queryByRole("region", { name: "Needs you" })).toBeNull();
    });

    it("opens a chip's ticket or project, and only that", async () => {
      const { slot } = await mountPage("", { home: () => homeView({ needsYou, projects }) });
      await slot.findByText("Calm one");
      for (const row of rows(slot)) for (const chip of chips(row)) fireEvent.click(chip);
      expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-7"), pushed("csv"), pushed("bill"), pushed("audit"), pushed("srch")]);
    });

    it("shows three chips and a +N more that opens the project", async () => {
      const blocked = [7, 8, 9, 10].map((n) => ({ kind: "blocked" as const, slug: "csv", project: "CSV export", key: `CSV-${n}`, text: "stuck", at: NOW - n }));
      const { slot } = await mountPage("", { home: () => homeView({ needsYou: [pending, ...blocked] }) });
      await slot.findByText("CSV export");
      expect(chips(rows(slot)[0]!).map((chip) => chip.textContent)).toEqual(["!CSV-7 blocked", "!CSV-8 blocked", "!CSV-9 blocked", "+2 more"]);
      fireEvent.click(slot.getByRole("button", { name: "+2 more" }));
      expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
    });

    it("says on the tile how many projects need you and how many tickets are blocked", async () => {
      const { slot } = await mountPage("", { home: () => homeView({ needsYou, projects }) });
      await slot.findByText("Calm one");
      const tile = slot.container.querySelector<HTMLElement>('[data-home-tile="needs"]')!;
      expect(tile.querySelector("[data-tile-value]")!.textContent).toBe("5");
      expect(tile.textContent).toContain("across 4 projects · 1 blocked");
      expect(tile.className).toContain("border-warning");

      slot.lifecycle.unmount();
      const { slot: none } = await mountPage("", { home: () => homeView({ needsYou: [] }) });
      await none.findByText("CSV export");
      const calm = none.container.querySelector<HTMLElement>('[data-home-tile="needs"]')!;
      expect(calm.textContent).toBe("Needs you0");
      expect(calm.className).not.toContain("border-warning");
    });
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
    expect(rows[0]!.getAttribute("data-attention")).toBe("planning");
    expect(rows[0]!.querySelector("[data-state-badge]")!.textContent).toBe("planning");
    expect(slot.container.querySelector("[data-guide]")).toBeNull();
    expect(slot.queryByRole("region", { name: "Planning" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Continue planning" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p1")]);
    fireEvent.click(rows[0]!);
    expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p1"), pushed("_plan/thr_p1")]);

    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "csv" } });
    expect(slot.container.querySelector("[data-planning-row]")).toBeNull();
    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "rate limits" } });
    expect([...slot.container.querySelectorAll("[data-planning-row]")]).toHaveLength(1);
    expect(slot.container.querySelector("[data-project-row]")).toBeNull();
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
  const runtime = () => (globalThis as unknown as { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } }).__bbPluginRuntime;
  let restoreComposer: (() => void) | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    restoreComposer?.();
    restoreComposer = null;
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
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Let people export their orders as CSV."), merge: "integration", reviewer: "codex, gpt-5", repos: [], confirm: true });
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
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site."), merge: "ask", reviewer: "", repos: [], confirm: true });
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
    await waitFor(() => expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site.", "proj_shop"), merge: "ask", reviewer: "", repos: [], confirm: true }));
  });

  const choices = (): BbProjectChoice[] => [
    { id: "proj_docs", name: "docs", hostIds: [] },
    { id: "proj_shop", name: "shop", hostIds: ["host_1"] },
    { id: "proj_api", name: "shop-api", hostIds: ["host_1"] },
    { id: "project-test", name: "test", hostIds: ["host_1", "host_2"] },
  ];
  const repoRows = (slot: Slot) => [...slot.getByRole("group", { name: "Repos" }).querySelectorAll("[data-repo-choice]")].map((row) => row.getAttribute("data-repo-choice"));
  const repoBox = (slot: Slot, name: string) => within(slot.getByRole("group", { name: "Repos" })).getByRole("checkbox", { name: new RegExp(`^${name}(?: no checkout)?$`) }) as HTMLInputElement;

  // Uncontrolled like bb's composer: it submits the project bb reports for it, which setComposerScope changes as the human's pick in its project picker would.
  function SwitchingComposer({ onSubmit }: { onSubmit(request: NewThreadRequest): void | Promise<void> }) {
    const scope = useComposers()[0]!.scope;
    const [text, setText] = useState("");
    const projectId = scope.kind === "new-thread" ? (scope.projectId ?? "") : "";
    return (
      <div>
        <textarea data-testid="bb-new-thread-composer-input" value={text} onChange={(event) => setText(event.target.value)} />
        <button type="button" data-testid="bb-new-thread-composer-submit" onClick={() => void onSubmit(request(text, projectId) as NewThreadRequest)}>
          Start thread
        </button>
      </div>
    );
  }
  const mountSwitching = async (rpc: Partial<Handlers>, projectId: string) => {
    const app = await loadPluginApp(() => import("../app"));
    // renderSlot installs the test runtime again, so the stub goes on the runtime's own object rather than a copy.
    const sdk = runtime().pluginSdkApp;
    const original = sdk.experimental_NewThreadComposer;
    sdk.experimental_NewThreadComposer = SwitchingComposer;
    restoreComposer = () => {
      sdk.experimental_NewThreadComposer = original;
    };
    const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath: "_new" }, { pluginId: "loom", rpc: handlers(rpc), composer: { scope: { kind: "new-thread", projectId } } });
    mounts.push(slot);
    return slot;
  };

  // As bb's composer does: each render registers a fresh API for useComposers in a layout effect, which re-renders every reader at once.
  const mountRegistering = async (rpc: Partial<Handlers>, projectId: string) => {
    const app = await loadPluginApp(() => import("../app"));
    const sdk = runtime().pluginSdkApp;
    const listeners = new Set<() => void>();
    let composers: readonly PluginComposerApi[] = [];
    let version = 0;
    function RegisteringComposer() {
      useLayoutEffect(() => {
        composers = [{ scope: { kind: "new-thread", projectId } } as PluginComposerApi];
        version += 1;
        for (const listener of [...listeners]) listener();
      });
      return <div data-testid="bb-new-thread-composer" />;
    }
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };
    function useRegisteredComposers() {
      useSyncExternalStore(subscribe, () => version);
      return composers;
    }
    const original = { composer: sdk.experimental_NewThreadComposer, useComposers: sdk.useComposers };
    sdk.experimental_NewThreadComposer = RegisteringComposer;
    sdk.useComposers = useRegisteredComposers;
    restoreComposer = () => {
      sdk.experimental_NewThreadComposer = original.composer;
      sdk.useComposers = original.useComposers;
    };
    const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath: "_new" }, { pluginId: "loom", rpc: handlers(rpc) });
    mounts.push(slot);
    return slot;
  };

  it("renders bb's composer once per registration, so the page does not loop on the composer's own updates", async () => {
    const slot = await mountRegistering({ bbProjects: choices }, "proj_shop");
    expect(await slot.findByRole("heading", { name: "What should exist when the project is done?" })).toBeTruthy();
    await waitFor(() => expect(repoRows(slot)).toEqual(["proj_docs", "proj_api", "project-test"]));
    expect(slot.getAllByTestId("bb-new-thread-composer")).toHaveLength(1);
  });

  it("follows the composer's project: switched from shop to shop-api, it offers shop, hides shop-api, and sends shop as a repo", async () => {
    localStorage.setItem(SAVED, "proj_shop");
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const slot = await mountSwitching({ startPlanning, bbProjects: choices }, "proj_shop");
    await waitFor(() => expect(repoRows(slot)).toEqual(["proj_docs", "proj_api", "project-test"]));
    fireEvent.click(repoBox(slot, "shop-api"));
    expect(slot.getByRole("group", { name: "Repos" }).textContent).toContain("1 of up to 10 picked");

    await slot.setComposerScope({ kind: "new-thread", projectId: "proj_api" });
    expect(repoRows(slot)).toEqual(["proj_docs", "proj_shop", "project-test"]);
    expect(slot.getByRole("group", { name: "Repos" }).textContent).toContain("0 of up to 10 picked");
    fireEvent.click(repoBox(slot, "shop"));

    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p7")]));
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site.", "proj_api"), merge: "ask", reviewer: "", repos: ["proj_shop"], confirm: true });
  });

  it("keeps a pick hidden while it is the composer's project, and shows it picked again when the composer moves off it", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const slot = await mountSwitching({ startPlanning, bbProjects: choices }, "proj_shop");
    await waitFor(() => expect(repoRows(slot)).toHaveLength(3));
    fireEvent.click(repoBox(slot, "docs"));
    await slot.setComposerScope({ kind: "new-thread", projectId: "proj_docs" });
    expect(repoRows(slot)).toEqual(["proj_shop", "proj_api", "project-test"]);
    await slot.setComposerScope({ kind: "new-thread", projectId: "proj_shop" });
    expect(repoBox(slot, "docs").checked).toBe(true);
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(startPlanning).toHaveBeenCalledWith(expect.objectContaining({ request: request("Write the docs site.", "proj_shop"), repos: ["proj_docs"] })));
  });

  it("offers bb's other standard projects as repos, filterable by name, marks one with no checkout, and passes the picked ids to startPlanning", async () => {
    localStorage.setItem(SAVED, "proj_shop");
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", { startPlanning, bbProjects: choices });
    await waitFor(() => expect(repoRows(slot)).toEqual(["proj_docs", "proj_api", "project-test"]));
    expect(calls(slot, "bbProjects")).toEqual([{ method: "bbProjects", input: null }]);
    const group = slot.getByRole("group", { name: "Repos" });
    expect([...group.querySelectorAll("[data-no-checkout]")].map((mark) => mark.closest("[data-repo-choice]")!.getAttribute("data-repo-choice"))).toEqual(["proj_docs"]);
    expect(group.querySelector("[data-no-checkout]")!.textContent).toBe("no checkout");

    const filter = within(group).getByRole("searchbox", { name: "Filter repos" });
    fireEvent.change(filter, { target: { value: " API " } });
    expect(repoRows(slot)).toEqual(["proj_api"]);
    fireEvent.click(repoBox(slot, "shop-api"));
    fireEvent.change(filter, { target: { value: "docs" } });
    expect(repoRows(slot)).toEqual(["proj_docs", "proj_api"]);
    expect(repoBox(slot, "shop-api").checked).toBe(true);
    fireEvent.click(repoBox(slot, "docs"));
    fireEvent.change(filter, { target: { value: "nothing like it" } });
    expect(repoRows(slot)).toEqual(["proj_docs", "proj_api"]);
    fireEvent.change(filter, { target: { value: "" } });
    expect(group.textContent).toContain("2 of up to 10 picked");

    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p7")]));
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site.", "proj_shop"), merge: "ask", reviewer: "", repos: ["proj_api", "proj_docs"], confirm: true });
  });

  it("says when no repo matches the filter, and unpicks a repo when its box is cleared", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", { startPlanning, bbProjects: choices });
    await waitFor(() => expect(repoRows(slot)).toHaveLength(4));
    fireEvent.click(repoBox(slot, "docs"));
    fireEvent.click(repoBox(slot, "docs"));
    fireEvent.change(within(slot.getByRole("group", { name: "Repos" })).getByRole("searchbox"), { target: { value: "zzz" } });
    expect(repoRows(slot)).toEqual([]);
    expect(slot.getByRole("group", { name: "Repos" }).textContent).toContain('No repo matches "zzz".');
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(startPlanning).toHaveBeenCalledWith(expect.objectContaining({ repos: [] })));
  });

  it("leaves out a picked repo that the composer submits as its own project", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", { startPlanning, bbProjects: choices });
    await waitFor(() => expect(repoRows(slot)).toEqual(["proj_docs", "proj_shop", "proj_api", "project-test"]));
    fireEvent.click(repoBox(slot, "test"));
    fireEvent.click(repoBox(slot, "shop-api"));
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(startPlanning).toHaveBeenCalledTimes(1));
    expect(startPlanning).toHaveBeenCalledWith({ request: request("Write the docs site."), merge: "ask", reviewer: "", repos: ["proj_api"], confirm: true });
  });

  it("lets the human pick at most 10 repos", async () => {
    const many = Array.from({ length: 11 }, (_, n): BbProjectChoice => ({ id: `proj_${n}`, name: `repo-${String(n).padStart(2, "0")}`, hostIds: ["host_1"] }));
    const { slot } = await mountPage("_new", { bbProjects: () => many });
    await waitFor(() => expect(repoRows(slot)).toHaveLength(11));
    for (const choice of many.slice(0, 10)) fireEvent.click(repoBox(slot, choice.name));
    expect(repoBox(slot, "repo-10").disabled).toBe(true);
    expect(repoBox(slot, "repo-00").disabled).toBe(false);
    fireEvent.click(repoBox(slot, "repo-00"));
    expect(repoBox(slot, "repo-10").disabled).toBe(false);
  });

  it("says when bb cannot list its projects, and still starts planning without repos", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", {
      startPlanning,
      bbProjects: () => {
        throw new Error("bb is restarting");
      },
    });
    await waitFor(() => expect(slot.getByRole("group", { name: "Repos" }).textContent).toContain("Could not list bb's projects: bb is restarting"));
    typeGoal(slot, "Write the docs site.");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p7")]));
    expect(startPlanning).toHaveBeenCalledWith(expect.objectContaining({ repos: [] }));
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
  const early = () => plannerViewOf({ threadId: "thr_p1", slug: null, projectState: null, steps: [{ kind: "started", at: NOW - HOUR, text: "Export orders as CSV" }], versions: [], review: { kind: "none" } });

  it("shows the Planner page under the Plan stage while the thread has not proposed, with its chat one click away", async () => {
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session(), plannerView: () => early() });
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    expect(slot.getByRole("heading", { name: "Export orders as CSV" })).toBeTruthy();
    expect(calls(slot, "plannerView")[0]!.input).toEqual({ threadId: "thr_p1" });
    expect(slot.getByRole("navigation", { name: "Loom" }).textContent).toContain("Planning");
    const bar = slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    expect(bar.textContent).toContain("Next: answer the planner.");
    expect(bar.querySelector('[aria-current="step"]')!.getAttribute("data-stage")).toBe("Plan");
    expect(slot.container.querySelector('[data-planning-step="current"]')!.textContent).toContain("Goal and code");
    expect(slot.container.querySelector("[data-nothing-needed]")).not.toBeNull();
    expect(slot.container.querySelector("[data-planner-story]")!.textContent).toContain("You started planning");
    expect(slot.container.querySelector("[data-versions]")!.textContent).toContain("No draft yet");
    expect(calls(slot, "project")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open as thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_p1" }]);

    fireEvent.click(slot.getByRole("tab", { name: "Conversation" }));
    const chat = slot.getByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thr_p1");
    expect(chat.getAttribute("data-variant")).toBe("compact");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(slot.container.querySelector("[data-planner-story]")).toBeNull();
  });

  it("opens the project's Planner tab once the planner proposed", async () => {
    let current = session();
    const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [] });
    const { slot, goTo } = await mountPage("_plan/thr_p1", { planningSession: () => current, plannerView: () => plannerViewOf(), project: () => draft, specVersion: () => specVersionView() });
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    current = session({ slug: "csv", projectState: "draft" });
    await slot.emitRealtime("loom:changed", { slug: null });
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "loom", options: { subPath: "csv", replace: true } }));
    goTo("csv");
    await waitFor(() => expect(slot.getByRole("tab", { name: "Planner" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    expect(slot.container.querySelector("[data-spec-dashboard]")).toBeNull();
  });

  it("says so when the thread is not a Loom planning thread", async () => {
    const { slot } = await mountPage("_plan/thr_other");
    expect(await slot.findByText("This thread is not a Loom planning thread.")).toBeTruthy();
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
  });

  it("gives a project with a planner thread a Planner tab, and a project without one no such tab", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 1 }) });
    await slot.findByRole("tab", { name: "Board" });
    expect([...slot.container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toEqual(["Board", "Agents", "Feed", "Metrics", "Spec", "Planner", "Changes"]);
    fireEvent.click(slot.getByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    expect(calls(slot, "plannerView")[0]!.input).toEqual({ threadId: "thr_plan" });
    expect(slot.container.querySelector("[data-planning-step]")).toBeNull();
    slot.lifecycle.unmount();

    const none = await mountPage("csv", { project: () => projectView({ overview: overview({ plannerThreadId: null }) }) });
    await none.slot.findByRole("tab", { name: "Board" });
    expect(none.slot.queryByRole("tab", { name: "Planner" })).toBeNull();
  });
});

describe("planner page", () => {
  const scroll = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    scroll.mockClear();
    Element.prototype.scrollIntoView = scroll;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  const sidebar = (status: string, hasPendingInteraction = false) => ({ threads: [{ id: "thr_plan", status, hasPendingInteraction } as unknown as PluginSidebarThread] });
  const approveStep: NextStep = { stage: 1, tone: "normal", title: "Next: review draft v2.", text: "Loom's spec review passed it.", action: { control: "approve", version: 2, label: "Approve v2 · create 2 tickets", confirm: "Click again to approve v2" } };
  const draft = () => projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: approveStep });
  const page = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-planner-page]")!;
  const openPlanner = async (rpc: Partial<Handlers> = {}, view: ProjectView = projectView(), options: Pick<RenderSlotOptions<typeof rpcContract>, "sdk" | "sidebarThreads"> = {}) => {
    const { slot } = await mountPage("csv", { project: () => view, plannerView: () => plannerViewOf(), specVersion: () => specVersionView(), ...rpc }, options);
    fireEvent.click(await slot.findByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    return slot;
  };
  const v2 = { version: 2, status: "draft" as const, createdAt: NOW - HOUR, tickets: 2, change: { added: [], removed: ["csv-docs"], changed: [], settings: 0, guardrails: 0 }, review: { state: "approved" as const, round: 1, findings: 0 } };
  const revised = () =>
    plannerViewOf({
      steps: [
        { kind: "started", at: NOW - 5 * HOUR, text: "Export orders as CSV" },
        { kind: "turn", at: NOW - 4 * HOUR, text: "I proposed v1.", actions: [{ kind: "proposed", version: 1, tickets: 3, change: null }] },
        { kind: "notes", at: NOW - 3 * HOUR, version: 1, notes: [{ version: 1, paths: ["ticket[csv-docs]"], body: "We do not need docs." }] },
        { kind: "turn", at: NOW - 2 * HOUR, text: "I took out csv-docs.", actions: [{ kind: "proposed", version: 2, tickets: 2, change: v2.change }] },
        { kind: "review", at: NOW - HOUR, version: 2, round: 1, state: "approved", summary: "Fits.", findings: [], reason: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR },
      ],
      versions: [{ version: 1, status: "superseded", createdAt: NOW - 4 * HOUR, tickets: 3, change: null, review: null }, v2],
      review: { kind: "approved", version: 2, round: 1, summary: "Fits." },
    });

  it("hands a ready draft over with Loom's review, what changed and the comments it answers, and opens the Spec tab on it", async () => {
    const slot = await openPlanner({ plannerView: () => revised() }, { ...draft(), spec: { ...draft().spec, version: 2 } });
    const card = page(slot).querySelector<HTMLElement>('[data-version-card="2"]')!;
    expect(card.textContent).toContain("Draft v2 is ready for your review");
    expect(card.textContent).toContain("Passed Loom's spec review in round 1.");
    expect(card.textContent).toContain("Since v1: 2 tickets, −1.");
    expect(card.textContent).toContain("You sent 1 comment on v1; the Spec tab shows what v2 did with each.");
    expect(card.textContent).toContain("approve it with the button in the bar above");
    expect(within(card).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(page(slot).querySelector("[data-needs-you] h2")!.textContent).toBe("Needs you1");
    expect(page(slot).querySelector('[data-planning-step="current"]')!.textContent).toContain("Your review");
    expect(page(slot).querySelector("[data-planner-status]")!.textContent).toBe("Idle · v2 is with you");

    fireEvent.click(within(card).getByRole("button", { name: "Review v2 on the Spec tab" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true");
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", version: 2 });
  });

  it("tells the story in chapters, one per draft and one for the running project, newest first, with filters", async () => {
    const view = plannerViewOf({
      projectState: "running",
      approvedVersion: 2,
      triageRounds: 1,
      steps: [
        ...revised().steps,
        { kind: "control", at: NOW - 50 * 60_000, action: "approve", version: 2, pending: false, skipReview: false },
        {
          kind: "triage",
          at: NOW - 30 * 60_000,
          round: 1,
          blocked: [{ key: "CSV-1", title: "Order rows", reason: "The check crashes without a locale." }],
          response: {
            kind: "turn",
            at: NOW - 25 * 60_000,
            text: "I fixed the check in v3 and requeued CSV-1.",
            actions: [
              { kind: "post", key: "CSV-1", postId: 12, text: "Try again with the fixed check.", reply: true },
              { kind: "requeue", key: "CSV-1" },
              { kind: "ask", why: "", steps: [{ action: "other", text: "Watch CSV-1 in the next hour." }] },
            ],
          },
        },
      ],
      versions: [{ version: 1, status: "superseded", createdAt: NOW - 4 * HOUR, tickets: 3, change: null, review: null }, { ...v2, status: "approved" }],
      review: { kind: "none" },
    });
    const slot = await openPlanner({ plannerView: () => view, ticket: () => ticketDetail() });
    const story = () => page(slot).querySelector<HTMLElement>("[data-planner-story]")!;
    const chapters = () => [...story().querySelectorAll("[data-chapter]")].map((chapter) => chapter.getAttribute("data-chapter"));
    expect(chapters()).toEqual(["Running on v2", "Draft v2", "Draft v1"]);
    const running = story().querySelector<HTMLElement>('[data-chapter="Running on v2"]')!;
    expect(running.textContent).toContain("Triage round 1: 1 ticket blocked");
    expect(running.textContent).toContain("The check crashes without a locale.");
    expect(running.textContent).toContain("Replied on CSV-1 (#12): “Try again with the fixed check.”");
    expect(running.textContent).toContain("Requeued CSV-1.");
    expect(running.textContent).toContain("Asked you to: Watch CSV-1 in the next hour.");
    expect(running.textContent).toContain("You approved v2");
    const draftOne = () => story().querySelector<HTMLElement>('[data-chapter="Draft v1"]')!;
    expect(draftOne().textContent).toContain("3 tickets.");
    expect(draftOne().querySelector("[data-story-step]")).toBeNull();
    fireEvent.click(within(draftOne()).getByRole("button", { expanded: false }));
    expect(draftOne().textContent).toContain("You started planning");
    expect(draftOne().textContent).toContain("Proposed v1");

    fireEvent.click(within(story()).getByRole("button", { name: "Triage" }));
    expect(chapters()).toEqual(["Running on v2"]);
    expect(story().querySelector('[data-chapter="Running on v2"] button')!.textContent).toContain("1 of 2 steps");
    fireEvent.click(within(story()).getByRole("button", { name: "Everything" }));
    fireEvent.click(within(story()).getByRole("button", { name: "Oldest first" }));
    expect(chapters()).toEqual(["Draft v1", "Draft v2", "Running on v2"]);

    fireEvent.click(within(running).getAllByRole("button", { name: "CSV-1" })[0]!);
    expect(slot.inspection.navigateCalls).toContainEqual(pushed("csv/CSV-1"));
  });

  it("lists the planner's asks with a button for each step, takes them in order, and sets them aside", async () => {
    const asked = (approved: boolean): PlannerView =>
      plannerViewOf({
        projectState: "running",
        approvedVersion: approved ? 2 : 1,
        pendingVersion: approved ? null : 2,
        review: approved ? { kind: "none" } : { kind: "approved", version: 2, round: 1, summary: "Holds." },
        ask: {
          id: 7,
          at: NOW - 10 * 60_000,
          why: "Both tickets fail the same check.",
          open: true,
          steps: [
            { action: "approve", version: 2, text: "Approve v2: it runs the check with a UTF-8 locale.", done: approved },
            { action: "requeue", key: "CSV-1", text: "Then requeue CSV-1.", done: false },
            { action: "other", text: "Check the alert in Observe.", done: false },
          ],
        },
      });
    let current = asked(false);
    const running = projectView({ overview: overview({ pendingVersion: 2 }), board: [card({ key: "CSV-1", state: "blocked" })], openAsks: 3 });
    const control = vi.fn(() => {
      current = asked(true);
      return running;
    });
    const ticketAction = vi.fn(() => ticketDetail());
    const dismissAsk = vi.fn(() => plannerViewOf({ ask: null }));
    const slot = await openPlanner({ plannerView: () => current, control, ticketAction, dismissAsk }, running);
    expect(slot.container.querySelector('[data-tab-badge="planner"]')!.textContent).toBe("3");
    const asks = () => page(slot).querySelector<HTMLElement>("[data-planner-asks]")!;
    expect(asks().textContent).toContain("Both tickets fail the same check.");
    expect([...asks().querySelectorAll("[data-ask-step]")].map((step) => step.getAttribute("data-ask-step"))).toEqual(["approve", "requeue", "other"]);
    const requeue = () => within(asks().querySelector<HTMLElement>('[data-ask-step="requeue"]')!).getByRole("button", { name: /Requeue/ }) as HTMLButtonElement;
    expect(requeue().disabled).toBe(true);
    expect(requeue().title).toBe("Approve v2 first");
    expect(page(slot).querySelector("[data-version-card]")).toBeNull();

    fireEvent.click(within(asks()).getByRole("button", { name: "Approve v2" }));
    fireEvent.click(within(asks()).getByRole("button", { name: "Click again to approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(asks().querySelector('[data-ask-step="approve"]')!.hasAttribute("data-done")).toBe(true));
    expect(requeue().disabled).toBe(false);
    fireEvent.click(requeue());
    fireEvent.click(within(asks()).getByRole("button", { name: "Click again to requeue CSV-1" }));
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-1", action: "requeue", note: "Requeued as the planner asked: Then requeue CSV-1.", confirm: true }));

    fireEvent.click(within(asks()).getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(dismissAsk).toHaveBeenCalledWith({ slug: "csv", ask: 7, confirm: true }));
    await waitFor(() => expect(page(slot).querySelector("[data-planner-asks]")).toBeNull());
  });

  it("sends the human's message to the planner and shows it in the story", async () => {
    const messagePlanner = vi.fn(() => plannerViewOf({ steps: [...plannerViewOf().steps, { kind: "message", at: NOW, text: "Keep it to one ticket." }] }));
    const slot = await openPlanner({ messagePlanner }, { ...draft(), spec: { ...draft().spec, version: 1 } });
    const box = within(page(slot).querySelector<HTMLElement>("[data-message-planner]")!);
    expect((box.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box.getByRole("textbox", { name: "Message to the planner" }), { target: { value: "  Keep it to one ticket. " } });
    fireEvent.click(box.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(messagePlanner).toHaveBeenCalledWith({ threadId: "thr_plan", text: "Keep it to one ticket.", confirm: true }));
    expect(await box.findByRole("status")).toBeTruthy();
    expect(page(slot).querySelector("[data-planner-story]")!.textContent).toContain("You wrote to the planner");
  });

  it("marks the Planner tab while the planner waits on you, and says what a working planner is on", async () => {
    const waiting = await openPlanner({}, draft(), { sidebarThreads: sidebar("idle", true) });
    expect(waiting.container.querySelector('[data-tab-badge="planner"]')!.textContent).toBe("?");
    expect(page(waiting).querySelector("[data-planner-status]")!.textContent).toBe("Waiting on you");
    waiting.lifecycle.unmount();

    const notes = plannerViewOf({ steps: [...plannerViewOf().steps, { kind: "notes", at: NOW - 60_000, version: 1, notes: [{ version: 1, paths: ["ticket[csv-model]"], body: "Name the rows." }] }] });
    const working = await openPlanner({ plannerView: () => notes }, draft(), { sidebarThreads: sidebar("active") });
    expect(working.container.querySelector('[data-tab-badge="planner"]')).toBeNull();
    expect(page(working).querySelector("[data-planner-status]")!.textContent).toBe("Working");
    expect(page(working).querySelector("[data-planner-strip]")!.textContent).toContain("on your comment on v1");
    expect(page(working).querySelector("[data-nothing-needed]")!.textContent).toContain("The planner is working on your comment on v1.");
    expect(page(working).querySelector("[data-planner-story]")!.textContent).toContain("Working on your comment on v1");
  });
});

describe("planner page states", () => {
  const sidebar = (status: string) => ({ threads: [{ id: "thr_plan", status, hasPendingInteraction: false } as unknown as PluginSidebarThread] });
  const draft = () => projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: null });
  const open = async (view: PlannerView, options: Pick<RenderSlotOptions<typeof rpcContract>, "sdk" | "sidebarThreads"> = {}) => {
    const { slot } = await mountPage("csv", { project: () => draft(), plannerView: () => view, specVersion: () => specVersionView() }, options);
    fireEvent.click(await slot.findByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    return slot;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("says a spec review that did not finish blocks the draft, and how to go on", async () => {
    const slot = await open(plannerViewOf({ review: { kind: "failed", version: 1, round: 1, reason: "the reviewer ended its turn twice without a verdict" } }), { sidebarThreads: sidebar("idle") });
    const card = slot.container.querySelector<HTMLElement>('[data-version-card="1"]')!;
    expect(card.querySelector("h3")!.textContent).toBe("Loom's spec review of v1 did not finish");
    expect(card.textContent).toContain("the reviewer ended its turn twice without a verdict");
    expect(card.querySelector("code")!.textContent).toBe("bb loom approve csv --skip-review");
    expect(card.textContent).not.toContain("`");
    expect(slot.container.querySelector("[data-planner-status]")!.textContent).toBe("Idle · Loom's spec review did not finish");
    expect(slot.container.querySelector('[data-planning-step="current"]')!.textContent).toContain("Loom's spec review");
    expect(slot.container.querySelector("[data-nothing-needed]")).toBeNull();
  });

  it("says the planner has your comments once you sent them on the newest version", async () => {
    const view = plannerViewOf({ steps: [...plannerViewOf().steps, { kind: "notes", at: NOW - 60_000, version: 1, notes: [{ version: 1, paths: ["ticket[csv-model]"], body: "Name the rows." }] }] });
    const slot = await open(view, { sidebarThreads: sidebar("idle") });
    expect(slot.container.querySelector("[data-planner-status]")!.textContent).toBe("Idle · it has your comments on v1");
    expect(slot.container.querySelector('[data-planning-step="current"]')!.textContent).toContain("Draft · v2");
    expect(slot.container.querySelector("[data-version-card]")).toBeNull();
  });

  it("reads the column order as it shows: one column on a narrow page, the side column beside the story on a wide one", async () => {
    const order = (slot: Slot) => [...slot.container.querySelectorAll("[data-needs-you], [data-message-planner], [data-planner-story], [data-decisions]")].map((element) => [...element.attributes].find((attribute) => attribute.name.startsWith("data-"))!.name);
    const narrow = await open(plannerViewOf());
    expect(narrow.container.querySelector("[data-planner-layout]")!.getAttribute("data-planner-layout")).toBe("narrow");
    expect(order(narrow)).toEqual(["data-needs-you", "data-message-planner", "data-planner-story", "data-decisions"]);
    narrow.lifecycle.unmount();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 1300 });
    try {
      const wide = await open(plannerViewOf());
      await waitFor(() => expect(wide.container.querySelector("[data-planner-layout]")!.getAttribute("data-planner-layout")).toBe("wide"));
      expect(order(wide)).toEqual(["data-needs-you", "data-planner-story", "data-message-planner", "data-decisions"]);
      expect(wide.container.querySelectorAll("textarea")).toHaveLength(1);
    } finally {
      Object.defineProperty(Element.prototype, "clientWidth", width);
    }
  });
});

describe("planner questions", () => {
  const session = (): PlanningSession => ({ threadId: "thr_p1", title: "Export orders as CSV", startedAt: Date.now(), slug: null, projectState: null });
  const early = () => plannerViewOf({ threadId: "thr_p1", slug: null, projectState: null, steps: [{ kind: "started", at: NOW - HOUR, text: "Export orders as CSV" }], versions: [], review: { kind: "none" } });
  const sidebar = (threadId: string, hasPendingInteraction: boolean) => ({ threads: [{ id: threadId, hasPendingInteraction } as PluginSidebarThread] });
  const pending = { threadId: "thr_p1", turnId: null, expiresAt: null, status: "pending", statusReason: null, resolution: null, resolvedAt: null };
  const asked = (id: string, over: Record<string, unknown> = {}) => ({
    ...pending,
    id,
    createdAt: 1,
    origin: { kind: "plugin", pluginId: "better-ask", rendererId: "ask-user-question" },
    payload: { kind: "plugin", title: "2 questions", data: { questions: [singleSelect, multiSelect] } },
    ...over,
  });
  const single = (id: string, over: Record<string, unknown> = {}) => asked(id, { payload: { kind: "plugin", title: "Merge plan", data: { questions: [singleSelect] } }, ...over });
  const providerApproval = {
    ...pending,
    id: "int_provider",
    createdAt: 1,
    origin: { kind: "provider", providerId: "codex", providerRequestId: "req_1", providerThreadId: "pt_1" },
    payload: { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject: { kind: "command", command: "rm -rf dist" } },
  };
  const mountQuestions = async (rows: () => unknown[], respond: (args: unknown) => Promise<unknown> = async () => ({}), waiting = true, events: () => unknown[] = () => []) => {
    const list = vi.fn(async () => rows());
    const answer = vi.fn(respond);
    const eventList = vi.fn(async () => events());
    const sdk = { threads: { interactions: { list, respond: answer }, events: { list: eventList } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session(), plannerView: () => early() }, { sdk, sidebarThreads: sidebar("thr_p1", waiting) });
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    return { slot, list, answer, eventList };
  };
  const card = (slot: Slot, id = "int_1") => slot.container.querySelector<HTMLElement>(`[data-question-card="${id}"]`);

  it("counts the questions the planner waits on, not its rounds of questions", async () => {
    const { slot } = await mountQuestions(() => [asked("int_1"), single("int_2", { createdAt: 2 })]);
    await waitFor(() => expect(card(slot)).not.toBeNull());
    expect(slot.container.querySelector("[data-planner-status]")!.textContent).toBe("Waiting on you \u00b7 3 questions");
  });

  it("asks the planner's questions one at a time under Needs you, and sends the answers as the question plugin's own form does", async () => {
    let rows = [asked("int_1")];
    const { slot, list, answer } = await mountQuestions(() => rows);
    await waitFor(() => expect(card(slot)).not.toBeNull());
    expect(card(slot)!.closest("[data-needs-you]")).not.toBeNull();
    const form = within(card(slot)!);
    expect(form.getByText("The planner asks 2 questions")).toBeTruthy();
    expect(form.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["1Merge plan", "2Checks", "Review"]);
    expect(form.getByText("How should finished tickets merge?")).toBeTruthy();
    expect(form.getByText("One branch, landed at the end")).toBeTruthy();
    expect(form.queryByText("Which checks must pass?")).toBeNull();
    const option = (name: RegExp) => form.getByRole("button", { name });
    fireEvent.click(option(/PR per ticket/));
    fireEvent.click(option(/Integration branch/));
    expect(option(/Integration branch/).getAttribute("aria-pressed")).toBe("true");
    expect(option(/PR per ticket/).getAttribute("aria-pressed")).toBe("false");
    expect(form.getByText("1 of 2 answered")).toBeTruthy();

    fireEvent.click(form.getByRole("button", { name: "Next" }));
    expect(form.getByText("Which checks must pass?")).toBeTruthy();
    expect(form.getByText("Pick any that apply")).toBeTruthy();
    expect(form.getByText("Each runs in the ticket's worktree.")).toBeTruthy();
    expect(option(/npm run typecheck/).textContent).toContain("Recommended");
    fireEvent.click(option(/npm run typecheck/));
    fireEvent.click(option(/npm run build/));
    fireEvent.change(form.getByRole("textbox", { name: "Or type your own answer" }), { target: { value: "  and docs " } });
    fireEvent.click(form.getByRole("button", { name: "Review answers" }));
    expect([...card(slot)!.querySelectorAll("[data-question-review] > div")].map((row) => row.textContent)).toEqual(["Merge planIntegration branchChange", "Checksnpm run typecheck, npm run build, “and docs”Change"]);

    rows = [];
    fireEvent.click(form.getByRole("button", { name: "Send 2 answers" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ threadId: "thr_p1", interactionId: "int_1", value: { answers: { q1: { selected: ["o1"] }, q2: { selected: ["o2", "o3"], freeText: "and docs" } } } }));
    await waitFor(() => expect(card(slot)).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ threadId: "thr_p1" });
  });

  it("fills the questions not answered yet with the planner's recommendations, and sends only once each has an answer", async () => {
    const { slot } = await mountQuestions(() => [asked("int_1")]);
    await waitFor(() => expect(card(slot)).not.toBeNull());
    const form = within(card(slot)!);
    fireEvent.click(form.getByRole("button", { name: "Use the recommended answers for the rest" }));
    const rows = () => [...card(slot)!.querySelectorAll("[data-question-review] > div")].map((row) => row.textContent);
    expect(rows()).toEqual(["Merge planNot answered yetChange", "Checksnpm run typecheckChange"]);
    expect((form.getByRole("button", { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(form.getAllByRole("button", { name: "Change" })[0]!);
    fireEvent.click(form.getByRole("button", { name: /PR per ticket/ }));
    fireEvent.click(form.getByRole("tab", { name: "Review" }));
    expect(rows()[0]).toBe("Merge planPR per ticketChange");
    expect((form.getByRole("button", { name: "Send 2 answers" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows why an answer failed, and sends a question it cannot draw to the thread", async () => {
    const other = asked("int_2", { createdAt: 0, origin: { kind: "plugin", pluginId: "colors", rendererId: "color-picker" }, payload: { kind: "plugin", title: "Pick a color", data: { questions: [singleSelect] } } });
    const unreadable = asked("int_3", { createdAt: 2, payload: { kind: "plugin", title: "A newer question form", data: { questions: "?" } } });
    const { slot } = await mountQuestions(
      () => [unreadable, single("int_1"), other],
      async () => {
        throw new Error("The question was already answered.");
      },
    );
    await waitFor(() => expect(card(slot)).not.toBeNull());
    expect([...slot.container.querySelectorAll("[data-question-card]")].map((entry) => entry.getAttribute("data-question-card"))).toEqual(["int_2", "int_1", "int_3"]);

    const form = within(card(slot)!);
    expect(form.getByText("The planner asks a question")).toBeTruthy();
    expect(form.queryByRole("tab")).toBeNull();
    fireEvent.click(form.getByRole("button", { name: /PR per ticket/ }));
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

  it("tells the answered rounds from bb's thread events in the story and under What you decided", async () => {
    const lifecycle = (status: string, at: number, resolution: unknown = null) => ({
      id: `evt_${at}`,
      threadId: "thr_p1",
      seq: at,
      createdAt: NOW - HOUR + at,
      type: "system/interaction/lifecycle",
      data: { interaction: { id: "pint_1", status, origin: { kind: "plugin", pluginId: "better-ask", rendererId: "ask-user-question" }, payload: { kind: "plugin", title: "2 questions" }, resolution } },
    });
    const resolved = {
      kind: "plugin_submitted",
      description: {
        title: "Answered 2 of 2 questions",
        payload: {
          questions: [
            { question: "How should finished tickets merge?", header: "Merge plan" },
            { question: "Which checks must pass?", header: "Checks" },
          ],
          answers: { "How should finished tickets merge?": "Integration branch", "Which checks must pass?": "npm test" },
        },
      },
    };
    const other = { ...lifecycle("resolved", 3), data: { interaction: { id: "pint_2", status: "resolved", origin: { kind: "provider" }, payload: {}, resolution: null } } };
    const { slot, eventList } = await mountQuestions(() => [], undefined, false, () => [lifecycle("pending", 1), lifecycle("resolved", 2, resolved), other]);
    await waitFor(() => expect(slot.container.querySelector("[data-planner-story]")!.textContent).toContain("You answered 2 questions"));
    expect(eventList).toHaveBeenCalledWith({ threadId: "thr_p1", types: ["system/interaction/lifecycle"], limit: "100", order: "asc" });
    const story = slot.container.querySelector<HTMLElement>("[data-planner-story]")!;
    expect(story.textContent).toContain("Merge planIntegration branch");
    expect([...slot.container.querySelectorAll("[data-decision]")].map((row) => row.textContent)).toEqual(["Merge planIntegration branch", "Checksnpm test"]);
    expect(slot.container.querySelector("[data-about-planner]")!.textContent).toContain("1 round, 2 answers");
  });

  it("keeps a round open while bb resolves it, says when one ended unanswered, and reads the open questions when the sidebar leaves the thread out", async () => {
    const lifecycle = (id: string, status: string, at: number) => ({ id: `evt_${id}_${at}`, threadId: "thr_p1", seq: at, createdAt: NOW - HOUR + at, type: "system/interaction/lifecycle", data: { interaction: { id, status, origin: { kind: "plugin", pluginId: "better-ask", rendererId: "ask-user-question" }, payload: { kind: "plugin", title: id === "pint_1" ? "Merge plan" : "Checks" }, resolution: null } } });
    const list = vi.fn(async () => []);
    const sdk = { threads: { interactions: { list }, events: { list: async () => [lifecycle("pint_1", "pending", 1), lifecycle("pint_1", "resolving", 2), lifecycle("pint_2", "pending", 3), lifecycle("pint_2", "interrupted", 4)] } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session(), plannerView: () => early() }, { sdk });
    await waitFor(() => expect(slot.container.querySelector("[data-planner-story]")!.textContent).toContain("The planner asks: Merge plan"));
    const story = slot.container.querySelector<HTMLElement>("[data-planner-story]")!;
    expect(story.textContent).toContain("Answer it in the Conversation view.");
    expect(story.textContent).toContain("The planner's question “Checks” ended without an answer");
    await waitFor(() => expect(list).toHaveBeenCalledWith({ threadId: "thr_p1" }));
  });

  it("reads the thread's lifecycle events a hundred at a time, after the last one it read", async () => {
    const row = (seq: number) => ({ id: `evt_${seq}`, threadId: "thr_p1", seq, createdAt: NOW - HOUR + seq, type: "system/interaction/lifecycle", data: { interaction: { id: `pint_${seq}`, status: "pending", origin: { kind: "plugin", pluginId: "better-ask", rendererId: "ask-user-question" }, payload: { kind: "plugin", title: `Round ${seq}` }, resolution: null } } });
    const list = vi.fn(async (args: { afterSeq?: string }) => (args.afterSeq === undefined ? Array.from({ length: 100 }, (_, n) => row(n + 1)) : [row(101)]));
    const sdk = { threads: { interactions: { list: async () => [] }, events: { list } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("_plan/thr_p1", { planningSession: () => session(), plannerView: () => early() }, { sdk });
    await waitFor(() => expect(slot.container.querySelector("[data-planner-story]")!.textContent).toContain("The planner asks: Round 101"));
    expect(list.mock.calls.map(([args]) => args.afterSeq).slice(0, 2)).toEqual([undefined, "100"]);
  });

  it("shows the questions on the project's Planner tab too, with a ? on the tab", async () => {
    const list = vi.fn(async () => [asked("int_1", { threadId: "thr_plan" })]);
    const sdk = { threads: { interactions: { list } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("csv", { project: () => projectView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 1 }) }, { sdk, sidebarThreads: sidebar("thr_plan", true) });
    expect((await slot.findByRole("tab", { name: "Planner" })).querySelector('[data-tab-badge="planner"]')!.textContent).toBe("?");
    fireEvent.click(slot.getByRole("tab", { name: "Planner" }));
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

  it("hides a draft's Approve while its spec review runs, has findings or did not finish, and shows it once the review passed", async () => {
    const draft = (specReview: ReturnType<typeof projectView>["specReview"]) => ({ ...bare("draft", { approvedVersion: null, ticketCounts: {} }), specReview });
    expect(await labels(draft({ kind: "reviewing", version: 1, round: 1 }))).toEqual(["⋯"]);
    expect(await labels(draft({ kind: "changes", version: 1, round: 1, findings: [{ title: "Too big", detail: "Drop it." }] }))).toEqual(["⋯"]);
    expect(await labels(draft({ kind: "failed", version: 1, round: 1, reason: "the reviewer ended its turn twice without a verdict" }))).toEqual(["⋯"]);
    expect(await labels(draft({ kind: "approved", version: 1, round: 1, summary: "Fits." }))).toEqual(["Approve", "⋯"]);
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
  beforeEach(() => localStorage.clear());
  const pending = (next: NextStep | null = projectView().next) => projectView({ spec: { ...projectView().spec, version: 1, pendingVersion: 2 }, overview: overview({ pendingVersion: 2 }), next });
  const pendingSpec = () => specVersionView({ status: "pending", compared: { version: 1, status: "approved", spec: specV1() }, versions: [{ version: 1, status: "approved" }, { version: 2, status: "pending" }] });

  it("shows the spec page for the pending version, and approves it from the review panel after a second click", async () => {
    const control = vi.fn(() => projectView());
    const { slot } = await mountPage("csv", { project: () => pending(), control, specVersion: () => pendingSpec() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    expect(calls(slot, "specVersion")[0]!.input).toEqual({ slug: "csv" });
    expect(slot.container.querySelector("[data-spec-pending]")!.textContent).toBe("v2 waits for your approval; until then the project runs on v1 and its tickets stay as they are.");
    const panel = slot.container.querySelector<HTMLElement>("[data-review-panel]")!;
    fireEvent.click(within(panel).getByRole("button", { name: "Approve v2" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("button", { name: "Click again to approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("leaves a pending version's Approve to the next-step bar when the bar carries it", async () => {
    const next: NextStep = { stage: 4, tone: "normal", title: "Next: approve v2.", text: "The planner proposed spec v2.", action: { control: "approve", version: 2, label: "Approve v2", confirm: "Click again to approve v2" } };
    const control = vi.fn(() => projectView());
    const { slot } = await mountPage("csv", { project: () => pending(next), control, specVersion: () => pendingSpec() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-review-panel]")).not.toBeNull());
    expect(within(slot.container.querySelector<HTMLElement>("[data-review-panel]")!).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(slot.getAllByRole("button", { name: /^Approve v2/ })).toHaveLength(1);
    expect(slot.getByRole("button", { name: "More actions" })).toBeTruthy();
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-next-step]")!).getByRole("button", { name: "Approve v2" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("offers no Approve on a draft while Loom's spec review holds it, and says where the review stands", async () => {
    const finding = { path: "ticket[csv-export]", title: "No criterion for an empty export", detail: "Add one." };
    const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: null, specReview: { kind: "changes", version: 2, round: 1, findings: [finding] } });
    const spec = specVersionView({ reviews: [{ version: 2, round: 1, state: "changes_requested", summary: "One gap.", findings: [finding], reason: null, startedAt: NOW - HOUR, endedAt: NOW }] });
    const { slot } = await mountPage("csv", { project: () => ({ ...draft, spec: { ...draft.spec, version: 2 } }), specVersion: () => spec });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-review-panel]")).not.toBeNull());
    expect(slot.queryAllByRole("button", { name: /^Approve/ })).toEqual([]);
    const status = slot.container.querySelector<HTMLElement>('[data-spec-review-status="changes_requested"]')!;
    expect(status.textContent).toContain("Loom's spec review found 1 problem in v2 · round 1 of 3. The planner revises the spec for them; each is pinned on its part.");
    expect(status.querySelector('[data-finding="1"]')!.textContent).toContain("No criterion for an empty export");
  });

  describe("tab badges", () => {
    const badge = (slot: Slot, tab: string) => slot.container.querySelector<HTMLElement>(`[data-tab-badge="${tab}"]`);

    it("counts the blocked tickets on the Board tab, and shows none without one", async () => {
      const blocked = projectView({ board: [card(), card({ key: "CSV-2", state: "blocked", blockedReason: "Needs a decision." }), card({ key: "CSV-3", state: "blocked" })] });
      const { slot } = await mountPage("csv", { project: () => blocked });
      const board = await slot.findByRole("tab", { name: "Board" });
      expect(badge(slot, "board")!.textContent).toBe("2");
      expect(badge(slot, "board")!.getAttribute("aria-hidden")).toBe("true");
      expect(badge(slot, "board")!.className).toContain("bg-destructive");
      expect(board.getAttribute("title")).toBe("2 tickets are blocked");
      expect(board.getAttribute("aria-description")).toBe("2 tickets are blocked");
      expect(badge(slot, "spec")).toBeNull();

      slot.lifecycle.unmount();
      const { slot: calm } = await mountPage("csv", { project: () => projectView() });
      expect((await calm.findByRole("tab", { name: "Board" })).getAttribute("title")).toBeNull();
      expect(calm.container.querySelector("[data-tab-badge]")).toBeNull();
    });

    it("marks the Spec tab while a draft or a pending version waits for you, but not on an archived project", async () => {
      const pending = projectView({ overview: overview({ pendingVersion: 2 }) });
      const { slot } = await mountPage("csv", { project: () => pending });
      const spec = await slot.findByRole("tab", { name: "Spec" });
      expect(badge(slot, "spec")!.textContent).toBe("1");
      expect(badge(slot, "spec")!.className).toContain("bg-warning");
      expect(spec.getAttribute("title")).toBe("Spec v2 waits for your approval");

      const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null }), spec: { ...projectView().spec, version: 3 } });
      slot.lifecycle.unmount();
      const { slot: drafted } = await mountPage("csv", { project: () => draft });
      expect((await drafted.findByRole("tab", { name: "Spec" })).getAttribute("title")).toBe("Draft v3 waits for your review");

      const archived = projectView({ overview: overview({ state: "archived", pendingVersion: 2 }) });
      drafted.lifecycle.unmount();
      const { slot: gone } = await mountPage("csv", { project: () => archived });
      await gone.findByRole("tab", { name: "Spec" });
      expect(badge(gone, "spec")).toBeNull();
    });
  });

  it("keeps the chosen tab across a change of the project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), specVersion: () => specVersionView() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(calls(slot, "project")).toHaveLength(2));
    expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("changes tab", () => {
  afterEach(() => localStorage.clear());
  const [A, B, C] = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
  const changed = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, previousPath: null, status: "modified", additions: 3, deletions: 1, binary: false, untracked: false, fingerprint: `blob-${path}`, tickets: [], ...over });
  const source = (over: Partial<ChangeSource>): ChangeSource => ({ id: "branch", kind: "branch", repo: null, key: null, title: null, state: null, base: A, head: C, against: "origin/main", at: null, attempt: 0, reviewRound: 0, files: [], truncated: false, note: null, gone: false, ...over });
  const changesView = (over: Partial<ChangesView> = {}): ChangesView => ({
    slug: "csv",
    strategy: "integration",
    base: "main",
    remoteBase: "origin/main",
    branch: "loom/csv",
    finished: false,
    repos: [{ name: null, base: "main", remoteBase: "origin/main", branch: "loom/csv", unavailable: null }],
    unavailable: null,
    sources: [
      source({ files: [changed("src/a.ts", { tickets: ["CSV-1"] }), changed("src/b.ts", { status: "added", tickets: ["CSV-1"] })] }),
      source({ id: "merge:CSV-1", kind: "merge", key: "CSV-1", title: "Order rows", state: "done", base: A, head: B, against: "loom/csv", at: NOW - 2 * HOUR, files: [changed("src/a.ts"), changed("src/b.ts", { status: "added" })] }),
      source({ id: "live:CSV-2", kind: "live", key: "CSV-2", title: "Export endpoint", state: "working", base: null, head: null, against: "loom/csv", attempt: 1, files: [changed("src/export.ts", { status: "added", untracked: true, fingerprint: "live:added:3:1" })] }),
      source({ id: "commit:CSV-3", kind: "commit", key: "CSV-3", title: "Docs", state: "queued", base: null, head: null, against: "loom/csv", files: [], note: "No changes yet." }),
    ],
    ...over,
  });
  const board = [card({ key: "CSV-1", state: "done", ready: false, hasChanges: true }), card({ key: "CSV-2", title: "Export endpoint", state: "working", ready: false, threadId: "thr_w1", hasChanges: true }), card({ key: "CSV-3", title: "Docs" })];
  const landing = () => projectView({ overview: overview({ ticketCounts: { done: 3 } }), board: board.map((entry) => ({ ...entry, state: "done" })), next: { stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label: "Land · open the pull request", confirm: "Click again to land" } } });
  const mountChanges = async (rpc: Partial<Handlers> = {}, view = projectView({ board })) => {
    const mounted = await mountPage("csv", { project: () => view, changes: () => changesView(), changePatch: ({ path }) => ({ patch: `diff --git a/${path} b/${path}\n+x\n`, truncated: false }), ...rpc });
    await mounted.slot.findByRole("tab", { name: "Board" });
    return mounted.slot;
  };
  const openTab = async (slot: Slot) => {
    fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
    return slot.findByText("compared with", { exact: false });
  };
  const fileRow = (slot: Slot, path: string) => slot.container.querySelector<HTMLElement>(`[data-file="${path}"]`)!;

  it("lists the branch, each merge and the unmerged tickets, and reads nothing until it opens", async () => {
    const slot = await mountChanges();
    expect(calls(slot, "changes")).toEqual([]);
    await openTab(slot);
    expect(calls(slot, "changes")).toEqual([{ method: "changes", input: { slug: "csv" } }]);
    expect([...slot.container.querySelectorAll("[data-source]")].map((node) => node.getAttribute("data-source"))).toEqual(["branch", "merge:CSV-1", "live:CSV-2", "commit:CSV-3"]);
    expect(slot.container.querySelector<HTMLButtonElement>('[data-source="commit:CSV-3"]')!.disabled).toBe(true);
    expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("branch");
    expect(slot.container.querySelector("[data-land-panel]")!.textContent).toContain("Land pushes loom/csv at ccccccc");
    expect(slot.container.querySelector("[data-land-panel]")!.textContent).not.toContain("This is what lands.");
    expect(slot.getByText("Viewed 0 of 2", { exact: false })).toBeTruthy();
    expect(slot.container.querySelector("[data-change-repo], [data-repo-chip]")).toBeNull();
    expect([...slot.container.querySelectorAll("[data-change-sources] h3")].map((heading) => heading.textContent)).toEqual(["On the integration branch", "Not merged yet"]);
  });

  it("keeps the Viewed marks a single-repo project saved before projects had repos", async () => {
    localStorage.setItem("loom.viewed.csv", JSON.stringify(["src/b.ts\u0000blob-src/b.ts"]));
    const slot = await mountChanges();
    await openTab(slot);
    expect(fileRow(slot, "src/b.ts").hasAttribute("data-viewed")).toBe(true);
    expect(fileRow(slot, "src/a.ts").hasAttribute("data-viewed")).toBe(false);
    expect(slot.getByText("Viewed 1 of 2", { exact: false })).toBeTruthy();
  });

  it("shows a file's diff with bb's viewer between the listing's commits, in split view when asked", async () => {
    const slot = await mountChanges();
    await openTab(slot);
    fireEvent.click(slot.getByRole("button", { name: "Show src/a.ts" }));
    const diff = await slot.findByTestId("bb-diff");
    expect(diff.getAttribute("data-path")).toBe("src/a.ts");
    expect(diff.getAttribute("data-view")).toBe("unified");
    expect(calls(slot, "changePatch")).toEqual([{ method: "changePatch", input: { slug: "csv", path: "src/a.ts", base: A, head: C } }]);
    fireEvent.click(slot.getByRole("button", { name: "split" }));
    expect(slot.getByTestId("bb-diff").getAttribute("data-view")).toBe("split");
    fireEvent.click(slot.getByRole("button", { name: "Expand all" }));
    await waitFor(() => expect(slot.getAllByTestId("bb-diff")).toHaveLength(2));
  });

  it("opens a ticket's changes from a file's ticket chip and from a board card's Changes link", async () => {
    const slot = await mountChanges();
    fireEvent.click(slot.getByRole("button", { name: "Show the changes of CSV-2" }));
    expect(await slot.findByText("Live.", { exact: false })).toBeTruthy();
    expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("live:CSV-2");
    expect(slot.queryByRole("button", { name: "Show the changes of CSV-3" })).toBeNull();
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-source="branch"]')!);
    fireEvent.click(fileRow(slot, "src/a.ts").querySelector<HTMLElement>('[data-file-ticket="CSV-1"]')!);
    expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("merge:CSV-1");
    expect(slot.container.querySelector("[data-change-source]")!.textContent).toContain("What its merge bbbbbbb added to loom/csv, 2h ago");
  });

  it("reads a live worktree's patch by the ticket's key and marks a file git does not track yet", async () => {
    const slot = await mountChanges();
    fireEvent.click(slot.getByRole("button", { name: "Show the changes of CSV-2" }));
    await slot.findByText("Live.", { exact: false });
    expect(fileRow(slot, "src/export.ts").textContent).toContain("new, not committed");
    fireEvent.click(slot.getByRole("button", { name: "Open worker thread" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread" });
    fireEvent.click(slot.getByRole("button", { name: "Show src/export.ts" }));
    await slot.findByTestId("bb-diff");
    expect(calls(slot, "changePatch")).toEqual([{ method: "changePatch", input: { slug: "csv", path: "src/export.ts", key: "CSV-2" } }]);
  });

  it("reads a live worktree again every 10 seconds while it shows, and stops when another source shows", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const slot = await mountChanges();
      fireEvent.click(slot.getByRole("button", { name: "Show the changes of CSV-2" }));
      await slot.findByText("Live.", { exact: false });
      const before = calls(slot, "changes").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(calls(slot, "changes").length).toBe(before + 1);
      fireEvent.click(slot.container.querySelector<HTMLElement>('[data-source="branch"]')!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(calls(slot, "changes").length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Viewed marks across visits, folds a viewed file, and clears a mark when the file changes again", async () => {
    let view = changesView();
    const slot = await mountChanges({ changes: () => view });
    await openTab(slot);
    fireEvent.click(slot.getByRole("button", { name: "Show src/a.ts" }));
    await slot.findByTestId("bb-diff");
    fireEvent.click(within(fileRow(slot, "src/a.ts")).getByRole("button", { name: "Viewed" }));
    expect(slot.queryByTestId("bb-diff")).toBeNull();
    expect(fileRow(slot, "src/a.ts").hasAttribute("data-viewed")).toBe(true);
    expect(slot.getByText("Viewed 1 of 2", { exact: false })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("loom.viewed.csv")!)).toEqual(["src/a.ts\u0000blob-src/a.ts"]);

    view = changesView({ sources: [source({ files: [changed("src/a.ts", { fingerprint: "blob-new" }), changed("src/b.ts")] })] });
    await slot.emitRealtime("loom:changed", { slug: "csv" });
    await waitFor(() => expect(slot.getByText("Viewed 0 of 2", { exact: false })).toBeTruthy());
  });

  it("when the project is ready to land, the bar's Review changes opens the branch, the tab counts the files not viewed, and the panel lands", async () => {
    const slot = await mountChanges({ control: () => landing() }, landing());
    const badge = await waitFor(() => {
      const found = slot.container.querySelector('[data-tab-badge="changes"]');
      if (found === null) throw new Error("no badge yet");
      return found;
    });
    expect(badge.textContent).toBe("2");
    fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
    await slot.findByText("This is what lands.", { exact: false });
    fireEvent.click(within(fileRow(slot, "src/b.ts")).getByRole("button", { name: "Viewed" }));
    expect(slot.container.querySelector('[data-tab-badge="changes"]')!.textContent).toBe("1");
    const panel = slot.container.querySelector<HTMLElement>("[data-land-panel]")!;
    fireEvent.click(within(panel).getByRole("button", { name: "Land" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Click again to land" }));
    await waitFor(() => expect(calls(slot, "control")).toEqual([{ method: "control", input: { slug: "csv", action: "land", confirm: true } }]));
  });

  it("leaves out work whose commits are gone, says why nothing can be read, and shows a finished project's merges", async () => {
    const gone = changesView({ finished: true, sources: [changesView().sources[0]!, { ...changesView().sources[1]!, gone: true, files: null, note: "Its commits are no longer in the repository." }] });
    const slot = await mountChanges({ changes: () => gone }, projectView({ overview: overview({ state: "done", ticketCounts: { done: 1 } }), board, next: null }));
    fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(slot.container.querySelector("[data-change-source]")!.textContent).toContain("What loom/csv merged"));
    expect(slot.container.querySelector("[data-land-panel]")).toBeNull();
    expect([...slot.container.querySelectorAll("[data-source]")].map((node) => node.getAttribute("data-source"))).toEqual(["branch"]);
    expect(slot.container.querySelector("[data-gone]")!.textContent).toBe("1 part of this project is no longer in the repository, so it is left out.");
    slot.lifecycle.unmount();

    const none = await mountChanges({ changes: () => changesView({ sources: [], unavailable: "The bb project has no checkout on the machine host_1, so its changes cannot be read." }) });
    fireEvent.click(none.getByRole("tab", { name: "Changes" }));
    expect(await none.findByText("The bb project has no checkout on the machine host_1, so its changes cannot be read.")).toBeTruthy();
  });

  it("has no Changes tab before the project starts, nor while it is rewound", async () => {
    const ready = await mountChanges({}, projectView({ overview: overview({ state: "ready", ticketCounts: { queued: 2 } }) }));
    expect(ready.queryByRole("tab", { name: "Changes" })).toBeNull();
    ready.lifecycle.unmount();
    const rewound = await mountChanges({}, projectView({ board, at: 12 }));
    expect(rewound.queryByRole("tab", { name: "Changes" })).toBeNull();
    expect(rewound.queryByRole("button", { name: "Show the changes of CSV-1" })).toBeNull();
  });

  describe("on a multi-repo project", () => {
    // web landed before and has nothing new; api has merged work to land, onto its own base and remote.
    const web = (over: Partial<RepoOverview> = {}) => repoOverview({ toLand: false, landedAt: NOW - HOUR, ...over });
    const api = (over: Partial<RepoOverview> = {}) => repoOverview({ name: "api", bbProjectId: "proj_api", base: "trunk", ...over });
    const multiChanges = (over: Partial<ChangesView> = {}): ChangesView =>
      changesView({
        repos: [changeRepo(), changeRepo({ name: "api", base: "trunk", remoteBase: "upstream/trunk" })],
        sources: [
          source({ id: "branch:web", repo: "web", files: [changed("src/a.ts", { tickets: ["CSV-1"] })] }),
          source({ id: "branch:api", repo: "api", against: "upstream/trunk", files: [changed("src/a.ts", { tickets: ["CSV-2"] }), changed("src/api.ts", { status: "added", tickets: ["CSV-2"] })] }),
          source({ id: "merge:CSV-1", kind: "merge", repo: "web", key: "CSV-1", title: "Order rows", state: "done", base: A, head: B, against: "loom/csv", at: NOW - 2 * HOUR, files: [changed("src/a.ts")] }),
          source({ id: "merge:CSV-2", kind: "merge", repo: "api", key: "CSV-2", title: "Export endpoint", state: "done", base: B, head: C, against: "loom/csv", at: NOW - HOUR, files: [changed("src/a.ts"), changed("src/api.ts", { status: "added" })] }),
          source({ id: "commit:CSV-3", kind: "commit", repo: "web", key: "CSV-3", title: "Docs", state: "queued", base: null, head: null, against: "loom/csv", files: [], note: "No changes yet." }),
          source({ id: "live:CSV-4", kind: "live", repo: "api", key: "CSV-4", title: "Rate limits", state: "working", base: null, head: null, against: "loom/csv", attempt: 1, files: [changed("src/limits.ts", { status: "added", untracked: true, fingerprint: "live:added:3:1" })] }),
        ],
        ...over,
      });
    const multiBoard = [
      card({ key: "CSV-1", repo: "web", state: "done", ready: false, hasChanges: true }),
      card({ key: "CSV-2", title: "Export endpoint", repo: "api", state: "done", ready: false, hasChanges: true }),
      card({ key: "CSV-3", title: "Docs", repo: "web" }),
      card({ key: "CSV-4", title: "Rate limits", repo: "api", state: "working", ready: false, threadId: "thr_w4", hasChanges: true }),
    ];
    const running = (repos = [web(), api()]) => projectView({ overview: overview({ repos, ticketCounts: { done: 2, queued: 1, working: 1 } }), board: multiBoard });
    // Every ticket done: the board and the Changes view hold only the branches and the merges.
    const landingChanges = () => multiChanges({ sources: multiChanges().sources.filter((entry) => entry.kind === "branch" || entry.kind === "merge") });
    const landingView = (repos = [web(), api()]) =>
      projectView({
        overview: overview({ repos, ticketCounts: { done: 2 } }),
        board: multiBoard.slice(0, 2),
        next: { stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label: "Land · 1 repo", confirm: "Click again to land" } },
      });
    const shown = (slot: Slot) => slot.container.querySelector("[data-change-source]")?.getAttribute("data-change-source") ?? null;
    const pick = (slot: Slot, id: string) => fireEvent.click(slot.container.querySelector<HTMLElement>(`[data-source="${id}"]`)!);
    const sectionOf = (slot: Slot, name: string) => slot.container.querySelector<HTMLElement>(`[data-change-repo="${name}"]`)!;

    it("shows one section per repo, headed by its chip, with its branch and merges and then its tickets not merged, and opens the first repo with work to land", async () => {
      const slot = await mountChanges({ changes: () => multiChanges() }, running());
      await openTab(slot);
      const sections = [...slot.container.querySelectorAll<HTMLElement>("[data-change-repo]")].map((section) => [
        section.getAttribute("data-change-repo"),
        section.querySelector("h3 [data-repo-chip]")!.textContent,
        [...section.querySelectorAll("h4")].map((heading) => heading.textContent),
        [...section.querySelectorAll("[data-source]")].map((row) => row.getAttribute("data-source")),
      ]);
      expect(sections).toEqual([
        ["web", "web", ["On the integration branch", "Not merged yet"], ["branch:web", "merge:CSV-1", "commit:CSV-3"]],
        ["api", "api", ["On the integration branch", "Not merged yet"], ["branch:api", "merge:CSV-2", "live:CSV-4"]],
      ]);
      expect(sectionOf(slot, "api").querySelector('[data-source="branch:api"]')!.textContent).toBe("loom/csvvs upstream/trunk · 2 files+6 −2");

      expect(shown(slot)).toBe("branch:api");
      const intro = slot.container.querySelector<HTMLElement>("[data-change-source]")!;
      expect(intro.querySelector("h2")!.textContent).toBe("apiloom/csv compared with upstream/trunk");
      expect(intro.querySelector("h2 [data-repo-chip]")!.textContent).toBe("api");
      expect(intro.textContent).toContain("Everything merged so far: 1 ticket, 2 files");

      pick(slot, "merge:CSV-1");
      expect(shown(slot)).toBe("merge:CSV-1");
      expect(slot.container.querySelector("[data-change-source] [data-repo-chip]")!.textContent).toBe("web");
    });

    it("says in its section why a repo cannot be read, and opens a repo that can", async () => {
      const message = 'The repo "api" has no checkout on the machine host_1, so its changes cannot be read. Clone it there with bb.';
      const unread = multiChanges({
        repos: [changeRepo(), changeRepo({ name: "api", base: "trunk", remoteBase: "upstream/trunk", unavailable: message })],
        sources: multiChanges().sources.map((entry) => (entry.repo === "api" ? { ...entry, base: null, head: null, files: null, note: message } : entry)),
      });
      const slot = await mountChanges({ changes: () => unread }, running());
      await openTab(slot);
      expect(sectionOf(slot, "api").querySelector("[data-repo-unavailable]")!.textContent).toBe(message);
      expect(sectionOf(slot, "api").querySelector("[data-source]")).toBeNull();
      expect([...sectionOf(slot, "web").querySelectorAll("[data-source]")].map((row) => row.getAttribute("data-source"))).toEqual(["branch:web", "merge:CSV-1", "commit:CSV-3"]);
      expect(shown(slot)).toBe("branch:web");
    });

    it("keeps every repo's section when no source can be shown, and says why beside them", async () => {
      const apiMessage = 'The repo "api" has no checkout on the machine host_1, so its changes cannot be read. Clone it there with bb.';
      const webMessage = 'The repo "web" has no checkout on the machine host_1, so its changes cannot be read. Clone it there with bb.';
      const empty = (slot: Slot) => waitFor(() => slot.container.querySelector<HTMLElement>("[data-changes-empty]")!.textContent);
      // web's commits are gone and api has no checkout: nothing can be shown, and both repos still say what happened.
      const goneAndUnread = multiChanges({
        repos: [changeRepo(), changeRepo({ name: "api", base: "trunk", remoteBase: "upstream/trunk", unavailable: apiMessage })],
        sources: multiChanges().sources.flatMap((entry): ChangeSource[] =>
          entry.repo === "api" ? [{ ...entry, base: null, head: null, files: null, note: apiMessage }] : entry.kind === "commit" ? [] : [{ ...entry, files: null, note: "Its commits are no longer in the repository.", gone: true }],
        ),
      });
      const slot = await mountChanges({ changes: () => goneAndUnread }, running());
      fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
      expect(await empty(slot)).toBe("The changes of the repos that can be read are no longer in their repositories. A repo that cannot be read says why in its section.");
      expect([...slot.container.querySelectorAll("[data-change-repo]")].map((section) => section.getAttribute("data-change-repo"))).toEqual(["web", "api"]);
      expect(sectionOf(slot, "web").textContent).toBe("webIts changes are no longer in the repository.");
      expect(sectionOf(slot, "api").querySelector("[data-repo-unavailable]")!.textContent).toBe(apiMessage);
      expect(slot.container.querySelector("[data-source]")).toBeNull();
      expect(slot.container.querySelector("[data-gone]")!.textContent).toBe("2 parts of this project are no longer in the repository, so they are left out.");
      expect(shown(slot)).toBeNull();
      slot.lifecycle.unmount();

      const unread = multiChanges({
        repos: [changeRepo({ unavailable: webMessage }), changeRepo({ name: "api", base: "trunk", remoteBase: "upstream/trunk", unavailable: apiMessage })],
        sources: [],
        unavailable: `None of the project's repos can be read. ${webMessage} ${apiMessage}`,
      });
      const none = await mountChanges({ changes: () => unread }, running());
      fireEvent.click(none.getByRole("tab", { name: "Changes" }));
      expect(await empty(none)).toBe("None of the project's repos can be read; each repo's section says why.");
      expect(sectionOf(none, "web").querySelector("[data-repo-unavailable]")!.textContent).toBe(webMessage);
      expect(sectionOf(none, "api").querySelector("[data-repo-unavailable]")!.textContent).toBe(apiMessage);
      expect(none.container.querySelector("[data-changes-unavailable]")).toBeNull();
      none.lifecycle.unmount();

      // A single-repo project still shows only the one sentence.
      const allGone = changesView({ sources: changesView().sources.map((entry) => ({ ...entry, files: null, gone: true })) });
      const single = await mountChanges({ changes: () => allGone });
      fireEvent.click(single.getByRole("tab", { name: "Changes" }));
      expect(await single.findByText("This project's changes are no longer in the repository.")).toBeTruthy();
      expect(single.container.querySelector("[data-changes], [data-change-sources], [data-change-repo]")).toBeNull();
    });

    it("reads a file's patch in the repo of the source it is in", async () => {
      const slot = await mountChanges({ changes: () => multiChanges() }, running());
      await openTab(slot);
      fireEvent.click(slot.getByRole("button", { name: "Show src/a.ts" }));
      await slot.findByTestId("bb-diff");
      pick(slot, "branch:web");
      fireEvent.click(slot.getByRole("button", { name: "Show src/a.ts" }));
      await waitFor(() => expect(calls(slot, "changePatch")).toHaveLength(2));
      pick(slot, "live:CSV-4");
      fireEvent.click(await slot.findByRole("button", { name: "Show src/limits.ts" }));
      await waitFor(() => expect(calls(slot, "changePatch")).toHaveLength(3));
      expect(calls(slot, "changePatch").map((call) => call.input)).toEqual([
        { slug: "csv", path: "src/a.ts", base: A, head: C, repo: "api" },
        { slug: "csv", path: "src/a.ts", base: A, head: C, repo: "web" },
        { slug: "csv", path: "src/limits.ts", key: "CSV-4", repo: "api" },
      ]);
    });

    it("lands only the repo of the branch shown, onto that repo's base", async () => {
      const slot = await mountChanges({ changes: () => landingChanges(), control: () => landingView() }, landingView());
      fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
      await slot.findByText("This is what lands in api.", { exact: false });
      const panel = () => slot.container.querySelector<HTMLElement>("[data-land-panel]")!;
      expect(panel().textContent).toContain("Land api pushes loom/csv in api at ccccccc and opens one pull request into trunk, or updates the one already open. Land api to trunk merges upstream/trunk in");
      expect(panel().textContent).toContain("The other repos do not land.");
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api" }));
      fireEvent.click(within(panel()).getByRole("button", { name: "Click again to land api" }));
      await waitFor(() => expect(within(panel()).getByRole<HTMLButtonElement>("button", { name: "Land api to trunk" }).disabled).toBe(false));
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api to trunk" }));
      fireEvent.click(within(panel()).getByRole("button", { name: "Click again to land api to trunk" }));
      await waitFor(() =>
        expect(calls(slot, "control").map((call) => call.input)).toEqual([
          { slug: "csv", action: "land", repo: "api", confirm: true },
          { slug: "csv", action: "landDirect", repo: "api", confirm: true },
        ]),
      );

      pick(slot, "branch:web");
      expect(panel().textContent).toContain("Land web pushes loom/csv in web at ccccccc and opens one pull request into main");
      expect(panel().textContent).not.toContain("This is what lands in api.");
      expect(within(panel()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Land web", "Land web to main"]);
    });

    it("disarms a Land armed for one repo when another repo's branch shows, so landing that repo takes two fresh clicks", async () => {
      const slot = await mountChanges({ changes: () => landingChanges(), control: () => landingView() }, landingView());
      fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
      await slot.findByText("This is what lands in api.", { exact: false });
      const panel = () => slot.container.querySelector<HTMLElement>("[data-land-panel]")!;
      const buttons = () => within(panel()).getAllByRole("button").map((button) => button.textContent);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api to trunk" }));
      expect(buttons()).toEqual(["Land api", "Click again to land api to trunk", "Cancel"]);
      pick(slot, "branch:web");
      expect(buttons()).toEqual(["Land web", "Land web to main"]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land web to main" }));
      expect(buttons()).toEqual(["Land web", "Click again to land web to main", "Cancel"]);

      pick(slot, "branch:api");
      expect(buttons()).toEqual(["Land api", "Land api to trunk"]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api" }));
      expect(buttons()).toEqual(["Click again to land api", "Cancel", "Land api to trunk"]);
      pick(slot, "branch:web");
      expect(buttons()).toEqual(["Land web", "Land web to main"]);
      expect(calls(slot, "control")).toEqual([]);

      fireEvent.click(within(panel()).getByRole("button", { name: "Land web" }));
      expect(calls(slot, "control")).toEqual([]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Click again to land web" }));
      await waitFor(() => expect(calls(slot, "control").map((call) => call.input)).toEqual([{ slug: "csv", action: "land", repo: "web", confirm: true }]));
    });

    it("keeps a Viewed mark for each repo the same path changed in, and counts the files not viewed across every repo on the tab's badge", async () => {
      const slot = await mountChanges({ changes: () => landingChanges() }, landingView());
      const badge = () => slot.container.querySelector('[data-tab-badge="changes"]')?.textContent ?? null;
      await waitFor(() => expect(badge()).toBe("3"));
      fireEvent.click(slot.getByRole("tab", { name: "Changes" }));
      await waitFor(() => expect(shown(slot)).toBe("branch:api"));
      fireEvent.click(within(fileRow(slot, "src/a.ts")).getByRole("button", { name: "Viewed" }));
      expect(badge()).toBe("2");
      expect(JSON.parse(localStorage.getItem("loom.viewed.csv")!)).toEqual(["api\u0000src/a.ts\u0000blob-src/a.ts"]);

      pick(slot, "branch:web");
      expect(fileRow(slot, "src/a.ts").hasAttribute("data-viewed")).toBe(false);
      expect(slot.getByText("Viewed 0 of 1", { exact: false })).toBeTruthy();
      fireEvent.click(within(fileRow(slot, "src/a.ts")).getByRole("button", { name: "Viewed" }));
      expect(badge()).toBe("1");
      pick(slot, "merge:CSV-2");
      expect(fileRow(slot, "src/a.ts").hasAttribute("data-viewed")).toBe(true);
      expect(fileRow(slot, "src/api.ts").hasAttribute("data-viewed")).toBe(false);
    });

    it("opens the first repo with work to land from the bar's Review changes, else the first repo's branch, and a ticket from its board card", async () => {
      const slot = await mountChanges({ changes: () => landingChanges() }, landingView());
      fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
      await waitFor(() => expect(shown(slot)).toBe("branch:api"));
      fireEvent.click(slot.getByRole("tab", { name: "Board" }));
      fireEvent.click(slot.getByRole("button", { name: /^Show \d+ done tickets?$/u }));
      fireEvent.click(slot.getByRole("button", { name: "Show the changes of CSV-1" }));
      await waitFor(() => expect(shown(slot)).toBe("merge:CSV-1"));
      slot.lifecycle.unmount();

      const landed = await mountChanges({ changes: () => landingChanges() }, landingView([web(), api({ toLand: false, landedAt: NOW - HOUR })]));
      fireEvent.click(landed.getByRole("button", { name: "Review changes" }));
      await waitFor(() => expect(shown(landed)).toBe("branch:web"));
      landed.lifecycle.unmount();

      // Nothing has merged yet: the first repo's empty branch shows, with nothing to land.
      const fresh = multiChanges({
        sources: multiChanges().sources.flatMap((entry) => (entry.kind === "merge" ? [] : entry.kind === "branch" ? [{ ...entry, base: null, head: null, files: [], note: "Nothing merged yet." }] : [entry])),
      });
      const before = await mountChanges({ changes: () => fresh }, projectView({ overview: overview({ repos: [web({ landedAt: null }), api({ toLand: false })], ticketCounts: { queued: 1, working: 1 } }), board: multiBoard.slice(2) }));
      await openTab(before);
      expect(shown(before)).toBe("branch:web");
      expect(before.getByText("Nothing merged yet.")).toBeTruthy();
      expect(before.container.querySelector("[data-land-panel]")).toBeNull();
    });
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

  it("stacks a row per stage down the page, blocked first, with Shipping holding approved, merging and open pull requests", async () => {
    const slot = await mountBoard();
    expect([...slot.container.querySelectorAll("[data-lane]")].map((node) => node.getAttribute("data-lane"))).toEqual(["blocked", "working", "checking", "review", "approved", "queued", "done", "cancelled"]);
    expect(lane(slot, "approved").textContent).toContain("Shipping");
    expect(lane(slot, "approved").textContent).toContain("approved · merging");
    expect(lane(slot, "approved").querySelector('[data-card="CSV-8"] [data-card-state]')!.textContent).toBe("merging");
    expect(lane(slot, "working").querySelector("[data-card-state]")).toBeNull();
    expect(lane(slot, "checking").textContent).toContain("None");
    expect(slot.container.querySelector("[data-board-progress]")!.textContent).toContain("1 of 8 done");
  });

  it("folds the done and cancelled tickets to one line each", async () => {
    const slot = await mountBoard();
    expect(lane(slot, "done").textContent).not.toContain("Order rows");
    fireEvent.click(within(lane(slot, "done")).getByRole("button", { name: "Show 1 done ticket" }));
    expect(lane(slot, "done").textContent).toContain("Order rows");
    expect(lane(slot, "cancelled").textContent).not.toContain("Old idea");
    fireEvent.click(lane(slot, "cancelled").querySelector("button[aria-expanded]")!);
    expect(lane(slot, "cancelled").textContent).toContain("Old idea");
  });

  it("puts open pull requests in Shipping on the pull request strategy, and leaves out Needs you when nothing is blocked", async () => {
    const pr = await mountBoard("pr");
    expect(lane(pr, "approved").textContent).toContain("approved · merging · PR open");
    expect(lane(pr, "approved").querySelector('[data-card="CSV-9"] [data-card-state]')!.textContent).toBe("PR open");
    const { slot } = await mountPage("csv", { project: () => projectView({ board: cards.filter((entry) => entry.state !== "blocked") }) });
    await slot.findByRole("tab", { name: "Board" });
    expect(slot.container.querySelector('[data-lane="blocked"]')).toBeNull();
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

  it("grows down the page instead of sideways", async () => {
    const slot = await mountBoard();
    const board = slot.container.querySelector("[data-board]")!;
    expect(board.className).not.toContain("overflow-x-auto");
    expect(board.className).toContain("@container");
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
          attempt({ n: 1, claimPostId: 4, outcome: "blocked", endedAt: Date.now(), line: "Asked the planner: Which API?", pipeline: { work: "fail", checks: [], review: [], merge: [], pr: [] } }),
          attempt({ n: 2, claimPostId: 10, outcome: "in_progress", pipeline: { work: "pass", checks: ["fail", "pass"], review: ["running"], merge: [], pr: [] } }),
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
        pipeline: { work: "pass", checks: ["pass"], review: ["pass"], merge: ["pass"], pr: [] },
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

  it("scrolls the side column with the page, and pins it beside the activity only while all of it fits", async () => {
    const plain = await mountTicket();
    const plainSide = plain.container.querySelector<HTMLElement>("[data-ticket-side]")!;
    expect(plainSide.getAttribute("data-pinned")).toBe("false");
    expect(plainSide.className).not.toMatch(/overflow|max-h|sticky/u);
    plain.lifecycle.unmount();

    const height = Object.getOwnPropertyDescriptor(window, "innerHeight")!;
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    let sideHeight = 600;
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const boxes = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.hasAttribute("data-loom-scroll") ? rect(48, 1000) : rect(0, 0);
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-ticket-side") ? sideHeight : 0;
      },
    });
    const removed = vi.spyOn(window, "removeEventListener");
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
      const slot = await mountTicket();
      const side = slot.container.querySelector<HTMLElement>("[data-ticket-side]")!;
      expect(side.getAttribute("data-pinned")).toBe("true");
      expect(side.className).toContain("@4xl:sticky");
      sideHeight = 1200;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(side.getAttribute("data-pinned")).toBe("false");
      expect(side.className).not.toContain("sticky");
      slot.lifecycle.unmount();
      expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
    } finally {
      Object.defineProperty(window, "innerHeight", height);
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offset);
      boxes.mockRestore();
      removed.mockRestore();
    }
  });

  it("hides and shows the side column on a wide page, and remembers the choice for the next ticket", async () => {
    localStorage.removeItem("loom.ticket.sideOpen");
    const slot = await mountTicket();
    const toggle = () => slot.container.querySelector<HTMLElement>("[data-side-toggle]")!;
    expect(toggle().textContent).toBe("Hide details");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-grid]")!.className).toContain("@6xl:grid-cols-[minmax(0,1fr)_24rem]");
    fireEvent.click(toggle());
    expect(slot.container.querySelector("[data-ticket-side]")).toBeNull();
    expect(toggle().textContent).toBe("Show details");
    expect(slot.container.querySelector("[data-ticket-grid]")!.className).not.toContain("grid-cols");
    expect(localStorage.getItem("loom.ticket.sideOpen")).toBe("false");
    slot.lifecycle.unmount();

    const next = await mountTicket();
    expect(next.container.querySelector("[data-ticket-side]")).toBeNull();
    fireEvent.click(next.container.querySelector<HTMLElement>("[data-side-toggle]")!);
    expect(next.container.querySelector("[data-ticket-side]")).not.toBeNull();
    expect(localStorage.getItem("loom.ticket.sideOpen")).toBe("true");
    localStorage.removeItem("loom.ticket.sideOpen");
  });

  it("wraps long words in the criteria and shows backticked text as code", async () => {
    const slot = await mountTicket({ acceptance: ["WHEN a backend has `logging false` THE SYSTEM SHALL drop `networkservices.googleapis.com/WasmPluginVersion` entries"] });
    const criteria = slot.container.querySelector<HTMLElement>("[data-ticket-side] [data-ac] ol")!;
    expect(criteria.className).toContain("[overflow-wrap:anywhere]");
    expect([...criteria.querySelectorAll("code")].map((node) => node.textContent)).toEqual(["logging false", "networkservices.googleapis.com/WasmPluginVersion"]);
    expect([...criteria.querySelectorAll("[data-ears]")].map((node) => node.textContent)).toEqual(["WHEN", "THE SYSTEM SHALL"]);
    expect(criteria.textContent).not.toContain("`");
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
      activity: withItems([{ type: "post", postId: 6 }], { threadId: null, outcome: "ended", endedAt: NOW - HOUR + 300, line: "The worker could not start.", pipeline: { work: "fail", checks: [], review: [], merge: [], pr: [] } }),
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

  describe("on the pull request strategy", () => {
    const URL = "https://github.com/acme/shop/pull/76810";
    const pr = (over: Partial<NonNullable<TicketDetail["pr"]>> = {}): NonNullable<TicketDetail["pr"]> => ({
      url: URL,
      draft: true,
      forge: "gh",
      branch: "loom/csv-2",
      pushedSha: "6f28bec71d2",
      commits: 1,
      rounds: 0,
      counted: 0,
      maxRounds: 5,
      follows: true,
      checks: { passed: 18, failed: 0, pending: 2, at: Date.now() - 2 * 60_000 },
      nextCheckAt: Date.now() + 3 * 60_000,
      writing: null,
      ...over,
    });
    const header = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-ticket-header]")!;
    const stageNames = (slot: Slot) => [...slot.container.querySelectorAll("[data-stage]")].map((node) => node.textContent);

    it("names the stage Pull request and says the worker is writing it, with how long it has left", async () => {
      const now = Date.now();
      const slot = await mountTicket({ state: "approved", reviewRound: 2, pr: pr({ pushedSha: null, commits: null, checks: null, nextCheckAt: null, writing: { since: now - 4 * 60_000, fix: false, until: now + 26 * 60_000 } }) });
      expect(stageNames(slot)).toContain("Pull request");
      expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toBe("Approved in round 2. The worker is writing the pull request's title, description and commit message (4m); Loom uses its own template if they are not in within 30m.");
      expect(header(slot).querySelector("[data-fact='pr-writing']")!.textContent).toBe("Writing the pull request · 4m");
      expect(slot.container.querySelector("[data-live-row]")!.textContent).toContain("The worker is writing the pull request · for 4m");
    });

    it("shows an open pull request's commits, checks and fix rounds, and that a reply starts a fix round", async () => {
      const slot = await mountTicket({ state: "pr_open", prUrl: URL, replyTo: "worker", pr: pr() });
      const summary = slot.container.querySelector("[data-ticket-summary]")!.textContent!;
      expect(summary).toContain("The pull request is open as 1 commit.");
      expect(summary).toContain("its checks: 18 passed and 2 running");
      expect(summary).toContain("It's done when you merge it.");
      expect(header(slot).querySelector("[data-fact='pr-number']")!.textContent).toBe("#76810");
      expect(header(slot).querySelector("[data-fact='pr-commits']")!.textContent).toBe("1 commit · 6f28bec");
      expect(header(slot).querySelector("[data-fact='pr-checks']")!.textContent).toContain("18 ✓");
      expect(header(slot).querySelector("[data-fact='pr-rounds']")!.textContent).toBe("Fix rounds 0 of 5");
      expect(slot.container.querySelector("[data-live-row]")!.textContent).toContain("Loom is following the pull request: checks 18 passed and 2 running · next check in 3m");
      expect(slot.container.querySelector("[data-reply-hint]")!.textContent).toBe("This starts a fix round: the worker gets it now, and Loom pushes the fix to the pull request as one more commit.");
    });

    it("shows the worker's pull request text and a fix round's feedback as cards, with what Loom left out", async () => {
      const now = Date.now();
      const text = { type: "pr_text" as const, postId: 20, at: now - HOUR, by: "worker" as const, fix: false, round: 0, title: "Keep hipaa-lab out of the log sinks", body: "## Why\nThe POC.", commit: "Exclude hipaa-lab\n\nFrom both sinks.", reason: null };
      const feedback = {
        type: "pr_feedback" as const,
        postId: 21,
        at: now - 6 * 60_000,
        round: 1,
        overLimit: false,
        counted: 1,
        human: false,
        url: URL,
        checks: [{ name: "tf/plan", url: "https://ci/1" }],
        items: [{ kind: "thread" as const, author: "binks-code-reviewer", body: "The regex is unanchored.", url: null, state: null, path: "gclb_logging.tf", line: 42 }],
        ignored: { bots: 2, own: 1 },
      };
      const extra = [
        { id: 20, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "merge" as const, body: "The worker wrote the pull request: Keep hipaa-lab out of the log sinks", at: now - HOUR },
        { id: 21, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "merge" as const, body: "Pull request feedback for fix round 1 of 5", at: now - 6 * 60_000 },
      ];
      const slot = await mountTicket({ state: "working", prUrl: URL, posts: [...posts, ...extra], pr: pr({ rounds: 1 }), activity: withItems([text, feedback], { pipeline: { work: "pass", checks: ["pass"], review: ["pass"], merge: [], pr: ["pass", "fail"] } }) });
      const card = slot.container.querySelector<HTMLElement>("[data-pr-text]")!;
      expect(card.textContent).toContain("The worker wrote the pull request");
      expect(card.querySelector("[data-pr-title]")!.textContent).toBe("Keep hipaa-lab out of the log sinks");
      expect(card.querySelector("[data-pr-commit]")!.textContent).toBe("Exclude hipaa-lab\n\nFrom both sinks.");
      const round = slot.container.querySelector<HTMLElement>("[data-pr-feedback='1']")!;
      expect(round.textContent).toContain("fix round 1 · 1 of 5");
      expect(round.querySelector("[data-feedback-check]")!.textContent).toContain("tf/plan");
      expect(round.querySelector("[data-feedback-item='thread']")!.textContent).toContain("gclb_logging.tf:42");
      expect(round.textContent).toContain("Not counted: 2 bot comments and 1 item from your own account");
      fireEvent.click(within(round).getByRole("button", { name: "Open the details of tf/plan" }));
      expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "openUrl" });
      expect(slot.container.querySelector("[data-pipeline]")!.textContent).toContain("PR ✓✗");
      expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toContain("Fix round 1: the worker is fixing the pull request's feedback");
    });

    it("says in a blocked ticket's callout that the pull request stays open and a requeue keeps it", async () => {
      const slot = await mountTicket({ state: "blocked", prUrl: URL, blockedReason: "the pull request's checks and reviews needed more than 5 fix rounds", pr: pr({ rounds: 5 }) });
      expect(slot.container.querySelector("[data-blocked-pr]")!.textContent).toContain("A requeue starts a new worker on the same pull request");
    });
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
    expect(part(slot, "pace")!.textContent).toContain("6 left: about 12d of running at this pace");
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
    const view = projectView({ health: health({ budget: null, deadline: null, pace: { perHour: 0, remaining: 6, etaMs: null } }) });
    const { slot } = await mountPage("csv", { project: () => view });
    await slot.findByRole("tab", { name: "Board" });
    expect(part(slot, "progress")).not.toBeNull();
    expect(part(slot, "budget")).toBeNull();
    expect(part(slot, "deadline")).toBeNull();
    expect(part(slot, "pace")!.textContent).toContain("6 left; none done in the last 14 days");
    expect(slot.container.textContent).not.toContain("NaN");
  });

  it("shows a fast pace per hour and the running time left in minutes", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ health: health({ pace: { perHour: 3.85, remaining: 3, etaMs: 46.8 * 60_000 } }) }) });
    await slot.findByRole("tab", { name: "Board" });
    expect(part(slot, "pace")!.textContent).toContain("3.9/hour");
    expect(part(slot, "pace")!.textContent).toContain("3 left: about 47m of running at this pace");
  });

  it("says when the project did not run in the window to pace by", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ health: health({ pace: { perHour: null, remaining: 2, etaMs: null } }) }) });
    await slot.findByRole("tab", { name: "Board" });
    expect(part(slot, "pace")!.textContent).toContain("none yet");
    expect(part(slot, "pace")!.textContent).toContain("2 left; not run in the last 14 days");
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
  const strip = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-timeline-strip]")!;
  const open = async (slot: Slot) => {
    fireEvent.click(await slot.findByRole("button", { name: "Timeline" }));
    await waitFor(() => expect(slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  };
  const rewound = async (slot: Slot) => waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).not.toBeNull());
  const rewind = async (slot: Slot) => {
    await open(slot);
    fireEvent.click(slot.getByRole("button", { name: "Previous moment" }));
    await rewound(slot);
  };
  // With no ResizeObserver the plot is 720 pixels wide over the fixture's 20 minutes, so a moment 15 minutes ago sits at 180.
  const track = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-timeline-track]")!;

  it("starts collapsed as a dashed frame with a Play button and says it is live", async () => {
    const { slot } = await mountPage("csv", { project });
    const toggle = await slot.findByRole("button", { name: "Timeline" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(strip(slot).className).toContain("border-dashed");
    expect(track(slot)).not.toBeNull();
    expect(slot.container.querySelector("[data-timeline-open]")).toBeNull();
    expect(slot.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(slot.container.querySelector("[data-timeline-status]")!.textContent).toContain("Live");
    expect(calls(slot, "timeline")[0]!.input).toEqual({ slug: "csv" });
  });

  it("opens on the newest moment, and stays open across a remount", async () => {
    const first = await mountPage("csv", { project });
    await open(first.slot);
    expect(first.slot.getByRole("button", { name: "Timeline" }).getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("loom.timeline.open")).toBe("true");
    expect(first.slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("now");
    expect(first.slot.container.querySelector("[data-timeline-moment]")!.textContent).toContain("CSV-1 moved from working to review: the checks passed, round 1.+1 more");
    expect(first.slot.getByRole("button", { name: "Next moment" }).getAttribute("aria-disabled")).toBe("true");
    first.slot.lifecycle.unmount();
    const again = await mountPage("csv", { project });
    await waitFor(() => expect(again.slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  });

  it("rewinds the page to the previous moment, with no controls, and either Back to now returns it", async () => {
    const { slot } = await mountPage("csv", { project });
    await slot.findByRole("button", { name: "Pause" });
    await rewind(slot);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
    expect([...slot.container.querySelectorAll("[data-state-badge]")].map((badge) => badge.textContent)).toContain("rewound");
    expect(slot.container.querySelector("[data-rewind-bar]")!.textContent).toContain("nothing here can change it");
    expect(slot.container.querySelector("[data-next-step]")).toBeNull();
    expect(slot.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(slot.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(strip(slot).hasAttribute("data-rewound")).toBe(true);
    expect(slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("2 of 3");
    // The caption is the line that gave the moment its kind, not the first one.
    expect(slot.container.querySelector("[data-timeline-moment]")!.textContent).toContain("You ran start.+2 more");
    expect(slot.container.querySelector("[data-timeline-playhead]")).not.toBeNull();

    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-rewind-bar]")!).getByRole("button", { name: "Back to now" }));
    await slot.findByRole("button", { name: "Pause" });
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
    expect(slot.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull();
    expect(strip(slot).hasAttribute("data-rewound")).toBe(false);

    fireEvent.click(slot.getByRole("button", { name: "Previous moment" }));
    await rewound(slot);
    fireEvent.click(within(strip(slot)).getByRole("button", { name: "Back to now" }));
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
  });

  it("steps with the arrow keys, and Escape returns to now", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    fireEvent.keyDown(strip(slot), { key: "ArrowLeft" });
    await rewound(slot);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
    fireEvent.keyDown(strip(slot), { key: "ArrowLeft" });
    await waitFor(() => expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 }));
    const previous = slot.getByRole("button", { name: "Previous moment" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    // At the first moment Previous keeps its focus and does nothing.
    previous.focus();
    fireEvent.click(previous);
    expect(document.activeElement).toBe(previous);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 });
    fireEvent.keyDown(strip(slot), { key: "Escape" });
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
  });

  it("shows what happened at a moment on hover, before anything rewinds, and a click rewinds to it", async () => {
    const { slot } = await mountPage("csv", { project });
    await slot.findByRole("button", { name: "Timeline" });
    fireEvent.mouseMove(track(slot), { clientX: 182, clientY: 10 });
    const tip = await slot.findByRole("tooltip");
    expect(tip.textContent).toContain("You ran start.");
    expect(tip.textContent).toContain("The project moved from ready to running.");
    expect(tip.textContent).toContain("Click to see the project at");
    expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull();

    fireEvent.pointerDown(track(slot), { clientX: 4, clientY: 10 });
    fireEvent.pointerUp(window);
    await rewound(slot);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 });
    fireEvent.mouseLeave(track(slot));
    expect(slot.queryByRole("tooltip")).toBeNull();
  });

  it("draws a row per ticket, keeps only the tickets in trouble, and a row per ticket's agent sessions", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    const rows = () => [...slot.container.querySelectorAll("[data-timeline-lanes] [data-timeline-row]")].map((row) => row.getAttribute("data-timeline-row"));
    const note = () => slot.container.querySelector("[data-timeline-note]")!.textContent;
    expect(rows()).toEqual(["CSV-1", "CSV-2"]);
    expect(note()).toBe("2 tickets");
    const trouble = slot.getByRole("switch", { name: /Only trouble/ });
    expect(trouble.textContent).toContain("Only trouble · 1");
    fireEvent.click(trouble);
    expect(trouble.getAttribute("aria-checked")).toBe("true");
    expect(rows()).toEqual(["CSV-2"]);
    expect(note()).toBe("1 ticket");
    fireEvent.click(trouble);
    fireEvent.click(slot.getByRole("button", { name: "Agents" }));
    expect(rows()).toEqual(["CSV-1"]);
    expect(slot.container.querySelectorAll('[data-timeline-session="worker"]')).toHaveLength(1);
    expect(slot.getByRole("img", { name: "Agent sessions over time" })).toBeTruthy();
  });

  it("tells a ticket's story on its row and opens the ticket from its name", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    const lanes = slot.container.querySelector<HTMLElement>("[data-timeline-lanes-plot]")!;
    fireEvent.mouseMove(lanes, { clientX: 400, clientY: 2 * 20 + 5 });
    const tip = await slot.findByRole("tooltip");
    expect(tip.textContent).toContain("CSV-2 · Export endpoint");
    expect(tip.textContent).toContain("CSV-2 moved from queued to working: attempt 1.");
    expect(tip.textContent).toContain("working 10m");
    expect(tip.textContent).toContain("working for 10m");
    fireEvent.mouseMove(lanes, { clientX: 400, clientY: 20 + 5 });
    // CSV-1 worked 5 minutes and has been in review for the 10 since, not for its whole 15.
    await waitFor(() => expect(slot.getByRole("tooltip").textContent).toContain("in review for 10m"));
    fireEvent.click(slot.getByRole("button", { name: "Open CSV-2" }));
    expect(slot.inspection.navigateCalls).toContainEqual(pushed("csv/CSV-2"));
  });

  it("counts in Only trouble just the tickets that have a row", async () => {
    const { slot } = await mountPage("csv", { project, timeline: () => timeline({ trouble: ["CSV-2", "CSV-3"], ticketCount: 3 }) });
    await open(slot);
    expect(slot.getByRole("switch", { name: /Only trouble/ }).textContent).toContain("Only trouble · 1");
    expect(slot.container.querySelector("[data-timeline-note]")!.textContent).toBe("2 tickets · 1 not started");
  });

  it("says when a stretch was quiet instead of pointing at a moment inside its fold", async () => {
    const quiet = () =>
      timeline({
        start: NOW - 60 * 60_000,
        events: [
          [11, NOW - 60 * 60_000],
          [12, NOW - 15 * 60_000],
          [13, NOW - 10 * 60_000],
        ],
        project: [{ from: NOW - 60 * 60_000, to: NOW, state: "running" }],
        moments: timeline().moments.map((moment, index) => (index === 0 ? { ...moment, at: NOW - 60 * 60_000 } : moment)),
      });
    const { slot } = await mountPage("csv", { project, timeline: quiet });
    await slot.findByRole("button", { name: "Timeline" });
    // The 45 quiet minutes fold to the first 16 pixels.
    fireEvent.mouseMove(track(slot), { clientX: 8, clientY: 10 });
    expect((await slot.findByRole("tooltip")).textContent).toContain("Quiet for 45m");
    fireEvent.pointerDown(track(slot), { clientX: 8, clientY: 10, button: 0 });
    expect(calls(slot, "project").every((call) => (call.input as { at?: number }).at === undefined)).toBe(true);
  });

  it("puts now one step past the newest moment when something happened after it, and on it when that was in the same millisecond", async () => {
    const later = await mountPage("csv", { project, timeline: () => timeline({ events: [...timeline().events, [14, NOW - 5 * 60_000]] }) });
    await open(later.slot);
    fireEvent.click(later.slot.getByRole("button", { name: "Previous moment" }));
    await rewound(later.slot);
    expect(calls(later.slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 13 });
    expect(later.slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("3 of 3");
    fireEvent.click(later.slot.getByRole("button", { name: "Next moment" }));
    await waitFor(() => expect(calls(later.slot, "project").at(-1)!.input).toEqual({ slug: "csv" }));
    later.slot.lifecycle.unmount();

    const same = await mountPage("csv", { project, timeline: () => timeline({ events: [[11, NOW - 20 * 60_000], [12, NOW - 15 * 60_000], [14, NOW - 10 * 60_000]] }) });
    // The first mount left the Timeline open.
    fireEvent.click(await same.slot.findByRole("button", { name: "Previous moment" }));
    await rewound(same.slot);
    expect(calls(same.slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
  });

  it("plays the project back a moment at a time and returns to now at the end", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(slot.getByRole("button", { name: "Play" }));
      await act(async () => {
        vi.advanceTimersByTime(130);
      });
      expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 });
      expect(slot.getByRole("button", { name: "Pause" })).toBeTruthy();
      // One tick per act, so each moment the playhead passes renders and asks for its page.
      for (let tick = 0; tick < 25; tick += 1)
        await act(async () => {
          vi.advanceTimersByTime(120);
        });
      expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
      expect(calls(slot, "project").some((call) => (call.input as { at?: number }).at === 12)).toBe(true);
      expect(slot.getByRole("button", { name: "Play" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrubs on a mouse drag, and tells each row's story only up to the moment shown", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    const summary = (key: string) => slot.getByRole("button", { name: `Open ${key}` }).getAttribute("aria-describedby")!;
    const text = (key: string) => slot.container.querySelector(`[id="${summary(key)}"]`)!.textContent;
    expect(text("CSV-2")).toBe("10m");
    fireEvent.pointerDown(track(slot), { clientX: 4, clientY: 10, button: 0, buttons: 1, pointerId: 7 });
    await waitFor(() => expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 }));
    fireEvent.pointerMove(track(slot), { clientX: 182, clientY: 10, buttons: 1, pointerId: 7 });
    await waitFor(() => expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 }));
    fireEvent.pointerUp(track(slot), { clientX: 182, clientY: 10, pointerId: 7 });
    // At 15 minutes ago CSV-2 had not started, and CSV-1 had worked for none of its 15 minutes yet.
    await waitFor(() => expect(text("CSV-2")).toBe("not started"));
    expect(text("CSV-1")).toBe("0s");
  });

  it("keeps focus in the Timeline when Escape removes its Back to now, and says nothing when the page opens", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    expect(slot.container.querySelector("[data-timeline-announce]")!.textContent).toBe("");
    fireEvent.click(slot.getByRole("button", { name: "Previous moment" }));
    await rewound(slot);
    expect(slot.container.querySelector("[data-timeline-announce]")!.textContent).toBe(`${new Date(NOW - 15 * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}: You ran start.`);
    const back = within(strip(slot)).getByRole("button", { name: "Back to now" });
    back.focus();
    fireEvent.keyDown(back, { key: "Escape" });
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
    expect(document.activeElement).toBe(strip(slot));
    expect(slot.container.querySelector("[data-timeline-announce]")!.textContent).toBe("Back at the live page");
  });

  it("leaves the speed menu's own keys, modified arrows and a right click alone", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    const before = calls(slot, "project").length;
    fireEvent.keyDown(slot.getByRole("combobox", { name: "Playback speed" }), { key: "ArrowLeft" });
    fireEvent.keyDown(strip(slot), { key: "ArrowLeft", metaKey: true });
    fireEvent.pointerDown(track(slot), { clientX: 4, clientY: 10, button: 2 });
    fireEvent.pointerDown(track(slot), { clientX: 4, clientY: 10, button: 0, ctrlKey: true });
    expect(calls(slot, "project")).toHaveLength(before);
    expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull();
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

  it("hides the Planner tab and the tab badges while rewound, and shows the spec in force with no notes", async () => {
    const pending = (input: { slug: string; at?: number }) => ({ ...project(input), overview: overview({ pendingVersion: 2 }) });
    const { slot } = await mountPage("csv", { project: pending, specVersion: () => specVersionView({ version: 1, status: "approved", changes: null }) });
    expect(await slot.findByRole("tab", { name: "Planner" })).toBeTruthy();
    expect(slot.container.querySelector('[data-tab-badge="spec"]')).not.toBeNull();
    await rewind(slot);
    expect(slot.queryByRole("tab", { name: "Planner" })).toBeNull();
    expect(slot.container.querySelector("[data-tab-badge]")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", version: 1 });
    expect(slot.container.querySelector("[data-spec-rewound]")!.textContent).toBe("At this moment, version 1 was the spec in force.");
    expect(slot.container.querySelector("[data-review-panel]")).toBeNull();
    expect(slot.container.querySelector("[data-comment-target][tabindex]")).toBeNull();
    expect(slot.queryAllByRole("button", { name: /^Comment/ })).toEqual([]);
    expect(slot.container.querySelector("[data-spec-pending]")).toBeNull();
  });
});

describe("spec page", () => {
  const scroll = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    scroll.mockClear();
    Element.prototype.scrollIntoView = scroll;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  const draft = (over: Partial<ProjectView> = {}) => {
    const view = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: null, ...over });
    return { ...view, spec: { ...view.spec, version: 2 } };
  };
  const openPage = async (rpc: Partial<Handlers> = {}, view: ProjectView = draft()) => {
    const { slot } = await mountPage("csv", { project: () => view, specVersion: () => specVersionView(), ...rpc });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    return slot;
  };
  const page = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-spec-page]")!;
  const section = (slot: Slot, name: string) => page(slot).querySelector<HTMLElement>(`[data-spec-section="${name}"]`)!;
  const target = (slot: Slot, path: string) => page(slot).querySelector<HTMLElement>(`[data-comment-target="${path}"]`);
  const panel = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-review-panel]")!;
  const box = (slot: Slot) => slot.getByRole("dialog");
  const tray = () => JSON.parse(localStorage.getItem("loom.notes.csv") ?? "[]");
  const cards = (slot: Slot) => [...section(slot, "settings").querySelectorAll("[data-settings-card]")].map((card) => card.getAttribute("data-settings-card"));
  const rows = (slot: Slot) => [...section(slot, "tickets").querySelectorAll("[data-ticket-row]")].map((row) => row.getAttribute("data-ticket-row"));
  const entire = (slot: Slot) => fireEvent.click(within(within(page(slot)).getByRole("group", { name: "What to show" })).getByRole("button", { name: "The entire spec" }));
  const layout = (slot: Slot, name: string) => fireEvent.click(within(within(page(slot)).getByRole("group", { name: "Ticket layout" })).getByRole("button", { name }));

  it("opens a revised draft on only what changed since the version before, and shows the entire spec at a click", async () => {
    const slot = await openPage();
    const filter = within(page(slot)).getByRole("group", { name: "What to show" });
    expect(within(filter).getByRole("button", { name: /^Only what changed since v1/ }).getAttribute("aria-pressed")).toBe("true");
    expect([...page(slot).querySelectorAll("[data-change]")].map((row) => [row.getAttribute("data-change"), row.querySelector("button")!.textContent])).toEqual([
      ["checks.commands", "Ticket checks1 command rewritten"],
      ["ticket[csv-export].acceptance", "csv-export › criteria1 criterion rewritten"],
    ]);
    expect(page(slot).querySelector("[data-spec-sections]")!.textContent).toContain("How it runs· 1 changed");
    expect(cards(slot)).toEqual(["checks"]);
    expect(section(slot, "settings").querySelector("[data-hidden-line]")!.textContent).toContain("5 groups of settings did not change.");
    const checks = section(slot, "settings").querySelector<HTMLElement>('[data-settings-card="checks"]')!;
    expect(checks.querySelector("[data-removed]")!.textContent).toBe("npm test -- --ci");
    expect(within(checks).getByText("new").closest("[data-comment-target]")!.getAttribute("data-comment-target")).toBe("checks.commands[0]");
    expect(rows(slot)).toEqual(["csv-export"]);
    expect(section(slot, "tickets").querySelector("[data-hidden-line]")!.textContent).toContain("1 ticket did not change.");
    expect(section(slot, "guardrails").querySelector("[data-hidden-line]")!.textContent).toContain("Nothing here changed.");

    fireEvent.click(within(page(slot).querySelector<HTMLElement>("[data-spec-sections]")!).getByRole("button", { name: "View the entire spec" }));
    expect(cards(slot)).toEqual(["merge", "workers", "reviewers", "checks", "scope", "limits"]);
    expect(rows(slot)).toEqual(["csv-model", "csv-export"]);
    expect(page(slot).querySelector("[data-hidden-line]")).toBeNull();
    expect(page(slot).querySelector('[data-settings-card="checks"]')!.hasAttribute("data-changed")).toBe(true);
    expect(page(slot).querySelector('[data-settings-card="merge"]')!.hasAttribute("data-changed")).toBe(false);
    expect(section(slot, "guardrails").querySelector('[data-guardrail="goal"]')!.textContent).toContain("Let people export their orders as a CSV file from the admin page.");
  });

  it("sizes the settings cards by their own column, so a narrow card stacks its rows and a long model name breaks at its slash", async () => {
    const slot = await openPage({
      specVersion: () =>
        specVersionView({ version: 1, compared: null, changes: null, versions: [{ version: 1, status: "draft" }] }, (doc) => {
          doc.agents = { worker: { provider: "pi", model: "anthropic/claude-sonnet-5-5" }, reviewer: { provider: "pi", model: "openai/gpt-5.5" } };
        }),
    });
    // The page is one container and the review panel sits beside these cards, so the page's width says nothing about theirs.
    const grid = section(slot, "settings").querySelector<HTMLElement>("[data-settings-grid]")!;
    expect(grid.parentElement!.className).toContain("@container");
    expect(grid.className).not.toContain("@3xl:grid-cols-3");
    const workers = grid.querySelector<HTMLElement>('[data-settings-card="workers"]')!;
    expect(workers.className).toContain("@container");
    expect(workers.querySelector("dl")!.className.split(" ")).toContain("grid-cols-1");
    const model = within(workers).getByText((_, element) => element?.getAttribute("data-model") === "anthropic/claude-sonnet-5-5");
    expect(model.innerHTML).toBe("anthropic/<wbr>claude-sonnet-5-5");
    expect(workers.querySelector('[aria-label="2 of up to 8"]')!.className).toContain("flex-wrap");
  });

  it("shows the entire spec of a first version, with no filter and no list of changes", async () => {
    const slot = await openPage({ specVersion: () => specVersionView({ version: 1, compared: null, changes: null, versions: [{ version: 1, status: "draft" }] }) });
    expect(page(slot).textContent).toContain("v1 is the first version, so the entire spec is shown.");
    expect(within(page(slot)).queryByRole("group", { name: "What to show" })).toBeNull();
    expect(page(slot).querySelector("[data-what-changed]")).toBeNull();
    expect(cards(slot)).toHaveLength(6);
  });

  it("suggests another option of a choice, and sends the comment with its suggestion as TOML", async () => {
    const sendNotes = vi.fn(() => specVersionView());
    const slot = await openPage({ sendNotes });
    entire(slot);
    fireEvent.click(target(slot, "merge.strategy")!.querySelector('[data-option="pr"]')!);
    expect(within(box(slot)).getByRole("button", { name: "Pull request per ticket" }).getAttribute("aria-pressed")).toBe("true");
    expect(box(slot).textContent).toContain("Integration branch · now");
    fireEvent.change(within(box(slot)).getByRole("textbox", { name: "Comment" }), { target: { value: "Review each part as its own pull request." } });
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Add comment" }));
    const note = { version: 2, paths: ["merge.strategy"], body: "Review each part as its own pull request.", label: "Merge strategy", section: "settings", suggest: { from: '"integration"', to: '"pr"' } };
    expect(tray()).toEqual([note]);
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(target(slot, "merge.strategy")!.hasAttribute("data-noted")).toBe(true);
    expect(target(slot, "merge.strategy")!.querySelector("[data-pin]")!.textContent).toBe("1");
    expect(panel(slot).querySelector('[data-draft-comment="merge.strategy"] [data-suggestion]')!.textContent).toBe('"integration"→"pr"');

    fireEvent.click(within(panel(slot)).getByRole("button", { name: "Preview the message" }));
    const sent = { version: 2, paths: ["merge.strategy"], body: note.body, suggest: note.suggest };
    expect(panel(slot).querySelector("[data-notes-preview]")!.textContent).toBe(notesMessage({ slug: "csv", version: 2, status: "draft", notes: [sent] }));
    fireEvent.click(within(panel(slot)).getByRole("button", { name: "Send 1 comment · ask for v3" }));
    await waitFor(() => expect(sendNotes).toHaveBeenCalledWith({ slug: "csv", notes: [sent], confirm: true }));
    await waitFor(() => expect(tray()).toEqual([]));
  });

  it("suggests a number with no text, adds a note on the whole spec, and edits and deletes a comment", async () => {
    const sendNotes = vi.fn(() => specVersionView());
    const slot = await openPage({ sendNotes });
    entire(slot);
    fireEvent.click(target(slot, "agents.max_workers")!);
    expect(within(box(slot)).getByRole("button", { name: "Add comment" })).toHaveProperty("disabled", true);
    fireEvent.click(within(box(slot)).getByRole("button", { name: "More" }));
    expect(within(box(slot)).getByRole("status", { hidden: true }).textContent).toBe("3");
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Add comment" }));
    expect(tray()).toEqual([{ version: 2, paths: ["agents.max_workers"], body: "", label: "Workers at the same time", section: "settings", suggest: { from: "2", to: "3" } }]);

    fireEvent.change(within(panel(slot)).getByRole("textbox", { name: "A note on the whole spec" }), { target: { value: "Keep it small." } });
    expect(tray()[1]).toEqual({ version: 2, paths: ["spec"], body: "Keep it small.", label: "The whole spec", section: "guardrails" });
    expect(within(panel(slot)).getByRole("button", { name: "Send 2 comments · ask for v3" })).toBeTruthy();

    fireEvent.click(within(panel(slot)).getByRole("button", { name: "Edit the comment on Workers at the same time" }));
    expect(box(slot).textContent).toContain("Edit the comment on");
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Delete" }));
    expect(tray()).toEqual([{ version: 2, paths: ["spec"], body: "Keep it small.", label: "The whole spec", section: "guardrails" }]);
    fireEvent.click(within(panel(slot)).getByRole("button", { name: "Send 1 comment · ask for v3" }));
    await waitFor(() => expect(sendNotes).toHaveBeenCalledWith({ slug: "csv", notes: [{ version: 2, paths: ["spec"], body: "Keep it small." }], confirm: true }));
  });

  it("pins the findings of Loom's spec review on their parts, goes to one from the list, and tags the changes that answer earlier findings", async () => {
    const round = (version: number, n: number, path: string, title: string) => ({ version, round: n, state: "changes_requested" as const, summary: `Round ${n}.`, findings: [{ path, title, detail: "Say exactly what it is." }], reason: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR });
    const spec = specVersionView({ reviews: [round(1, 1, "checks.commands[0]", "Run the tests the CI way"), round(2, 2, "ticket[csv-export].acceptance[1]", "Say what the empty file holds")] });
    const slot = await openPage({ specVersion: () => spec });
    const status = page(slot).querySelector<HTMLElement>('[data-spec-review-status="changes_requested"]')!;
    expect(status.textContent).toContain("Loom's spec review found 1 problem in v2 · round 2 of 3.");
    expect(status.querySelector('[data-finding="1"]')!.textContent).toContain("Say what the empty file holds");
    expect(status.textContent).not.toContain("Run the tests the CI way");
    const criterion = target(slot, "ticket[csv-export].acceptance[1]")!;
    expect(criterion.querySelector('[data-finding-pin="1"]')!.getAttribute("title")).toBe("Loom's spec review: Say what the empty file holds");
    expect(criterion.hasAttribute("data-found")).toBe(true);
    expect(page(slot).querySelector('[data-change="checks.commands"]')!.textContent).toContain("answers Loom's review");
    expect(page(slot).querySelector('[data-change="ticket[csv-export].acceptance"]')!.textContent).not.toContain("answers Loom's review");
    scroll.mockClear();
    fireEvent.click(within(status).getByRole("button", { name: "Go to it" }));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it("keeps a passed review of a version after approval, with the reviewer's summary", async () => {
    const spec = specVersionView({ status: "approved", reviews: [{ version: 2, round: 1, state: "approved", summary: "Every ticket serves the request.", findings: [], reason: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR }] });
    const slot = await openPage({ specVersion: () => spec }, projectView({ spec: { ...projectView().spec, version: 2 } }));
    const status = page(slot).querySelector<HTMLElement>('[data-spec-review-status="approved"]')!;
    expect(status.textContent).toContain("✓ Loom's spec review passed v2 · round 1 of 3");
    expect(status.textContent).toContain("Every ticket serves the request.");
    expect(page(slot).querySelector("[data-finding-pin]")).toBeNull();
  });

  it("shows a changed ticket's changed parts beside the list, the whole ticket at a click, and takes a comment on a criterion", async () => {
    const slot = await openPage();
    const detail = () => section(slot, "tickets").querySelector<HTMLElement>("[data-ticket-detail]")!;
    expect(detail().getAttribute("data-ticket-detail")).toBe("csv-export");
    expect(detail().querySelector("[data-removed]")!.textContent).toBe("WHEN there are no orders THE SYSTEM SHALL return an empty file");
    expect(target(slot, "ticket[csv-export].acceptance[1]")!.textContent).toContain("WHEN there are no orders THE SYSTEM SHALL return a header row");
    expect(target(slot, "ticket[csv-export].acceptance[0]")).toBeNull();
    expect(detail().textContent).toContain("… 1 unchanged");
    expect(detail().textContent).not.toContain("Brief for the worker");
    fireEvent.click(within(detail()).getByRole("button", { name: "Show the whole ticket" }));
    expect(detail().textContent).toContain("Brief for the worker");
    expect(target(slot, "ticket[csv-export].acceptance[0]")).not.toBeNull();

    fireEvent.click(target(slot, "ticket[csv-export].acceptance[1]")!);
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Not testable" }));
    expect((within(box(slot)).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Not testable. ");
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Add comment" }));
    expect(tray()).toEqual([{ version: 2, paths: ["ticket[csv-export].acceptance[1]"], body: "Not testable.", label: "csv-export › criterion 2", section: "tickets" }]);
    expect(section(slot, "tickets").querySelector('[data-ticket-row="csv-export"]')!.textContent).toContain("1");
  });

  it("maps the tickets by wave, marks the changed one, and opens a picked ticket whole", async () => {
    const slot = await openPage();
    layout(slot, "Map");
    const nodes = () => [...page(slot).querySelectorAll("[data-map-node]")].map((node) => [node.getAttribute("data-map-node"), node.getAttribute("data-mark")]);
    expect(nodes()).toEqual([
      ["csv-model", "same"],
      ["csv-export", "changed"],
    ]);
    expect(page(slot).querySelectorAll("[data-edge]")).toHaveLength(1);
    fireEvent.click(page(slot).querySelector('[data-map-node="csv-model"]')!);
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.getAttribute("data-ticket-detail")).toBe("csv-model");
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.textContent).toContain("Brief for the worker");
    layout(slot, "Files");
    expect(section(slot, "tickets").querySelector('[data-file="src/model/**"]')).not.toBeNull();
  });

  it("lists a new ticket and a removed one, and shows what the removed one had", async () => {
    const replaced = specVersionView({ compared: { version: 1, status: "superseded", spec: parseSpec(specToml()).spec! } }, (doc) => (doc.ticket[1] = { ...doc.ticket[1], ref: "csv-stream", title: "Stream the export" }));
    const slot = await openPage({ specVersion: () => replaced });
    expect([...page(slot).querySelectorAll("[data-change]")].map((row) => [row.getAttribute("data-change"), row.querySelector("button")!.textContent])).toEqual([
      ["ticket[csv-stream]", "csv-streamnew ticket · takes over files from csv-export"],
      ["ticket[csv-export]", "csv-exportremoved · its files go to csv-stream"],
    ]);
    expect(rows(slot)).toEqual(["csv-stream", "removed:csv-export"]);
    fireEvent.click(section(slot, "tickets").querySelector('[data-ticket-row="removed:csv-export"]')!);
    const removed = section(slot, "tickets").querySelector<HTMLElement>('[data-removed-ticket="csv-export"]')!;
    expect(removed.textContent).toContain("REMOVED IN v2");
    expect(removed.textContent).toContain("Export endpoint");
    expect(removed.querySelector("[data-comment-target][tabindex]")).toBeNull();
    fireEvent.click(within(removed).getByRole("button", { name: "csv-stream" }));
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.textContent).toContain("NEW IN v2");
  });

  it("goes to a change from the list or with j, counts it seen in this browser, and keeps the sections marked reviewed", async () => {
    const slot = await openPage();
    const change = (path: string) => page(slot).querySelector<HTMLElement>(`[data-change="${path}"]`)!;
    fireEvent.click(change("checks.commands").querySelector("button")!);
    expect(change("checks.commands").hasAttribute("data-seen")).toBe(true);
    expect(scroll).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("loom.review.csv")!)).toEqual({ "v2<v1": { seen: ["list:checks.commands"], reviewed: [] } });
    expect(page(slot).querySelector("[data-what-changed]")!.textContent).toContain("1 of 2 seen");
    fireEvent.keyDown(document.body, { key: "j" });
    expect(page(slot).querySelector("[data-spec-sections]")!.textContent).toContain("Change 2 of 2");
    expect(change("ticket[csv-export].acceptance").hasAttribute("data-seen")).toBe(true);
    fireEvent.click(within(section(slot, "settings")).getByRole("button", { name: "Mark reviewed" }));
    expect(JSON.parse(localStorage.getItem("loom.review.csv")!)["v2<v1"].reviewed).toEqual(["settings"]);
    expect(within(section(slot, "settings")).getByRole("button", { name: "✓ Reviewed" })).toBeTruthy();
  });

  it("says when the planner is drafting the next version, and which changes answer the comments sent before", async () => {
    const waiting = specVersionView({ notes: [{ version: 2, paths: ["merge.strategy"], body: "Use pull requests.", sentAt: NOW, answeredIn: null, changed: false }] });
    const slot = await openPage({ specVersion: () => waiting });
    expect(page(slot).querySelector("[data-spec-waiting]")!.textContent).toBe("You sent 1 comment on v2. The planner is drafting v3; this page shows what changed when it arrives.");
    expect(panel(slot).querySelector("[data-sent-note]")!.textContent).toContain("Waiting for the planner's next version");
    slot.lifecycle.unmount();

    const answered = specVersionView({ notes: [{ version: 1, paths: ["checks.commands[0]"], body: "Run the plain tests.", sentAt: NOW, answeredIn: 2, changed: true }] });
    const again = await openPage({ specVersion: () => answered });
    const why = (path: string) => page(again).querySelector<HTMLElement>(`[data-change="${path}"]`)!.textContent;
    expect(why("checks.commands")).toContain("answers your comment");
    expect(why("ticket[csv-export].acceptance")).toContain("not from your comments");
    expect(panel(again).querySelector("[data-sent-note]")!.textContent).toContain("✓ v2 changed this");
  });

  it("reads another version from the switcher, and compares the newest with an older version", async () => {
    const versions = [
      { version: 1, status: "superseded" as const },
      { version: 2, status: "superseded" as const },
      { version: 3, status: "draft" as const },
    ];
    const specVersion = ({ version, base }: { slug: string; version?: number; base?: number }) =>
      version === 1 ? specVersionView({ version: 1, status: "superseded", compared: null, versions }) : specVersionView({ version: 3, versions, compared: { version: base ?? 2, status: "superseded", spec: specV1() } });
    const slot = await openPage({ specVersion }, draft({ spec: { ...projectView().spec, version: 3 } }));
    fireEvent.change(within(page(slot)).getByRole("combobox", { name: "Compare with" }), { target: { value: "1" } });
    await waitFor(() => expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", base: 1 }));
    await waitFor(() => expect(page(slot).textContent).toContain("Only what changed since v1"));
    fireEvent.click(within(within(page(slot)).getByRole("group", { name: "Spec versions" })).getByRole("button", { name: "v1 superseded" }));
    await waitFor(() => expect(page(slot).textContent).toContain("You are reading v1 (superseded)."));
    expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv", version: 1 });
    fireEvent.click(within(page(slot)).getByRole("button", { name: "Back to v3" }));
    await waitFor(() => expect(calls(slot, "specVersion").at(-1)!.input).toEqual({ slug: "csv" }));
  });

  it("keeps an unchanged criterion that carries a comment in view while only what changed is shown", async () => {
    localStorage.setItem("loom.notes.csv", JSON.stringify([{ version: 2, paths: ["ticket[csv-export].acceptance[0]"], body: "Name the format.", label: "csv-export › criterion 1", section: "tickets" }]));
    const slot = await openPage();
    expect(target(slot, "ticket[csv-export].acceptance[0]")!.querySelector("[data-pin]")!.textContent).toBe("1");
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.textContent).not.toContain("unchanged");
  });

  it("goes to a rewritten brief and goal from What changed, and takes a comment on them as diffs", async () => {
    const rewritten = specVersionView({ compared: { version: 1, status: "superseded", spec: parseSpec(specToml()).spec! } }, (doc) => ((doc.ticket[0].body = "Build the order row mapper."), (doc.project.goal = "Let people export their orders as a CSV file from the orders page.")));
    const slot = await openPage({ specVersion: () => rewritten });
    for (const path of ["ticket[csv-model].body", "project.goal"]) {
      scroll.mockClear();
      fireEvent.click(page(slot).querySelector(`[data-change="${path}"] button`)!);
      expect(target(slot, path)!.querySelector("[data-word-diff]")).not.toBeNull();
      expect(scroll).toHaveBeenCalled();
    }
    fireEvent.click(target(slot, "project.goal")!);
    expect(box(slot).textContent).toContain("Comment on Goal");
  });

  it("files a planning-view note that has no section under its own section", async () => {
    localStorage.setItem("loom.notes.csv", JSON.stringify([{ version: 2, paths: ["ticket[csv-export].title"], body: "Say endpoint.", label: "csv-export › title" }]));
    const slot = await openPage();
    expect(panel(slot).textContent).toContain("Tickets · 1");
    expect(panel(slot).textContent).not.toContain("How it runs · 1");
    expect(page(slot).querySelector("[data-spec-sections]")!.textContent).toContain("Tickets· 1 changed· 1 comment");
  });

  it("edits the very note pressed in the panel, on a ticket that is not picked, with its suggestion", async () => {
    localStorage.setItem(
      "loom.notes.csv",
      JSON.stringify([
        { version: 2, paths: ["ticket[csv-model].priority"], body: "First comment", label: "csv-model › priority", section: "tickets", suggest: { from: "2", to: "0" } },
        { version: 2, paths: ["ticket[csv-model].priority"], body: "Second comment", label: "csv-model › priority", section: "tickets" },
      ]),
    );
    const slot = await openPage();
    layout(slot, "Files");
    fireEvent.click(within(panel(slot)).getAllByRole("button", { name: "Edit the comment on csv-model › priority" })[1]!);
    await waitFor(() => expect(slot.getByRole("dialog")).toBeTruthy());
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.getAttribute("data-ticket-detail")).toBe("csv-model");
    expect((within(box(slot)).getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Second comment");
    fireEvent.change(within(box(slot)).getByRole("textbox", { name: "Comment" }), { target: { value: "Second, edited" } });
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Save" }));
    expect(tray().map((note: { body: string }) => note.body)).toEqual(["First comment", "Second, edited"]);

    fireEvent.click(within(panel(slot)).getAllByRole("button", { name: "Edit the comment on csv-model › priority" })[0]!);
    await waitFor(() => expect(slot.getByRole("dialog")).toBeTruthy());
    expect(within(box(slot)).getByRole("button", { name: "P0" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a stored suggestion it has no control for, and drops it", async () => {
    localStorage.setItem("loom.notes.csv", JSON.stringify([{ version: 2, paths: ["merge", "project.base"], body: "Use pull requests.", label: "Merging", section: "settings", suggest: { from: '"integration"', to: '"pr"' } }]));
    const slot = await openPage();
    fireEvent.click(within(panel(slot)).getByRole("button", { name: "Edit the comment on Merging" }));
    await waitFor(() => expect(slot.getByRole("dialog")).toBeTruthy());
    expect(box(slot).querySelector("[data-suggestion]")!.textContent).toBe('"integration"→"pr"');
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Drop the suggestion" }));
    fireEvent.click(within(box(slot)).getByRole("button", { name: "Save" }));
    expect(tray()).toEqual([{ version: 2, paths: ["merge", "project.base"], body: "Use pull requests.", label: "Merging", section: "settings" }]);
  });

  it("opens an unchanged ticket picked from a dependency, and shows no ticket when none changed", async () => {
    const slot = await openPage();
    const detail = () => section(slot, "tickets").querySelector<HTMLElement>("[data-ticket-detail]");
    fireEvent.click(within(detail()!).getByRole("button", { name: "Show the whole ticket" }));
    fireEvent.click(within(detail()!).getByRole("button", { name: "csv-model" }));
    expect(detail()!.getAttribute("data-ticket-detail")).toBe("csv-model");
    slot.lifecycle.unmount();

    const settingsOnly = specVersionView({ compared: { version: 1, status: "superseded", spec: parseSpec(specToml((doc) => (doc.agents.max_workers = 3))).spec! } });
    const quiet = await openPage({ specVersion: () => settingsOnly });
    expect(section(quiet, "tickets").querySelector("[data-ticket-detail]")).toBeNull();
    expect(section(quiet, "tickets").querySelector("[data-hidden-line]")!.textContent).toContain("No ticket changed.");
  });

  it("offers Approve in the panel only on the version it approves", async () => {
    const versions = [
      { version: 1, status: "approved" as const },
      { version: 2, status: "pending" as const },
    ];
    const specVersion = ({ version }: { slug: string; version?: number }) =>
      version === 1 ? specVersionView({ version: 1, status: "approved", compared: null, versions }) : specVersionView({ status: "pending", versions, compared: { version: 1, status: "approved", spec: specV1() } });
    const view = projectView({ spec: { ...projectView().spec, version: 1, pendingVersion: 2 }, overview: overview({ pendingVersion: 2 }) });
    const slot = await openPage({ specVersion }, view);
    expect(within(panel(slot)).getByRole("button", { name: "Approve v2" })).toBeTruthy();
    fireEvent.click(within(within(page(slot)).getByRole("group", { name: "Spec versions" })).getByRole("button", { name: "v1 approved" }));
    await waitFor(() => expect(panel(slot).textContent).toContain("Your review of v1"));
    expect(within(panel(slot)).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });

  it("gives focus back to the part when the comment box closes, and ignores j and k while it is open", async () => {
    const slot = await openPage();
    entire(slot);
    const part = target(slot, "review.max_rounds")!;
    part.focus();
    fireEvent.keyDown(part, { key: "Enter" });
    expect(box(slot)).toBeTruthy();
    fireEvent.keyDown(within(box(slot)).getByRole("button", { name: "Cancel" }), { key: "j" });
    expect(page(slot).querySelector("[data-spec-sections]")!.textContent).toContain("Change – of 2");
    fireEvent.keyDown(box(slot), { key: "Escape" });
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(part);
  });

  it("keeps comments in memory across a version switch when the browser refuses to store them", async () => {
    const refuse = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      const versions = [
        { version: 1, status: "superseded" as const },
        { version: 2, status: "draft" as const },
      ];
      const specVersion = ({ version }: { slug: string; version?: number }) => (version === 1 ? specVersionView({ version: 1, status: "superseded", compared: null, versions }) : specVersionView({ versions }));
      const slot = await openPage({ specVersion });
      fireEvent.click(target(slot, "ticket[csv-export].acceptance[1]")!);
      fireEvent.change(within(box(slot)).getByRole("textbox", { name: "Comment" }), { target: { value: "Keep me." } });
      fireEvent.click(within(box(slot)).getByRole("button", { name: "Add comment" }));
      fireEvent.click(within(within(page(slot)).getByRole("group", { name: "Spec versions" })).getByRole("button", { name: "v1 superseded" }));
      await waitFor(() => expect(panel(slot).textContent).toContain("Your review of v1"));
      expect(panel(slot).textContent).toContain("Keep me.");
    } finally {
      refuse.mockRestore();
    }
  });

  it("marks a section of a first version reviewed", async () => {
    const slot = await openPage({ specVersion: () => specVersionView({ version: 1, compared: null, changes: null, versions: [{ version: 1, status: "draft" }] }) });
    fireEvent.click(within(section(slot, "tickets")).getByRole("button", { name: "Mark reviewed" }));
    expect(within(section(slot, "tickets")).getByRole("button", { name: "✓ Reviewed" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("loom.review.csv")!)).toEqual({ v1: { seen: [], reviewed: ["tickets"] } });
  });

  it("shows each repo of a multi-repo spec with its settings, and a repo chip on its tickets", async () => {
    const slot = await openPage({ specVersion: () => specVersionView({}, withRepos) }, draft({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {}, repos: [repoOverview(), repoOverview({ name: "api", bbProjectId: "proj_api", bbProjectName: null, base: "trunk" })] }) }));
    entire(slot);
    const repo = (name: string) => section(slot, "settings").querySelector<HTMLElement>(`[data-repo="${name}"]`)!;
    expect(repo("web").querySelector("[data-repo-project]")!.textContent).toBe("bb project shop-web");
    expect(repo("web").querySelector("[data-repo-checks]")!.textContent).toContain("npm run web-test");
    expect(repo("api").textContent).toContain("base trunk");
    expect(repo("api").textContent).toContain("remote upstream");
    expect(section(slot, "tickets").querySelector('[data-ticket-row="csv-model"] [data-repo-chip]')!.textContent).toBe("web");
    expect(section(slot, "tickets").querySelector("[data-ticket-detail]")!.textContent).toContain("No command of its own; only npm run web-test runs.");
  });
});

describe("repos", () => {
  beforeEach(() => localStorage.clear());
  const repos = () => [repoOverview(), repoOverview({ name: "api", bbProjectId: "proj_api", bbProjectName: null, base: "trunk" })];
  const multi = (over: Partial<ProjectView> = {}) =>
    projectView({
      overview: overview({ repos: repos() }),
      board: [card({ key: "CSV-1", repo: "web" }), card({ key: "CSV-2", title: "Export endpoint", state: "working", repo: "api", threadId: "thr_w1" })],
      ...over,
    });
  const chipsIn = (root: ParentNode) => [...root.querySelectorAll("[data-repo-chip]")].map((chip) => chip.textContent);
  const openFiles = async (view: ProjectView, spec: SpecVersionView) => {
    const { slot } = await mountPage("csv", { project: () => view, specVersion: () => spec });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    const page = slot.container.querySelector<HTMLElement>("[data-spec-page]")!;
    fireEvent.click(within(page).getByRole("button", { name: "The entire spec" }));
    fireEvent.click(within(within(page).getByRole("group", { name: "Ticket layout" })).getByRole("button", { name: "Files" }));
    return { slot, pane: () => page.querySelector<HTMLElement>('[data-spec-section="tickets"]')! };
  };
  const landing = (label = "Land · 2 repos"): NextStep => ({ stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label, confirm: "Click again to land" } });

  it("shows each card's repo as a chip on the board and on a draft's dashed cards", async () => {
    const { slot } = await mountPage("csv", { project: () => multi() });
    await slot.findByRole("tab", { name: "Board" });
    expect(chipsIn(slot.container.querySelector('[data-card="CSV-1"]')!)).toEqual(["web"]);
    expect(chipsIn(slot.container.querySelector('[data-card="CSV-2"]')!)).toEqual(["api"]);

    const draft = multi({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {}, repos: repos() }) });
    const { slot: dashed } = await mountPage("csv", { project: () => draft });
    await dashed.findByRole("tab", { name: "Board" });
    expect(chipsIn(dashed.container.querySelector('[data-card="CSV-1"][data-draft]')!)).toEqual(["web"]);
  });

  it("shows the ticket's repo in the ticket page's header", async () => {
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => ticketDetail({ repo: "api" }) });
    await slot.findByRole("heading", { name: /Export endpoint/ });
    expect(chipsIn(slot.container.querySelector("[data-ticket-header]")!)).toEqual(["api"]);
  });

  it("groups the ticket scopes by repo in the spec page's Files view, where the same path in two repos is not shared", async () => {
    const spec = specVersionView({ overlaps: [{ a: "csv-model", b: "csv-docs", paths: ["src/shared/types.ts"] }] }, (doc) => {
      withRepos(doc);
      doc.ticket[0].scope = ["src/model/**", "src/shared/types.ts"];
      doc.ticket[1].scope = ["src/export/**", "src/shared/types.ts"];
      doc.ticket.push({ ref: "csv-docs", title: "Export docs", body: "Document the types.", acceptance: ["WHEN the docs are read THE SYSTEM SHALL name every type"], scope: ["src/shared/types.ts"], repo: "web" });
    });
    const { slot, pane } = await openFiles(multi(), spec);
    const groups = () =>
      [...pane().querySelectorAll("[data-repo-files]")].map((group) => [
        group.getAttribute("data-repo-files"),
        [...group.querySelectorAll("[data-folder]")].map((folder) => [folder.getAttribute("data-folder"), [...folder.querySelectorAll("[data-file]")].map((row) => row.getAttribute("data-file"))]),
      ]);
    expect(groups()).toEqual([
      ["web", [["src/model", ["src/model/**"]], ["src/shared", ["src/shared/types.ts"]]]],
      ["api", [["src/export", ["src/export/**"]], ["src/shared", ["src/shared/types.ts"]]]],
    ]);
    expect(pane().textContent).toContain("All files by repo and folder · 4 paths");
    const group = (name: string) => pane().querySelector<HTMLElement>(`[data-repo-files="${name}"]`)!;
    expect(group("web").querySelector("h5")!.textContent).toBe("web2 paths");
    const types = (name: string) => group(name).querySelector<HTMLElement>('[data-file="src/shared/types.ts"]')!;
    expect([...types("web").querySelectorAll("[data-ticket-chip]")].map((chip) => chip.textContent)).toEqual(["csv-model", "csv-docs"]);
    expect(types("web").textContent).toContain("shared");
    expect([...types("api").querySelectorAll("[data-ticket-chip]")].map((chip) => chip.textContent)).toEqual(["csv-export"]);
    expect(types("api").textContent).not.toContain("shared");

    const shared = [...pane().querySelectorAll("[data-shared]")].map((row) => [row.getAttribute("data-repo"), row.getAttribute("data-shared"), chipsIn(row)]);
    expect(shared).toEqual([["web", "src/shared/types.ts", ["web"]]]);
    expect(slot.getByRole("button", { name: "Add a note on shared path src/shared/types.ts in web" })).toBeTruthy();

    fireEvent.click(within(within(pane()).getByRole("group", { name: "Which files" })).getByRole("button", { name: "Shared only" }));
    expect(groups()).toEqual([["web", [["src/shared", ["src/shared/types.ts"]]]]]);
  });

  it("labels the land control for the pull requests of several repos, and names the repos to land in its confirm", async () => {
    const control = vi.fn(() => multi({ overview: overview({ state: "done", repos: repos() }), next: null }));
    const view = multi({ overview: overview({ repos: repos(), ticketCounts: { done: 2 } }), next: landing() });
    const { slot } = await mountPage("csv", { project: () => view, control });
    await slot.findByRole("heading", { name: "CSV export" });
    expect([...slot.container.querySelectorAll("[data-controls] button")].map((button) => button.textContent)).toEqual(["Pause", "Pause now", "Land to each repo's base", "⋯"]);
    const bar = () => slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(bar()).getByRole("button", { name: "Land · open the pull requests" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Click again to land web and api" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "land", confirm: true }));
  });

  it("names every repo the land pushes in its confirm, a repo landed before included, even when it lands onto each base instead", async () => {
    const control = vi.fn(() => multi({ next: null }));
    // web opened its pull request before api had merged work; a land without a repo pushes both again.
    const partly = [repoOverview({ prUrl: "https://github.com/acme/web/pull/4", landedAt: NOW - HOUR, toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", base: "trunk" })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: partly, ticketCounts: { done: 2 } }), next: null }), control });
    await slot.findByRole("heading", { name: "CSV export" });
    expect([...slot.container.querySelectorAll("[data-controls] button")].map((button) => button.textContent)).toEqual(["Pause", "Pause now", "Land · open the pull requests", "Land to each repo's base", "⋯"]);
    fireEvent.click(slot.getByRole("button", { name: "Land · open the pull requests" }));
    expect(slot.getByRole("button", { name: "Click again to land web and api" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Land to each repo's base" }));
    fireEvent.click(slot.getByRole("button", { name: "Click again to land web and api to their bases" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "landDirect", confirm: true }));

    const { slot: bar } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: partly, ticketCounts: { done: 2 } }), next: landing("Land · 1 repo") }) });
    await bar.findByRole("heading", { name: "CSV export" });
    const step = bar.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(step).getByRole("button", { name: "Land · open the pull requests" }));
    expect(within(step).getByRole("button", { name: "Click again to land web and api" })).toBeTruthy();
  });

  it("leaves out a repo with no done ticket, and keeps the bar's label when every repo is landed", async () => {
    const apiOnly = [repoOverview({ toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", base: "trunk" })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: apiOnly, ticketCounts: { done: 1 } }), next: null }) });
    await slot.findByRole("heading", { name: "CSV export" });
    fireEvent.click(slot.getByRole("button", { name: "Land · open the pull requests" }));
    expect(slot.getByRole("button", { name: "Click again to land api" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Land to each repo's base" }));
    expect(slot.getByRole("button", { name: "Click again to land api to their bases" })).toBeTruthy();

    const landed = repos().map((repo) => ({ ...repo, landedAt: NOW - HOUR, toLand: false }));
    const { slot: done } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: landed, ticketCounts: { done: 2 } }), next: landing("Land · finish the project") }) });
    await done.findByRole("heading", { name: "CSV export" });
    const step = done.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(step).getByRole("button", { name: "Land · finish the project" }));
    expect(within(step).getByRole("button", { name: "Click again to land web and api" })).toBeTruthy();
  });

  it("names exactly the repos the engine lands: those with a done ticket, from the server's repo overviews", () => {
    const spec = parseSpec(
      specToml((doc) => {
        withRepos(doc);
        doc.repo.push({ name: "docs", project: "proj_docs" });
        doc.ticket.push({ ref: "csv-docs", title: "Export docs", body: "Document the export.", acceptance: ["WHEN the docs are read THE SYSTEM SHALL name every column"], scope: ["docs/**"], repo: "docs" });
      }),
    ).spec!;
    const row = (repo: string, state: TicketRow["state"], at: number) => ({ repo, state, state_at: at }) as TicketRow;
    const tickets = [row("web", "done", NOW - 2 * HOUR), row("api", "done", NOW - HOUR), row("docs", "queued", NOW - HOUR)];
    // web landed after its merge, api never landed, docs has nothing done.
    const lands = new Map([["web", { prUrl: "https://github.com/acme/web/pull/4", landedAt: NOW - HOUR }]]);
    const overviews = repoOverviews({ bb_project_id: "proj_1" }, spec, tickets, lands);
    expect(overviews.map((repo) => [repo.name, repo.toLand])).toEqual([
      ["web", false],
      ["api", true],
      ["docs", false],
    ]);
    // landRepos in merge.ts: every repo with a done ticket, in the spec's order.
    const withDone = new Set(tickets.filter((ticket) => ticket.state === "done").map((ticket) => ticket.repo));
    const landedByEngine = spec.repo!.map((repo) => repo.name).filter((name) => withDone.has(name));
    expect(repoLand(overviews)!.names).toEqual(landedByEngine);
    expect(repoLand(overviews)!.confirm).toBe("Click again to land web and api");
  });

  it("opens each repo's pull request from under the header", async () => {
    const landed = [repoOverview({ prUrl: "https://github.com/acme/web/pull/4", toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", prUrl: null, toLand: false })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: landed }) }) });
    await slot.findByRole("heading", { name: "CSV export" });
    expect(chipsIn(slot.container.querySelector("[data-repo-prs]")!)).toEqual(["web"]);
    fireEvent.click(slot.getByRole("button", { name: "Open the pull request in web" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://github.com/acme/web/pull/4" }]);
  });

  it("shows no repo chip and no repo section on a single-repo project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ next: landing("Land · open the pull request") }), specVersion: () => specVersionView() });
    await slot.findByRole("tab", { name: "Board" });
    expect(slot.container.querySelector("[data-repo-chip]")).toBeNull();
    expect(slot.container.querySelector("[data-repo-prs]")).toBeNull();
    const bar = slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(bar).getByRole("button", { name: "Land · open the pull request" }));
    expect(within(bar).getByRole("button", { name: "Click again to land" })).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).not.toBeNull());
    const page = slot.container.querySelector<HTMLElement>("[data-spec-page]")!;
    fireEvent.click(within(page).getByRole("button", { name: "The entire spec" }));
    for (const layout of ["List + detail", "Map", "Files"]) {
      fireEvent.click(within(within(page).getByRole("group", { name: "Ticket layout" })).getByRole("button", { name: layout }));
      expect(page.querySelector("[data-repo-chip], [data-repo], [data-repo-files], [data-repo-checks]")).toBeNull();
      expect(page.querySelector("[data-spec-section=settings]")!.textContent).not.toMatch(/\brepos?\b/i);
    }

    const { slot: ticket } = await mountPage("csv/CSV-2", { ticket: () => ticketDetail() });
    await ticket.findByRole("heading", { name: /Export endpoint/ });
    expect(ticket.container.querySelector("[data-ticket-header] [data-repo-chip]")).toBeNull();

  });
});
