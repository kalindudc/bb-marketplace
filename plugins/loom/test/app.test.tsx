// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginNavPanelProps, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import type { HomeProject, PlanningSession, ProjectSummary, ThreadInfo, rpcContract } from "../src/contract";
import { HOUR, NOW, agent, card, feedRow, health, homeProject, homeView, metrics, overview, projectView, ticketDetail } from "./fixtures";

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
  feed: unexpected,
  threadInfo: () => null,
  reply: unexpected,
  ticketAction: unexpected,
  control: unexpected,
  startPlanning: unexpected,
  planning: () => [],
  planningSession: () => null,
  ...over,
});

type Slot = ReturnType<typeof renderSlot>;
const mounts: Slot[] = [];
afterEach(() => {
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  document.body.replaceChildren();
});

describe("registration", () => {
  it("lists Loom in the left navigation with the Layers icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map(({ id, title, icon, path }) => ({ id, title, icon, path }))).toEqual([{ id: "loom", title: "Loom", icon: "Layers", path: "loom" }]);
    expect(app.threadHeaderActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "ticket", title: "Loom" }]);
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

// ---------------------------------------------------------------- the page

async function mountPage(subPath: string, rpc: Partial<Handlers> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(app.navPanels[0]!, { subPath }, { pluginId: "loom", rpc: handlers(rpc) });
  mounts.push(slot);
  const Panel = app.navPanels[0]!.component;
  const goTo = (next: string) => slot.lifecycle.rerender(<Panel subPath={next} />);
  return { slot, goTo };
}
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "loom", options: { subPath } });

describe("project list", () => {
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
  const request = (text: string, projectId = "project-test") => ({ projectId, providerId: "codex", model: "gpt-5", reasoningLevel: "medium", permissionMode: "auto", executionInputSources: {}, environment: { type: "project-default" }, input: [{ type: "text", text, mentions: [] }] });

  it("starts planning with the composer's request and the answers given up front, then opens the conversation", async () => {
    const startPlanning = vi.fn(() => ({ threadId: "thr_p7" }));
    const { slot } = await mountPage("_new", { startPlanning });
    expect(await slot.findByRole("heading", { name: "What should exist when the project is done?" })).toBeTruthy();
    expect(slot.getByRole("navigation", { name: "Loom" }).textContent).toContain("New project");
    expect(slot.container.querySelectorAll("[data-guide-step]")).toHaveLength(5);
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
    expect(calls(slot, "project")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Open as thread" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_p1" }]);
  });

  it("fills in the draft card once the planner proposes, approves it after a second click, and opens the project", async () => {
    let current = session();
    const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [] });
    const control = vi.fn(() => projectView({ overview: overview({ state: "ready" }) }));
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
    expect(card().querySelector("[data-draft-warnings]")!.textContent).toContain("overlapping scope");
    expect(slot.queryByText(/No draft yet/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Confirm approve" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", confirm: true }));
    expect(await slot.findByRole("button", { name: "Start" })).toBeTruthy();
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

  it("shows the controls that fit the project's state", async () => {
    const none = { ticketCounts: { queued: 2 } };
    expect(await labels(withState("draft", { approvedVersion: null, ...none }))).toEqual(["Approve", "Archive"]);
    expect(await labels(withState("ready", none))).toEqual(["Start", "Archive"]);
    expect(await labels(withState("running", none))).toEqual(["Pause", "Pause now", "Archive"]);
    expect(await labels(withState("paused", none))).toEqual(["Resume", "Archive"]);
    expect(await labels(withState("done", none))).toEqual(["Archive"]);
    expect(await labels(withState("archived", none))).toEqual([]);
  });

  it("offers Land on an integration project with a done ticket, and Approve for a pending spec version", async () => {
    expect(await labels(withState("running", { ticketCounts: { done: 1 } }))).toEqual(["Pause", "Pause now", "Land", "Archive"]);
    expect(await labels(withState("running", { strategy: "pr", ticketCounts: { done: 1 } }))).toEqual(["Pause", "Pause now", "Archive"]);
    expect(await labels(withState("paused", { pendingVersion: 2, ticketCounts: {} }))).toEqual(["Approve v2", "Resume", "Archive"]);
  });

  it("says to land under the header once every ticket of an integration project is finished", async () => {
    const line = "Every ticket is finished. Land the integration branch to open its pull request.";
    const shown = async (view: ReturnType<typeof projectView>) => {
      const { slot } = await mountPage("csv", { project: () => view });
      await slot.findByRole("heading", { name: "CSV export" });
      const found = slot.queryByText(line) !== null;
      slot.lifecycle.unmount();
      return found;
    };
    expect(await shown(withState("running", { ticketCounts: { done: 3, cancelled: 1 } }))).toBe(true);
    expect(await shown(withState("paused", { ticketCounts: { done: 1 } }))).toBe(true);
    expect(await shown(withState("running", { ticketCounts: { done: 1, queued: 1 } }))).toBe(false);
    expect(await shown(withState("running", { strategy: "pr", ticketCounts: { done: 2 } }))).toBe(false);
    expect(await shown(withState("done", { ticketCounts: { done: 2 } }))).toBe(false);
    expect(await labels(withState("running", { ticketCounts: { done: 3 } }))).toContain("Land");
  });

  it("asks twice before it acts, then calls control with confirm: true and shows the refreshed project", async () => {
    const control = vi.fn(() => projectView({ overview: overview({ state: "running" }) }));
    const { slot } = await mountPage("csv", { project: () => withState("ready"), control });
    fireEvent.click(await slot.findByRole("button", { name: "Start" }));
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Confirm start" }));
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
      expect(slot.getByRole("button", { name: "Confirm start" })).toBeTruthy();
      act(() => void vi.advanceTimersByTime(4900));
      expect(slot.getByRole("button", { name: "Confirm start" })).toBeTruthy();
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
    fireEvent.click(slot.getByRole("button", { name: "Confirm pause now" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "pauseNow", confirm: true }));
    fireEvent.click(await slot.findByRole("button", { name: "Approve v2" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm approve v2" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("shows a refusal under the header", async () => {
    const control = () => {
      throw new Error("Project csv is ready; pause needs a running project.");
    };
    const { slot } = await mountPage("csv", { project: () => withState("ready"), control });
    fireEvent.click(await slot.findByRole("button", { name: "Start" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm start" }));
    expect((await slot.findByRole("alert")).textContent).toContain("pause needs a running project");
  });

  it("shows why the plugin paused the project", async () => {
    const { slot } = await mountPage("csv", { project: () => withState("paused", { reason: "The deadline 2026-01-01 has passed." }) });
    expect((await slot.findByText(/The deadline 2026-01-01 has passed/)).textContent).toContain("Paused");
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
  it("shows the spec and its version, and approves a pending version after a second click", async () => {
    const control = vi.fn(() => projectView());
    const view = projectView({ spec: { ...projectView().spec, toml: '[project]\nslug = "csv"\n', version: 1, pendingVersion: 2, pendingToml: '[project]\nslug = "csv"\nname = "Orders CSV"\n' }, overview: overview({ pendingVersion: 2 }) });
    const { slot } = await mountPage("csv", { project: () => view, control });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    expect(slot.getByText("Spec v1")).toBeTruthy();
    expect(slot.container.querySelector("[data-spec-current]")!.textContent).toContain('slug = "csv"');
    expect(slot.container.querySelector("[data-spec-pending]")!.textContent).toContain("Orders CSV");
    const approve = slot.container.querySelector("[data-spec-pending] button")!;
    fireEvent.click(approve);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(slot.container.querySelector("[data-spec-pending] button")!);
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("keeps the chosen tab across a change of the project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
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
});

describe("ticket", () => {
  const posts = [
    { id: 1, parentId: null, depth: 0, authorKind: "planner" as const, authorThreadId: "thr_plan", kind: "brief" as const, body: "Serve the file.\n\nAcceptance criteria:\n1. Streams a CSV", at: 1 },
    { id: 2, parentId: 1, depth: 1, authorKind: "human" as const, authorThreadId: null, kind: "reply" as const, body: "Use the v2 API", at: 2 },
    { id: 3, parentId: 2, depth: 2, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "note" as const, body: "On it.", at: 3 },
    { id: 4, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "claim" as const, body: "Worker attempt 1 is starting.", at: 4 },
    { id: 5, parentId: 3, depth: 9, authorKind: "human" as const, authorThreadId: null, kind: "reply" as const, body: "Deep", at: 5 },
  ];
  const mountTicket = async (over: Parameters<typeof ticketDetail>[0] = {}, rpc: Partial<Handlers> = {}) => {
    const view = ticketDetail({ posts, ...over });
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => view, ...rpc });
    await slot.findByRole("heading", { name: /Export endpoint/ });
    return slot;
  };
  const post = (slot: Slot, id: number) => slot.container.querySelector<HTMLElement>(`[data-post="${id}"]`)!;

  it("shows the ticket's key, title, state, attempt, branch, acceptance criteria and live thread", async () => {
    const slot = await mountTicket({ reviewRound: 2, prUrl: "https://github.com/acme/shop/pull/2" });
    const header = slot.container.querySelector("[data-ticket-header]")!;
    expect(header.textContent).toContain("CSV-2");
    expect(header.textContent).toContain("Export endpoint");
    expect(header.querySelector("[data-state-badge]")!.textContent).toBe("working");
    expect(header.textContent).toContain("attempt 1");
    expect(header.textContent).toContain("review round 2");
    expect(header.textContent).toContain("loom/csv-2");
    expect(header.textContent).toContain("after CSV-1");
    expect(slot.getByText("WHEN the endpoint is called THE SYSTEM SHALL stream a CSV")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open worker thread" }));
    fireEvent.click(slot.getByRole("button", { name: "Open the pull request" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_w1" }, { method: "openUrl", url: "https://github.com/acme/shop/pull/2" }]);
  });

  it("leaves ended threads out of the header", async () => {
    const slot = await mountTicket({ threads: [{ threadId: "thr_old", role: "worker", state: "ended", startedAt: 1, endedAt: 2, endReason: "abandoned" }] });
    expect(slot.queryByRole("button", { name: /Open worker thread/ })).toBeNull();
  });

  it("indents each reply by its depth, 16px a level and no deeper than six levels", async () => {
    const slot = await mountTicket();
    expect(post(slot, 1).style.marginLeft).toBe("0px");
    expect(post(slot, 2).style.marginLeft).toBe("16px");
    expect(post(slot, 3).style.marginLeft).toBe("32px");
    expect(post(slot, 5).style.marginLeft).toBe("96px");
    expect([...slot.container.querySelectorAll("[data-post]")].map((node) => node.getAttribute("data-post"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(post(slot, 2).textContent).toContain("human");
    expect(post(slot, 2).textContent).toContain("reply");
    expect(post(slot, 3).textContent).toContain("worker");
    expect(post(slot, 3).textContent).toContain("note");
    expect(post(slot, 1).querySelector("[data-post-body]")!.className).toContain("whitespace-pre-wrap");
    expect(post(slot, 1).querySelector("[data-post-body]")!.textContent).toContain("Acceptance criteria:\n1. Streams a CSV");
  });

  it("sends a reply to a post with its parentId and shows the refreshed thread", async () => {
    const reply = vi.fn(() => ticketDetail({ posts: [...posts, { id: 6, parentId: 3, depth: 3, authorKind: "human", authorThreadId: null, kind: "reply", body: "Thanks", at: 6 }] }));
    const slot = await mountTicket({}, { reply });
    fireEvent.click(slot.getByRole("button", { name: "Reply to #3" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Reply text for #3" }), { target: { value: "Thanks" } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply to #3" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({ key: "CSV-2", body: "Thanks", parentId: 3, confirm: true }));
    await waitFor(() => expect(post(slot, 6).style.marginLeft).toBe("48px"));
    expect(slot.queryByRole("textbox", { name: "Reply text for #3" })).toBeNull();
  });

  it("sends a new top-level reply from the box at the end, and not an empty one", async () => {
    const reply = vi.fn(() => ticketDetail({ posts }));
    const slot = await mountTicket({}, { reply });
    expect((slot.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByRole("textbox", { name: "New reply" }), { target: { value: "  Please add a test.  " } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({ key: "CSV-2", body: "Please add a test.", confirm: true }));
    await waitFor(() => expect((slot.getByRole("textbox", { name: "New reply" }) as HTMLTextAreaElement).value).toBe(""));
  });

  it("shows Requeue only for a blocked ticket, and sends the action with the note after a second click", async () => {
    const working = await mountTicket();
    expect(working.queryByRole("button", { name: "Requeue" })).toBeNull();
    expect(working.getByRole("button", { name: "Block" })).toBeTruthy();
    expect(working.getByRole("button", { name: "Cancel ticket" })).toBeTruthy();
    working.lifecycle.unmount();

    const ticketAction = vi.fn(() => ticketDetail({ state: "queued", posts }));
    const slot = await mountTicket({ state: "blocked", blockedReason: "Needs a decision." }, { ticketAction });
    expect(slot.getByText(/Needs a decision\./)).toBeTruthy();
    expect((slot.getByRole("button", { name: "Requeue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slot.getByRole("textbox", { name: "Note" }), { target: { value: "Use the v2 API" } });
    fireEvent.click(slot.getByRole("button", { name: "Requeue" }));
    expect(ticketAction).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Confirm requeue" }));
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-2", action: "requeue", note: "Use the v2 API", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-header] [data-state-badge]")!.textContent).toBe("queued"));
  });

  it("sends Block and Cancel with the note, and offers neither on a finished ticket", async () => {
    const ticketAction = vi.fn(() => ticketDetail({ posts }));
    const slot = await mountTicket({}, { ticketAction });
    const note = () => slot.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    expect((slot.getByRole("button", { name: "Block" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(note(), { target: { value: "Wrong approach" } });
    fireEvent.click(slot.getByRole("button", { name: "Block" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm block" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "block", note: "Wrong approach", confirm: true }));
    await waitFor(() => expect(note().value).toBe(""));
    fireEvent.change(note(), { target: { value: "Not needed" } });
    fireEvent.click(slot.getByRole("button", { name: "Cancel ticket" }));
    fireEvent.click(slot.getByRole("button", { name: "Confirm cancel ticket" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "cancel", note: "Not needed", confirm: true }));
    slot.lifecycle.unmount();

    for (const state of ["done", "cancelled"] as const) {
      const finished = await mountTicket({ state });
      expect(finished.queryByRole("button", { name: "Block" })).toBeNull();
      expect(finished.queryByRole("button", { name: "Cancel ticket" })).toBeNull();
      expect(finished.queryByRole("textbox", { name: "Note" })).toBeNull();
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
    expect((await slot.findByRole("alert")).textContent).toContain("another ticket");
  });

  it("lists the reviews with their findings", async () => {
    const slot = await mountTicket({ reviews: [{ id: 1, round: 1, verdict: "changes_requested", summary: "Needs a fix", findings: [{ severity: "blocking", title: "Off by one", detail: "The loop skips the last order.", file: "src/a.ts", line: 12 }], at: 1 }] });
    const reviews = slot.container.querySelector("[data-reviews]")!;
    expect(reviews.textContent).toContain("Round 1");
    expect(reviews.textContent).toContain("changes requested");
    expect(reviews.textContent).toContain("Needs a fix");
    expect(reviews.textContent).toContain("Off by one");
    expect(reviews.textContent).toContain("src/a.ts:12");
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
    const charts = [...slot.container.querySelectorAll("svg[aria-label]")];
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
