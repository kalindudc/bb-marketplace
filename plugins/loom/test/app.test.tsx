// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type PluginSdkTestFakes, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useComposers, type NewThreadRequest, type PluginComposerApi, type PluginNavPanelProps, type PluginSidebarThread, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { mergeLead } from "../src/ui/merge-order";
import type { Attempt, BoardCard, MergeConfirmView, BadgeView, BbProjectChoice, InsightsWindow, ChangedFile, ChangeSource, ChangesView, ChecksItem, HomeProject, MergeEntry, MergeOrderView, NextStep, PlannerView, PlanningSession, ProjectSummary, ProjectView, RepoOverview, RolloutStep, RolloutView, SentNote, SpecVersionView, ThreadInfo, TicketDetail, rpcContract } from "../src/contract";
import type { TicketRow } from "../src/db/store";
import { repoOverviews } from "../src/projects";
import { clockTime } from "../src/format";
import { notesMessage } from "../src/prompts";
import { parseSpec } from "../src/spec";
import { ConfirmButton, MoreMenu } from "../src/ui/common";
import { armedFits } from "../src/ui/header";
import { NewProject } from "../src/ui/new-project";
import { repoLand } from "../src/ui/next-step-bar";
import { controlDone, narrowPage, shortCrumb, sidewaysInto } from "../src/ui/page";
import { createCommands } from "../src/ui/commands";
import { exportHost } from "../src/ui/map-export-ui";
import { nextStepOf } from "../src/next-step";
import { reloadRemembered } from "../src/ui/remember";
import { keysSheet, palette, rewind } from "../src/ui/dispatch";
import { questionsOf } from "../src/ui/questions";
import { HOUR, NOW, agent, attempt, card, changeRepo, health, homeProject, homeView, metrics, need, overview, plannerViewOf, projectView, repoOverview, specV1, specVersionView, threadInfo, ticketDetail, timeline, withRepos } from "./fixtures";
import { phasesOf } from "../src/phases";
import { phased } from "./phase-fixtures";
import { specToml, type Doc } from "./helpers";
import { at, story } from "./insights-rows";
import { projectInsights } from "../src/insights";
import { changedTags } from "../src/rpc-tags";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const handlers = (over: Partial<Handlers> = {}): Handlers => ({
  projects: unexpected,
  home: unexpected,
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
  changes: unexpected,
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
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
  // The page's overlays and rewind are stores shared by its separate React trees, so they outlive a mount.
  palette.set(false);
  keysSheet.set(false);
  rewind.set(null);
  // Where the page was left is remembered on the device; each case starts as a first visit.
  localStorage.clear();
  reloadRemembered();
});

describe("registration", () => {
  it("lists Loom in the left navigation with its spool icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels.map(({ id, title, icon, path }) => ({ id, title, icon, path }))).toEqual([{ id: "loom", title: "Loom", icon: "loom/loom", path: "loom" }]);
    expect(app.navPanels[0]).toMatchObject({ experimental_sidebar: expect.any(Function), experimental_useBadge: expect.any(Function), experimental_usePageTitle: expect.any(Function) });
    // The ticket button is a header thread action now; the retired header slot is empty.
    expect(app.threadHeaderActions).toEqual([]);
    expect(app.threadActions.map(({ id, title, group }) => ({ id, title, group }))).toEqual([{ id: "ticket", title: "Loom", group: "loom" }]);
    // The pinned test harness drops fields it does not know, so read the registration bb receives.
    const registered: Array<{ placement?: string }> = [];
    const recorder = new Proxy({}, { get: (_target, slot) => (slot === "experimental_threadAction" ? (entry: { placement?: string }) => registered.push(entry) : () => undefined) });
    ((await import("../app")).default as unknown as { setup(app: unknown): void }).setup({ slots: recorder, commands: { register: () => undefined } });
    expect(registered.map((entry) => entry.placement)).toEqual(["header"]);
    expect(app.threadContextSegments.map(({ id, group }) => ({ id, group }))).toEqual([{ id: "loom", group: "2_loom" }]);
    expect(app.tabs.map(({ id, context, availability }) => ({ id, context, availability }))).toEqual([{ id: "loom", context: { kind: "thread" }, availability: "fixed" }]);
    expect(app.threadInfoRows.map(({ id, group, order }) => ({ id, group, order }))).toEqual([{ id: "loom", group: "1_thread", order: 40 }]);
    // bb draws the rail's badge now, so nothing reaches into its DOM.
    expect(app.contentScripts).toEqual([]);
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

describe("rail badge", () => {
  const mountBadge = async (badge: BadgeView, threads: Array<{ id: string; hasPendingInteraction: boolean }> = []) => {
    const app = await loadPluginApp(() => import("../app"));
    const useBadge = app.navPanels[0]!.experimental_useBadge!;
    const Probe = () => <output data-badge>{JSON.stringify(useBadge())}</output>;
    const slot = renderSlot({ component: Probe }, {}, { pluginId: "loom", rpc: handlers({ badge: () => badge }), sidebarThreads: { threads: threads as unknown as PluginSidebarThread[] } });
    mounts.push(slot);
    return slot;
  };
  const shown = (slot: Slot) => JSON.parse(slot.container.querySelector("[data-badge]")!.textContent!);

  it("draws nothing while nothing needs you", async () => {
    const slot = await mountBadge({ needsYou: 0, blocked: false, threadIds: ["thr_plan"] }, [{ id: "thr_plan", hasPendingInteraction: false }]);
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([{ method: "badge", input: null }]));
    expect(shown(slot)).toBeNull();
  });

  it("counts the Needs you items and the Loom threads bb shows waiting on you, in amber", async () => {
    const slot = await mountBadge({ needsYou: 1, blocked: false, threadIds: ["thr_plan", "thr_w1"] }, [
      { id: "thr_plan", hasPendingInteraction: true },
      { id: "thr_w1", hasPendingInteraction: false },
      { id: "thr_other", hasPendingInteraction: true },
    ]);
    await waitFor(() => expect(shown(slot)).toEqual({ count: 2, tone: "warning", label: "2 things need you" }));
  });

  it("turns red while a ticket is blocked, and reads again when a change refreshes it", async () => {
    let badge: BadgeView = { needsYou: 1, blocked: true, threadIds: [] };
    const app = await loadPluginApp(() => import("../app"));
    const useBadge = app.navPanels[0]!.experimental_useBadge!;
    const Probe = () => <output data-badge>{JSON.stringify(useBadge())}</output>;
    const slot = renderSlot({ component: Probe }, {}, { pluginId: "loom", rpc: handlers({ badge: () => badge }) });
    mounts.push(slot);
    await waitFor(() => expect(shown(slot)).toEqual({ count: 1, tone: "critical", label: "1 thing needs you" }));
    badge = { needsYou: 0, blocked: false, threadIds: [] };
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(shown(slot)).toBeNull());
  });
});

describe("title in bb's header", () => {
  const titleOf = async (subPath: string, rpc: Partial<Handlers> = {}) => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: () => null, experimental_usePageTitle: app.navPanels[0]!.experimental_usePageTitle }, { subPath }, { pluginId: "loom", rpc: handlers(rpc) });
    mounts.push(slot);
    return slot;
  };
  const home = () => homeView({ projects: [homeProject()] });

  it("keeps bb's own title on the home page and names the other pages", async () => {
    expect((await titleOf("")).inspection.experimental_pageTitle).toBeNull();
    expect((await titleOf("_guide")).inspection.experimental_pageTitle).toEqual({ title: "How Loom works" });
    expect((await titleOf("_new")).inspection.experimental_pageTitle).toEqual({ title: "New project" });
    expect((await titleOf("_plan/thr_plan")).inspection.experimental_pageTitle).toEqual({ title: "Planning" });
  });

  it("names a planning conversation by its title once it loads", async () => {
    const session: PlanningSession = { threadId: "thr_p2", title: "Search revamp", startedAt: NOW, slug: null, projectState: null };
    const slot = await titleOf("_plan/thr_p2", { planningSession: () => session });
    await waitFor(() => expect(slot.inspection.experimental_pageTitle).toEqual({ breadcrumbs: [{ label: "Planning" }, { label: "Search revamp" }] }));
  });

  it("names a project by its name, once home has it, and by its slug before", async () => {
    const slot = await titleOf("csv", { home });
    expect(slot.inspection.experimental_pageTitle).toEqual({ title: "csv" });
    await waitFor(() => expect(slot.inspection.experimental_pageTitle).toEqual({ title: "CSV export" }));
  });

  it("puts a ticket under its project, which links back to the project", async () => {
    const slot = await titleOf("csv/CSV-3", { home });
    await waitFor(() =>
      expect(slot.inspection.experimental_pageTitle).toEqual({ breadcrumbs: [{ label: "CSV export", to: "/plugins/loom/loom/csv" }, { label: "CSV-3" }] }),
    );
  });

  it("leaves the breadcrumb row to bb", async () => {
    const { slot } = await mountPage("_guide");
    expect(slot.queryByRole("navigation", { name: "Loom" })).toBeNull();
  });
});

describe("thread Info tab", () => {
  const mountRow = async (info: ThreadInfo | null) => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadInfoRows[0]!, { threadId: "thr_known", projectId: "proj_1", environment: null }, { pluginId: "loom", rpc: handlers({ threadInfo: () => info }) });
    mounts.push(slot);
    return slot;
  };

  it("shows a worker's ticket, its state and the project, and opens the ticket on the page", async () => {
    const slot = await mountRow(threadInfo({ role: "worker", slug: "csv", key: "CSV-3", state: "pr_open" }));
    const link = await slot.findByRole("button", { name: "CSV-3" });
    expect(slot.container.querySelector("[data-loom-info]")!.textContent).toBe("CSV-3pr open · Worker on csv");
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-3" } }]);
  });

  it("shows a planner's project, and a planning conversation before it has a spec", async () => {
    const planner = await mountRow(threadInfo({ role: "planner", slug: "csv", key: null, state: "running" }));
    expect((await planner.findByRole("button", { name: "csv" })).closest("[data-loom-info]")!.textContent).toBe("csvrunning · Planner");
    document.body.replaceChildren();
    const planning = await mountRow(threadInfo({ role: "planner", slug: null, key: null, state: "planning" }));
    fireEvent.click(await planning.findByRole("button", { name: "Planning conversation" }));
    expect(planning.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "_plan/thr_known" } }]);
  });

  it("shows nothing for a thread that is not a Loom thread", async () => {
    const slot = await mountRow(null);
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    expect(slot.container.textContent).toBe("");
  });
});

describe("sidebar", () => {
  const two = [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "paused" }), homeProject({ slug: "old", name: "Old work", key: "OLD", state: "done" })];
  const needs = homeView().needsYou.filter((need) => need.slug === "csv");
  const mountSidebar = async (subPath: string, rpc: Partial<Handlers> = {}, sidebarThreads: Array<{ id: string; hasPendingInteraction: boolean }> = []) => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: app.navPanels[0]!.experimental_sidebar! }, { subPath }, {
      pluginId: "loom",
      rpc: handlers({ home: () => homeView({ projects: two, needsYou: needs }), planning: () => [], ...rpc }),
      sidebarThreads: { threads: sidebarThreads as unknown as PluginSidebarThread[] },
    });
    mounts.push(slot);
    await slot.findByRole("button", { name: /CSV export/ });
    return slot;
  };
  // A project row sits beside its info button, which only touch screens and narrow windows show.
  const names = (slot: Slot) => [...slot.container.querySelectorAll("nav button:not([data-row-info])")].filter((button) => !button.className.includes("pl-7")).map((button) => button.textContent);


  it("lists home with what needs you, the live projects woven with their state, the finished ones folded, and the guide and New project", async () => {
    const slot = await mountSidebar("");
    expect(names(slot)).toEqual(["Home1", "Insights", "CSV CSV export11/4running", "DOC Docs site1/4paused", "Finished1", "How Loom works", "New project"]);
    expect(slot.getByRole("button", { name: /Home/ }).getAttribute("aria-current")).toBe("page");
    // The ticket bar says its counts in words, and the count beside it says done of all the project's tickets.
    const row = slot.getByRole("button", { name: /CSV export/ });
    expect(row.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("1 done · 1 in progress · 2 up next");
    expect([...row.querySelectorAll("[data-bar]")].map((block) => block.getAttribute("data-bar"))).toEqual(["done", "flight", "open"]);
    fireEvent.click(slot.getByRole("button", { name: /Finished/ }));
    expect(names(slot)).toContain("OLD Old work1/4done");
    fireEvent.click(slot.getByRole("button", { name: /Docs site/ }));
    fireEvent.click(slot.getByRole("button", { name: "New project" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("docs"), pushed("_new")]);
  });

  it("gives each project's bar a button of its own for touch, which opens the key and opens nothing else", async () => {
    const slot = await mountSidebar("");
    await slot.findByRole("button", { name: /CSV export/ });
    const info = slot.getByRole("button", { name: "Key to the CSV bar" });
    // Shown only where there is no hover to show a tip on: touch screens and narrow windows.
    expect(info.className).toContain("hidden");
    expect(info.className).toContain("[@media(pointer:coarse)]:inline-flex");
    expect(info.className).toContain("max-[576px]:inline-flex");
    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    const key = await within(document.body).findByRole("dialog", { name: "Key to the CSV bar" });
    expect(key.textContent).toContain("CSV export");
    expect(key.textContent).toContain("1 done");
    expect(key.textContent).toContain("2 up next");
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.keyDown(key, { key: "Escape" });
    await waitFor(() => expect(info.getAttribute("aria-expanded")).toBe("false"));
    fireEvent.click(slot.getByRole("button", { name: /CSV export/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
  });

  it("lists the open project's phases, a closed one with no success tick and its cut tickets apart, and the tickets that need you", async () => {
    const version = specVersionView({}, phased);
    const tickets = [
      { phase: "skeleton", state: "done" as const },
      { phase: "skeleton", state: "cancelled" as const },
      { phase: "polish", state: "working" as const },
    ];
    const board = tickets.map((ticket, index) => card({ key: `CSV-${index + 1}`, ...ticket }));
    const blocked = need({ kind: "blocked", slug: "csv", project: "CSV export", key: "CSV-7", text: "Needs a decision", startedAt: NOW });
    const slot = await mountSidebar("csv/CSV-7", { home: () => homeView({ projects: two, needsYou: [blocked] }), project: () => projectView({ phases: phasesOf(version.spec, tickets), board }) });
    const skeleton = await slot.findByRole("button", { name: /Skeleton/ });
    expect(skeleton.getAttribute("title")).toBe("Phase 1, Skeleton · closed · 1 done · 1 cancelled");
    expect(skeleton.textContent).toContain("1/2· 1 cut");
    expect(skeleton.querySelector('[data-phase-mark="closed"]')).not.toBeNull();
    expect(skeleton.textContent).not.toMatch(/complete|✓/i);
    expect(skeleton.querySelector(GREEN_INK)).toBeNull();
    expect(slot.getByRole("button", { name: /Polish/ }).textContent).toContain("0/1");
    expect(slot.getByRole("button", { name: /Launch/ }).textContent).toContain("planned");
    const ask = slot.getByRole("button", { name: /CSV-7/ });
    expect(ask.textContent).toBe("CSV-7 blocked");
    expect(ask.getAttribute("aria-current")).toBe("page");
    fireEvent.click(slot.getByRole("button", { name: /DOC Docs site/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("docs")]);
  });

  it("marks the open project on its Work view, and not on another view or a ticket", async () => {
    const slot = await mountSidebar("csv", { project: () => projectView() });
    expect(slot.getByRole("button", { name: /CSV export/ }).getAttribute("aria-current")).toBe("page");
    slot.lifecycle.unmount();
    const ticket = await mountSidebar("csv/CSV-3", { project: () => projectView() });
    expect(ticket.getByRole("button", { name: /CSV export/ }).getAttribute("aria-current")).toBeNull();
  });

  it("lists a planning conversation with no spec yet, and marks one whose planner asks you", async () => {
    const session: PlanningSession = { threadId: "thr_p2", title: "Search revamp", startedAt: NOW, slug: null, projectState: null };
    const slot = await mountSidebar("_plan/thr_p2", { planning: () => [session, { ...session, threadId: "thr_p3", title: "Proposed", slug: "csv" }] }, [{ id: "thr_p2", hasPendingInteraction: true }]);
    const item = await slot.findByRole("button", { name: /Search revamp/ });
    expect(item.getAttribute("aria-current")).toBe("page");
    expect(within(item).getByLabelText("The planner asks you a question")).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Proposed/ })).toBeNull();
  });

  it("adds no history entry for the page already shown", async () => {
    const slot = await mountSidebar("_home");
    fireEvent.click(slot.getByRole("button", { name: /Home/ }));
    fireEvent.click(slot.getByRole("button", { name: /Docs site/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("docs")]);
  });

  it("goes home on its own address, and keeps the Done and archived group open across visits", async () => {
    const slot = await mountSidebar("csv");
    fireEvent.click(slot.getByRole("button", { name: /Home/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_home")]);
    fireEvent.click(slot.getByRole("button", { name: /Finished/ }));
    slot.lifecycle.unmount();
    const again = await mountSidebar("csv", { project: () => projectView() });
    expect(names(again)).toContain("OLD Old work1/4done");
  });

  it("marks the route the page reopens on, and names it in the title, while the address is still bb's root", async () => {
    const page = await mountPage("docs", { project: () => projectView({ overview: overview({ slug: "docs", name: "Docs site", key: "DOC" }) }) });
    await page.slot.findByRole("heading", { name: "Docs site" });
    page.slot.lifecycle.unmount();
    const app = await loadPluginApp(() => import("../app"));
    const title = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: () => null, experimental_usePageTitle: app.navPanels[0]!.experimental_usePageTitle }, { subPath: "" }, { pluginId: "loom", rpc: handlers({ home: () => homeView({ projects: two, needsYou: needs }) }) });
    mounts.push(title);
    await waitFor(() => expect(title.inspection.experimental_pageTitle).toEqual({ title: "Docs site" }));
    const slot = await mountSidebar("");
    expect(slot.getByRole("button", { name: /Docs site/ }).getAttribute("aria-current")).toBe("page");
  });

  it("follows the projects as they change", async () => {
    let projects = [homeProject()];
    const slot = await mountSidebar("", { home: () => homeView({ projects, needsYou: [] }) });
    projects = [...projects, homeProject({ slug: "docs", name: "Docs site", key: "DOC" })];
    await slot.experimental_invalidateRpc(changedTags("docs"));
    await slot.findByRole("button", { name: /Docs site/ });
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
  // The page with its controls in bb's title bar; the title itself has tests of its own.
  const Panel = app.navPanels[0]!.component;
  const Header = app.navPanels[0]!.headerContent!;
  const Page = (props: PluginNavPanelProps) => (
    <>
      <Header {...props} />
      <Panel {...props} />
    </>
  );
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: Page }, { subPath }, { pluginId: "loom", rpc: handlers(rpc), ...options });
  mounts.push(slot);
  const goTo = (next: string) => slot.lifecycle.rerender(<Page subPath={next} />);
  return { slot, goTo };
}
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
// A closed phase never paints itself green, in bb's success ink or Loom's own.
const GREEN_INK = ".text-success, .text-\\[var\\(--loom-ok\\)\\]";
const classNamesOf = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
const titleBar = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-title-controls]")!;
const inTitleBar = async (slot: Slot) => {
  await waitFor(() => expect(titleBar(slot)).not.toBeNull());
  return within(titleBar(slot));
};
/** Opens the title bar's ⋯ menu, which Radix opens from the keyboard in jsdom. */
const openMenu = async (slot: Slot) => {
  const trigger = await slot.findByRole("button", { name: "More project controls" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  return within(await slot.findByRole("menu", { name: "More project controls" }));
};
const pick = async (slot: Slot, item: string | RegExp) => fireEvent.click((await openMenu(slot)).getByRole("menuitem", { name: item }));
const menuLabels = async (slot: Slot) => (await openMenu(slot)).queryAllByRole("menuitem").map((item) => item.querySelector("[data-menu-label]")?.textContent ?? item.textContent);
/** Opens a project view by its tab, then a part of Ship or History by its own. */
async function openView(slot: Slot | HTMLElement, view: "Work" | "Spec" | "Planner" | "Ship" | "History", part?: string | RegExp) {
  const scope = slot instanceof HTMLElement ? within(slot) : slot;
  fireEvent.click(await scope.findByRole("tab", { name: view }));
  if (part !== undefined) fireEvent.click(await scope.findByRole("tab", { name: part }));
}
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "loom", options: { subPath } });
/** Opens the open ticket's ⋯ menu in Work's pane. */
const ticketMenu = async (slot: Slot, key?: string) => {
  // Whole-page role retries can consume the ticket query's notification window under load.
  const header = await waitFor(() => {
    const header = slot.container.querySelector<HTMLElement>(key === undefined ? "[data-ticket-header]" : `[data-ticket="${key}"] [data-ticket-header]`);
    expect(header).not.toBeNull();
    return header!;
  });
  fireEvent.keyDown(within(header).getByRole("button", { name: "Ticket actions" }), { key: "Enter" });
  return within(await slot.findByRole("menu", { name: "Ticket actions" }));
};
const ticketTab = (slot: Slot, name: "Activity" | "Brief" | "Agents") => fireEvent.click(slot.getByRole("tab", { name: new RegExp(`^${name}`) }));

describe("phase presentation", () => {
  it("draws each phase's tickets on the rail, keeps a closed phase's done and cancelled apart, and groups the spec by phase", async () => {
    const version = specVersionView({ compared: null, changes: { changed: [], removed: [] } }, (d) => {
      phased(d);
      d.phase[0].report = "The CSV download passed.";
    });
    const tickets = [
      { phase: "skeleton", state: "done" as const },
      { phase: "skeleton", state: "done" as const },
      { phase: "skeleton", state: "cancelled" as const },
      { phase: "polish", state: "cancelled" as const },
      { phase: "polish", state: "cancelled" as const },
      { phase: "launch", state: "queued" as const },
    ];
    const phases = phasesOf(version.spec, tickets);
    const view = projectView({ phases, board: tickets.map((ticket, index) => card({ key: `CSV-${index + 1}`, ...ticket })) });
    const { slot } = await mountPage("csv", { project: () => view, specVersion: () => version });
    const rail = await slot.findByRole("navigation", { name: "Phases" });
    const cardOf = (ref: string) => rail.querySelector<HTMLElement>(`[data-phase="${ref}"]`)!;
    // A closed phase is closed, never complete: no success tick, and its bar and count keep the cut ticket apart.
    expect(cardOf("skeleton").getAttribute("aria-label")).toBe("Phase 1, Skeleton: closed · 2 done · 1 cancelled");
    expect(cardOf("skeleton").textContent).toContain("2/3");
    expect(cardOf("skeleton").textContent).toContain("1 cut");
    expect(cardOf("skeleton").querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("2 done · 1 cancelled");
    expect([...cardOf("skeleton").querySelectorAll("[data-bar]")].map((block) => block.getAttribute("data-bar"))).toEqual(["done", "cut"]);
    expect(cardOf("polish").getAttribute("aria-label")).toBe("Phase 2, Polish: closed · 0 done · 2 cancelled");
    expect(cardOf("polish").textContent).toContain("0/2");
    expect(cardOf("launch").getAttribute("aria-label")).toBe("Phase 3, Launch: active · 0 of 1 done");
    expect(cardOf("launch").getAttribute("aria-current")).toBe("true");
    for (const ref of ["skeleton", "polish"]) {
      expect(cardOf(ref).textContent).not.toMatch(/complete|✓/i);
      expect(cardOf(ref).querySelector(GREEN_INK)).toBeNull();
    }
    // Work lists the active phase's tickets under its name.
    expect(slot.container.querySelector("[data-ticket-list] h2")!.textContent).toBe("Phase 3Launch");
    // The active phase's title shows whole, wrapping as it needs; another is cut, with its whole name a focus away.
    const titleOf = (ref: string) => cardOf(ref).querySelector<HTMLElement>("[data-rail-title]")!;
    expect(titleOf("launch").textContent).toBe("Launch");
    expect(titleOf("launch").className).not.toMatch(/line-clamp|truncate/);
    expect(titleOf("skeleton").className).toContain("truncate");
    fireEvent.focus(cardOf("skeleton"));
    expect((await within(document.body).findByRole("tooltip")).textContent).toContain("Phase 1, Skeleton · closed · 2 done · 1 cancelled");
    fireEvent.blur(cardOf("skeleton"));
    // A tap shows the same facts and the key as a popover, and stays on the page; its button does what a click does.
    fireEvent.click(slot.getByRole("tab", { name: /^Spec/ }));
    await waitFor(() => expect(slot.getByRole("tab", { name: /^Spec/ }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.pointerDown(cardOf("skeleton"), { pointerType: "touch" });
    fireEvent.click(cardOf("skeleton"));
    const facts = await within(document.body).findByRole("dialog", { name: "Phase 1, Skeleton" });
    expect(facts.textContent).toContain("closed · 2 done · 1 cancelled");
    // The key: a swatch beside each state's count, the same blocks the bar draws.
    expect(facts.querySelectorAll("[aria-hidden].size-2")).toHaveLength(2);
    expect(slot.getByRole("tab", { name: /^Spec/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(facts, { key: "Escape" });
    await waitFor(() => expect(within(document.body).queryByRole("dialog", { name: "Phase 1, Skeleton" })).toBeNull());
    expect(slot.getByRole("tab", { name: /^Spec/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.pointerDown(cardOf("polish"), { pointerType: "touch" });
    fireEvent.click(cardOf("polish"));
    fireEvent.click(within(await within(document.body).findByRole("dialog", { name: "Phase 2, Polish" })).getByRole("button", { name: "Open Work" }));
    await waitFor(() => expect(slot.getByRole("tab", { name: /^Work/ }).getAttribute("aria-selected")).toBe("true"));
    expect(within(document.body).queryByRole("dialog", { name: "Phase 2, Polish" })).toBeNull();
    // A mouse click acts at once, as before.
    fireEvent.click(slot.getByRole("tab", { name: /^Spec/ }));
    fireEvent.pointerDown(cardOf("launch"), { pointerType: "mouse" });
    fireEvent.click(cardOf("launch"));
    await waitFor(() => expect(slot.getByRole("tab", { name: /^Work/ }).getAttribute("aria-selected")).toBe("true"));
    expect(within(document.body).queryByRole("dialog", { name: "Phase 3, Launch" })).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-list]")).not.toBeNull());
    const list = slot.container.querySelector("[data-ticket-list]")!;
    expect(list.textContent).toContain("Phase 1 · Skeleton");
    expect(list.textContent).toContain("Phase 2 · Polish");
    expect(list.textContent).toContain("Stream large files");
    expect(list.textContent).toContain("The CSV download passed.");
  });

  it("draws an unphased project by repo, and keeps a count whole however narrow its card", async () => {
    const repos = [repoOverview({ name: "web" }), repoOverview({ name: "world", bbProjectName: "shop-world" })];
    const board = [card({ key: "CSV-1", repo: "web", state: "done" }), ...Array.from({ length: 14 }, (_, index) => card({ key: `CSV-${index + 2}`, repo: "world", state: index < 3 ? "done" : "queued" }))];
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ repos }), board }) });
    const rail = await slot.findByRole("navigation", { name: "Tickets by repo" });
    expect([...rail.querySelectorAll("[data-rail-card]")].map((entry) => entry.getAttribute("aria-label"))).toEqual(["web: 1 of 1 done", "world: 3 of 14 done"]);
    expect(rail.querySelector('[data-rail-card="world"]')!.textContent).toContain("3/14");
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
    // At 200% text a truncated name could not be read in full: it wraps instead.
    const name = repoBox(slot, "docs").nextElementSibling!;
    expect(name.textContent).toBe("docs");
    expect(classNamesOf(name)).toContain("[overflow-wrap:anywhere]");
    expect(classNamesOf(name)).not.toContain("truncate");
    fireEvent.click(repoBox(slot, "docs"));
    fireEvent.click(repoBox(slot, "docs"));
    fireEvent.change(within(slot.getByRole("group", { name: "Repos" })).getByRole("searchbox"), { target: { value: "zzz" } });
    expect(repoRows(slot)).toEqual([]);
    expect(slot.getByRole("group", { name: "Repos" }).textContent).toContain('No repo matches "zzz".');
    // The note is in the picker's status region, so a screen reader hears it.
    expect(within(slot.getByRole("group", { name: "Repos" })).getByRole("status").textContent).toBe('No repo matches "zzz".');
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
    const slot = renderSlot<Parameters<typeof NewProject>[0], typeof rpcContract>({ component: NewProject }, { go: unexpected }, { pluginId: "loom", rpc: handlers({ bbProjects: () => many }) });
    mounts.push(slot);
    const group = await slot.findByRole("group", { name: "Repos" });
    await waitFor(() => expect(group.querySelectorAll("[data-repo-choice]")).toHaveLength(11));
    const boxes = many.map((choice) => within(group).getByLabelText<HTMLInputElement>(choice.name));
    for (const box of boxes.slice(0, 10)) fireEvent.click(box);
    expect(boxes[10]!.disabled).toBe(true);
    expect(boxes[0]!.disabled).toBe(false);
    fireEvent.click(boxes[0]!);
    expect(boxes[10]!.disabled).toBe(false);
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
    expect(within(slot.getByRole("group", { name: "Repos" })).getByRole("alert").textContent).toBe("Could not list bb's projects: bb is restarting");
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
    await slot.experimental_invalidateRpc(changedTags(null));
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

  it("shows the merges the planner asks the human to confirm under Needs you, with a Confirm that sends the commit shown", async () => {
    const confirm: MergeConfirmView = { prUrl: "https://github.com/acme/shop/pull/4", sha: "f".repeat(40), ready: true, waiting: null, confirmed: false, requested: { at: NOW - HOUR, note: "You asked me to get CSV-4 merged" } };
    const confirmMerge = vi.fn((_input: unknown) => ticketDetail({ key: "CSV-4" }));
    const { slot } = await mountPage("csv", { project: () => projectView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 1, mergeRequests: [{ key: "CSV-4", title: "Guide", confirm }] }), confirmMerge });
    await slot.findByRole("tab", { name: "Work" });
    fireEvent.click(slot.getByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector('[data-needs-you] [data-merge-request="CSV-4"]')).not.toBeNull());
    const request = slot.container.querySelector<HTMLElement>('[data-needs-you] [data-merge-request="CSV-4"]')!;
    expect(request.textContent).toContain("Ready to merge at ffffffffffff. The planner asks you to confirm the merge: “You asked me to get CSV-4 merged”. Loom merges it only once you confirm.");
    expect(slot.container.querySelector("[data-needs-you] h2")!.textContent).toBe("Needs you1");
    fireEvent.click(within(request).getByRole("button", { name: "Confirm merge" }));
    fireEvent.click(within(request).getByRole("button", { name: "Yes, merge ffffffffffff" }));
    await waitFor(() => expect(confirmMerge).toHaveBeenLastCalledWith({ key: "CSV-4", prUrl: confirm.prUrl, sha: confirm.sha, confirm: true }));
  });

  it("gives a project with a planner thread a Planner tab, and a project without one no such tab", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 1 }) });
    await slot.findByRole("tab", { name: "Work" });
    expect([...slot.container.querySelectorAll('[role=tablist][aria-label="Project views"] [role=tab]')].map((tab) => tab.textContent)).toEqual(["Work", "Spec", "Planner", "Ship", "History"]);
    fireEvent.click(slot.getByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    expect(calls(slot, "plannerView")[0]!.input).toEqual({ threadId: "thr_plan" });
    expect(slot.container.querySelector("[data-planning-step]")).toBeNull();
    slot.lifecycle.unmount();

    const none = await mountPage("csv", { project: () => projectView({ overview: overview({ plannerThreadId: null }) }) });
    await none.slot.findByRole("tab", { name: "Work" });
    // The five views keep their places and keys; a project with no planner thread says so on its Planner tab.
    const planner = none.slot.getByRole("tab", { name: "Planner" });
    expect(planner.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(planner);
    expect(toast.info).toHaveBeenCalledWith("This project has no planner thread");
    expect(none.slot.container.querySelector("[data-planner-page]")).toBeNull();
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
  const approveStep: NextStep = { stage: 1, tone: "normal", title: "Next: review draft v2.", text: "Loom's spec review passed it.", action: { control: "approve", version: 2, label: "Approve v2 · create 2 tickets", confirm: "Yes, approve v2" } };
  const draft = () => projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: approveStep });
  const page = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-planner-page]")!;
  const openPlanner = async (rpc: Partial<Handlers> = {}, view: ProjectView = projectView(), options: Pick<RenderSlotOptions<typeof rpcContract>, "sdk" | "sidebarThreads"> = {}) => {
    const { slot } = await mountPage("csv", { project: () => view, plannerView: () => plannerViewOf(), specVersion: () => specVersionView(), ...rpc }, options);
    fireEvent.click(await slot.findByRole("tab", { name: "Planner" }));
    await waitFor(() => expect(slot.container.querySelector("[data-planner-page]")).not.toBeNull());
    return slot;
  };
  const v2 = { version: 2, status: "draft" as const, createdAt: NOW - HOUR, tickets: 2, change: { added: [], removed: ["csv-docs"], changed: [], settings: 0, guardrails: 0 }, summary: null, summaryChanged: false, review: { state: "approved" as const, round: 1, findings: 0 } };
  const revised = () =>
    plannerViewOf({
      steps: [
        { kind: "started", at: NOW - 5 * HOUR, text: "Export orders as CSV" },
        { kind: "turn", at: NOW - 4 * HOUR, text: "I proposed v1.", actions: [{ kind: "proposed", version: 1, tickets: 3, change: null }] },
        { kind: "notes", at: NOW - 3 * HOUR, version: 1, notes: [{ version: 1, paths: ["ticket[csv-docs]"], body: "We do not need docs." }] },
        { kind: "turn", at: NOW - 2 * HOUR, text: "I took out csv-docs.", actions: [{ kind: "proposed", version: 2, tickets: 2, change: v2.change }] },
        { kind: "review", at: NOW - HOUR, version: 2, round: 1, state: "approved", summary: "Fits.", findings: [], reason: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR },
      ],
      versions: [{ version: 1, status: "superseded", createdAt: NOW - 4 * HOUR, tickets: 3, change: null, summary: null, summaryChanged: false, review: null }, v2],
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

  it("quotes the summary of a draft, and of a pending version only when it writes or changes it", async () => {
    const withSummary = () => plannerViewOf({ ...revised(), versions: [revised().versions[0]!, { ...v2, summary: "Export orders as CSV for finance.", summaryChanged: false }] });
    const slot = await openPlanner({ plannerView: withSummary }, { ...draft(), spec: { ...draft().spec, version: 2 } });
    expect(page(slot).querySelector('[data-version-card="2"] [data-version-summary]')!.textContent).toBe("Summary: Export orders as CSV for finance.");
    slot.lifecycle.unmount();

    const pending = (summaryChanged: boolean) => () =>
      plannerViewOf({ ...revised(), projectState: "running", approvedVersion: 1, pendingVersion: 2, versions: [{ ...revised().versions[0]!, status: "approved" }, { ...v2, status: "pending", summary: "Export orders as CSV for finance.", summaryChanged }] });
    const running = projectView({ overview: overview({ pendingVersion: 2 }) });
    const added = await openPlanner({ plannerView: pending(true) }, running);
    expect(page(added).querySelector('[data-version-card="2"] [data-version-summary]')!.textContent).toBe("New summary: Export orders as CSV for finance.");
    added.lifecycle.unmount();
    const same = await openPlanner({ plannerView: pending(false) }, running);
    expect(page(same).querySelector('[data-version-card="2"]')).not.toBeNull();
    expect(page(same).querySelector("[data-version-summary]")).toBeNull();
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
      versions: [{ version: 1, status: "superseded", createdAt: NOW - 4 * HOUR, tickets: 3, change: null, summary: null, summaryChanged: false, review: null }, { ...v2, status: "approved" }],
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
        versions: [
          { version: 1, status: approved ? "superseded" : "approved", createdAt: NOW - 4 * HOUR, tickets: 2, change: null, summary: null, summaryChanged: false, review: null },
          { version: 2, status: approved ? "approved" : "pending", createdAt: NOW - HOUR, tickets: 2, change: null, summary: "Export orders as CSV for finance.", summaryChanged: true, review: null },
        ],
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
    const running = projectView({ overview: overview({ pendingVersion: 2 }), board: [card({ key: "CSV-1", state: "blocked" })], askSteps: [
        { index: 0, action: "approve", text: "Approve v2.", key: null },
        { index: 1, action: "requeue", text: "Then requeue CSV-1.", key: "CSV-1" },
        { index: 2, action: "other", text: "Check the alert in Observe.", key: null },
      ] });
    const control = vi.fn(() => {
      current = asked(true);
      return running;
    });
    const ticketAction = vi.fn(() => ticketDetail());
    const dismissAsk = vi.fn(() => (current = plannerViewOf({ ask: null })));
    const slot = await openPlanner({ plannerView: () => current, control, ticketAction, dismissAsk }, running);
    expect(slot.container.querySelector('[data-tab-badge="planner"]')!.textContent).toBe("3");
    const asks = () => page(slot).querySelector<HTMLElement>("[data-planner-asks]")!;
    expect(asks().textContent).toContain("Both tickets fail the same check.");
    expect([...asks().querySelectorAll("[data-ask-step]")].map((step) => step.getAttribute("data-ask-step"))).toEqual(["approve", "requeue", "other"]);
    // The version to approve writes the summary, so the step quotes it where the human approves.
    expect(asks().querySelector('[data-ask-step="approve"] [data-version-summary]')!.textContent).toBe("New summary: Export orders as CSV for finance.");
    const requeue = () => within(asks().querySelector<HTMLElement>('[data-ask-step="requeue"]')!).getByRole("button", { name: /Requeue/ }) as HTMLButtonElement;
    expect(requeue().disabled).toBe(true);
    expect(requeue().title).toBe("Approve v2 first");
    expect(page(slot).querySelector("[data-version-card]")).toBeNull();

    fireEvent.click(within(asks()).getByRole("button", { name: "Approve v2" }));
    fireEvent.click(within(asks()).getByRole("button", { name: "Yes, approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
    // The approve refreshes the project's reads, the planner's among them.
    await waitFor(() => expect(asks().querySelector('[data-ask-step="approve"]')!.hasAttribute("data-done")).toBe(true));
    expect(toast.success).toHaveBeenCalledWith("Approved v2");
    expect(requeue().disabled).toBe(false);
    fireEvent.click(requeue());
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-1", action: "requeue", note: "Requeued as the planner asked: Then requeue CSV-1.", confirm: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("CSV-1 requeued"));

    fireEvent.click(within(asks()).getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(dismissAsk).toHaveBeenCalledWith({ slug: "csv", ask: 7, confirm: true }));
    await waitFor(() => expect(page(slot).querySelector("[data-planner-asks]")).toBeNull());
    expect(toast.success).toHaveBeenLastCalledWith("Set aside until the planner asks again");
  });

  it("holds every action the planner listed after an approval until that approval lands, and says which step it waits for", async () => {
    const asked = (approved: boolean) =>
      plannerViewOf({
        projectState: "paused",
        approvedVersion: approved ? 2 : 1,
        pendingVersion: approved ? null : 2,
        review: { kind: "approved", version: 2, round: 1, summary: "Holds." },
        ask: {
          id: 8,
          at: NOW - 60_000,
          why: "",
          open: true,
          steps: [
            { action: "approve", version: 2, text: "Approve v2.", done: approved },
            { action: "resume", text: "Resume once v2 is approved.", done: false },
            { action: "live", key: "CSV-1", text: "Then mark CSV-1 live.", done: false },
          ],
        },
      });
    let current = asked(false);
    const paused = projectView({ overview: overview({ state: "paused", pendingVersion: 2 }) });
    const slot = await openPlanner({ plannerView: () => current }, paused);
    const asks = () => page(slot).querySelector<HTMLElement>("[data-planner-asks]")!;
    const step = (action: string) => within(asks().querySelector<HTMLElement>(`[data-ask-step="${action}"]`)!);
    for (const [action, label] of [["resume", "Resume"], ["live", "Mark CSV-1 live"]] as const) {
      const button = step(action).getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe("Approve v2 first");
      expect(asks().querySelector(`[data-ask-step="${action}"] [data-ask-wait]`)!.textContent).toBe("after step 1");
    }
    // The approval lands: the planner's view says step 1 is done, and the actions after it open up.
    current = asked(true);
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect((step("resume").getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false));
    expect((step("live").getByRole("button", { name: "Mark CSV-1 live" }) as HTMLButtonElement).disabled).toBe(false);
    expect(asks().querySelector("[data-ask-wait]")).toBeNull();
  });

  it("keeps an ask's text the width of its step, with the step's buttons under the text at every width", async () => {
    const view = plannerViewOf({
      projectState: "running",
      approvedVersion: 1,
      pendingVersion: 2,
      review: { kind: "approved", version: 2, round: 1, summary: "Holds." },
      ask: { id: 3, at: NOW - 60_000, why: "", open: true, steps: [{ action: "approve", version: 2, text: "Approve spec v10: the web repo's forge gains edit and reply.", done: false }, { action: "other", text: "Watch the alert.", done: false }] },
    });
    const slot = await openPlanner({ plannerView: () => view }, projectView({ overview: overview({ pendingVersion: 2 }) }));
    const step = await waitFor(() => {
      const found = page(slot).querySelector<HTMLElement>('[data-ask-step="approve"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const classes = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
    // Beside the text, three buttons squeezed a long step to a few words a line, so they sit under it.
    expect(classes(step)).toEqual(expect.arrayContaining(["grid-cols-[1.25rem_minmax(0,1fr)]"]));
    expect(classes(step).some((name) => name.includes("_auto]"))).toBe(false);
    const actions = step.querySelector("[data-ask-actions]")!;
    expect(classes(actions)).toEqual(expect.arrayContaining(["col-start-2", "empty:hidden"]));
    expect(within(actions as HTMLElement).getAllByRole("button").map((button) => button.textContent)).toEqual(["See what changed", "Approve v2", "Mark done"]);
    // At 200% text a fixed-height button ran 81 px out of its step: each wraps inside the row and grows instead.
    for (const button of within(actions as HTMLElement).getAllByRole("button")) {
      expect(classes(button)).toEqual(expect.arrayContaining(["max-w-full"]));
      expect(classes(button).some((name) => /^h-\d/.test(name))).toBe(false);
    }
    // An other step has no button of its own, only the human's Mark done.
    expect(within(page(slot).querySelector<HTMLElement>('[data-ask-step="other"] [data-ask-actions]')!).getAllByRole("button").map((button) => button.textContent)).toEqual(["Mark done"]);
    // A story step's title breaks a long link or name rather than run off the page.
    expect(classes(page(slot).querySelector("[data-story-step] span.font-medium"))).toEqual(expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"]));
  });

  it("sums up a skipped review's settings on the version card, and lists them behind a disclosure", async () => {
    const paths = ["repo[0].forge.edit", "repo[0].forge.reply", "repo[1].forge.kind"];
    const view = plannerViewOf({
      projectState: "running",
      approvedVersion: 1,
      pendingVersion: 2,
      versions: [
        { version: 1, status: "approved", createdAt: NOW - 4 * HOUR, tickets: 2, change: null, summary: null, summaryChanged: false, review: null },
        { version: 2, status: "pending", createdAt: NOW - HOUR, tickets: 2, change: null, summary: null, summaryChanged: false, review: null },
      ],
      review: { kind: "skipped", version: 2, against: 1, paths },
    });
    const repos = [repoOverview({ name: "web" }), repoOverview({ name: "infra", bbProjectId: "proj_infra" })];
    const slot = await openPlanner({ plannerView: () => view }, projectView({ overview: overview({ pendingVersion: 2, repos }) }));
    const card = await waitFor(() => {
      const found = page(slot).querySelector<HTMLElement>('[data-version-card="2"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card.textContent).toContain("Loom skipped its spec review: against v1, it changes only 3 operational settings: the forge on 2 repos.");
    expect(card.textContent).not.toContain("repo[0].forge.edit,");
    expect([...card.querySelectorAll("[data-setting-path]")].map((item) => item.textContent)).toEqual(["web › forge › edit", "web › forge › reply", "infra › forge › kind"]);
    expect(card.querySelector<HTMLDetailsElement>("[data-setting-paths]")!.open).toBe(false);
  });

  it("lets the human mark each step done, marks a live step live, and lists the open steps at the top of the tab", async () => {
    const asked = (done: boolean[]) =>
      plannerViewOf({
        projectState: "running",
        approvedVersion: 1,
        ask: {
          id: 9,
          at: NOW - 60_000,
          why: "The rollout needs two things from you.",
          open: done.some((value) => !value),
          steps: [
            { action: "other", text: "Rotate the API token in 1Password.", done: done[0]! },
            { action: "live", key: "CSV-1", text: "Mark CSV-1 live once the pipeline deployed it.", done: done[1]! },
          ],
        },
      });
    const steps = (done: boolean[]) => [
      ...(done[0] ? [] : [{ index: 0, action: "other" as const, text: "Rotate the API token in 1Password.", key: null }]),
      ...(done[1] ? [] : [{ index: 1, action: "live" as const, text: "Mark CSV-1 live once the pipeline deployed it.", key: "CSV-1" }]),
    ];
    let done = [false, false];
    const current = () => projectView({ askSteps: steps(done) });
    const askStepDone = vi.fn(() => {
      done = [true, done[1]!];
      return asked(done);
    });
    const markLive = vi.fn(() => {
      done = [done[0]!, true];
      return current();
    });
    const slot = await openPlanner({ plannerView: () => asked(done), project: current, askStepDone, markLive }, current());
    expect(slot.container.querySelector('[data-tab-badge="planner"]')!.textContent).toBe("2");
    // The asks card is the one reader of the open steps on Planner: no notice above it repeats them.
    expect(slot.container.querySelector('[data-badge-notice="planner"]')).toBeNull();
    const asks = () => page(slot).querySelector<HTMLElement>("[data-planner-asks]")!;
    expect([...asks().querySelectorAll("[data-ask-step]")].map((step) => step.getAttribute("data-ask-step"))).toEqual(["other", "live"]);
    expect(asks().textContent).toContain("Rotate the API token in 1Password.");
    expect(asks().textContent).toContain("Mark CSV-1 live once the pipeline deployed it.");
    const other = () => within(asks().querySelector<HTMLElement>('[data-ask-step="other"]')!);
    fireEvent.click(other().getByRole("button", { name: "Mark done" }));
    fireEvent.click(other().getByRole("button", { name: "Yes, mark step 1 done" }));
    await waitFor(() => expect(askStepDone).toHaveBeenCalledWith({ slug: "csv", ask: 9, step: 0, confirm: true }));
    await waitFor(() => expect(asks().querySelector('[data-ask-step="other"]')!.hasAttribute("data-done")).toBe(true));
    expect(toast.success).toHaveBeenCalledWith("Step 1 marked done");
    await waitFor(() => expect(slot.container.querySelector('[data-tab-badge="planner"]')!.textContent).toBe("1"));

    const live = () => within(asks().querySelector<HTMLElement>('[data-ask-step="live"]')!);
    fireEvent.click(live().getByRole("button", { name: "Mark CSV-1 live" }));
    await waitFor(() => expect(markLive).toHaveBeenCalledWith({ slug: "csv", target: "CSV-1", note: "Marked live as the planner asked: Mark CSV-1 live once the pipeline deployed it.", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector('[data-tab-badge="planner"]')).toBeNull());
    expect(slot.container.querySelector("[data-badge-notice]")).toBeNull();
  });

  it("sends the human's message to the planner and shows it in the story", async () => {
    let view = plannerViewOf();
    const messagePlanner = vi.fn(() => (view = plannerViewOf({ steps: [...plannerViewOf().steps, { kind: "message", at: NOW, text: "Keep it to one ticket." }] })));
    const slot = await openPlanner({ messagePlanner, plannerView: () => view }, { ...draft(), spec: { ...draft().spec, version: 1 } });
    const box = within(page(slot).querySelector<HTMLElement>("[data-message-planner]")!);
    expect((box.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box.getByRole("textbox", { name: "Message to the planner" }), { target: { value: "  Keep it to one ticket. " } });
    fireEvent.click(box.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(messagePlanner).toHaveBeenCalledWith({ threadId: "thr_plan", text: "Keep it to one ticket.", confirm: true }));
    expect(await box.findByRole("status")).toBeTruthy();
    await waitFor(() => expect(page(slot).querySelector("[data-planner-story]")!.textContent).toContain("You wrote to the planner"));
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
    // A fixed 6rem label column squeezed each value at 200% text; a value goes under its label when it has under 7rem.
    const about = slot.container.querySelector("[data-about-planner] [data-about-row]")!;
    expect(classNamesOf(about)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    expect(classNamesOf(about.querySelector("dd")!)).toEqual(expect.arrayContaining(["min-w-[min(100%,7rem)]", "[overflow-wrap:anywhere]"]));
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
    expect(slot.container.querySelector("[data-waits-in-chat]")).toBeNull();
  });

  it("says the planner waits in its chat, with the way there, when bb's wait is on nothing the page can show", async () => {
    // A provider's own tool approval is no plugin interaction, so the list Loom reads has nothing for it.
    const sdk = { threads: { interactions: { list: async () => [] } } } as unknown as PluginSdkTestFakes;
    const { slot } = await mountPage("csv", { project: () => projectView(), plannerView: () => plannerViewOf({ projectState: "running", approvedVersion: 1 }) }, { sdk, sidebarThreads: sidebar("thr_plan", true) });
    const tab = await slot.findByRole("tab", { name: "Planner" });
    expect(tab.getAttribute("aria-description")).toBe("The planner's thread waits for your answer in its chat");
    fireEvent.click(tab);
    const waits = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-waits-in-chat]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(waits.textContent).toContain("reading the thread does not clear it");
    expect(slot.container.querySelector("[data-nothing-needed]")).toBeNull();
    // The card is the one reader of the wait on Planner: no notice above it says the same.
    expect(slot.container.querySelector('[data-badge-notice="planner"]')).toBeNull();
    fireEvent.click(within(waits).getByRole("button", { name: "Answer in the thread" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_plan" });
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
    // The ticket sits in its project's shell, which reads the project; the ticket shows even when that read fails.
    expect(calls(slot, "project")[0]!.input).toEqual({ slug: "csv" });
    expect(await slot.findByRole("heading", { name: /Export endpoint/ })).toBeTruthy();
  });

  it("moves between the list, a project and a ticket when the address changes", async () => {
    const { slot, goTo } = await mountPage("_home", { home: () => homeView(), project: () => projectView(), ticket: () => ticketDetail() });
    await slot.findByText("CSV export");
    goTo("csv");
    await slot.findByRole("heading", { name: "CSV export" });
    goTo("csv/CSV-2");
    await waitFor(() => expect(calls(slot, "ticket")).toHaveLength(1));
    goTo("_home");
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(2));
  });

  it("puts one theme layer in the page that defines only --loom-* properties, scoped to Loom, with prefixed keyframes", async () => {
    const { slot } = await mountPage("_home", { home: () => homeView() });
    await slot.findByText("CSV export");
    const css = document.getElementById("loom-theme")!.textContent!;
    expect(document.querySelectorAll("#loom-theme")).toHaveLength(1);
    // A host token defined in terms of itself turns invalid in the subtree, so Loom mixes into names of its own.
    const defined = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!);
    expect(defined.length).toBeGreaterThan(10);
    expect(defined.filter((name) => !name.startsWith("--loom-"))).toEqual([]);
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|})\s*([^{}@]+?)\s*\{/g)].map((match) => match[1]!.trim()).filter((selector) => !/^(from|to|\d+%)$/.test(selector));
    for (const selector of selectors) for (const part of selector.split(",")) expect(part, part).toContain("[data-loom-root]");
    expect([...css.matchAll(/@keyframes\s+([a-z-]+)/g)].map((match) => match[1]!).every((name) => name.startsWith("loom-"))).toBe(true);
  });

  it("opens Jump to with / and the keys with ?, both from the keyboard, and Jump to only goes places", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), home: () => homeView() });
    await slot.findByRole("heading", { name: "CSV export" });
    const shell = slot.container.querySelector<HTMLElement>("[data-project-shell]")!;
    const page = within(document.body);
    fireEvent.keyDown(shell, { key: "/" });
    const input = await page.findByRole("combobox", { name: "Jump to" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await waitFor(() => expect(page.getAllByRole("option").length).toBeGreaterThan(5));
    const labels = page.getAllByRole("option").map((option) => option.textContent);
    expect(labels).toEqual(expect.arrayContaining(["CSV · Spec", "Home", "New project", "How Loom works", "Keys"]));
    fireEvent.change(input, { target: { value: "spec" } });
    expect(page.getAllByRole("option")[0]!.textContent).toContain("CSV · Spec");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(page.queryByRole("combobox", { name: "Jump to" })).toBeNull());
    await waitFor(() => expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true"));
    expect(calls(slot, "control")).toEqual([]);

    fireEvent.keyDown(slot.container.querySelector<HTMLElement>("[data-project-shell]")!, { key: "?" });
    const sheet = await page.findByRole("dialog", { name: "Keys" });
    expect(within(sheet).getByRole("region", { name: "In a row of tabs" }).textContent).toContain("Move between tabs");
    expect(within(sheet).getByRole("region", { name: "In a row of tabs" }).textContent).toContain("EnterSpaceOpen it");
    expect(within(sheet).getByRole("region", { name: "On the time ruler" }).textContent).toContain("SpacePlay the moments up to now, or pause");
    expect(within(sheet).getByRole("region", { name: "In Work" }).textContent).toContain("jkNext or previous ticket in the list");
    expect(within(sheet).getByRole("region", { name: "In Work" }).textContent).toContain("mMap, or back to the list");
    expect(within(sheet).getByRole("region", { name: "In a dependency map" }).textContent).toContain("EnterSpaceOpen the ticket");
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(page.queryByRole("dialog", { name: "Keys" })).toBeNull());
  });

  describe("Loom's rows in bb's palette", () => {
    const blocked = need({ kind: "blocked", slug: "csv", project: "CSV export", key: "CSV-7", text: "Needs a decision", startedAt: NOW });
    const context = {} as Parameters<ReturnType<typeof createCommands>[number]["run"]>[0];
    const command = (id: string) => createCommands().find((entry) => entry.id === id)!;
    // bb keeps the rail's badge hook mounted on every screen, which is where the commands get their navigator.
    const mountRail = async () => {
      const app = await loadPluginApp(() => import("../app"));
      const useBadge = app.navPanels[0]!.experimental_useBadge!;
      const Probe = () => <output>{JSON.stringify(useBadge())}</output>;
      const slot = renderSlot({ component: Probe }, {}, { pluginId: "loom", rpc: handlers() });
      mounts.push(slot);
      return slot;
    };

    it("names two rows for themselves, offered once bb's rail has Loom mounted and gone when it unmounts", async () => {
      expect(createCommands().map(({ id, title }) => ({ id, title }))).toEqual([
        { id: "next-needs-you", title: "Loom: Go to the next thing that needs me" },
        { id: "jump-to", title: "Loom: Jump to a project or ticket" },
      ]);
      expect(createCommands().every((entry) => entry.isAvailable?.(context) === false)).toBe(true);
      const rail = await mountRail();
      await waitFor(() => expect(createCommands().every((entry) => entry.isAvailable?.(context) === true)).toBe(true));
      rail.lifecycle.unmount();
      expect(createCommands().every((entry) => entry.isAvailable?.(context) === false)).toBe(true);
    });

    it("goes from elsewhere in bb to the oldest thing that needs you, replacing Home so Back returns to where you were", async () => {
      const rail = await mountRail();
      await waitFor(() => expect(command("next-needs-you").isAvailable?.(context)).toBe(true));
      act(() => void command("next-needs-you").run(context));
      expect(rail.inspection.navigateCalls).toEqual([pushed("_home")]);
      const { slot } = await mountPage("_home", { home: () => homeView({ needsYou: [blocked] }) });
      await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-7", replace: true } }]));
    });

    it("opens Jump to over Loom from elsewhere in bb, and acts in place while Loom is open", async () => {
      const rail = await mountRail();
      await waitFor(() => expect(command("jump-to").isAvailable?.(context)).toBe(true));
      act(() => void command("jump-to").run(context));
      expect(rail.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: undefined }]);
      const { slot } = await mountPage("csv", { project: () => projectView(), home: () => homeView() });
      const page = within(document.body);
      const input = await page.findByRole("combobox", { name: "Jump to" });
      await waitFor(() => expect(page.getAllByRole("option").map((option) => option.textContent)).toContain("CSV CSV export"));
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(page.queryByRole("combobox", { name: "Jump to" })).toBeNull());
      act(() => void command("jump-to").run(context));
      await page.findByRole("combobox", { name: "Jump to" });
      act(() => void command("next-needs-you").run(context));
      expect(rail.inspection.navigateCalls).toHaveLength(1);
      // The oldest item is first: Billing API's pause.
      await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "bill", replace: true } }]));
    });
  });

  it("brings the option the arrows choose into view on a long list, and leaves the list alone under the pointer", async () => {
    const board = Array.from({ length: 45 }, (_, index) => card({ key: `CSV-${index + 1}`, title: `Ticket ${index + 1}` }));
    const { slot } = await mountPage("csv", { project: () => projectView({ board }), home: () => homeView() });
    await slot.findByRole("heading", { name: "CSV export" });
    const scrolled: Array<{ id: string; options: unknown }> = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, options?: unknown) {
      scrolled.push({ id: this.id, options });
    } as typeof Element.prototype.scrollIntoView;
    try {
      fireEvent.keyDown(slot.container.querySelector<HTMLElement>("[data-project-shell]")!, { key: "/" });
      const page = within(document.body);
      const input = await page.findByRole("combobox", { name: "Jump to" });
      await waitFor(() => expect(page.getAllByRole("option").length).toBe(40));
      for (let press = 0; press < 25; press++) fireEvent.keyDown(input, { key: "ArrowDown" });
      const chosen = page.getAllByRole("option").findIndex((option) => option.getAttribute("aria-selected") === "true");
      expect(chosen).toBe(25);
      expect(input.getAttribute("aria-activedescendant")).toBe("loom-palette-25");
      expect(scrolled.at(-1)).toEqual({ id: "loom-palette-25", options: { block: "nearest" } });
      expect(scrolled).toHaveLength(25);
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(scrolled.at(-1)).toEqual({ id: "loom-palette-24", options: { block: "nearest" } });
      fireEvent.pointerMove(page.getAllByRole("option")[30]!);
      expect(page.getAllByRole("option")[30]!.getAttribute("aria-selected")).toBe("true");
      expect(scrolled).toHaveLength(26);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("makes each row of tabs one Tab stop that arrows, Home and End move along, and Enter opens", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    const list = await slot.findByRole("tablist", { name: "Project views" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    // Focus alone opens nothing: each view reads its own data.
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(document.activeElement).toBe(tabs[4]);
    fireEvent.keyDown(tabs[4]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[4]);
    fireEvent.keyDown(tabs[4]!, { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.click(tabs[4]!);
    await waitFor(() => expect(within(list).getByRole("tab", { name: "History" }).tabIndex).toBe(0));
    expect(within(list).getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
  });
});

describe("where the page was left", () => {
  const rpc = { home: () => homeView(), project: () => projectView(), ticket: () => ticketDetail(), insights: () => projectInsights(story().rows(), { now: at(60), strategy: "integration", maxWorkers: 2, maxTokens: null }) };
  const scroller = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-loom-scroll]")!;

  it("reopens from bb's rail on the route it was left on, and puts that route in the address", async () => {
    const first = await mountPage("csv/CSV-2", rpc);
    await waitFor(() => expect(calls(first.slot, "ticket")).toHaveLength(1));
    first.slot.lifecycle.unmount();
    const { slot } = await mountPage("", rpc);
    await waitFor(() => expect(calls(slot, "ticket")).toHaveLength(1));
    expect(calls(slot, "home")).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-2", replace: true } }]);
  });

  it("opens on home the first time, and on home again once home was the last place, each time at home's own address", async () => {
    const { slot, goTo } = await mountPage("", rpc);
    await slot.findByText("CSV export");
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "_home", replace: true } }]);
    goTo("csv");
    await slot.findByRole("heading", { name: "CSV export" });
    goTo("_home");
    await waitFor(() => expect(calls(slot, "home").length).toBeGreaterThan(1));
    slot.lifecycle.unmount();
    const again = await mountPage("", rpc);
    await again.slot.findByText("CSV export");
    expect(calls(again.slot, "project")).toEqual([]);
    expect(again.slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "_home", replace: true } }]);
  });

  it("opens each project on the tab it was left on, and another project on the board", async () => {
    const first = await mountPage("csv", rpc);
    await openView(first.slot, "History", "Insights");
    first.slot.lifecycle.unmount();
    const { slot, goTo } = await mountPage("csv", rpc);
    await waitFor(() => expect(slot.getByRole("tab", { name: "Insights" }).getAttribute("aria-selected")).toBe("true"));
    goTo("docs");
    await waitFor(() => expect(slot.getByRole("tab", { name: "Work" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("scrolls back to where each view was left", async () => {
    const first = await mountPage("csv", rpc);
    await first.slot.findByRole("tab", { name: "Work" });
    const node = scroller(first.slot);
    let top = 0;
    // jsdom lays nothing out, so the scroll position is a plain property here.
    const fake = (element: HTMLElement) =>
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get: () => top,
        set: (next: number) => void (top = next),
      });
    fake(node);
    top = 420;
    fireEvent.scroll(node);
    await new Promise((resolve) => setTimeout(resolve, 300));
    first.slot.lifecycle.unmount();
    top = 0;
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true, get: () => top, set: (next: number) => void (top = next) });
    try {
      const { slot } = await mountPage("csv", rpc);
      await slot.findByRole("tab", { name: "Work" });
      expect(top).toBe(420);
    } finally {
      if (originalDescriptor === undefined) delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      else Object.defineProperty(HTMLElement.prototype, "scrollTop", originalDescriptor);
    }
  });
});

describe("project controls", () => {
  // A test that patches layout restores it here, which runs even when the test times out: the patch once outlived a timed-out
  // test and sent the next tests' armed controls to the panel.
  let layoutPatch: { mockRestore(): void } | null = null;
  afterEach(() => {
    layoutPatch?.mockRestore();
    layoutPatch = null;
  });
  const withState = (state: ProjectSummary["state"], over: Partial<ProjectSummary> = {}) => projectView({ overview: overview({ state, ...over }) });
  /** The title bar's own buttons, then the ⋯ menu's items. */
  const labels = async (view: ReturnType<typeof projectView>) => {
    const { slot } = await mountPage("csv", { project: () => view });
    await slot.findByRole("heading", { name: "CSV export" });
    await waitFor(() => expect(titleBar(slot)).not.toBeNull());
    const bar = [...titleBar(slot).querySelectorAll(":scope > button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    const menu = (await openMenu(slot)).queryAllByRole("menuitem").map((item) => item.querySelector("[data-menu-label]")?.textContent ?? item.textContent);
    slot.lifecycle.unmount();
    return { bar, menu };
  };

  const bare = (state: ProjectSummary["state"], over: Partial<ProjectSummary> = {}) => ({ ...withState(state, over), next: null });
  const starting = (): NextStep => ({ stage: 3, tone: "normal", title: "Next: start the project.", text: "Loom starts 2 workers right away, on CSV-1 and CSV-3.", action: { control: "start", label: "Start project · 2 workers", confirm: "Yes, start 2 workers" } });

  // One mount per case, each with its own time: six whole-page mounts in one test ran past 5 s on a loaded machine.
  const none = { ticketCounts: { queued: 2 } };
  it.each([
    ["draft", { approvedVersion: null, ...none }, { bar: ["More project controls"], menu: ["Approve", "Planner", "Archive project…"] }],
    ["ready", none, { bar: ["More project controls"], menu: ["Start", "Planner", "Archive project…"] }],
    ["running", none, { bar: ["Pause", "More project controls"], menu: ["Pause now", "Planner", "Archive project…"] }],
    ["paused", none, { bar: ["Resume", "More project controls"], menu: ["Planner", "Archive project…"] }],
    ["done", none, { bar: ["More project controls"], menu: ["Planner", "Archive project…"] }],
    ["archived", none, { bar: ["More project controls"], menu: ["Planner"] }],
  ] as const)("shows the controls that fit a %s project: Pause or Resume in the bar, the rest in the ⋯ menu", async (state, over, expected) => {
    expect(await labels(bare(state, over))).toEqual(expected);
  });

  it.each([
    ["runs", { kind: "reviewing", version: 1, round: 1 }, false],
    ["has findings", { kind: "changes", version: 1, round: 1, findings: [{ title: "Too big", detail: "Drop it." }] }, false],
    ["did not finish", { kind: "failed", version: 1, round: 1, reason: "the reviewer ended its turn twice without a verdict" }, false],
    ["passed", { kind: "approved", version: 1, round: 1, summary: "Fits." }, true],
  ] as const)("offers a draft's Approve only once its spec review passed: here the review %s", async (_case, specReview, offered) => {
    const draft = { ...bare("draft", { approvedVersion: null, ticketCounts: {} }), specReview: specReview as ReturnType<typeof projectView>["specReview"] };
    expect((await labels(draft)).menu.includes("Approve")).toBe(offered);
  });

  it("offers Land on an integration project with a done ticket, and Approve for a pending spec version", async () => {
    expect((await labels(bare("running", { ticketCounts: { done: 1 } }))).menu).toEqual(["Pause now", "Land", "Land to main", "Planner", "Archive project…"]);
    expect((await labels(bare("running", { strategy: "pr", ticketCounts: { done: 1 } }))).menu).toEqual(["Pause now", "Planner", "Archive project…"]);
    expect(await labels(bare("paused", { pendingVersion: 2, ticketCounts: {} }))).toEqual({ bar: ["Resume", "More project controls"], menu: ["Approve v2", "Planner", "Archive project…"] });
  });

  const prOpen = { strategy: "pr" as const, ticketCounts: { pr_open: 1, queued: 1 } };
  it("offers Sync pull requests on a running pull request project with one open, in the bar and the menu", async () => {
    expect(await labels(bare("running", prOpen))).toEqual({ bar: ["Sync pull requests", "Pause", "More project controls"], menu: ["Sync pull requests", "Pause now", "Planner", "Archive project…"] });
  });
  it("offers Sync pull requests on a paused pull request project with one open, and not on a finished one", async () => {
    expect((await labels(bare("paused", prOpen))).bar).toEqual(["Sync pull requests", "Resume", "More project controls"]);
    expect((await labels(bare("done", { strategy: "pr", ticketCounts: { done: 2 } }))).bar).toEqual(["More project controls"]);
  });

  it("syncs on one click, says what the reads found in a toast, and warns when a read failed", async () => {
    const found = { slug: "csv", tickets: [], message: "CSV-1's pull request merged, so CSV-1 is done.", problem: false };
    const syncPullRequests = vi.fn(() => found);
    const { slot } = await mountPage("csv", { project: () => bare("running", { strategy: "pr", ticketCounts: { pr_open: 1 } }), syncPullRequests });
    fireEvent.click(await slot.findByRole("button", { name: "Sync pull requests" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("CSV-1's pull request merged, so CSV-1 is done."));
    expect(syncPullRequests).toHaveBeenCalledWith({ slug: "csv", confirm: true });

    syncPullRequests.mockReturnValue({ ...found, message: "Could not read CSV-1's pull request: gh: HTTP 502.", problem: true });
    await waitFor(() => expect((slot.getByRole("button", { name: "Sync pull requests" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByRole("button", { name: "Sync pull requests" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Could not read CSV-1's pull request: gh: HTTP 502."));
    expect(syncPullRequests).toHaveBeenCalledTimes(2);
  });

  it("arms Land to main in the title bar from the menu, and lands on Yes with no timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      const control = vi.fn(() => bare("done", { ticketCounts: { done: 1 } }));
      const { slot } = await mountPage("csv", { project: () => bare("running", { ticketCounts: { done: 1 } }), control });
      await pick(slot, /Land to main/);
      expect(control).not.toHaveBeenCalled();
      const yes = await within(titleBar(slot)).findByRole("button", { name: "Yes, land to main" });
      await waitFor(() => expect(document.activeElement).toBe(yes));
      // Confirm in place waits for the person: a minute later it is still armed.
      act(() => void vi.advanceTimersByTime(60_000));
      fireEvent.click(within(titleBar(slot)).getByRole("button", { name: "Yes, land to main" }));
      await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "landDirect", confirm: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the next step's action out of the title bar", async () => {
    expect((await labels({ ...withState("ready", { ticketCounts: { queued: 2 } }), next: starting() })).menu).toEqual(["Planner", "Archive project…"]);
  });

  it("archives from the ⋯ menu on Yes, and Back or Escape disarms it without acting", async () => {
    const control = vi.fn(() => withState("archived"));
    const { slot } = await mountPage("csv", { project: () => withState("running"), control });
    await pick(slot, "Archive project…");
    fireEvent.click(await within(titleBar(slot)).findByRole("button", { name: "Back" }));
    expect(within(titleBar(slot)).queryByRole("button", { name: "Yes, archive CSV" })).toBeNull();
    await pick(slot, "Archive project…");
    fireEvent.keyDown(await within(titleBar(slot)).findByRole("button", { name: "Yes, archive CSV" }), { key: "Escape" });
    expect(within(titleBar(slot)).queryByRole("button", { name: "Yes, archive CSV" })).toBeNull();
    expect(control).not.toHaveBeenCalled();
    await pick(slot, "Archive project…");
    fireEvent.click(await within(titleBar(slot)).findByRole("button", { name: "Yes, archive CSV" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "archive", confirm: true }));
  });

  it("confirms in a panel under the bar when the armed group would leave the window, with Back and the whole consequence", async () => {
    // jsdom lays nothing out: the armed group reports itself running 120 px past the window's edge, as at 320 px.
    const real = Element.prototype.getBoundingClientRect;
    layoutPatch = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.hasAttribute("data-confirm-armed") && !this.hasAttribute("data-confirm-panel") ? ({ left: 200, right: window.innerWidth + 120, width: window.innerWidth - 80, top: 0, bottom: 28, height: 28, x: 200, y: 0 } as DOMRect) : real.call(this);
    });
    const control = vi.fn(() => withState("archived"));
    const { slot } = await mountPage("csv", { project: () => withState("running"), control });
    await pick(slot, "Archive project…");
    const panel = await waitFor(() => document.querySelector<HTMLElement>("[data-confirm-panel]")!);
    expect(within(titleBar(slot)).queryByRole("button", { name: "Yes, archive CSV" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Yes, archive CSV" })).toBe(document.activeElement);
    expect(within(panel).getByRole("button", { name: "Back" })).toBeTruthy();
    fireEvent.keyDown(within(panel).getByRole("button", { name: "Yes, archive CSV" }), { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-confirm-panel]")).toBeNull());
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "More project controls" }));
    expect(control).not.toHaveBeenCalled();
    await pick(slot, "Archive project…");
    fireEvent.click(within(await waitFor(() => document.querySelector<HTMLElement>("[data-confirm-panel]")!)).getByRole("button", { name: "Yes, archive CSV" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "archive", confirm: true }));
  });

  it("keeps an armed group in the bar only while it fits", () => {
    const rect = (left: number, right: number) => ({ left, right, width: right - left }) as DOMRect;
    expect(armedFits(rect(600, 900), 1000, { scrollWidth: 120, clientWidth: 120 })).toBe(true);
    expect(armedFits(rect(200, 1110), 1000, null)).toBe(false);
    expect(armedFits(rect(-40, 300), 1000, null)).toBe(false);
    expect(armedFits(rect(600, 900), 1000, { scrollWidth: 180, clientWidth: 120 })).toBe(false);
    expect(armedFits(rect(0, 0), 1000, null)).toBe(true);
  });

  it("shows the next step on the project line, with the reason a tap or a key away", async () => {
    const next: NextStep = { stage: 4, tone: "warning", title: "1 ticket is blocked.", text: "CSV-1: bb refused to start a worker.", action: null };
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("running"), next }) });
    await slot.findByRole("heading", { name: "CSV export" });
    const line = slot.container.querySelector<HTMLElement>('[data-next-step][data-tone="warning"]')!;
    expect(line.getAttribute("aria-label")).toBe("Next step");
    expect(line.textContent).toContain("1 ticket is blocked");
    const title = within(line).getByRole("button", { name: "1 ticket is blocked" });
    expect(title.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(title);
    expect(title.getAttribute("aria-expanded")).toBe("true");
    expect((await slot.findByRole("dialog", { name: "Next step" })).textContent).toContain("CSV-1: bb refused to start a worker.");
  });

  it("opens the state's facts from the pill by key or tap, says so, and Esc closes them back onto the pill", async () => {
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("paused"), next: null }) });
    await slot.findByRole("heading", { name: "CSV export" });
    const pill = slot.container.querySelector<HTMLElement>("[data-state-pill]")!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    pill.focus();
    // A focused button activates on Enter and Space as a click.
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const card = await within(document.body).findByRole("dialog", { name: /CSV export: paused/i });
    expect(card.textContent).toContain("Since");
    expect(within(card).getByRole("button", { name: /Resume/ })).toBeTruthy();
    fireEvent.keyDown(card, { key: "Escape" });
    await waitFor(() => expect(pill.getAttribute("aria-expanded")).toBe("false"));
    await waitFor(() => expect(document.activeElement).toBe(pill));
  });

  it("never points the project line at the view or the ticket already open", async () => {
    const blocked = (key: string, hours: number) => card({ key, title: `Ticket ${key}`, state: "blocked", stateAt: NOW - hours * HOUR });
    const asks = { ...withState("running"), board: [blocked("CSV-1", 5), blocked("CSV-2", 2)], next: null };
    const answer = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-next-step]")!.textContent;
    const onWork = await mountPage("csv", { project: () => asks });
    await onWork.slot.findByRole("heading", { name: "CSV export" });
    // The oldest ask leads, until that ticket is the one open.
    await waitFor(() => expect(answer(onWork.slot)).toContain("CSV-1"));
    onWork.slot.lifecycle.unmount();
    const onTicket = await mountPage("csv/CSV-1", { project: () => asks, ticket: () => ticketDetail({ key: "CSV-1", state: "blocked" }) });
    await waitFor(() => expect(answer(onTicket.slot)).toContain("CSV-2"));
    expect(answer(onTicket.slot)).not.toContain("CSV-1");
    onTicket.slot.lifecycle.unmount();
    // With the only ask open below, the line says it is open and offers no second way to it, never "nothing needs you".
    const one = { ...asks, board: [blocked("CSV-1", 5), card({ key: "CSV-3", state: "working" })] };
    const alone = await mountPage("csv/CSV-1", { project: () => one, ticket: () => ticketDetail({ key: "CSV-1", state: "blocked" }) });
    await waitFor(() => expect(answer(alone.slot)).toBe("CSV-1asks · answer below"));
    expect(within(alone.slot.container.querySelector<HTMLElement>("[data-next-step]")!).queryByRole("button")).toBeNull();
    alone.slot.lifecycle.unmount();

    const pending: NextStep = { stage: 2, tone: "normal", title: "v2 waits for you.", text: "Approve v2 to run it.", action: { control: "approve", version: 2, label: "Approve v2", confirm: "Yes, approve v2" } };
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("running", { pendingVersion: 2 }), next: pending }) });
    await slot.findByRole("heading", { name: "CSV export" });
    const line = () => within(slot.container.querySelector<HTMLElement>("[data-next-step]")!);
    expect(line().getByRole("button", { name: "Read v2" })).toBeTruthy();
    fireEvent.click(line().getByRole("button", { name: "Read v2" }));
    await waitFor(() => expect(slot.getByRole("tab", { name: /^Spec/ }).getAttribute("aria-selected")).toBe("true"));
    expect(line().queryByRole("button", { name: "Read v2" })).toBeNull();
    expect(line().getByRole("button", { name: "Approve v2" })).toBeTruthy();
  });

  it("acts from the project line's lead on Yes", async () => {
    const control = vi.fn(() => withState("running"));
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("ready"), next: starting() }), control });
    const line = () => slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(await slot.findByRole("button", { name: "Start project · 2 workers" }));
    expect(line().getAttribute("data-tone")).toBe("normal");
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(within(line()).getByRole("button", { name: "Yes, start 2 workers" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "start", confirm: true }));
  });

  it("arms a risky control first, then calls control with confirm: true, says so in a toast and shows the refreshed project", async () => {
    let state: ProjectView["overview"]["state"] = "ready";
    const control = vi.fn(() => {
      state = "running";
      return { ...withState(state), next: null };
    });
    const { slot } = await mountPage("csv", { project: () => ({ ...withState(state), next: null }), control });
    await pick(slot, /^Start/);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(await within(titleBar(slot)).findByRole("button", { name: /^Yes, start/ }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "start", confirm: true }));
    await waitFor(() => expect(within(titleBar(slot)).getByRole("button", { name: "Pause" })).toBeTruthy());
    expect(toast.success).toHaveBeenCalledWith("Project started");
    expect(calls(slot, "project")).toHaveLength(2);
  });

  it("pauses and resumes in one click, and sends Pause now and an approve version with their own actions", async () => {
    const control = vi.fn(() => ({ ...withState("running", { pendingVersion: 2 }), next: null }));
    const { slot } = await mountPage("csv", { project: () => ({ ...withState("running", { pendingVersion: 2 }), next: null }), control });
    fireEvent.click((await inTitleBar(slot)).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "pause", confirm: true }));
    await waitFor(() => expect((within(titleBar(slot)).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
    // Pause now says what it does, and does it: it stops the agents at once, with one click like Pause.
    const menu = await openMenu(slot);
    expect(menu.getByRole("menuitem", { name: /Pause now/ }).textContent).toContain("Stops running agents at once");
    fireEvent.click(menu.getByRole("menuitem", { name: /Pause now/ }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "pauseNow", confirm: true }));
    expect(toast.success).toHaveBeenLastCalledWith("Paused, and its workers stopped");
    await waitFor(() => expect((within(titleBar(slot)).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
    await pick(slot, /Approve v2/);
    fireEvent.click(await within(titleBar(slot)).findByRole("button", { name: "Yes, approve v2" }));
    await waitFor(() => expect(control).toHaveBeenLastCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("disables every write in the title bar while rewound, refuses one that gets through, and keeps navigation", async () => {
    const project = (input: { slug: string; at?: number }) => (input.at === undefined ? withState("running", { strategy: "pr", ticketCounts: { pr_open: 1, done: 1 } }) : { ...withState("running", { strategy: "pr", ticketCounts: { pr_open: 1, done: 1 } }), at: input.at, now: NOW - 15 * 60_000 });
    const control = vi.fn(() => withState("paused"));
    const syncPullRequests = vi.fn(() => ({ slug: "csv", tickets: [], message: "", problem: false }));
    const { slot } = await mountPage("csv", { project, control, syncPullRequests });
    await waitFor(() => expect(slot.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuemax")).not.toBe("0"));
    fireEvent.click(slot.getByRole("button", { name: "Previous moment" }));
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).not.toBeNull());
    const bar = within(titleBar(slot));
    for (const name of ["Pause", "Sync pull requests"]) {
      const button = bar.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
    }
    expect(toast.error).toHaveBeenCalledWith("Read-only while rewound: go back to now to act");
    const menu = await openMenu(slot);
    for (const name of [/Sync pull requests/, /Pause now/, /Archive project/]) expect(menu.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
    expect(menu.getByRole("menuitem", { name: "Planner" }).getAttribute("aria-disabled")).toBeNull();
    // The keys write nothing either: 1 to 5 change views, [ and ] move in time.
    fireEvent.keyDown(slot.container.querySelector("[data-project-shell]")!, { key: "p" });
    expect(control).not.toHaveBeenCalled();
    expect(syncPullRequests).not.toHaveBeenCalled();
  });

  // bb's query client shows its own toast for every failed write, so Loom adds none and says nothing went through.
  it("leaves a refusal to bb's toast, says nothing went through, and keeps the controls", async () => {
    const control = vi.fn(() => {
      throw new Error("Project csv is ready; pause needs a running project.");
    });
    const { slot } = await mountPage("csv", { project: () => withState("running"), control });
    fireEvent.click((await inTitleBar(slot)).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(control).toHaveBeenCalled());
    await waitFor(() => expect((within(titleBar(slot)).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("says in each control's toast what it did", () => {
    expect(controlDone("approve")).toBe("Spec approved");
    expect(controlDone("approve", 3)).toBe("Approved v3");
    expect(controlDone("pause")).toBe("Paused: work in flight carries on, and nothing new starts");
    expect(controlDone("pauseNow")).toBe("Paused, and its workers stopped");
    expect(controlDone("land", undefined, "api")).toBe("api: Landed: the branch is pushed and its pull request is open");
    expect(controlDone("landDirect")).toBe("Landed on the base branch");
    expect(controlDone("archive")).toBe("Project archived");
  });
});

describe("confirm button", () => {
  it("arms in place on the first click: Yes with what it does, beside Back, focus on Yes, and acts on Yes", () => {
    const onConfirm = vi.fn();
    const view = render(<ConfirmButton label="Start" onConfirm={onConfirm} />);
    fireEvent.click(view.getByRole("button", { name: "Start" }));
    const armed = view.getByRole("button", { name: "Yes, start" });
    expect(armed.hasAttribute("data-confirming")).toBe(true);
    expect(document.activeElement).toBe(armed);
    expect(view.getByRole("group", { name: "Start" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(armed);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(view.getByRole("button", { name: "Start" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("goes back to its label on Back or Escape without acting, with focus on it again, and never on a timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onConfirm = vi.fn();
      const view = render(<ConfirmButton label="Archive project" danger onConfirm={onConfirm} />);
      fireEvent.click(view.getByRole("button", { name: "Archive project" }));
      act(() => void vi.advanceTimersByTime(60_000));
      fireEvent.click(view.getByRole("button", { name: "Back" }));
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Archive project" }));
      fireEvent.click(view.getByRole("button", { name: "Archive project" }));
      fireEvent.keyDown(view.getByRole("button", { name: "Yes, archive project" }), { key: "Escape" });
      expect(view.getByRole("button", { name: "Archive project" })).toBeTruthy();
      expect(view.queryByRole("button", { name: "Back" })).toBeNull();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says its own confirm label when it has one", () => {
    const view = render(<ConfirmButton primary label="Start project · 2 workers" confirmLabel="Yes, start 2 workers" onConfirm={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Start project · 2 workers" }));
    expect(view.getByRole("button", { name: "Yes, start 2 workers" }).className).toContain("h-8");
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
  const approving = (version: number): ReturnType<typeof projectView> => ({
    ...projectView({ overview: overview({ state: "paused", pendingVersion: version }) }),
    next: { stage: 2, tone: "normal", title: `v${version} waits for you.`, text: `Approve v${version} to run it.`, action: { control: "approve", version, label: `Approve v${version}`, confirm: `Yes, approve v${version}` } },
  });

  it("disarms the project line's Approve when the pending version changes under it, so Enter writes nothing", async () => {
    let version = 21;
    const control = vi.fn(() => approving(version));
    const { slot } = await mountPage("csv", { project: () => approving(version), control });
    await slot.findByRole("heading", { name: "CSV export" });
    const line = () => within(slot.container.querySelector<HTMLElement>("[data-next-step]")!);
    fireEvent.click(line().getByRole("button", { name: "Approve v21" }));
    const yes = line().getByRole("button", { name: "Yes, approve v21" });
    await waitFor(() => expect(document.activeElement).toBe(yes));
    version = 22;
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(line().getByRole("button", { name: "Approve v22" })).toBeTruthy());
    expect(line().queryByRole("button", { name: /^Yes, approve/ })).toBeNull();
    // Focus went back to the idle button, where Enter arms the new version instead of approving it.
    expect(document.activeElement).toBe(line().getByRole("button", { name: "Approve v22" }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.click(yes);
    expect(control).not.toHaveBeenCalled();
    fireEvent.click(line().getByRole("button", { name: "Approve v22" }));
    fireEvent.click(line().getByRole("button", { name: "Yes, approve v22" }));
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(calls(slot, "control")[0]!.input).toMatchObject({ slug: "csv", action: "approve", version: 22 });
  });

  it("disarms the title bar's armed control when its offer goes away or changes, so Yes writes nothing", async () => {
    let state: ProjectSummary["state"] = "running";
    const control = vi.fn(() => projectView({ overview: overview({ state }) }));
    const { slot } = await mountPage("csv", { project: () => ({ ...projectView({ overview: overview({ state }) }), next: null }), control });
    await slot.findByRole("heading", { name: "CSV export" });
    fireEvent.click((await openMenu(slot)).getByRole("menuitem", { name: /Archive project/ }));
    const yes = await within(titleBar(slot)).findByRole("button", { name: /^Yes, archive/ });
    await waitFor(() => expect(document.activeElement).toBe(yes));
    state = "archived";
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(within(titleBar(slot)).queryByRole("button", { name: /^Yes, archive/ })).toBeNull());
    fireEvent.click(yes);
    expect(control).not.toHaveBeenCalled();
  });

  it("asks for the project again when it changes, and ignores other projects", async () => {
    let state: ProjectSummary["state"] = "ready";
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ state }) }) });
    await slot.findByRole("heading", { name: "CSV export" });
    expect(slot.queryByRole("button", { name: "Pause" })).toBeNull();
    state = "running";
    await slot.experimental_invalidateRpc(changedTags("other"));
    expect(calls(slot, "project")).toHaveLength(1);
    await slot.experimental_invalidateRpc(changedTags("csv"));
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
    fireEvent.click(within(panel).getByRole("button", { name: "Yes, approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("leaves a pending version's Approve to the next-step bar when the bar carries it", async () => {
    const next: NextStep = { stage: 4, tone: "normal", title: "Next: approve v2.", text: "The planner proposed spec v2.", action: { control: "approve", version: 2, label: "Approve v2", confirm: "Yes, approve v2" } };
    const control = vi.fn(() => projectView());
    const { slot } = await mountPage("csv", { project: () => pending(next), control, specVersion: () => pendingSpec() });
    fireEvent.click(await slot.findByRole("tab", { name: "Spec" }));
    await waitFor(() => expect(slot.container.querySelector("[data-review-panel]")).not.toBeNull());
    expect(within(slot.container.querySelector<HTMLElement>("[data-review-panel]")!).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(slot.getAllByRole("button", { name: /^Approve v2/ })).toHaveLength(1);
    expect(slot.getByRole("button", { name: "More project controls" })).toBeTruthy();
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-next-step]")!).getByRole("button", { name: "Approve v2" }));
    fireEvent.click(slot.getByRole("button", { name: "Yes, approve v2" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "approve", version: 2, confirm: true }));
  });

  it("offers no Approve on a draft while Loom's spec review holds it, and says where the review stands", async () => {
    const finding = { path: "ticket[csv-export]", title: "No criterion for an empty export", detail: "Add one." };
    const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }), board: [], next: null, specReview: { kind: "changes", version: 2, round: 1, findings: [finding] } });
    const spec = specVersionView({ reviews: [{ version: 2, round: 1, state: "changes_requested", summary: "One gap.", findings: [finding], reason: null, skip: null, startedAt: NOW - HOUR, endedAt: NOW }] });
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
      const board = await slot.findByRole("tab", { name: "Work" });
      expect(badge(slot, "work")!.textContent).toBe("2");
      expect(badge(slot, "work")!.getAttribute("aria-hidden")).toBe("true");
      expect(badge(slot, "work")!.getAttribute("data-tone")).toBe("destructive");
      expect(board.getAttribute("aria-description")).toBe("2 tickets are blocked");
      expect(badge(slot, "spec")).toBeNull();
      // The tab says the same at its top, in one line with what clears it; the tickets are the Needs you rows just under it.
      const notice = slot.container.querySelector<HTMLElement>('[data-badge-notice="board"]')!;
      expect(notice.textContent).toBe("2 tickets are blocked. A ticket leaves the count once it is requeued, by you or by the planner in a triage round, or cancelled.");
      expect(notice.className).toContain("border-l-destructive");
      expect(notice.querySelector("[data-badge-item]")).toBeNull();
      const need = await slot.findByRole("list", { name: "Needs you" });
      fireEvent.click(within(need).getByRole("button", { name: /^CSV-3, blocked/ }));
      expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv/CSV-3"));

      slot.lifecycle.unmount();
      const { slot: calm } = await mountPage("csv", { project: () => projectView() });
      expect((await calm.findByRole("tab", { name: "Work" })).getAttribute("aria-description")).toBeNull();
      expect(calm.container.querySelector("[data-tab-badge]")).toBeNull();
    });

    it("marks the Spec tab while a draft or a pending version waits for you, but not on an archived project", async () => {
      const pending = projectView({ overview: overview({ pendingVersion: 2 }) });
      const { slot } = await mountPage("csv", { project: () => pending });
      const spec = await slot.findByRole("tab", { name: "Spec" });
      expect(badge(slot, "spec")!.textContent).toBe("1");
      expect(badge(slot, "spec")!.getAttribute("data-tone")).toBe("warning");
      expect(spec.getAttribute("aria-description")).toBe("Spec v2 waits for your approval");

      const draft = projectView({ overview: overview({ state: "draft", approvedVersion: null }), spec: { ...projectView().spec, version: 3 } });
      slot.lifecycle.unmount();
      const { slot: drafted } = await mountPage("csv", { project: () => draft });
      expect((await drafted.findByRole("tab", { name: "Spec" })).getAttribute("aria-description")).toBe("Draft v3 waits for your review");

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
    await slot.experimental_invalidateRpc(changedTags("csv"));
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
  const landing = () => projectView({ overview: overview({ ticketCounts: { done: 3 } }), board: board.map((entry) => ({ ...entry, state: "done" })), next: { stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label: "Land · open the pull request", confirm: "Yes, land: push and open the pull request" } } });
  const mountChanges = async (rpc: Partial<Handlers> = {}, view = projectView({ board })) => {
    const mounted = await mountPage("csv", { project: () => view, ticket: ({ key }) => ticketDetail({ key }), changes: () => changesView(), changePatch: ({ path }) => ({ patch: `diff --git a/${path} b/${path}\n+x\n`, truncated: false }), ...rpc });
    await mounted.slot.findByRole("tab", { name: "Work" });
    return Object.assign(mounted.slot, { goTo: mounted.goTo });
  };
  /** A ticket's changes, from its menu in Work's pane: the page leaves the ticket for Ship's Changes. */
  const changesOf = async (slot: Slot & { goTo(next: string): void }, key: string) => {
    slot.goTo(`csv/${key}`);
    fireEvent.click((await ticketMenu(slot, key)).getByRole("menuitem", { name: "Changes" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv"));
    slot.goTo("csv");
  };
  const openTab = async (slot: Slot) => {
    await openView(slot, "Ship", "Changes");
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

  it("opens a ticket's changes from a file's ticket chip and from the ticket's menu", async () => {
    const slot = await mountChanges();
    await changesOf(slot, "CSV-2");
    expect(await slot.findByText("Live.", { exact: false })).toBeTruthy();
    expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("live:CSV-2");
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-source="branch"]')!);
    fireEvent.click(fileRow(slot, "src/a.ts").querySelector<HTMLElement>('[data-file-ticket="CSV-1"]')!);
    expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("merge:CSV-1");
    expect(slot.container.querySelector("[data-change-source]")!.textContent).toContain("What its merge bbbbbbb added to loom/csv, 2h ago");
  });

  it("reads a live worktree's patch by the ticket's key and marks a file git does not track yet", async () => {
    const slot = await mountChanges();
    await changesOf(slot, "CSV-2");
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
      await changesOf(slot, "CSV-2");
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
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(slot.getByText("Viewed 0 of 2", { exact: false })).toBeTruthy());
  });

  it("says politely when a refresh changes the open source's files, and not when the person picks another source", async () => {
    let view = changesView({ sources: [source({ files: [changed("src/a.ts")] }), changesView().sources[1]!] });
    const slot = await mountChanges({ changes: () => view });
    await openTab(slot);
    const status = () => slot.container.querySelector<HTMLElement>("[data-changes-refreshed]")!;
    await waitFor(() => expect(status().getAttribute("role")).toBe("status"));
    expect(status().textContent).toBe("");
    view = changesView({ sources: [source({ files: [changed("src/a.ts"), changed("src/c.ts", { status: "added" })] }), changesView().sources[1]!] });
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(status().textContent).toBe("Changes updated: 1 added; 2 files in all."));
    const said = status().firstElementChild;
    // The same files read again say nothing new; another source the person picks is not an update.
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(calls(slot, "changes").length).toBeGreaterThanOrEqual(3));
    expect(status().textContent).toBe("Changes updated: 1 added; 2 files in all.");
    expect(status().firstElementChild).toBe(said);
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-source="merge:CSV-1"]')!);
    await waitFor(() => expect(slot.container.querySelector("[data-change-source]")!.getAttribute("data-change-source")).toBe("merge:CSV-1"));
    expect(status().textContent).toBe("");
  });

  it("announces each refresh that changes the open source's files, also when the count stays the same", async () => {
    const twoFiles = (a: string, b: string) => changesView({ sources: [source({ files: [changed("src/a.ts", { fingerprint: a }), changed("src/b.ts", { fingerprint: b })] }), changesView().sources[1]!] });
    let view = twoFiles("a1", "b1");
    const slot = await mountChanges({ changes: () => view });
    await openTab(slot);
    const status = () => slot.container.querySelector<HTMLElement>("[data-changes-refreshed]")!;
    await waitFor(() => expect(status().getAttribute("role")).toBe("status"));
    expect(status().textContent).toBe("");
    view = twoFiles("a2", "b2");
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(status().textContent).toBe("Changes updated: 2 files changed; 2 files in all."));
    const first = status().firstElementChild;
    // The second refresh changes the same two files again: the words match, so the note is a new node a screen reader reads as news.
    view = twoFiles("a3", "b3");
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(status().firstElementChild).not.toBe(first));
    expect(status().textContent).toBe("Changes updated: 2 files changed; 2 files in all.");
    const second = status().firstElementChild;
    view = twoFiles("a3", "b4");
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(status().textContent).toBe("Changes updated: 1 file changed; 2 files in all."));
    expect(status().firstElementChild).not.toBe(second);
    // An unchanged read leaves the last note in place.
    const third = status().firstElementChild;
    const reads = calls(slot, "changes").length;
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(calls(slot, "changes").length).toBeGreaterThan(reads));
    expect(status().firstElementChild).toBe(third);
  });

  it("when the project is ready to land, the bar's Review changes opens the branch, the tab counts the files not viewed, and the panel lands", async () => {
    const slot = await mountChanges({ control: () => landing() }, landing());
    // On Work the Ship tab carries the count; inside Ship, its Changes part does.
    const badge = await waitFor(() => {
      const found = slot.container.querySelector('[data-tab-badge="ship"]');
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
    fireEvent.click(within(panel).getByRole("button", { name: "Yes, land: push and open the pull request" }));
    await waitFor(() => expect(calls(slot, "control")).toEqual([{ method: "control", input: { slug: "csv", action: "land", confirm: true } }]));
  });

  it("leaves out work whose commits are gone, says why nothing can be read, and shows a finished project's merges", async () => {
    const gone = changesView({ finished: true, sources: [changesView().sources[0]!, { ...changesView().sources[1]!, gone: true, files: null, note: "Its commits are no longer in the repository." }] });
    const slot = await mountChanges({ changes: () => gone }, projectView({ overview: overview({ state: "done", ticketCounts: { done: 1 } }), board, next: null }));
    await openView(slot, "Ship", "Changes");
    await waitFor(() => expect(slot.container.querySelector("[data-change-source]")!.textContent).toContain("What loom/csv merged"));
    expect(slot.container.querySelector("[data-land-panel]")).toBeNull();
    expect([...slot.container.querySelectorAll("[data-source]")].map((node) => node.getAttribute("data-source"))).toEqual(["branch"]);
    expect(slot.container.querySelector("[data-gone]")!.textContent).toBe("1 part of this project is no longer in the repository, so it is left out.");
    slot.lifecycle.unmount();

    const none = await mountChanges({ changes: () => changesView({ sources: [], unavailable: "The bb project has no checkout on the machine host_1, so its changes cannot be read." }) });
    await openView(none, "Ship", "Changes");
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
        next: { stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label: "Land · 1 repo", confirm: "Yes, land: push and open the pull request" } },
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
      await openView(slot, "Ship", "Changes");
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
      await openView(none, "Ship", "Changes");
      expect(await empty(none)).toBe("None of the project's repos can be read; each repo's section says why.");
      expect(sectionOf(none, "web").querySelector("[data-repo-unavailable]")!.textContent).toBe(webMessage);
      expect(sectionOf(none, "api").querySelector("[data-repo-unavailable]")!.textContent).toBe(apiMessage);
      expect(none.container.querySelector("[data-changes-unavailable]")).toBeNull();
      none.lifecycle.unmount();

      // A single-repo project still shows only the one sentence.
      const allGone = changesView({ sources: changesView().sources.map((entry) => ({ ...entry, files: null, gone: true })) });
      const single = await mountChanges({ changes: () => allGone });
      await openView(single, "Ship", "Changes");
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
      await openView(slot, "Ship", "Changes");
      await slot.findByText("This is what lands in api.", { exact: false });
      const panel = () => slot.container.querySelector<HTMLElement>("[data-land-panel]")!;
      expect(panel().textContent).toContain("Land api pushes loom/csv in api at ccccccc and opens one pull request into trunk, or updates the one already open. Land api to trunk merges upstream/trunk in");
      expect(panel().textContent).toContain("The other repos do not land.");
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api" }));
      fireEvent.click(within(panel()).getByRole("button", { name: "Yes, land api: push and open its pull request" }));
      await waitFor(() => expect(within(panel()).getByRole<HTMLButtonElement>("button", { name: "Land api to trunk" }).disabled).toBe(false));
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api to trunk" }));
      fireEvent.click(within(panel()).getByRole("button", { name: "Yes, push api straight to trunk" }));
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
      await openView(slot, "Ship", "Changes");
      await slot.findByText("This is what lands in api.", { exact: false });
      const panel = () => slot.container.querySelector<HTMLElement>("[data-land-panel]")!;
      const buttons = () => within(panel()).getAllByRole("button").map((button) => button.textContent);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api to trunk" }));
      expect(buttons()).toEqual(["Land api", "Yes, push api straight to trunk", "Back"]);
      pick(slot, "branch:web");
      expect(buttons()).toEqual(["Land web", "Land web to main"]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land web to main" }));
      expect(buttons()).toEqual(["Land web", "Yes, push web straight to main", "Back"]);

      pick(slot, "branch:api");
      expect(buttons()).toEqual(["Land api", "Land api to trunk"]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Land api" }));
      expect(buttons()).toEqual(["Yes, land api: push and open its pull request", "Back", "Land api to trunk"]);
      pick(slot, "branch:web");
      expect(buttons()).toEqual(["Land web", "Land web to main"]);
      expect(calls(slot, "control")).toEqual([]);

      fireEvent.click(within(panel()).getByRole("button", { name: "Land web" }));
      expect(calls(slot, "control")).toEqual([]);
      fireEvent.click(within(panel()).getByRole("button", { name: "Yes, land web: push and open its pull request" }));
      await waitFor(() => expect(calls(slot, "control").map((call) => call.input)).toEqual([{ slug: "csv", action: "land", repo: "web", confirm: true }]));
    });

    it("keeps a Viewed mark for each repo the same path changed in, and counts the files not viewed across every repo on the tab's badge", async () => {
      const slot = await mountChanges({ changes: () => landingChanges() }, landingView());
      const badge = () => slot.container.querySelector('[data-tab-badge="ship"]')?.textContent ?? null;
      await waitFor(() => expect(badge()).toBe("3"));
      await openView(slot, "Ship", "Changes");
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

    it("opens the first repo with work to land from the bar's Review changes, else the first repo's branch, and a ticket's from its menu", async () => {
      const slot = await mountChanges({ changes: () => landingChanges() }, landingView());
      fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
      await waitFor(() => expect(shown(slot)).toBe("branch:api"));
      await changesOf(slot, "CSV-1");
      await waitFor(() => expect(shown(slot)).toBe("merge:CSV-1"));
      slot.lifecycle.unmount();

      const landed = await mountChanges({ changes: () => landingChanges() }, landingView([web(), api({ toLand: false, landedAt: NOW - HOUR })]));
      // The page reopens on Ship's Changes, where Review changes would point at what is open; Work offers it.
      expect(landed.queryByRole("button", { name: "Review changes" })).toBeNull();
      fireEvent.click(landed.getByRole("tab", { name: "Work" }));
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

describe("work", () => {
  const cards = [
    card({ key: "CSV-1", title: "Order rows", state: "done", ready: false }),
    card({ key: "CSV-2", title: "Export endpoint", state: "working", attempt: 2, ready: false, threadId: "thr_w1", deps: ["CSV-1"] }),
    card({ key: "CSV-3", title: "Docs", state: "queued", ready: true }),
    card({ key: "CSV-4", title: "Guide", state: "queued", ready: false, deps: ["CSV-2"], waitingOn: ["CSV-2", "CSV-3"] }),
    card({ key: "CSV-5", title: "Fix flaky test", state: "blocked", ready: false, blockedReason: "Needs a decision.", ask: { question: "Which runner?", options: 3 }, deps: ["CSV-2"] }),
    card({ key: "CSV-6", title: "Old idea", state: "cancelled", ready: false }),
    card({ key: "CSV-7", title: "Review me", state: "review", ready: false, reviewRound: 2, threadId: "thr_r1", deps: ["CSV-2"] }),
    card({ key: "CSV-8", title: "Merge me", state: "merging", ready: false, deps: ["CSV-2"] }),
    card({ key: "CSV-9", title: "Open PR", state: "pr_open", ready: false, prUrl: "https://github.com/acme/shop/pull/9" }),
  ];
  const groupsOf = (slot: Slot) => [...slot.container.querySelectorAll<HTMLElement>("[data-move-group]")].map((group) => [group.getAttribute("data-move-group"), [...group.querySelectorAll("[data-row]")].map((row) => row.getAttribute("data-row"))]);
  const row = (slot: Slot, key: string) => slot.container.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
  const mountWork = async (board = cards, over: Partial<ProjectView> = {}, path = "csv", rpc: Partial<Handlers> = {}) => {
    const mounted = await mountPage(path, { project: () => projectView({ board: board.map((entry) => ({ ...entry, stateAt: projectView().now - 5 * HOUR })), ...over }), ticket: ({ key }) => ticketDetail({ key }), ...rpc });
    await mounted.slot.findByRole("tab", { name: "Work" });
    await waitFor(() => expect(mounted.slot.container.querySelector("[data-ticket-list], [data-map-stage]")).not.toBeNull());
    return mounted;
  };

  it("groups the tickets by whose move it is, in a fixed order, with Loom's own state words and Done folded", async () => {
    const { slot } = await mountWork();
    expect(groupsOf(slot)).toEqual([
      ["need", ["CSV-5"]],
      ["working", ["CSV-2", "CSV-7", "CSV-8"]],
      ["waiting", ["CSV-3", "CSV-4", "CSV-9"]],
      ["done", []],
    ]);
    expect(slot.container.querySelector('[data-move-group="need"] h3')!.textContent).toBe("Needs you1");
    expect(row(slot, "CSV-5").textContent).toContain("blocked · asks · 3 options");
    expect(row(slot, "CSV-7").textContent).toContain("in review · round 2");
    expect(row(slot, "CSV-9").textContent).toContain("PR open · #9 · in review");
    expect(row(slot, "CSV-4").textContent).toContain("queued · after CSV-2, CSV-3");
    expect(row(slot, "CSV-2").textContent).toContain("5h");
    // The lists are plain lists of named row buttons, one list per group.
    const need = slot.getByRole("list", { name: "Needs you" });
    expect(within(need).getByRole("button", { name: "CSV-5, blocked: Fix flaky test" })).toBeTruthy();
    const done = slot.container.querySelector<HTMLElement>('[data-move-group="done"] h3 button')!;
    expect(done.getAttribute("aria-expanded")).toBe("false");
    expect(done.textContent).toBe("Done1Cancelled 1");
    fireEvent.click(done);
    expect(groupsOf(slot).at(-1)).toEqual(["done", ["CSV-1", "CSV-6"]]);
  });

  it("puts a failure Loom retries in Failed and a merge to confirm in Ready for you, ahead of the work in flight", async () => {
    const now = projectView().now;
    const board = [
      card({ key: "CSV-2", title: "Export endpoint", state: "merging", ready: false, retry: { step: "merge", failures: 2, since: now - 60_000, until: now + 4 * 60_000, message: "deadline", kind: "unknown" } }),
      card({ key: "CSV-3", title: "Docs", state: "pr_open", ready: false, prUrl: "https://github.com/acme/shop/pull/3", mergeConfirm: { prUrl: "https://github.com/acme/shop/pull/3", sha: "c".repeat(40), ready: true, waiting: null, confirmed: false, requested: null } }),
      card({ key: "CSV-4", title: "Guide", state: "working", ready: false, waitsForSlot: true }),
    ];
    const { slot } = await mountWork(board);
    expect(groupsOf(slot).map(([group]) => group)).toEqual(["failed", "ready", "working"]);
    expect(row(slot, "CSV-2").textContent).toContain(`Failed · merge failed · retry ${clockTime(now + 4 * 60_000)}`);
    expect(row(slot, "CSV-3").textContent).toContain("PR open · #3 · confirm merge");
    expect(row(slot, "CSV-4").textContent).toContain("waits for a slot");
  });

  it("folds a group past what fits on the first screen, counts what it hides, and opens it in place", async () => {
    const many = Array.from({ length: 30 }, (_, at) => card({ key: `CSV-${at + 1}`, title: `Ticket ${at + 1}`, state: "working", ready: false }));
    const { slot } = await mountWork(many);
    const group = slot.container.querySelector<HTMLElement>('[data-move-group="working"]')!;
    const shown = group.querySelectorAll("[data-row]").length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(8);
    fireEvent.click(within(group).getByRole("button", { name: `${30 - shown} more` }));
    expect(group.querySelectorAll("[data-row]")).toHaveLength(30);
    fireEvent.click(within(group).getByRole("button", { name: "Fewer" }));
    expect(group.querySelectorAll("[data-row]")).toHaveLength(shown);
  });

  it("opens a ticket from its row, and with one open keeps the list beside it, compact, with the open row marked", async () => {
    const { slot, goTo } = await mountWork();
    fireEvent.click(within(row(slot, "CSV-2")).getByRole("button", { name: "CSV-2, working: Export endpoint" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-2")]);
    goTo("csv/CSV-2");
    await slot.findByRole("heading", { name: "Export endpoint", level: 1 });
    const open = within(row(slot, "CSV-2")).getByRole("button");
    expect(open.getAttribute("aria-current")).toBe("true");
    // Compact: one line per row, no facts.
    expect(row(slot, "CSV-7").textContent).not.toContain("round 2");
    expect(slot.container.querySelector("[data-work-pane] [data-ticket='CSV-2']")).not.toBeNull();
    // The pane names what it waits on and what it unblocks, from the board.
    const facts = slot.container.querySelector<HTMLElement>("[data-ticket-facts]")!;
    expect(facts.querySelector('[data-fact="waits-on"]')!.textContent).toContain("CSV-1");
    expect(facts.querySelector('[data-fact="unblocks"]')!.textContent).toBe("UnblocksCSV-4CSV-5CSV-7CSV-8");
    fireEvent.click(within(facts).getByRole("button", { name: "CSV-7" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv/CSV-7"));
    fireEvent.click(slot.getByRole("button", { name: "Close the ticket" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv"));
  });

  it("shows a row's whole title in a tip on keyboard focus when the row cuts it, and none for a title that fits", async () => {
    const long = "Core: lane header in request specs for every shard of the admin and storefront suites";
    const board = [card({ key: "CSV-1", title: long, state: "working", ready: false }), card({ key: "CSV-2", title: "Docs", state: "working", ready: false })];
    // jsdom has no layout: the long title overflows its box, the short one fits.
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-row-title") && this.textContent === long ? 500 : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-row-title") ? 100 : 0; } });
    try {
      const { slot } = await mountWork(board);
      const open = (key: string) => within(row(slot, key)).getByRole("button");
      expect(open("CSV-1").hasAttribute("title")).toBe(false);
      fireEvent.focus(open("CSV-2"));
      await new Promise((done) => setTimeout(done, 50));
      expect(within(document.body).queryByRole("tooltip")).toBeNull();
      fireEvent.blur(open("CSV-2"));
      fireEvent.focus(open("CSV-1"));
      expect((await within(document.body).findByRole("tooltip")).textContent).toBe(long);
      // Showing it opens nothing.
      expect(slot.inspection.navigateCalls).toEqual([]);
      fireEvent.blur(open("CSV-1"));
    } finally {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it("moves between rows with j and k, and leaves those keys to a field", async () => {
    const { slot } = await mountWork();
    const buttons = () => [...slot.container.querySelectorAll<HTMLButtonElement>("[data-open-row]")];
    buttons()[0]!.focus();
    fireEvent.keyDown(buttons()[0]!, { key: "j" });
    expect(document.activeElement).toBe(buttons()[1]);
    fireEvent.keyDown(buttons()[1]!, { key: "j" });
    fireEvent.keyDown(buttons()[2]!, { key: "k" });
    expect(document.activeElement).toBe(buttons()[1]);
    const filter = slot.getByRole("textbox", { name: "Filter tickets" });
    filter.focus();
    fireEvent.keyDown(filter, { key: "j" });
    expect(document.activeElement).toBe(filter);
  });

  it("filters by key or title, says when nothing matches and clears in one step", async () => {
    const { slot } = await mountWork();
    fireEvent.change(slot.getByRole("textbox", { name: "Filter tickets" }), { target: { value: "guide" } });
    expect(groupsOf(slot)).toEqual([["waiting", ["CSV-4"]]]);
    fireEvent.change(slot.getByRole("textbox", { name: "Filter tickets" }), { target: { value: "nothing like it" } });
    expect(slot.getByRole("status").textContent).toContain("No ticket matches");
    fireEvent.click(slot.getByRole("button", { name: "Clear filters" }));
    expect(groupsOf(slot)[0]).toEqual(["need", ["CSV-5"]]);
  });

  it("shows a draft's tickets as proposals under a note, with nothing to open", async () => {
    const board = [card({ key: "CSV-1", title: "Order rows" }), card({ key: "CSV-2", title: "Export endpoint", ready: false, deps: ["CSV-1"], waitingOn: ["CSV-1"] })];
    const { slot } = await mountWork(board, { overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {} }) });
    expect(slot.container.querySelector("[data-draft-note]")!.textContent).toBe("Draft v1: approving creates these 2 tickets. Until then they are proposals, not tickets to open.");
    expect(slot.container.querySelector('[data-move-group="paused"] h3')!.textContent).toContain("Proposed");
    expect(row(slot, "CSV-1").hasAttribute("data-draft")).toBe(true);
    expect(row(slot, "CSV-2").textContent).toContain("proposed · after CSV-1");
    expect(slot.container.querySelector("[data-open-row]")).toBeNull();
    // The map and the exact list draw the proposals too, and open none of them.
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-work-mode]")!).getByRole("button", { name: "Map" }));
    const stage = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
    expect(stage.querySelectorAll("[data-map-node]").length).toBeGreaterThan(0);
    expect(stage.querySelector("button[data-map-node]")).toBeNull();
    fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
    expect(slot.container.querySelector("[data-exact-list] [data-exact-row] button")).toBeNull();
  });

  it("draws the tickets as a map one key away, walks it by keyboard, and has the exact list one switch away", async () => {
    const { slot } = await mountWork();
    const list = slot.container.querySelector("[data-ticket-list]")!;
    fireEvent.keyDown(list.querySelector("[data-open-row]")!, { key: "m" });
    const stage = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
    // One node per ticket, whatever kinds join it.
    const nodes = [...stage.querySelectorAll<HTMLButtonElement>("[data-map-node]")];
    expect(new Set(nodes.map((node) => node.dataset.mapNode)).size).toBe(nodes.length);
    const map = within(stage).getByRole("group", { name: /arrows move along the edges/ });
    // One tab stop: the focus, else the first node.
    expect(nodes.filter((node) => node.tabIndex === 0)).toHaveLength(1);
    // An unphased project's map starts on what needs the person, with what it waits on to its left.
    const first = stage.querySelector<HTMLButtonElement>('[data-map-node][tabindex="0"]')!;
    expect(first.dataset.mapNode).toBe("CSV-5");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    const next = document.activeElement as HTMLElement;
    expect(next.dataset.mapNode).toBe("CSV-2");
    expect(next.tabIndex).toBe(0);
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.click(first);
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed(`csv/${first.dataset.mapNode}`));
    expect(map).toBeTruthy();
    fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
    const table = slot.container.querySelector<HTMLElement>("[data-exact-list]")!;
    expect(table.textContent).toContain("Every ticket: 7 open, most unblocked first. Unblocks counts open tickets, directly and in all.");
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Ticket", "State", "Waits on", "Unblocks directly", "In all"]);
    expect(table.querySelector("[data-exact-row]")!.getAttribute("data-exact-row")).toBe("CSV-2");
    expect(table.querySelector('[data-exact-row="CSV-2"]')!.textContent).toContain("CSV-1");
    fireEvent.click(within(stage).getByRole("button", { name: "List" }));
    expect(slot.container.querySelector("[data-ticket-list]")).not.toBeNull();
  });

  it("never shrinks a map below its text size: the side map folds to what needs you, its neighbours, and counts the rest", async () => {
    const phase = (ref: string, title: string, state: "done" | "active") => ({ ref, title, goal: "", doneWhen: [], outline: [], report: null, maxTickets: 12, state, tickets: { total: 0, done: 0, cancelled: 0, open: 0 } });
    const mk = (key: string, state: BoardCard["state"], deps: string[] = [], phaseRef = "large") => card({ key, title: `${key} title`, state, ready: false, deps, waitingOn: deps, phase: phaseRef });
    const board = [mk("CSV-3", "done", [], "p1"), mk("CSV-6", "done", ["CSV-3"]), mk("CSV-7", "done", ["CSV-3"]), mk("CSV-8", "done", ["CSV-3"]), mk("CSV-9", "working", ["CSV-6", "CSV-7", "CSV-8"]), mk("CSV-10", "review", ["CSV-6", "CSV-7", "CSV-8"]), mk("CSV-11", "blocked", ["CSV-6", "CSV-7", "CSV-8"]), mk("CSV-12", "pr_open", ["CSV-7"]), mk("CSV-13", "queued", ["CSV-10"]), mk("CSV-16", "queued", ["CSV-11", "CSV-13"]), mk("CSV-17", "queued", ["CSV-9", "CSV-11"])];
    // jsdom has no layout: give the maps a 300 px frame, a phone's pane.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-phase-map") || this.hasAttribute("data-dep-map") ? 300 : 0; } });
    try {
      const { slot } = await mountWork(board, { phases: [phase("p1", "A usable download", "done"), phase("large", "Large exports", "active")] });
      const side = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-phase-summary] [data-phase-map]")!);
      expect(side.dataset.mapFold).not.toBe("phase");
      expect(side.querySelector("[data-map-node][aria-current]")).toBeNull();
      expect(side.querySelector('[data-map-node="CSV-11"]')).not.toBeNull();
      expect(side.querySelector('[data-map-node="CSV-12"]')).toBeNull();
      expect(side.querySelector("figcaption")!.textContent).toMatch(/^\d+ of the phase's 10 tickets: CSV-11, what it waits on and /);
      for (const camera of slot.container.querySelectorAll<HTMLElement>("[data-map-camera]")) expect(camera.style.transform).toBe("scale(1.0000)");
    } finally {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  describe("Map's Show done", () => {
    const phase = (ref: string, title: string, state: "done" | "active") => ({ ref, title, goal: "", doneWhen: [], outline: [], report: null, maxTickets: 12, state, tickets: { total: 0, done: 0, cancelled: 0, open: 0 } });
    const mk = (key: string, state: BoardCard["state"], deps: string[] = [], phaseRef: string | null = "large") => card({ key, title: `${key} title`, state, ready: false, deps, waitingOn: deps, phase: phaseRef });
    const phases = [phase("p1", "A usable download", "done"), phase("large", "Large exports", "active")];
    const openBoard = [mk("CSV-3", "done", [], "p1"), mk("CSV-4", "cancelled", [], "p1"), mk("CSV-6", "done", ["CSV-3"]), mk("CSV-7", "working", ["CSV-3"]), mk("CSV-8", "queued", ["CSV-6", "CSV-7"])];
    const toMap = async (slot: Awaited<ReturnType<typeof mountWork>>["slot"]) => {
      fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-work-mode]")!).getByRole("button", { name: "Map" }));
      return waitFor(() => slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
    };
    const nodeKeys = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-map-node]")].map((node) => node.dataset.mapNode).sort();

    it("is off while tickets are open, and leaves the phase map as it was", async () => {
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      expect(within(stage).getByRole<HTMLInputElement>("switch", { name: "Show done" }).checked).toBe(false);
      expect(stage.querySelector("[data-project-map]")).toBeNull();
      // Today's map: the active phase, with phase 1 as one stub.
      expect(nodeKeys(stage.querySelector("[data-phase-map]")!)).toEqual(["CSV-6", "CSV-7", "CSV-8"]);
      expect(stage.querySelector('[data-map-stub="phase:p1"]')!.textContent).toBe("Phase 1");
      expect(stage.querySelector("[data-map-band]")).toBeNull();
      expect(stage.querySelector("h2")!.textContent).toBe("Phase 2Large exports");
    });

    it("draws every phase as a band with its done and cancelled tickets, remembers the choice, and the exact list follows", async () => {
      const first = await mountWork(openBoard, { phases });
      let stage = await toMap(first.slot);
      fireEvent.click(within(stage).getByRole("switch", { name: "Show done" }));
      const map = await waitFor(() => stage.querySelector<HTMLElement>("[data-project-map]")!);
      expect(nodeKeys(map)).toEqual(["CSV-3", "CSV-4", "CSV-6", "CSV-7", "CSV-8"]);
      expect(map.querySelector("[data-map-stub]")).toBeNull();
      expect([...map.querySelectorAll<HTMLElement>("[data-map-band]")].map((band) => [band.dataset.mapBand, band.textContent])).toEqual([
        ["p1", "1A usable download1 of 2 done · 1 cancelled"],
        ["large", "2Large exports1 of 3 done"],
      ]);
      expect(map.querySelector('[data-map-band="large"]')!.getAttribute("data-on")).toBe("true");
      expect(map.querySelector('[data-map-node="CSV-3"]')!.getAttribute("data-closed")).toBe("done");
      expect(map.querySelector('[data-map-node="CSV-4"]')!.getAttribute("data-closed")).toBe("cancelled");
      expect(map.querySelector('[data-map-node="CSV-7"]')!.hasAttribute("data-closed")).toBe(false);
      // Every edge between them, the cross-phase ones included.
      expect(map.querySelectorAll("[data-edge]")).toHaveLength(4);
      expect([...map.querySelectorAll<HTMLElement>("[data-legend]")].map((entry) => entry.textContent)).toEqual(["done", "cancelled"]);
      expect(stage.querySelector("h2")!.textContent).toBe("Whole project2 of 5 done · 1 cancelled");
      expect(map.querySelector("figcaption")!.textContent).toBe("5 tickets in 2 phases · 2 of 5 done · 1 cancelled");
      // Keyboard and Enter still open tickets.
      const start = map.querySelector<HTMLButtonElement>('[data-map-node][tabindex="0"]')!;
      start.focus();
      fireEvent.keyDown(start, { key: "End" });
      fireEvent.click(document.activeElement!);
      expect(first.slot.inspection.navigateCalls.at(-1)).toEqual(pushed(`csv/${(document.activeElement as HTMLElement).dataset.mapNode}`));
      // The exact list lists every ticket too, open first, with its phase.
      fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
      const table = stage.querySelector<HTMLElement>("[data-exact-list]")!;
      expect(table.textContent).toContain("Every ticket: 5 tickets, 2 open; open ones first");
      expect([...table.querySelectorAll<HTMLElement>("[data-exact-row]")].map((one) => one.dataset.exactRow)).toEqual(["CSV-7", "CSV-8", "CSV-3", "CSV-6", "CSV-4"]);
      expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toContain("Phase");
      fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
      // Remembered for this project: it is on again after a reload of the page.
      first.slot.unmount();
      const again = await mountWork(openBoard, { phases });
      stage = await waitFor(() => again.slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
      expect(within(stage).getByRole<HTMLInputElement>("switch", { name: "Show done" }).checked).toBe(true);
      fireEvent.click(within(stage).getByRole("switch", { name: "Show done" }));
      await waitFor(() => expect(stage.querySelector("[data-phase-map]")).not.toBeNull());
    });

    it("is on for a project with no open tickets, so a finished project's map is never empty", async () => {
      const board = [mk("CSV-3", "done", [], "p1"), mk("CSV-6", "done", ["CSV-3"]), mk("CSV-7", "cancelled", ["CSV-3"])];
      const { slot } = await mountWork(board, { phases: [phase("p1", "A usable download", "done"), phase("large", "Large exports", "done")], overview: overview({ state: "done" }) });
      const stage = await toMap(slot);
      expect(within(stage).getByRole<HTMLInputElement>("switch", { name: "Show done" }).checked).toBe(true);
      expect(nodeKeys(stage.querySelector("[data-project-map]")!)).toEqual(["CSV-3", "CSV-6", "CSV-7"]);
      expect(stage.textContent).not.toContain("No open tickets");
    });

    it("draws an unphased finished project's whole graph instead of the hop map", async () => {
      const board = [mk("CSV-1", "done", [], null), mk("CSV-2", "done", ["CSV-1"], null), mk("CSV-3", "done", ["CSV-1"], null), mk("CSV-4", "done", ["CSV-2", "CSV-3"], null), mk("CSV-5", "done", [], null)];
      const { slot } = await mountWork(board, { phases: null, overview: overview({ state: "done" }) });
      const stage = await toMap(slot);
      expect(stage.querySelector("[data-hop-map]")).toBeNull();
      const map = stage.querySelector<HTMLElement>("[data-project-map]")!;
      expect(nodeKeys(map)).toEqual(["CSV-1", "CSV-2", "CSV-3", "CSV-4", "CSV-5"]);
      expect(map.querySelector("[data-map-band]")).toBeNull();
      expect(map.querySelectorAll("[data-edge]")).toHaveLength(4);
      expect(map.querySelector("figcaption")!.textContent).toBe("5 tickets · 5 of 5 done");
    });
  });

  describe("Map's Export", () => {
    const phase = (ref: string, title: string, state: "done" | "active") => ({ ref, title, goal: "", doneWhen: [], outline: [], report: null, maxTickets: 12, state, tickets: { total: 0, done: 0, cancelled: 0, open: 0 } });
    const mk = (key: string, state: BoardCard["state"], deps: string[] = [], phaseRef: string | null = "large") => card({ key, title: `${key} title`, state, ready: false, deps, waitingOn: deps, phase: phaseRef });
    const phases = [phase("p1", "A usable download", "done"), phase("large", "Large exports", "active")];
    const openBoard = [mk("CSV-3", "done", [], "p1"), mk("CSV-4", "cancelled", [], "p1"), mk("CSV-6", "done", ["CSV-3"]), mk("CSV-7", "working", ["CSV-3"]), mk("CSV-8", "queued", ["CSV-6", "CSV-7"])];
    const toMap = async (slot: Awaited<ReturnType<typeof mountWork>>["slot"]) => {
      fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-work-mode]")!).getByRole("button", { name: "Map" }));
      return waitFor(() => slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
    };
    /** Radix opens a menu from the keyboard in jsdom, and names it by its trigger. */
    const openExport = async (stage: HTMLElement) => {
      fireEvent.keyDown(within(stage).getByRole("button", { name: "Export" }), { key: "Enter" });
      return within(await within(document.body).findByRole("menu", { name: "Export" }));
    };
    const DAY = /\d{4}-\d{2}-\d{2}/.source;
    // jsdom's Blob has no text().
    const textOf = (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    let saved: Array<{ fileName: string; blob: Blob }> = [];
    beforeEach(() => {
      saved = [];
      vi.spyOn(exportHost, "save").mockImplementation(async (request) => {
        saved.push(request);
        return "started";
      });
      vi.spyOn(exportHost, "rasterize").mockImplementation(async (_svg, width, height) => new Blob([`png ${width}x${height}`], { type: "image/png" }));
      // jsdom has no canvas; the export measures text by estimate there.
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    });
    afterEach(() => vi.restoreAllMocks());

    it("sits in the Map's header with Copy image and both downloads, and hides while the exact list is shown", async () => {
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      const header = stage.querySelector("header")!;
      expect(within(header).getByRole("button", { name: "Export" })).toBeTruthy();
      const menu = await openExport(stage);
      expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Copy image", "Download PNG", "Download SVG"]);
      fireEvent.keyDown(menu.getAllByRole("menuitem")[0]!, { key: "Escape" });
      fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
      await waitFor(() => expect(within(stage).queryByRole("button", { name: "Export" })).toBeNull());
      fireEvent.click(within(stage).getByRole("switch", { name: "Exact list" }));
      await waitFor(() => expect(within(stage).getByRole("button", { name: "Export" })).toBeTruthy());
    });

    it("downloads an SVG drawn from the map's own layout, named for the project, the phase and the day", async () => {
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Download SVG" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      const { fileName, blob } = saved[0]!;
      expect(fileName).toMatch(new RegExp(`^CSV-map-phase-2-${DAY}\\.svg$`));
      expect(blob.type).toBe("image/svg+xml");
      const svg = await textOf(blob);
      expect(svg.match(/ data-node="/g)).toHaveLength(stage.querySelectorAll("[data-map-node]").length);
      expect(svg.match(/ data-edge="/g)).toHaveLength(stage.querySelectorAll("[data-edge]").length);
      expect(svg.match(/ data-stub="/g)).toHaveLength(stage.querySelectorAll("[data-map-stub]").length);
      expect(svg).toContain("Phase 2 of 2 · Large exports · 3 tickets · 1 done");
      expect(svg).toContain(">CSV</text>");
      expect(svg).toContain(">CSV export</text>");
      expect(svg).not.toContain("var(");
      expect(svg).not.toContain("foreignObject");
      expect(toast.success).toHaveBeenCalledWith(`Saved ${fileName}`);
    });

    it("downloads a PNG drawn at 2x from the same picture", async () => {
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Download PNG" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]!.fileName).toMatch(new RegExp(`^CSV-map-phase-2-${DAY}\\.png$`));
      const [svg, width, height] = vi.mocked(exportHost.rasterize).mock.calls[0]!;
      const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
      expect([width, height]).toEqual([Number(box[1]) * 2, Number(box[2]) * 2]);
      expect(svg).toContain(`width="${width}" height="${height}"`);
      expect(toast.success).toHaveBeenCalledWith(`Saved ${saved[0]!.fileName}`);
    });

    it("copies the PNG through a clipboard item made inside the click, and offers Download PNG when the clipboard refuses it", async () => {
      const items: Array<Record<string, Promise<Blob>>> = [];
      class Item {
        constructor(data: Record<string, Promise<Blob>>) {
          items.push(data);
        }
      }
      const write = vi.fn(async (list: unknown[]) => {
        await items.at(-1)!["image/png"];
        return void list;
      });
      vi.spyOn(exportHost, "ClipboardItem").mockReturnValue(Item as unknown as typeof ClipboardItem);
      vi.spyOn(exportHost, "clipboard").mockReturnValue({ write });
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Copy image" }));
      // The write starts in the click itself, with the PNG still a promise (Safari's form).
      expect(write).toHaveBeenCalledTimes(1);
      expect(Object.keys(items[0]!)).toEqual(["image/png"]);
      expect(items[0]!["image/png"]).toBeInstanceOf(Promise);
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied the map of CSV, 3 tickets"));
      expect(await textOf(await items[0]!["image/png"])).toMatch(/^png \d+x\d+$/);
      expect(saved).toHaveLength(0);

      write.mockRejectedValueOnce(Object.assign(new Error("Write permission denied."), { name: "NotAllowedError" }));
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Copy image" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy: the clipboard refused the image", expect.objectContaining({ action: expect.objectContaining({ label: "Download PNG" }) })));
      const offer = vi.mocked(toast.error).mock.calls.at(-1)![1] as unknown as { action: { onClick(): void } };
      offer.action.onClick();
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]!.fileName).toMatch(new RegExp(`^CSV-map-phase-2-${DAY}\\.png$`));
    });

    it("says so when the browser cannot put an image on the clipboard, and offers Download PNG", async () => {
      vi.spyOn(exportHost, "ClipboardItem").mockReturnValue(undefined);
      const { slot } = await mountWork(openBoard, { phases });
      const stage = await toMap(slot);
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Copy image" }));
      expect(toast.error).toHaveBeenCalledWith("Couldn't copy: this browser can't put an image on the clipboard", expect.objectContaining({ action: expect.objectContaining({ label: "Download PNG" }) }));
      expect(exportHost.rasterize).not.toHaveBeenCalled();
    });

    it("exports the whole project with Show done, and a draft with its proposed tickets", async () => {
      const first = await mountWork(openBoard, { phases });
      let stage = await toMap(first.slot);
      fireEvent.click(within(stage).getByRole("switch", { name: "Show done" }));
      await waitFor(() => expect(stage.querySelector("[data-project-map]")).not.toBeNull());
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Download SVG" }));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect(saved[0]!.fileName).toMatch(new RegExp(`^CSV-map-whole-${DAY}\\.svg$`));
      const whole = await textOf(saved[0]!.blob);
      expect(whole).toContain("Whole project · 5 tickets · 2 done · 1 cancelled");
      expect(whole.match(/ data-band="/g)).toHaveLength(2);
      expect(whole.match(/ data-node="/g)).toHaveLength(5);
      fireEvent.click(within(stage).getByRole("switch", { name: "Show done" }));
      first.slot.unmount();

      const draft = await mountWork(openBoard.map((one) => ({ ...one, state: "queued" as const })), { phases, overview: overview({ state: "draft" }) });
      stage = await toMap(draft.slot);
      fireEvent.click((await openExport(stage)).getByRole("menuitem", { name: "Download SVG" }));
      await waitFor(() => expect(saved).toHaveLength(2));
      expect(saved[1]!.fileName).toMatch(new RegExp(`^CSV-map-draft-phase-2-${DAY}\\.svg$`));
      expect(await textOf(saved[1]!.blob)).toContain("Draft v1 · Phase 2 of 2 · Large exports · 3 proposed tickets");
    });
  });

  it("reaches a capped column's and-N-more by keyboard, opens it, and puts focus on the first ticket it revealed", async () => {
    const board = [card({ key: "CSV-1", title: "Shared schema", state: "blocked", ready: false }), ...Array.from({ length: 10 }, (_, at) => card({ key: `CSV-${at + 2}`, title: `Uses the schema ${at + 2}`, state: "queued", ready: false, deps: ["CSV-1"], waitingOn: ["CSV-1"] }))];
    const { slot } = await mountWork(board);
    fireEvent.keyDown(slot.container.querySelector("[data-open-row]")!, { key: "m" });
    const stage = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-map-stage]")!);
    const start = stage.querySelector<HTMLButtonElement>('[data-map-stop][tabindex="0"]')!;
    expect(start.dataset.mapNode).toBe("CSV-1");
    const before = new Set([...stage.querySelectorAll<HTMLElement>("[data-map-node]")].map((node) => node.dataset.mapNode));
    expect(before.size).toBe(8);
    start.focus();
    // End reaches the last stop, the column's "and 3 more"; Up and Down walk past it and back.
    fireEvent.keyDown(start, { key: "End" });
    const more = document.activeElement as HTMLButtonElement;
    expect(more.dataset.mapMore).toBeDefined();
    expect(more.getAttribute("aria-label")).toBe("Show 3 more tickets in this column");
    expect(more.tabIndex).toBe(0);
    fireEvent.keyDown(more, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement).dataset.mapNode).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    await waitFor(() => expect(stage.querySelector("[data-map-more]")).toBeNull());
    expect(stage.querySelectorAll("[data-map-node]")).toHaveLength(11);
    const revealed = document.activeElement as HTMLElement;
    expect(revealed.dataset.mapNode).toBeDefined();
    expect(before.has(revealed.dataset.mapNode)).toBe(false);
    expect(revealed.tabIndex).toBe(0);
  });

  it("says in Confirm merge what merging changes for each ticket that waits on it, with what still holds it, as Ship does", async () => {
    const URL = "https://github.com/acme/shop/pull/12";
    const board = [
      card({ key: "CSV-12", title: "Gzip", state: "pr_open", ready: false, prUrl: URL }),
      card({ key: "CSV-15", title: "Rate limit", state: "pr_open", ready: false, prUrl: "https://github.com/acme/shop/pull/15", prereqs: [{ key: "CSV-12", kind: "merge" }] }),
      card({ key: "CSV-16", title: "Retry", state: "pr_open", ready: false, prUrl: "https://github.com/acme/shop/pull/16", prereqs: [{ key: "CSV-12", kind: "merge" }] }),
      card({ key: "CSV-17", title: "Load test", state: "queued", ready: false, prereqs: [{ key: "CSV-9", kind: "work" }, { key: "CSV-12", kind: "live" }] }),
    ];
    const base = { title: "", repo: null, base: "main", prOpen: true, elsewhere: null, step: 2, stackedOn: null, unblocks: [], checks: null, draft: false, draftHold: null, publishWait: null, review: "APPROVED" as const, reviewRead: true, conflicts: false, behind: null, refreshBehind: null, trap: false, mergedInto: null, mergedIntoState: null, blockedReason: null };
    const waitsOn = [{ key: "CSV-12", why: "merge_after" as const, repo: null, prNumber: "12" }];
    const mergeOrder: MergeOrderView = {
      repos: [null],
      steps: 2,
      counts: { open: 3, first: 1, ready: 1, wrong: 0 },
      entries: [
        { ...base, key: "CSV-12", state: "pr_open", prUrl: URL, prNumber: "12", step: 1, waitsOn: [], verdict: "ready", holds: [], prHolds: [] },
        { ...base, key: "CSV-15", state: "pr_open", prUrl: "https://github.com/acme/shop/pull/15", prNumber: "15", waitsOn, verdict: "after", holds: [], prHolds: [{ code: "failing", count: 1 }] },
        { ...base, key: "CSV-16", state: "pr_open", prUrl: "https://github.com/acme/shop/pull/16", prNumber: "16", waitsOn, verdict: "after", holds: [], prHolds: [] },
      ],
    };
    const confirm = { prUrl: URL, sha: "a".repeat(40), ready: true, waiting: null, confirmed: false, requested: null };
    const { slot } = await mountWork(board, { mergeOrder }, "csv/CSV-12", { ticket: ({ key }) => ticketDetail({ key, state: "pr_open", prUrl: URL, mergeConfirm: confirm }) });
    const then = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-merge-then]")!);
    expect(then.textContent).toBe("Then CSV-15 stops waiting on CSV-12, but 1 check failing still holds it · CSV-16 stops waiting on CSV-12 and can merge · CSV-17 still needs CSV-12 live");
  });

  it("draws a worker's structured ask as a form with its pick preselected, and sends the option chosen with the note", async () => {
    const ask = { question: "How should the memory check run?", options: [{ label: "Generate rows in the test", consequence: "no disk" }, { label: "Nightly runner; 200k rows in CI", consequence: "nightly runner has 200 GB" }, { label: "Lower the check to 1M rows", consequence: null }], recommended: 1 };
    const block = { id: 6, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "block" as const, body: "The fixture does not fit.", at: 6 };
    const ticketAction = vi.fn(() => ticketDetail({ key: "CSV-5", state: "queued" }));
    const { slot } = await mountWork(cards, {}, "csv/CSV-5", { ticket: () => ticketDetail({ key: "CSV-5", state: "blocked", attempt: 1, blockedReason: "The fixture does not fit.", posts: [block], ask }), ticketAction });
    const form = await slot.findByRole("radiogroup", { name: "How should the memory check run?" });
    const options = within(form).getAllByRole("radio") as HTMLInputElement[];
    expect(options).toHaveLength(4);
    expect(options.map((option) => option.checked)).toEqual([false, true, false, false]);
    expect(form.querySelector('[data-ask-option="1"]')!.textContent).toContain("Recommended");
    expect(form.querySelector('[data-ask-option="1"]')!.textContent).toContain("nightly runner has 200 GB");
    const note = slot.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    expect(note.placeholder).toBe("Note (optional)");
    // A digit picks an option; Other asks for the person's own answer.
    fireEvent.keyDown(form, { key: "4" });
    expect(options[3]!.checked).toBe(true);
    expect(note.placeholder).toBe("Your answer for the next worker (required)");
    const requeue = slot.getByRole("button", { name: "Requeue · attempt 2" }) as HTMLButtonElement;
    expect(requeue.disabled).toBe(true);
    fireEvent.keyDown(form, { key: "1" });
    expect(options[0]!.checked).toBe(true);
    fireEvent.change(note, { target: { value: "Keep it under a minute." } });
    fireEvent.click(requeue);
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-5", action: "requeue", note: "Generate rows in the test\n\nKeep it under a minute.", confirm: true }));
  });

  it("docks the answer at the bottom on a phone, and asks for the answer before it offers Requeue", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      const ticketAction = vi.fn(() => ticketDetail({ key: "CSV-5", state: "queued" }));
      const { slot } = await mountWork(cards, {}, "csv/CSV-5", { ticket: () => ticketDetail({ key: "CSV-5", state: "blocked", attempt: 1, blockedReason: "Needs the staging key." }), ticketAction });
      const dock = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-answer-dock]")!);
      expect(dock.className).toContain("sticky");
      expect(dock.className).toContain("safe-area-inset-bottom");
      // Only the dock holds the action, and with no answer yet it takes the person to the note.
      const callout = slot.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
      expect(within(callout).queryByRole("button", { name: /^Requeue/ })).toBeNull();
      const note = slot.getByRole("textbox", { name: "Note" });
      expect(note.className).toContain("text-[16px]");
      fireEvent.click(within(dock).getByRole("button", { name: "Write your answer to requeue" }));
      expect(document.activeElement).toBe(note);
      fireEvent.change(note, { target: { value: "The key is in the vault now." } });
      fireEvent.click(within(dock).getByRole("button", { name: "Requeue · attempt 2" }));
      await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-5", action: "requeue", note: "The key is in the vault now.", confirm: true }));
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    }
  });

  it("shows a ticket that cannot load in its own pane, with the list still beside it", async () => {
    const { slot } = await mountWork(cards, {}, "csv/CSV-2", {
      ticket: () => {
        throw new Error("CSV-2 is no longer blocked.");
      },
    });
    const error = await waitFor(() => slot.container.querySelector<HTMLElement>("[data-work-pane] [data-ticket-error]")!);
    expect(error.textContent).toContain("Could not load CSV-2");
    expect(error.textContent).toContain("CSV-2 is no longer blocked.");
    expect(slot.container.querySelector("[data-ticket-list]")).not.toBeNull();
    expect(within(error).getByRole("button", { name: "Try again" })).toBeTruthy();
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
    // As on the server, the ticket a change returns is the one the page reads after it.
    let view = ticketDetail({ posts, activity: withItems([]), ...over });
    const { slot } = await mountPage("csv/CSV-2", {
      project: () => projectView(),
      ticket: () => view,
      ...rpc,
      reply: async (input) => (view = await (rpc.reply ?? unexpected)(input)),
      ticketAction: async (input) => (view = await (rpc.ticketAction ?? unexpected)(input)),
    });
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
    ticketTab(slot, "Brief");
    expect(slot.container.querySelector("[data-ticket-brief] [data-ac]")!.textContent).toContain("WHEN the endpoint is called THE SYSTEM SHALL stream a CSV");
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
    ticketTab(slot, "Agents");
    const row = (id: string) => slot.container.querySelector<HTMLElement>(`[data-ticket-details] [data-ticket-threads] [data-thread-row="${id}"]`)!;
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
    expect(box.placeholder).toBe("Reply on CSV-2…");
    expect(slot.container.querySelector("[data-reply-hint]")!.textContent).toBe("The worker gets this now.");
    expect((slot.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  Please add a test.  " } });
    fireEvent.click(slot.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(reply).toHaveBeenCalledWith({ key: "CSV-2", body: "Please add a test.", confirm: true }));
    await waitFor(() => expect((slot.getByRole("textbox", { name: "New reply" }) as HTMLTextAreaElement).value).toBe(""));
  });

  it("shows Requeue only for a blocked ticket, and sends the action with the note after a second click", async () => {
    const working = await mountTicket();
    expect(working.queryByRole("button", { name: /^Requeue/ })).toBeNull();
    expect(working.container.querySelector("[data-blocked-callout]")).toBeNull();
    working.lifecycle.unmount();

    const block = { id: 6, parentId: null, depth: 0, authorKind: "worker" as const, authorThreadId: "thr_w1", kind: "block" as const, body: "Needs a decision. Which API?", at: 6 };
    const ticketAction = vi.fn(() => ticketDetail({ state: "queued", posts }));
    const blocked = { state: "blocked" as const, blockedReason: "Needs a decision. Which API?", replyTo: "planner" as const, stoppedFrom: "working" as const, posts: [...posts, block] };
    const slot = await mountTicket({ ...blocked, activity: withItems([{ type: "post", postId: 6 }], { outcome: "blocked", endedAt: Date.now() }) }, { ticketAction });
    const callout = slot.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
    expect(callout.hasAttribute("data-ticket-actions")).toBe(true);
    expect(callout.textContent).toContain("Worker asks");
    expect(callout.textContent).toContain("Needs a decision. Which API?");
    expect(callout.textContent).toContain("Or reply on the post: the planner gets it now and can requeue the ticket itself.");
    expect((within(callout).getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).placeholder).toBe("Your answer for the next worker (required)");
    expect((within(callout).getByRole("button", { name: "Requeue · attempt 2" }) as HTMLButtonElement).disabled).toBe(true);
    const menu = await ticketMenu(slot);
    expect(menu.queryByRole("menuitem", { name: "Block…" })).toBeNull();
    expect(menu.getByRole("menuitem", { name: "Cancel ticket…" })).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    fireEvent.change(within(callout).getByRole("textbox", { name: "Note" }), { target: { value: "Use the v2 API" } });
    // The typed note is the deliberate step, so Requeue takes one click.
    fireEvent.click(within(callout).getByRole("button", { name: "Requeue · attempt 2" }));
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-2", action: "requeue", note: "Use the v2 API", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-ticket-header] [data-state-badge]")!.textContent).toBe("queued"));
    expect(toast.success).toHaveBeenCalledWith("CSV-2 requeued");
    slot.lifecycle.unmount();

    const refused = await mountTicket({ ...blocked, posts, replyTo: null, blockedReason: "bb refused to start a worker: HTTP 400" });
    const plain = refused.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
    expect(plain.textContent).toContain("Blocked");
    expect(plain.textContent).not.toContain("Worker asks");
    expect(plain.textContent).not.toContain("Or reply on the post");
    expect(within(plain).queryByRole("button", { name: "Read the post that blocked it" })).toBeNull();
  });

  it("offers Review again as is beside Requeue only when Loom says it may, and sends it with no note needed", async () => {
    const block = { id: 6, parentId: null, depth: 0, authorKind: "loom" as const, authorThreadId: null, kind: "block" as const, body: "reviewers ended without a verdict", at: 6 };
    const blocked = { state: "blocked" as const, blockedReason: "reviewers ended without a verdict", replyTo: null, stoppedFrom: "review" as const, posts: [...posts, block] };
    const without = await mountTicket(blocked);
    expect(within(without.container.querySelector<HTMLElement>("[data-blocked-callout]")!).queryByRole("button", { name: "Review again as is" })).toBeNull();
    without.lifecycle.unmount();

    const ticketAction = vi.fn(() => ticketDetail({ state: "review", posts }));
    const slot = await mountTicket({ ...blocked, reviewAgain: true }, { ticketAction });
    const callout = slot.container.querySelector<HTMLElement>("[data-blocked-callout]")!;
    expect(callout.querySelector("[data-review-again]")!.textContent).toContain("starts no worker");
    const button = within(callout).getByRole("button", { name: "Review again as is" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(ticketAction).toHaveBeenCalledWith({ key: "CSV-2", action: "review", note: "", confirm: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("CSV-2 sent back as it is"));
  });

  // Tony's review: the button sent only the key, so the server confirmed whatever head it found when the request ran.
  it("offers Confirm merge on a manual merge, sends the pull request and commit it shows, and disarms when the head moves", async () => {
    const URL = "https://github.com/acme/shop/pull/2";
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const shown = (sha: string, over: Partial<MergeConfirmView> = {}): MergeConfirmView => ({ prUrl: URL, sha, ready: true, waiting: null, confirmed: false, requested: null, ...over });
    const confirmMerge = vi.fn((_input: unknown) => ticketDetail({ posts, state: "pr_open", mergeConfirm: shown(A, { ready: false, confirmed: true }) }));
    let view = ticketDetail({ posts, activity: withItems([]), state: "pr_open", mergeConfirm: shown(A) });
    const { slot } = await mountPage("csv/CSV-2", { ticket: () => view, confirmMerge: async (input) => (view = await confirmMerge(input)) });
    await slot.findByRole("heading", { name: /Export endpoint/ });
    expect(slot.container.querySelector("[data-merge-confirm]")!.textContent).toContain("Ready to merge at aaaaaaaaaaaa. auto_merge.mode is manual, so Loom waits for you to confirm the merge of this commit.");
    fireEvent.click(slot.getByRole("button", { name: "Confirm merge" }));
    fireEvent.click(slot.getByRole("button", { name: "Yes, merge aaaaaaaaaaaa" }));
    await waitFor(() => expect(confirmMerge).toHaveBeenLastCalledWith({ key: "CSV-2", prUrl: URL, sha: A, confirm: true }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Confirm merge" })).toBeNull());
    expect(slot.container.querySelector("[data-merge-confirm]")!.textContent).toContain("You confirmed the merge of aaaaaaaaaaaa.");
    slot.lifecycle.unmount();

    // Armed for one head, the button disarms when the page shows another, and its next click only arms it again.
    let moving = ticketDetail({ posts, activity: withItems([]), state: "pr_open", mergeConfirm: shown(A) });
    const never = vi.fn(() => moving);
    const second = await mountPage("csv/CSV-2", { ticket: () => moving, confirmMerge: never });
    await second.slot.findByRole("heading", { name: /Export endpoint/ });
    fireEvent.click(second.slot.getByRole("button", { name: "Confirm merge" }));
    expect(second.slot.getByRole("button", { name: "Yes, merge aaaaaaaaaaaa" })).toBeTruthy();
    moving = ticketDetail({ posts, activity: withItems([]), state: "pr_open", mergeConfirm: shown(B) });
    await second.slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(second.slot.container.querySelector("[data-merge-confirm]")!.getAttribute("data-sha")).toBe(B));
    expect(second.slot.queryByRole("button", { name: /^Yes, / })).toBeNull();
    fireEvent.click(second.slot.getByRole("button", { name: "Confirm merge" }));
    expect(never).not.toHaveBeenCalled();
    second.slot.lifecycle.unmount();

    const plain = await mountTicket({ state: "pr_open" });
    expect(plain.queryByRole("button", { name: "Confirm merge" })).toBeNull();
    expect(plain.container.querySelector("[data-merge-confirm]")).toBeNull();
  });

  it("asks for a reason in place before Block or Cancel acts, from the ticket's menu, and offers neither on a finished ticket", async () => {
    const ticketAction = vi.fn(() => ticketDetail({ posts }));
    const slot = await mountTicket({}, { ticketAction });
    fireEvent.click((await ticketMenu(slot)).getByRole("menuitem", { name: "Block…" }));
    // Block opens a form first: nothing is sent until a reason is typed and Block is pressed.
    const form = await waitFor(() => slot.container.querySelector<HTMLElement>('[data-reason-form="block"]')!);
    const reason = () => within(form).getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement;
    expect(reason().placeholder).toBe("Why block it (required)");
    expect(document.activeElement).toBe(reason());
    expect((within(form).getByRole("button", { name: "Block CSV-2" }) as HTMLButtonElement).disabled).toBe(true);
    expect(ticketAction).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: "Wrong approach" } });
    fireEvent.click(within(form).getByRole("button", { name: "Block CSV-2" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "block", note: "Wrong approach", confirm: true }));
    await waitFor(() => expect(slot.container.querySelector("[data-reason-form]")).toBeNull());
    // Escape backs out of the form with nothing sent.
    fireEvent.click((await ticketMenu(slot)).getByRole("menuitem", { name: "Block…" }));
    const again = await waitFor(() => slot.container.querySelector<HTMLElement>('[data-reason-form="block"]')!);
    fireEvent.keyDown(within(again).getByRole("textbox", { name: "Reason" }), { key: "Escape" });
    expect(slot.container.querySelector("[data-reason-form]")).toBeNull();
    fireEvent.click((await ticketMenu(slot)).getByRole("menuitem", { name: "Cancel ticket…" }));
    const cancel = await waitFor(() => slot.container.querySelector<HTMLElement>('[data-reason-form="cancel"]')!);
    fireEvent.change(within(cancel).getByRole("textbox", { name: "Reason" }), { target: { value: "Not needed" } });
    fireEvent.click(within(cancel).getByRole("button", { name: "Cancel ticket" }));
    fireEvent.click(within(cancel).getByRole("button", { name: "Yes, cancel CSV-2" }));
    await waitFor(() => expect(ticketAction).toHaveBeenLastCalledWith({ key: "CSV-2", action: "cancel", note: "Not needed", confirm: true }));
    expect(ticketAction).toHaveBeenCalledTimes(2);
    slot.lifecycle.unmount();

    const refusedAction = vi.fn(() => {
      throw new Error("The ticket is checking.");
    });
    const refused = await mountTicket({}, { ticketAction: refusedAction });
    fireEvent.click((await ticketMenu(refused)).getByRole("menuitem", { name: "Block…" }));
    const kept = await waitFor(() => refused.container.querySelector<HTMLElement>('[data-reason-form="block"]')!);
    fireEvent.change(within(kept).getByRole("textbox", { name: "Reason" }), { target: { value: "Wrong approach" } });
    fireEvent.click(within(kept).getByRole("button", { name: "Block CSV-2" }));
    await waitFor(() => expect(refusedAction).toHaveBeenCalled());
    await waitFor(() => expect((within(kept).getByRole("button", { name: "Block CSV-2" }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(kept).getByRole("textbox", { name: "Reason" }) as HTMLTextAreaElement).value).toBe("Wrong approach");
    refused.lifecycle.unmount();

    for (const state of ["done", "cancelled"] as const) {
      const finished = await mountTicket({ state });
      const menu = await ticketMenu(finished);
      expect(menu.queryByRole("menuitem", { name: "Block…" })).toBeNull();
      expect(menu.queryByRole("menuitem", { name: "Cancel ticket…" })).toBeNull();
      expect(menu.getByRole("menuitem", { name: "Copy key" })).toBeTruthy();
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

  it("shows the brief with its criteria, files and verify command in Brief, and the agents in Agents", async () => {
    const slot = await mountTicket({
      acceptance: ["WHEN the endpoint is called THE SYSTEM SHALL stream a CSV", "IF there are no orders THEN THE SYSTEM SHALL return a header row"],
      scope: ["src/export/**", "README.md"],
      verify: ["npm test -- export"],
      reviewRound: 2,
      reviews: [{ id: 2, round: 2, verdict: "approved", status: "approved", summary: "Fine", findings: [], threadId: "thr_r2", at: 1 }],
      body: "Serve the file.\n\n## Notes\nStream it.",
    });
    expect(slot.getByRole("tab", { name: /Activity/ }).getAttribute("aria-selected")).toBe("true");
    ticketTab(slot, "Brief");
    const side = slot.container.querySelector<HTMLElement>("[data-ticket-brief]")!;
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
    expect(slot.container.querySelector("[data-ticket-details]")).toBeNull();
    ticketTab(slot, "Agents");
    expect(slot.getByRole("tab", { name: /^Agents/ }).getAttribute("aria-selected")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-details] [data-ticket-threads]")).toBeTruthy();
    ticketTab(slot, "Brief");
    const pane = slot.container.querySelector<HTMLElement>("[data-ticket-brief]")!;
    expect(within(pane).getByTestId("bb-markdown").textContent).toBe("Serve the file.\n\n## Notes\nStream it.");
    expect(pane.textContent).toContain("This is the brief the next worker reads.");
    expect(slot.container.querySelector("[data-attempt]")).toBeNull();
  });

  it("says in the summary that the worker could not start and when Loom tries again", async () => {
    const slot = await mountTicket({ state: "queued", startWait: { role: "worker", reason: "No free slot.", until: Date.now() + 2 * 60_000, tries: 1, unavailable: true } });
    expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toBe("Its worker could not start (No free slot.); Loom tries again in 2m; the wait counts no attempt.");
  });

  it("says in the summary that the merge waits after a temporary failure and when Loom tries it again", async () => {
    const until = Date.now() + 2 * 60_000;
    const slot = await mountTicket({ state: "merging", retry: { step: "merge", failures: 1, since: Date.now(), until, message: "The forge's open command printed no pull request URL: Error: 429: retry shortly", kind: "temporary" } });
    expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toBe(`Loom tries the merge again at ${clockTime(until)} after a failure: The forge's open command printed no pull request URL: Error: 429: retry shortly.`);
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
    fireEvent.click(within(planning).getByRole("button", { name: "Read the brief" }));
    expect(slot.getByRole("tab", { name: "Brief" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.container.querySelector("[data-ticket-brief] [data-verify]")!.textContent).toContain("No command of its own; only the project's checks run.");
    expect(slot.container.querySelector("[data-ticket-brief]")!.textContent).toContain("Written by the planner, edited 2 times since (scope, body).");
  });

  it("says in the header what the ticket is doing", async () => {
    const now = Date.now();
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
    const header = done.container.querySelector<HTMLElement>("[data-ticket-header]")!;
    expect(header.textContent).toContain("3 attempts");
    expect(header.textContent).toContain("2 review rounds");
    expect(header.querySelector("[data-fact='time']")!.textContent).toBe("1h");
    expect(header.querySelector('[data-dep="CSV-1"]')!.textContent).toContain("✓");
    expect(header.querySelector('[data-dep="CSV-3"]')!.textContent).not.toContain("✓");
    expect(within(header).queryByRole("button", { name: "Open worker thread" })).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: "CSV-3" }));
    expect(done.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "loom", options: { subPath: "csv/CSV-3" } }]);
    fireEvent.click(within(header).getByRole("button", { name: "Copy the branch name" }));
    await waitFor(() => expect(done.inspection.experimental_clipboardWrites).toEqual([{ text: "loom/csv-2" }]));
    done.lifecycle.unmount();

    const working = await mountTicket({ activity: withItems([], { startedAt: now - 7 * 60_000 }) });
    expect(summary(working)).toBe("Worker attempt 1 is working for 7m.");
    expect(working.container.querySelector("[data-state-badge]")!.textContent).toBe("working");
    working.lifecycle.unmount();

    const blocked = await mountTicket({ state: "blocked", stoppedFrom: "working", blockedReason: "Needs a key.", activity: withItems([], { outcome: "blocked", endedAt: now }) });
    expect(summary(blocked)).toBeNull();
    expect(blocked.container.querySelector("[data-state-badge]")!.textContent).toBe("blocked");
    blocked.lifecycle.unmount();

    const open = await mountTicket({ state: "pr_open", prUrl: "https://github.com/acme/shop/pull/2" });
    expect(open.container.querySelector("[data-state-badge]")!.textContent).toBe("PR open");
    expect(summary(open)).toBe("The pull request is open; the ticket is done when it merges.");
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
    expect(slot.getByRole("tab", { name: /Activity/ }).textContent).toBe("Activity2");
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
    expect(cards[0]!.querySelector("[data-check-step] .font-mono")!.className).toContain("text-[var(--loom-muted)]");
    expect(within(cards[0]!).getByRole("button", { name: "Hide commands" }).getAttribute("aria-expanded")).toBe("true");

    expect(cards[1]!.textContent).toContain("Checks after the merge failed");
    const changed = cards[1]!.querySelector("[data-changed]")!;
    expect(changed.textContent).toBe("The command passed but changed the branch: moved HEAD from aaa to bbb.");
    expect(changed.className).toContain("text-[var(--loom-bad)]");

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

  it("writes success text in Loom's success tone, bb's success foreground mixed toward the text colour so it keeps its contrast on a pale tint", async () => {
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
    const toned = (node: Element) => node.classList.contains("text-[var(--loom-ok)]");
    expect(page.querySelectorAll(".text-success")).toHaveLength(0);
    expect(toned(within(page).getByText("Merged"))).toBe(true);
    expect(toned(within(page).getByText("Approved"))).toBe(true);
    expect(toned(within(checksCard).getByText("Checks passed"))).toBe(true);
    expect(page.querySelectorAll('[data-pipeline] [class~="text-[var(--loom-ok)]"]')).toHaveLength(4);
    expect(checksCard.querySelectorAll('[data-check-step] [class~="text-[var(--loom-ok)]"]')).toHaveLength(1);
    expect(toned(page.querySelector('[data-dep="CSV-1"] [role="img"]')!)).toBe(true);
    ticketTab(slot, "Brief");
    expect(toned(within(page.querySelector<HTMLElement>("[data-ac]")!).getByText(/approved, round 1/))).toBe(true);
    ticketTab(slot, "Agents");
    const agents = page.querySelector<HTMLElement>("[data-ticket-details] [data-ticket-threads]")!;
    expect(toned(within(agents).getByText("merged"))).toBe(true);
    expect(toned(within(agents).getByText("approved"))).toBe(true);
  });

  it("wraps long words in the criteria and shows backticked text as code", async () => {
    const slot = await mountTicket({ acceptance: ["WHEN a backend has `logging false` THE SYSTEM SHALL drop `networkservices.googleapis.com/WasmPluginVersion` entries"] });
    ticketTab(slot, "Brief");
    const criteria = slot.container.querySelector<HTMLElement>("[data-ticket-brief] [data-ac] ol")!;
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
    ticketTab(slot, "Agents");
    const row = slot.container.querySelector<HTMLElement>('[data-ticket-details] [data-thread-row="worker"]')!;
    expect(row.textContent).toBe("WWorker · attempt 1could not start");
  });

  it("asks for the ticket again when its project changes", async () => {
    const slot = await mountTicket();
    await slot.experimental_invalidateRpc(changedTags("csv"));
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
      maxFixRounds: 5,
      follows: true,
      checks: { passed: 18, failed: 0, pending: 2, at: Date.now() - 2 * 60_000 },
      nextCheckAt: Date.now() + 3 * 60_000,
      writing: null,
      ...over,
    });
    const header = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-ticket-header]")!;

    it("names the stage Pull request and says the worker is writing it, with how long it has left", async () => {
      const now = Date.now();
      const slot = await mountTicket({ state: "approved", reviewRound: 2, pr: pr({ pushedSha: null, commits: null, checks: null, nextCheckAt: null, writing: { since: now - 4 * 60_000, fix: false, until: now + 26 * 60_000 } }) });
      expect(slot.container.querySelector("[data-ticket-summary]")!.textContent).toBe("Approved in round 2. The worker is writing the pull request's title, description and commit message (4m); Loom uses its own template if they are not in within 30m.");
      expect(header(slot).querySelector("[data-fact='pr-writing']")!.textContent).toBe("Writing the pull request · 4m");
      expect(slot.container.querySelector("[data-live-row]")!.textContent).toContain("The worker is writing the pull request · for 4m");
    });

    it("syncs an open pull request from its ticket, and offers no sync once it is not open or the page is rewound", async () => {
      const syncPullRequests = vi.fn(() => ({ slug: "csv", tickets: [], message: "Read CSV-2's pull request: nothing new, it is still open.", problem: false }));
      const slot = await mountTicket({ state: "pr_open", prUrl: URL, pr: pr() }, { syncPullRequests });
      fireEvent.click(within(header(slot)).getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(syncPullRequests).toHaveBeenCalledWith({ slug: "csv", key: "CSV-2", confirm: true }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Read CSV-2's pull request: nothing new, it is still open."));
      slot.lifecycle.unmount();

      for (const over of [{ state: "working" as const }, { state: "pr_open" as const, projectState: "archived" as const }, { state: "pr_open" as const, at: 7 }]) {
        const other = await mountTicket({ prUrl: URL, pr: pr(), ...over });
        expect(within(header(other)).queryByRole("button", { name: "Sync now" }), JSON.stringify(over)).toBeNull();
        other.lifecycle.unmount();
      }
    });

    it("offers no sync while Loom replaces a stacked pull request the forge closed, and says so, but does for the push-only forge's branch", async () => {
      const replacing = await mountTicket({ state: "pr_open", prUrl: null, pr: pr({ url: null }) });
      expect(within(header(replacing)).queryByRole("button", { name: "Sync now" })).toBeNull();
      expect(replacing.container.querySelector("[data-live-row]")!.textContent).toContain("The forge closed its pull request with the branch it built on; Loom opens a new one");
      replacing.lifecycle.unmount();
      const pushOnly = await mountTicket({ state: "pr_open", prUrl: null, pr: pr({ url: null, forge: "none" }) });
      expect(within(header(pushOnly)).getByRole("button", { name: "Sync now" })).not.toBeNull();
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
        items: [
          { kind: "thread" as const, author: "review-bot", body: "The regex is unanchored.", url: null, state: null, path: "gclb_logging.tf", line: 42 },
          { kind: "review" as const, author: "river", body: "> Test while logged in with a verified email\n>\n> - Preview options\n> - Sign in\n\n1. First\n2. Second\n\nThird paragraph.", url: null, state: "COMMENTED", path: null, line: null },
        ],
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
      // A comment's Markdown sits in a box that clips whole blocks: a line clamp on quotes and lists painted their lines over one another.
      const [short, long] = [...round.querySelectorAll<HTMLElement>("[data-feedback-body]")];
      for (const body of [short!, long!]) expect(body.className).not.toMatch(/line-clamp/);
      expect(long!.className).toContain("max-h-[7.5em]");
      expect(within(short!.parentElement!).queryByRole("button", { name: "Show all" })).toBeNull();
      const more = within(long!.parentElement!).getByRole("button", { name: "Show all" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(more);
      expect(long!.className).not.toContain("max-h-");
      expect(within(long!.parentElement!).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
      // A keyboard stop the box hides opens the body, then is scrolled into view once the opened layout has moved it.
      fireEvent.click(within(long!.parentElement!).getByRole("button", { name: "Show less" }));
      const stop = long!.querySelector<HTMLElement>("[data-testid='bb-markdown']")!;
      stop.tabIndex = 0;
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      try {
        act(() => stop.focus());
        expect(within(long!.parentElement!).getByRole("button", { name: "Show less" })).toBeTruthy();
        await waitFor(() => expect(scroll.mock.contexts).toContain(stop));
        expect(scroll.mock.calls[scroll.mock.contexts.indexOf(stop)]![0]).toMatchObject({ block: "nearest" });
        expect(document.activeElement).toBe(stop);
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
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

  it("shows progress, pace, the token budget, the deadline and capacity in Work's side pane", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    await slot.findByRole("tab", { name: "Work" });
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
    expect(strip.closest('[data-work-pane]')).not.toBeNull();
  });

  it("hides the budget and the deadline when the spec sets neither, and says when nothing was done to pace by", async () => {
    const view = projectView({ health: health({ budget: null, deadline: null, pace: { perHour: 0, remaining: 6, etaMs: null } }) });
    const { slot } = await mountPage("csv", { project: () => view });
    await slot.findByRole("tab", { name: "Work" });
    expect(part(slot, "progress")).not.toBeNull();
    expect(part(slot, "budget")).toBeNull();
    expect(part(slot, "deadline")).toBeNull();
    expect(part(slot, "pace")!.textContent).toContain("6 left; none done in the last 14 days");
    expect(slot.container.textContent).not.toContain("NaN");
  });

  it("shows a fast pace per hour and the running time left in minutes", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ health: health({ pace: { perHour: 3.85, remaining: 3, etaMs: 46.8 * 60_000 } }) }) });
    await slot.findByRole("tab", { name: "Work" });
    expect(part(slot, "pace")!.textContent).toContain("3.9/hour");
    expect(part(slot, "pace")!.textContent).toContain("3 left: about 47m of running at this pace");
  });

  it("says when the project did not run in the window to pace by", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ health: health({ pace: { perHour: null, remaining: 2, etaMs: null } }) }) });
    await slot.findByRole("tab", { name: "Work" });
    expect(part(slot, "pace")!.textContent).toContain("none yet");
    expect(part(slot, "pace")!.textContent).toContain("2 left; not run in the last 14 days");
  });

  it("is not shown for a draft", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ state: "draft", approvedVersion: null }), health: null }) });
    await slot.findByRole("tab", { name: "Work" });
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
    await openView(slot, "History", "Agents");
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
    // The model reads as its provider's icon and its name, with the whole "provider / model" in its title.
    expect(worker.querySelector('[data-model-name="claude / sonnet"]')!.textContent).toBe("sonnet");
    expect(worker.querySelector('[data-model-name="claude / sonnet"]')!.getAttribute("title")).toBe("claude / sonnet");
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
    await openView(slot, "History", "Agents");
    expect(row(slot, "thr_r3").textContent).toContain("not reported");
    expect(row(slot, "thr_w1").textContent).not.toContain("not reported");
    expect(slot.container.querySelector("[data-agents-planner]")!.textContent).toContain("Tokens not reported");
    expect(slot.container.querySelector("[data-agents-tokens]")!.textContent).toContain("1 thread reports no token usage");
  });

  it("shows a dash, not \"not reported\", for a row bb never started a thread for", async () => {
    const neverStarted = agent({ threadId: null, role: "reviewer", ticketKey: "CSV-1", state: "ended", endedAt: NOW, endReason: "failed", tokens: null, timeoutAt: null });
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [neverStarted, ...agents] }) });
    await openView(slot, "History", "Agents");
    const tokens = slot.container.querySelector<HTMLElement>('[data-agent-row="reviewer"] [data-label="Tokens"]')!;
    expect(tokens.textContent).toBe("—");
  });

  it("says nothing about unreported tokens when every thread reports them", async () => {
    const slot = await openAgents();
    expect(slot.container.querySelector("[data-agents-tokens]")!.textContent).not.toContain("no token usage");
  });

  it("says so when no agent is working", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [] }) });
    await openView(slot, "History", "Agents");
    expect(await slot.findByText("No agent is working now.")).toBeTruthy();
    expect(slot.container.querySelector("[data-agents-history]")).toBeNull();
    expect(slot.container.querySelector("[data-agents-planner]")).toBeNull();
  });

  it("shows the planner on call in its own section, with its tokens and thread but no running time, and not as working", async () => {
    const planner = agent({ threadId: "thr_plan", role: "planner", ticketKey: null, ticketTitle: null, startedAt: NOW - 32 * 60_000, tokens: 2000, rateLimitRetries: 0, model: null, timeoutAt: null });
    const { slot } = await mountPage("csv", { project: () => projectView({ agents: [planner, ...agents] }) });
    await openView(slot, "History", "Agents");
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
    await openView(slot, "History", "Agents");
    expect(await slot.findByText("No agent is working now.")).toBeTruthy();
    expect(slot.container.querySelector("[data-agents-planner]")!.textContent).toContain("On call for triage rounds");
  });
});

describe("insights tab", () => {
  const insightsView = (input: { slug: string; window?: InsightsWindow; at?: number } = { slug: "csv" }) => projectInsights(story().rows(), { now: at(60), window: input.window, strategy: "integration", maxWorkers: 2, maxTokens: null });
  const openInsights = async (insights: Handlers["insights"] = insightsView, project: Handlers["project"] = () => projectView()) => {
    const { slot } = await mountPage("csv", { project, insights });
    await openView(slot, "History", "Insights");
    await waitFor(() => expect(slot.container.querySelector("[data-insights-headline]")).not.toBeNull());
    return slot;
  };
  const pressed = (slot: Slot, group: string) => [...slot.container.querySelectorAll(`${group} button[aria-pressed=true]`)].map((button) => button.textContent);
  const chapterKeys = (slot: Slot) => [...slot.container.querySelectorAll("[data-chapter]")].map((row) => row.getAttribute("data-chapter"));
  // React reports a duplicate key, or any other render problem, on console.error; the tab must render without one.
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error");
  });
  afterEach(() => {
    expect(errors.mock.calls.filter((call: unknown[]) => /same key|unique "key"|act\(/.test(String(call[0])))).toEqual([]);
    errors.mockRestore();
  });

  it("separates stacked marks with a line of the surface colour, outlines a pull request's and hatches a block, in the chart and its key", async () => {
    const view = (input: Parameters<typeof insightsView>[0]) => {
      const out = insightsView(input);
      const when = out.activity.marks.find((mark) => mark.kind === "done")!.at;
      const marks = (["done", "pr", "back", "bad"] as const).map((kind) => ({ at: when, kind, key: "CSV-1", text: kind }));
      return { ...out, strategy: "pr" as const, activity: { ...out.activity, marks: [...out.activity.marks, ...marks] } };
    };
    const slot = await openInsights(view);
    const bar = [...slot.container.querySelectorAll("[data-activity-bar]")].find((entry) => entry.querySelectorAll("[data-mark]").length === 4)!;
    expect([...bar.querySelectorAll("[data-mark]")].map((mark) => mark.getAttribute("data-mark"))).toEqual(["done", "pr", "back", "bad"]);
    // Every mark but the bottom one has a separator at its lower edge, in the colour the chart sits on.
    const separators = [...bar.querySelectorAll<SVGLineElement>("[data-mark-separator]")];
    expect(separators).toHaveLength(3);
    for (const line of separators) expect(line.style.stroke).toBe("var(--background, transparent)");
    const mark = (kind: string) => bar.querySelector<SVGRectElement>(`[data-mark="${kind}"]`)!;
    expect(mark("pr").style.stroke).toContain("--success");
    expect(mark("bad").getAttribute("fill")).toMatch(/^url\(#.*-bad\)$/);
    expect(mark("done").style.stroke).toBe("");
    const key = slot.getByText("Blocked or failed").firstElementChild as HTMLElement;
    expect(key.style.background).toContain("repeating-linear-gradient");
    // The paused hatch is data too: its lines are full-strength muted ink, never faded below 3:1.
    const paused = bar.closest("svg")!.querySelector<SVGLineElement>("pattern line")!;
    expect(paused.style.stroke).toBe("var(--loom-muted, currentColor)");
    expect(paused.style.strokeOpacity).toBe("");
  });

  it("brings a ticket's story into view without gliding when the person asks for reduced motion", async () => {
    const calls: unknown[] = [];
    const original = (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    Element.prototype.scrollIntoView = function (options?: unknown) {
      calls.push(options);
    } as typeof Element.prototype.scrollIntoView;
    const media = window.matchMedia;
    // jsdom has no CSS.escape, which the story's lookup uses.
    const css = (globalThis as { CSS?: unknown }).CSS;
    (globalThis as { CSS?: unknown }).CSS = { escape: (value: string) => value };
    try {
      for (const reduce of [true, false]) {
        calls.length = 0;
        window.matchMedia = ((query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
        const slot = await openInsights();
        fireEvent.click(slot.container.querySelector<HTMLElement>("[data-first-try]")!);
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        expect(calls.every((options) => (options as ScrollIntoViewOptions).behavior === (reduce ? "auto" : "smooth")), JSON.stringify(calls)).toBe(true);
        // It lands on the same ticket's story either way.
        expect((slot.getByPlaceholderText("Find a ticket or a word") as HTMLInputElement).value).toBe(slot.container.querySelector("[data-first-try]")!.getAttribute("data-first-try"));
        slot.lifecycle.unmount();
      }
    } finally {
      window.matchMedia = media;
      (globalThis as { CSS?: unknown }).CSS = css;
      if (original === undefined) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      else Element.prototype.scrollIntoView = original as typeof Element.prototype.scrollIntoView;
    }
  });

  it("takes the place of the Feed and Metrics tabs and reads the whole project", async () => {
    const slot = await openInsights();
    expect([...slot.container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).not.toContain("Feed");
    expect(slot.queryByRole("tab", { name: "Metrics" })).toBeNull();
    expect(calls(slot, "insights")[0]!.input).toEqual({ slug: "csv" });
    expect(pressed(slot, "[data-insights-window]")).toEqual(["Whole project"]);
    expect(slot.container.querySelector("[data-insights-live]")).not.toBeNull();
  });

  it("leads with how it went, four figures and links that show the problems or your actions", async () => {
    const slot = await openInsights();
    expect(slot.container.querySelector("[data-insights-headline]")!.textContent).toBe("Running: 1 ticket is blocked and needs you.");
    expect([...slot.container.querySelectorAll("[data-insights-line]")].map((line) => line.textContent)).toContain("Checks failed once in 3 runs, in npm test.");
    expect([...slot.container.querySelectorAll("[data-figure]")].map((figure) => figure.getAttribute("data-figure"))).toEqual(["Running time", "A ticket takes", "Right first time", "Tokens"]);
    // At 200% text two fixed columns spilled every figure: the figures take as many 11rem columns as fit.
    const figures = classNamesOf(slot.container.querySelector("[data-figure]")!.parentElement!);
    expect(figures).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))]");
    expect(figures).not.toContain("grid-cols-2");
    expect(slot.container.querySelector('[data-figure="Right first time"]')!.textContent).toContain("0%");
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-insights-summary]")!).getByRole("button", { name: "The one reviewed ticket" }));
    expect(pressed(slot, "[data-story-filter]")).toEqual(["Problems3"]);
    // A quote's marks come from the q element's CSS, so they are not in the text.
    expect([...slot.container.querySelectorAll("[data-story-body] [data-line]")].map((line) => line.textContent)).toEqual([
      expect.stringContaining("CSV-2Blocked: The fixture file is missing"),
      expect.stringContaining("CSV-2Checks failed: npm test exited 1."),
      expect.stringContaining("CSV-1A reviewer asked for changes in round 1 (1 finding, 1 blocking): Sort is not stable"),
    ]);
    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-insights-summary]")!).getByRole("button", { name: "You stepped in twice" }));
    expect(pressed(slot, "[data-story-filter]")).toEqual(["You4"]);
  });

  it("tells each ticket's story by run, newest first, with its steps and a link to its ticket", async () => {
    const slot = await openInsights();
    expect([...slot.container.querySelectorAll("[data-group]")].map((group) => group.getAttribute("data-group"))).toEqual(["Running now 2", "Paused", "Run 1", "Planning"]);
    expect(chapterKeys(slot)).toEqual(["CSV-2", "CSV-1", "CSV-2", "CSV-1"]);
    const shipped = slot.container.querySelectorAll<HTMLElement>('[data-chapter="CSV-1"]')[0]!;
    expect(shipped.textContent).toContain("Shipped after fixes.");
    expect(shipped.textContent).toContain("It was sent back once before this stretch.");
    fireEvent.click(within(shipped).getByRole("button", { name: /^Show \d+ steps$/ }));
    const steps = [...shipped.querySelectorAll("[data-chapter-steps] li")].map((step) => step.textContent);
    expect(steps.at(-1)).toContain("Merged into loom/csv at abcdef1.");
    expect(within(shipped).getByRole("button", { name: "Hide the steps" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(shipped).getByRole("button", { name: "CSV-1" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-1")]);
    fireEvent.click(slot.getByRole("button", { name: "Oldest first" }));
    expect(chapterKeys(slot)).toEqual(["CSV-1", "CSV-2", "CSV-1", "CSV-2"]);
  });

  it("lists what needs you right now, with a way to answer it", async () => {
    const slot = await openInsights();
    const blocked = slot.container.querySelector<HTMLElement>('[data-current="CSV-2"]')!;
    expect(blocked.textContent).toContain("Blocked, waiting for you: The fixture file is missing");
    expect(blocked.textContent).toContain("for 5m");
    fireEvent.click(within(blocked).getByRole("button", { name: "Answer on the ticket" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-2")]);
  });

  it("shows every event as one line per action, and searches the story", async () => {
    const slot = await openInsights();
    fireEvent.click(slot.getByRole("button", { name: /^Every event/ }));
    const lines = [...slot.container.querySelectorAll("[data-story-body] [data-line]")].map((line) => line.textContent ?? "");
    expect(lines.some((line) => line.includes("A reviewer asked for changes in round 1"))).toBe(true);
    expect(lines.some((line) => line.includes("so it went back to the worker"))).toBe(false);
    fireEvent.change(slot.getByRole("searchbox", { name: "Find a ticket or a word" }), { target: { value: "fixture" } });
    expect([...slot.container.querySelectorAll("[data-story-body] [data-line]")].map((line) => line.textContent)).toEqual([expect.stringContaining("CSV-2Blocked: The fixture file is missing")]);
    fireEvent.click(slot.getByRole("button", { name: "Story" }));
    expect(chapterKeys(slot)).toEqual(["CSV-2"]);
    expect(slot.container.querySelector("[data-insights-current]")).toBeNull();
    fireEvent.change(slot.getByRole("searchbox", { name: "Find a ticket or a word" }), { target: { value: "nothing like it" } });
    expect(slot.container.querySelector("[data-story-body]")!.textContent).toBe("Nothing matches “nothing like it”.");
  });

  it("shows the latest run, or a stretch picked on the chart, and the whole project again", async () => {
    const insights = vi.fn(insightsView);
    const slot = await openInsights(insights);
    fireEvent.click(slot.getByRole("button", { name: "Latest run" }));
    await waitFor(() => expect(slot.container.querySelector("[data-insights-headline]")!.textContent).toBe("1 ticket shipped in this stretch."));
    expect(calls(slot, "insights").at(-1)!.input).toEqual({ slug: "csv", window: "run" });
    expect(pressed(slot, "[data-insights-window]")).toEqual(["Latest run"]);

    const chart = slot.container.querySelector<HTMLElement>("[data-activity-chart]")!;
    fireEvent.keyDown(chart, { key: "Home" });
    expect(slot.container.querySelector("[data-activity-tip]")).not.toBeNull();
    fireEvent.keyDown(chart, { key: "Enter" });
    await waitFor(() => expect(slot.container.querySelector("[data-insights-range]")).not.toBeNull());
    const picked = calls(slot, "insights").at(-1)!.input as { window: { from: number; to: number } };
    expect(picked.window.from).toBeLessThanOrEqual(at(0));
    expect(picked.window.to).toBeGreaterThan(picked.window.from);
    expect(pressed(slot, "[data-insights-window]")).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Show the whole project" }));
    await waitFor(() => expect(slot.container.querySelector("[data-insights-range]")).toBeNull());
    expect(calls(slot, "insights").at(-1)!.input).toEqual({ slug: "csv" });
  });

  it("selects only with the main button, and a cancelled drag selects nothing", async () => {
    const insights = vi.fn(insightsView);
    const slot = await openInsights(insights);
    const bucket = (index: number) => slot.container.querySelector<SVGElement>(`[data-bucket="${index}"]`)!;
    const before = calls(slot, "insights").length;
    fireEvent.pointerDown(bucket(1), { button: 2, isPrimary: true, pointerId: 1 });
    fireEvent.pointerUp(bucket(1), { button: 2, isPrimary: true, pointerId: 1 });
    fireEvent.pointerDown(bucket(1), { button: 0, isPrimary: true, pointerId: 1, buttons: 1 });
    fireEvent.pointerCancel(bucket(1), { pointerId: 1 });
    fireEvent.pointerMove(bucket(3), { pointerId: 1, buttons: 0 });
    expect(slot.container.querySelectorAll("[data-activity-selected]")).toHaveLength(0);
    fireEvent.pointerUp(bucket(3), { button: 0, isPrimary: true, pointerId: 1 });
    expect(calls(slot, "insights")).toHaveLength(before);
    fireEvent.pointerDown(bucket(1), { button: 0, isPrimary: true, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(bucket(2), { pointerId: 1, buttons: 1 });
    fireEvent.pointerUp(bucket(2), { button: 0, isPrimary: true, pointerId: 1 });
    await waitFor(() => expect(calls(slot, "insights")).toHaveLength(before + 1));
    expect(calls(slot, "insights").at(-1)!.input).toMatchObject({ window: { from: expect.any(Number), to: expect.any(Number) } });
  });

  it("falls back to the whole project when the stretch it showed is not offered, and keeps the picker after a failed read", async () => {
    let fail = false;
    let runs = true;
    const insights = vi.fn((input: { slug: string; window?: InsightsWindow }) => {
      if (fail) throw new Error("db is closed");
      const view = insightsView(input);
      return { ...view, presets: { ...view.presets, run: runs, day: true } };
    });
    const slot = await openInsights(insights);
    fireEvent.click(slot.getByRole("button", { name: "Latest run" }));
    await waitFor(() => expect(pressed(slot, "[data-insights-window]")).toEqual(["Latest run"]));
    runs = false;
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(pressed(slot, "[data-insights-window]")).toEqual(["Whole project"]));
    expect(calls(slot, "insights").at(-1)!.input).toEqual({ slug: "csv" });

    runs = true;
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Latest run" })).not.toBeNull());
    // A stretch read before reopens from bb's cache, so the failed read is of one not read yet.
    fail = true;
    fireEvent.click(slot.getByRole("button", { name: "Last 24 hours" }));
    expect((await slot.findByRole("alert")).textContent).toContain("db is closed");
    fail = false;
    fireEvent.click(within(slot.getByRole("alert")).getByRole("button", { name: "Show the whole project" }));
    await waitFor(() => expect(slot.container.querySelector("[data-insights-headline]")).not.toBeNull());
  });

  it("finds a ticket's story from the numbers", async () => {
    const slot = await openInsights();
    expect(slot.container.querySelector('[data-card="cycle"]')!.textContent).toContain("44m");
    expect(slot.container.querySelector('[data-card="wrong"]')!.textContent).toContain("Sent back to the worker (1 by review, 1 by checks)");
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-cycle-dot="CSV-1"]')!);
    expect((slot.getByRole("searchbox", { name: "Find a ticket or a word" }) as HTMLInputElement).value).toBe("CSV-1");
    expect(chapterKeys(slot)).toEqual(["CSV-1", "CSV-1"]);
    expect(slot.container.querySelectorAll('[data-chapter="CSV-1"] [data-chapter-steps]')).toHaveLength(2);
    expect(slot.container.querySelector('[data-chapter="CSV-1"]')!.className).toContain("bg-primary/10");
    fireEvent.change(slot.getByRole("searchbox", { name: "Find a ticket or a word" }), { target: { value: "" } });
    expect(slot.container.querySelector('[data-chapter="CSV-1"]')!.className).not.toContain("bg-primary/10");
  });

  it("puts the half and most labels on either side of their lines when the two times are close", async () => {
    const close = (input: { slug: string }) => {
      const view = insightsView(input);
      return { ...view, numbers: { ...view.numbers, cycle: [...view.numbers.cycle, { key: "CSV-99", ms: 10 * view.numbers.cycleP50! }], cycleP85: view.numbers.cycleP50! + 1000 } };
    };
    const slot = await openInsights(close);
    const mark = (label: string) => slot.container.querySelector<HTMLElement>(`[data-cycle-mark="${label}"]`)!;
    expect(mark("half").className).toContain("-translate-x-full");
    expect(mark("most").className).not.toContain("-translate-x");
    slot.lifecycle.unmount();
    const apart = await openInsights();
    expect(apart.container.querySelector<HTMLElement>('[data-cycle-mark="half"]')!.className).toContain("-translate-x-1/2");
  });

  it("finds a ticket by its exact key, so CSV-1 does not find CSV-10", async () => {
    const rows = story();
    rows.ticket(10, 56, "Tenth").move(10, 57, "queued", "working");
    const slot = await openInsights(() => projectInsights(rows.rows(), { now: at(60), strategy: "integration", maxWorkers: 2, maxTokens: null }));
    fireEvent.change(slot.getByRole("searchbox", { name: "Find a ticket or a word" }), { target: { value: "csv-1" } });
    expect(new Set(chapterKeys(slot))).toEqual(new Set(["CSV-1"]));
    fireEvent.change(slot.getByRole("searchbox", { name: "Find a ticket or a word" }), { target: { value: "tenth" } });
    expect(chapterKeys(slot)).toEqual(["CSV-10"]);
  });

  it("reads again after a change, and shows a failed read", async () => {
    const insights = vi.fn(insightsView);
    const slot = await openInsights(insights);
    const before = calls(slot, "insights").length;
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(calls(slot, "insights").length).toBe(before + 1));
    await slot.experimental_invalidateRpc(changedTags("other"));
    expect(calls(slot, "insights").length).toBe(before + 1);
    slot.lifecycle.unmount();

    const { slot: failed } = await mountPage("csv", { project: () => projectView(), insights: () => Promise.reject(new Error("db is closed")) });
    await openView(failed, "History", "Insights");
    expect((await failed.findByRole("alert")).textContent).toContain("db is closed");
  });

  it("reads the moment the page is rewound to", async () => {
    const project = (input: { slug: string; at?: number }) => (input.at === undefined ? projectView() : projectView({ at: input.at, now: NOW - 15 * 60_000 }));
    const { slot } = await mountPage("csv", { project, insights: insightsView });
    // The ruler over every view rewinds the page.
    await waitFor(() => expect(slot.container.querySelector("[data-time-ruler]")).not.toBeNull());
    await waitFor(() => expect(slot.getByRole("slider", { name: "Timeline" }).getAttribute("aria-valuemax")).not.toBe("0"));
    fireEvent.click(slot.getByRole("button", { name: "Previous moment" }));
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).not.toBeNull());
    await openView(slot, "History", "Insights");
    await waitFor(() => expect(calls(slot, "insights").length).toBeGreaterThan(0));
    expect(calls(slot, "insights")[0]!.input).toEqual({ slug: "csv", at: expect.any(Number) });
    await waitFor(() => expect(slot.container.querySelector("[data-insights-headline]")).not.toBeNull());
    expect(slot.container.querySelector("[data-insights-live]")).toBeNull();
    localStorage.clear();
  });
});

describe("timeline", () => {
  afterEach(() => localStorage.clear());
  const PAST = NOW - 15 * 60_000;
  const project = (input: { slug: string; at?: number }) => (input.at === undefined ? projectView() : projectView({ at: input.at, now: PAST }));
  const strip = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-timeline-strip]")!;
  // The full timeline is History's Rewind, always open there; the ruler over every view has tests of its own.
  const history = async (slot: Slot) => {
    await openView(slot, "History");
    return waitFor(() => {
      expect(slot.container.querySelector("[data-timeline-strip]")).not.toBeNull();
      return strip(slot);
    });
  };
  const open = async (slot: Slot) => {
    await history(slot);
    await waitFor(() => expect(slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  };
  const inStrip = (slot: Slot, name: string) => within(strip(slot)).getByRole("button", { name });
  const rewound = async (slot: Slot) => waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).not.toBeNull());
  const rewind = async (slot: Slot) => {
    await open(slot);
    fireEvent.click(inStrip(slot, "Previous moment"));
    await rewound(slot);
  };
  // With no ResizeObserver the plot is 720 pixels wide over the fixture's 20 minutes, so a moment 15 minutes ago sits at 180.
  const track = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-timeline-track]")!;

  it("opens in full as a dashed frame with its rows, a Play button and no fold, and says it is live", async () => {
    const { slot } = await mountPage("csv", { project });
    await history(slot);
    expect(strip(slot).className).toContain("border-dashed");
    expect(track(slot)).not.toBeNull();
    await waitFor(() => expect(slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
    expect(within(strip(slot)).queryByRole("button", { name: "Timeline" })).toBeNull();
    expect(within(strip(slot)).queryByRole("button", { name: "Fold the Timeline" })).toBeNull();
    expect(inStrip(slot, "Play")).toBeTruthy();
    expect(slot.container.querySelector("[data-timeline-status]")!.textContent).toContain("Live");
    expect(calls(slot, "timeline")[0]!.input).toEqual({ slug: "csv" });
  });

  it("gives each ticket's row a 44 px tap on a phone-narrow frame, and keeps 24 px rows otherwise", async () => {
    const tickets = (slot: Slot) => strip(slot).querySelector<HTMLElement>('ul[aria-label="Tickets"]')!;
    const observer = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    // jsdom lays nothing out: every observed element reports `frame` pixels wide, once.
    const reporting = (frame: number) =>
      class {
        constructor(private readonly report: (entries: Array<{ contentRect: { width: number } }>) => void) {}
        observe() {
          this.report([{ contentRect: { width: frame } }]);
        }
        disconnect() {}
      };
    try {
      vi.stubGlobal("ResizeObserver", reporting(390));
      const narrow = await mountPage("csv", { project });
      await open(narrow.slot);
      await waitFor(() => expect(tickets(narrow.slot).style.gridAutoRows).toBe("44px"));
      expect(strip(narrow.slot).querySelector("[data-timeline-lanes]")!.getAttribute("height")).toBe(String(44 * (tickets(narrow.slot).children.length)));
      narrow.slot.lifecycle.unmount();
      vi.stubGlobal("ResizeObserver", reporting(1080));
      const wide = await mountPage("csv", { project });
      await open(wide.slot);
      expect(tickets(wide.slot).style.gridAutoRows).toBe("24px");
    } finally {
      vi.stubGlobal("ResizeObserver", observer);
    }
  });

  it("opens on the newest moment, and open again after a remount", async () => {
    const first = await mountPage("csv", { project });
    await open(first.slot);
    expect(first.slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("now");
    expect(first.slot.container.querySelector("[data-timeline-moment]")!.textContent).toContain("CSV-1 moved from working to review: the checks passed, round 1.+1 more");
    expect(within(strip(first.slot)).getByRole("button", { name: "Next moment" }).getAttribute("aria-disabled")).toBe("true");
    first.slot.lifecycle.unmount();
    const again = await mountPage("csv", { project });
    await waitFor(() => expect(again.slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
  });

  it("rewinds the page to the previous moment, read-only, and either Back to now returns it", async () => {
    const { slot } = await mountPage("csv", { project });
    const pause = () => slot.container.querySelector<HTMLElement>('[data-title-toggle="pause"]')!;
    await waitFor(() => expect(pause()).not.toBeNull());
    await rewind(slot);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
    expect(slot.container.querySelector("[data-rewind-bar]")!.textContent).toContain("read-only");
    expect(slot.container.querySelector("[data-next-step]")).toBeNull();
    // The title bar keeps its controls in place, disabled, so nothing moves under the pointer.
    expect(pause().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pause());
    expect(calls(slot, "control")).toEqual([]);
    expect(strip(slot).hasAttribute("data-rewound")).toBe(true);
    expect(slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("2 of 3");
    // The caption is the line that gave the moment its kind, not the first one.
    expect(slot.container.querySelector("[data-timeline-moment]")!.textContent).toContain("You ran start.+2 more");
    expect(slot.container.querySelector("[data-timeline-playhead]")).not.toBeNull();

    fireEvent.click(within(slot.container.querySelector<HTMLElement>("[data-rewind-bar]")!).getByRole("button", { name: "Back to now" }));
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
    expect(pause().getAttribute("aria-disabled")).toBeNull();
    expect(strip(slot).hasAttribute("data-rewound")).toBe(false);

    fireEvent.click(inStrip(slot, "Previous moment"));
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
    const previous = inStrip(slot, "Previous moment");
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    // At the first moment Previous keeps its focus and does nothing.
    previous.focus();
    fireEvent.click(previous);
    expect(document.activeElement).toBe(previous);
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 });
    const when = slot.container.querySelector("[data-ruler-when]")!.textContent!;
    expect(when).toMatch(/^[A-Z][a-z]{2} \d{1,2}, /);
    fireEvent.keyDown(strip(slot), { key: "Escape" });
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
    expect(slot.container.querySelector("[data-ruler-when]")!.textContent).toBe("Now");
  });

  it("takes Escape from the body while rewound, before bb leaves the page with it", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    fireEvent.keyDown(strip(slot), { key: "ArrowLeft" });
    await rewound(slot);
    const host = vi.fn();
    window.addEventListener("keydown", host);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", host);
    await waitFor(() => expect(slot.container.querySelector("[data-rewind-bar]")).toBeNull());
    expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
    expect(host).not.toHaveBeenCalled();
  });

  it("shows what happened at a moment on hover, before anything rewinds, and a click rewinds to it", async () => {
    const { slot } = await mountPage("csv", { project });
    await history(slot);
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
    fireEvent.mouseMove(lanes, { clientX: 400, clientY: 2 * 24 + 5 });
    const tip = await slot.findByRole("tooltip");
    expect(tip.textContent).toContain("CSV-2 · Export endpoint");
    expect(tip.textContent).toContain("CSV-2 moved from queued to working: attempt 1.");
    expect(tip.textContent).toContain("working 10m");
    expect(tip.textContent).toContain("working for 10m");
    fireEvent.mouseMove(lanes, { clientX: 400, clientY: 24 + 5 });
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
    await history(slot);
    // The 45 quiet minutes fold to the first 16 pixels.
    fireEvent.mouseMove(track(slot), { clientX: 8, clientY: 10 });
    expect((await slot.findByRole("tooltip")).textContent).toContain("Quiet for 45m");
    fireEvent.pointerDown(track(slot), { clientX: 8, clientY: 10, button: 0 });
    expect(calls(slot, "project").every((call) => (call.input as { at?: number }).at === undefined)).toBe(true);
  });

  it("puts now one step past the newest moment when something happened after it, and on it when that was in the same millisecond", async () => {
    const later = await mountPage("csv", { project, timeline: () => timeline({ events: [...timeline().events, [14, NOW - 5 * 60_000]] }) });
    await open(later.slot);
    fireEvent.click(inStrip(later.slot, "Previous moment"));
    await rewound(later.slot);
    expect(calls(later.slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 13 });
    expect(later.slot.container.querySelector("[data-timeline-count]")!.textContent).toBe("3 of 3");
    fireEvent.click(inStrip(later.slot, "Next moment"));
    await waitFor(() => expect(calls(later.slot, "project").at(-1)!.input).toEqual({ slug: "csv" }));
    later.slot.lifecycle.unmount();

    const same = await mountPage("csv", { project, timeline: () => timeline({ events: [[11, NOW - 20 * 60_000], [12, NOW - 15 * 60_000], [14, NOW - 10 * 60_000]] }) });
    // The first mount left the Timeline open.
    await waitFor(() => expect(same.slot.container.querySelector("[data-timeline-open]")).not.toBeNull());
    fireEvent.click(inStrip(same.slot, "Previous moment"));
    await rewound(same.slot);
    expect(calls(same.slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 12 });
  });

  it("plays the project back a moment at a time and returns to now at the end", async () => {
    const { slot } = await mountPage("csv", { project });
    await open(slot);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(inStrip(slot, "Play"));
      await act(async () => {
        vi.advanceTimersByTime(130);
      });
      expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv", at: 11 });
      expect(inStrip(slot, "Pause")).toBeTruthy();
      // One tick per act, so each moment the playhead passes renders and asks for its page.
      for (let tick = 0; tick < 25; tick += 1)
        await act(async () => {
          vi.advanceTimersByTime(120);
        });
      expect(calls(slot, "project").at(-1)!.input).toEqual({ slug: "csv" });
      expect(calls(slot, "project").some((call) => (call.input as { at?: number }).at === 12)).toBe(true);
      expect(inStrip(slot, "Play")).toBeTruthy();
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
    fireEvent.click(inStrip(slot, "Previous moment"));
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
    expect(await slot.findByRole("textbox", { name: "New reply" })).toBeTruthy();
  });

  it("hides the Planner tab and the tab badges while rewound, and shows the spec in force with no notes", async () => {
    const pending = (input: { slug: string; at?: number }) => ({ ...project(input), overview: overview({ pendingVersion: 2 }) });
    const { slot } = await mountPage("csv", { project: pending, specVersion: () => specVersionView({ version: 1, status: "approved", changes: null }) });
    expect((await slot.findByRole("tab", { name: "Planner" })).getAttribute("aria-disabled")).toBeNull();
    expect(slot.container.querySelector('[data-tab-badge="spec"]')).not.toBeNull();
    await rewind(slot);
    // Planner and Ship stay in their places, disabled, and say why.
    expect(slot.getByRole("tab", { name: "Planner" }).getAttribute("aria-disabled")).toBe("true");
    expect(slot.getByRole("tab", { name: "Ship" }).getAttribute("aria-disabled")).toBe("true");
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

  it("keeps the keyboard clear of the review dock while it is docked at the bottom", async () => {
    // jsdom applies no Tailwind, so the dock reports itself docked the way the browser does below the two-column width.
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      return element instanceof HTMLElement && element.hasAttribute("data-spec-review-dock") ? ({ ...style, bottom: "0px" } as CSSStyleDeclaration) : style;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-spec-review-dock") ? 212 : 0;
    });
    const slot = await openPage();
    const scroller = slot.container.querySelector<HTMLElement>("[data-loom-scroll]")!;
    expect(page(slot).querySelector("[data-spec-review-dock]")).not.toBeNull();
    expect(scroller.style.scrollPaddingBottom).toBe("220px");
    fireEvent.click(slot.getByRole("tab", { name: "Work" }));
    await waitFor(() => expect(slot.container.querySelector("[data-spec-page]")).toBeNull());
    expect(scroller.style.scrollPaddingBottom).toBe("");
    vi.restoreAllMocks();
  });

  it("suggests a number with no text, adds a note on the whole spec, and edits and deletes a comment", async () => {
    const sendNotes = vi.fn(() => specVersionView());
    const slot = await openPage({ sendNotes });
    entire(slot);
    fireEvent.click(target(slot, "agents.max_workers")!);
    expect(within(box(slot)).getByRole("button", { name: "Add comment" })).toHaveProperty("disabled", true);
    fireEvent.click(within(box(slot)).getByRole("button", { name: "More" }));
    expect(within(box(slot)).getByRole("status", { hidden: true }).textContent).toBe("3");
    // At 200% text "now 2 · 1 to 8" ran 59 px out of the box: the stepper row and the box's actions wrap.
    expect(classNamesOf(box(slot).querySelector("[data-number-row]"))).toContain("flex-wrap");
    expect(classNamesOf(box(slot).querySelector("[data-comment-actions]"))).toContain("flex-wrap");
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
    const round = (version: number, n: number, path: string, title: string) => ({ version, round: n, state: "changes_requested" as const, summary: `Round ${n}.`, findings: [{ path, title, detail: "Say exactly what it is." }], reason: null, skip: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR });
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
    const spec = specVersionView({ status: "approved", reviews: [{ version: 2, round: 1, state: "approved", summary: "Every ticket serves the request.", findings: [], reason: null, skip: null, startedAt: NOW - 2 * HOUR, endedAt: NOW - HOUR }] });
    const slot = await openPage({ specVersion: () => spec }, projectView({ spec: { ...projectView().spec, version: 2 } }));
    const status = page(slot).querySelector<HTMLElement>('[data-spec-review-status="approved"]')!;
    expect(status.textContent).toContain("✓ Loom's spec review passed v2 · round 1 of 3");
    expect(status.textContent).toContain("Every ticket serves the request.");
    expect(page(slot).querySelector("[data-finding-pin]")).toBeNull();
  });

  it("says a version skipped Loom's spec review, against which version and for which settings", async () => {
    const skip = { against: 1, paths: ["merge.forge.feedback", "agents.max_workers"] };
    const spec = specVersionView({ status: "pending", reviews: [{ version: 2, round: 1, state: "skipped", summary: "v2 changes only operational settings against v1.", findings: [], reason: null, skip, startedAt: NOW - HOUR, endedAt: NOW - HOUR }] });
    const slot = await openPage({ specVersion: () => spec }, projectView({ spec: { ...projectView().spec, version: 2 } }));
    const status = page(slot).querySelector<HTMLElement>('[data-spec-review-status="skipped"]')!;
    expect(status.textContent).toContain("Loom skipped the spec review of v2: against v1, it changes only operational settings");
    expect(status.textContent).toContain("You still approve it.");
    expect(status.querySelector("[data-skipped-paths]")!.textContent).toContain(" · ");
  });

  it("shows a changed ticket's changed parts beside the list, the whole ticket at a click, and takes a comment on a criterion", async () => {
    const slot = await openPage();
    const detail = () => section(slot, "tickets").querySelector<HTMLElement>("[data-ticket-detail]")!;
    expect(detail().getAttribute("data-ticket-detail")).toBe("csv-export");
    expect(detail().querySelector("[data-removed]")!.textContent).toBe("WHEN there are no orders THE SYSTEM SHALL return an empty file");
    expect(target(slot, "ticket[csv-export].acceptance[1]")!.textContent).toContain("WHEN there are no orders THE SYSTEM SHALL return a header row");
    // A long path in a criterion, kept or removed, breaks inside the card as file and command values do.
    expect(target(slot, "ticket[csv-export].acceptance[1]")!.className).toContain("[overflow-wrap:anywhere]");
    expect(detail().querySelector("[data-removed]")!.className).toContain("[overflow-wrap:anywhere]");
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

  it("puts a change's tags beside it, or under it when the row is narrow, never over its name, and breaks a long value", async () => {
    const answered = specVersionView({ notes: [{ version: 1, paths: ["checks.commands[0]"], body: "Run the plain tests.", sentAt: NOW, answeredIn: 2, changed: true }] });
    const slot = await openPage({ specVersion: () => answered });
    const classes = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
    const row = page(slot).querySelector<HTMLElement>('[data-change="ticket[csv-export].acceptance"]')!;
    const tag = row.querySelector("[data-change-tag]")!;
    expect(tag.textContent).toBe("not from your comments");
    const box = tag.parentElement!;
    expect(classes(box)).toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0", "flex-1"]));
    const go = box.querySelector("button")!;
    expect(classes(go)).toEqual(expect.arrayContaining(["min-w-[min(100%,12rem)]", "flex-1"]));
    expect(classes(go.firstElementChild)).toEqual(expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"]));
    expect(classes(go.firstElementChild)).not.toContain("shrink-0");
    expect(classes(go.querySelector("[data-change-line]"))).toEqual(expect.arrayContaining(["[overflow-wrap:anywhere]", "@3xl:truncate"]));
    // The sections bar stops under the project's tab bar, which sticks at the top of a narrow page too.
    expect(classes(page(slot).querySelector("[data-spec-sections]"))).toEqual(expect.arrayContaining(["sticky", "top-0", "@max-xl/loom:top-[var(--loom-tabs,0px)]"]));
    // Opaque like the other sticky bars: the dark themes' recessed surface is a third opaque, so text scrolled under it showed through.
    expect(classes(page(slot).querySelector("[data-spec-sections]"))).toContain("bg-background");
    expect(classes(page(slot).querySelector("[data-spec-sections]"))).not.toContain("backdrop-blur");
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

  it("labels the summary in the Goal card, marks one this version adds as new, and shows a rewritten one as a word diff", async () => {
    const before = (doc: Doc) => delete doc.project.summary;
    const added = specVersionView({ compared: { version: 1, status: "approved", spec: parseSpec(specToml(before)).spec! } });
    const slot = await openPage({ specVersion: () => added });
    const block = section(slot, "guardrails").querySelector<HTMLElement>("[data-spec-summary-block]")!;
    expect(block.querySelector("h4")!.textContent).toBe("Summarynew");
    expect(block.querySelector("[data-spec-summary]")!.textContent).toBe("Let people export their orders as a CSV file from the admin page.");
    fireEvent.click(page(slot).querySelector('[data-change="project.summary"] button')!);
    expect(target(slot, "project.summary")!.className).toContain("ring-success");
    slot.lifecycle.unmount();

    const rewritten = specVersionView({ compared: { version: 1, status: "approved", spec: parseSpec(specToml()).spec! } }, (doc) => (doc.project.summary = "Let people export their orders as a CSV file from the orders page."));
    const again = await openPage({ specVersion: () => rewritten });
    const diff = section(again, "guardrails").querySelector<HTMLElement>("[data-spec-summary-block]")!;
    expect(diff.querySelector("h4")!.textContent).toBe("Summaryrewritten");
    expect(diff.querySelector("[data-word-diff]")).not.toBeNull();
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
  const landing = (label = "Land · 2 repos"): NextStep => ({ stage: 5, tone: "normal", title: "Next: land the project.", text: "Every ticket is finished.", action: { control: "land", label, confirm: "Yes, land: push and open the pull request" } });

  it("shows each row's repo as its own mark in Work's list, and on a draft's proposed rows", async () => {
    const { slot } = await mountPage("csv", { project: () => multi() });
    await slot.findByRole("tab", { name: "Work" });
    await waitFor(() => expect(slot.container.querySelector('[data-row="CSV-1"]')).not.toBeNull());
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-move-group="done"] h3 button') ?? document.body);
    expect(chipsIn(slot.container.querySelector('[data-row="CSV-1"]')!)).toEqual(["web"]);
    expect(chipsIn(slot.container.querySelector('[data-row="CSV-2"]')!)).toEqual(["api"]);

    const draft = multi({ overview: overview({ state: "draft", approvedVersion: null, ticketCount: 0, ticketCounts: {}, repos: repos() }) });
    const { slot: dashed } = await mountPage("csv", { project: () => draft });
    await waitFor(() => expect(dashed.container.querySelector('[data-row="CSV-1"][data-draft]')).not.toBeNull());
    expect(chipsIn(dashed.container.querySelector('[data-row="CSV-1"][data-draft]')!)).toEqual(["web"]);
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
    expect(await menuLabels(slot)).toEqual(["Pause now", "Land to each repo's base", "Planner", "Archive project…"]);
    fireEvent.keyDown(slot.getByRole("menu"), { key: "Escape" });
    const line = () => slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(line()).getByRole("button", { name: "Land · open the pull requests" }));
    fireEvent.click(within(line()).getByRole("button", { name: "Yes, land web and api" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "land", confirm: true }));
  });

  it("names every repo the land pushes in its confirm, a repo landed before included, even when it lands onto each base instead", async () => {
    const control = vi.fn(() => multi({ next: null }));
    // web opened its pull request before api had merged work; a land without a repo pushes both again.
    const partly = [repoOverview({ prUrl: "https://github.com/acme/web/pull/4", landedAt: NOW - HOUR, toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", base: "trunk" })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: partly, ticketCounts: { done: 2 } }), next: null }), control });
    await slot.findByRole("heading", { name: "CSV export" });
    expect(await menuLabels(slot)).toEqual(["Pause now", "Land · open the pull requests", "Land to each repo's base", "Planner", "Archive project…"]);
    fireEvent.click(slot.getByRole("menuitem", { name: /^Land · open the pull requests/ }));
    expect(within(titleBar(slot)).getByRole("button", { name: "Yes, land web and api" })).toBeTruthy();
    fireEvent.click(within(titleBar(slot)).getByRole("button", { name: "Back" }));
    await pick(slot, /^Land to each repo's base/);
    fireEvent.click(within(titleBar(slot)).getByRole("button", { name: "Yes, land web and api to their bases" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "csv", action: "landDirect", confirm: true }));

    const { slot: bar } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: partly, ticketCounts: { done: 2 } }), next: landing("Land · 1 repo") }) });
    await waitFor(() => expect(bar.container.querySelector("[data-next-step]")).not.toBeNull());
    const step = bar.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(step).getByRole("button", { name: "Land · open the pull requests" }));
    expect(within(step).getByRole("button", { name: "Yes, land web and api" })).toBeTruthy();
  });

  it("leaves out a repo with no done ticket, and keeps the bar's label when every repo is landed", async () => {
    const apiOnly = [repoOverview({ toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", base: "trunk" })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: apiOnly, ticketCounts: { done: 1 } }), next: null }) });
    await slot.findByRole("heading", { name: "CSV export" });
    await pick(slot, /^Land · open the pull requests/);
    expect(within(titleBar(slot)).getByRole("button", { name: "Yes, land api" })).toBeTruthy();
    fireEvent.click(within(titleBar(slot)).getByRole("button", { name: "Back" }));
    await pick(slot, /^Land to each repo's base/);
    expect(within(titleBar(slot)).getByRole("button", { name: "Yes, land api to their bases" })).toBeTruthy();

    const landed = repos().map((repo) => ({ ...repo, landedAt: NOW - HOUR, toLand: false }));
    const { slot: done } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: landed, ticketCounts: { done: 2 } }), next: landing("Land · finish the project") }) });
    await waitFor(() => expect(done.container.querySelector("[data-next-step]")).not.toBeNull());
    const step = done.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(step).getByRole("button", { name: "Land · finish the project" }));
    expect(within(step).getByRole("button", { name: "Yes, land web and api" })).toBeTruthy();
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
    expect(repoLand(overviews)!.confirm).toBe("Yes, land web and api");
  });

  it("opens each repo's pull request from Work's side pane", async () => {
    const landed = [repoOverview({ prUrl: "https://github.com/acme/web/pull/4", toLand: false }), repoOverview({ name: "api", bbProjectId: "proj_api", prUrl: null, toLand: false })];
    const { slot } = await mountPage("csv", { project: () => multi({ overview: overview({ repos: landed }) }) });
    await slot.findByRole("heading", { name: "CSV export" });
    expect(chipsIn(slot.container.querySelector("[data-repo-prs]")!)).toEqual(["web"]);
    fireEvent.click(slot.getByRole("button", { name: "Open the pull request in web" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://github.com/acme/web/pull/4" }]);
  });

  it("shows no repo chip and no repo section on a single-repo project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ next: landing("Land · open the pull request") }), specVersion: () => specVersionView() });
    await slot.findByRole("tab", { name: "Work" });
    expect(slot.container.querySelector("[data-repo-chip]")).toBeNull();
    expect(slot.container.querySelector("[data-repo-prs]")).toBeNull();
    const bar = slot.container.querySelector<HTMLElement>("[data-next-step]")!;
    fireEvent.click(within(bar).getByRole("button", { name: "Land · open the pull request" }));
    expect(within(bar).getByRole("button", { name: "Yes, land: push and open the pull request" })).toBeTruthy();

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

describe("merge order tab", () => {
  const entry = (over: Partial<MergeEntry> & Pick<MergeEntry, "key">): MergeEntry => ({
    title: `${over.key} title`,
    repo: null,
    state: "pr_open",
    base: "main",
    prUrl: `https://github.com/acme/shop/pull/${over.key.split("-")[1]}`,
    prNumber: over.key.split("-")[1]!,
    prOpen: over.state === undefined || over.state === "pr_open",
    elsewhere: null,
    step: 1,
    stackedOn: null,
    waitsOn: [],
    unblocks: [],
    checks: { passed: 4, failed: 0, pending: 0 },
    draft: false,
    draftHold: null,
    publishWait: null,
    review: "APPROVED",
    reviewRead: true,
    conflicts: false,
    behind: null,
    refreshBehind: null,
    verdict: "ready",
    holds: [],
    prHolds: [],
    trap: false,
    mergedInto: null,
    mergedIntoState: null,
    blockedReason: null,
    ...over,
  });
  const order = (over: Partial<MergeOrderView> = {}): MergeOrderView => ({
    repos: [null],
    steps: 2,
    entries: [
      entry({ key: "CSV-1", verdict: "first", holds: [{ code: "needs_review" }], review: "REVIEW_REQUIRED", unblocks: ["CSV-2"] }),
      entry({ key: "CSV-2", step: 2, stackedOn: "CSV-1", waitsOn: [{ key: "CSV-1", why: "stacked", repo: null, prNumber: "1" }], verdict: "after", trap: true }),
      entry({ key: "CSV-3", verdict: "merged", state: "done", step: 0, review: null }),
    ],
    counts: { open: 2, first: 1, ready: 0, wrong: 0 },
    ...over,
  });
  const prView = (mergeOrder: MergeOrderView | null = order()) => projectView({ overview: overview({ strategy: "pr", branch: null }), mergeOrder });
  const mountOrder = async (view = prView()) => {
    const mounted = await mountPage("csv", { project: () => view });
    await mounted.slot.findByRole("tab", { name: "Work" });
    return mounted.slot;
  };

  it("shows a draft the human holds apart from one Loom is marking ready", async () => {
    const slot = await mountOrder(
      prView(
        order({
          entries: [
            entry({ key: "CSV-1", verdict: "first", holds: [{ code: "draft" }], draft: true, draftHold: "held" }),
            entry({ key: "CSV-2", verdict: "first", holds: [{ code: "draft" }], draft: true, draftHold: "marking" }),
            entry({ key: "CSV-3", verdict: "first", holds: [{ code: "draft" }], draft: true, draftHold: "marking", publishWait: "1 check is still running" }),
          ],
        }),
      ),
    );
    await openView(slot, "Ship", /Merge order/);
    await waitFor(() => expect(slot.container.textContent).toContain("held as a draft: you release it"));
    expect(slot.container.textContent).toContain("being marked ready");
    expect(slot.container.textContent).toContain("draft until it can ship: 1 check is still running");
  });

  it("is no tab on an integration project", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    await openView(slot, "Ship");
    await slot.findByRole("tablist", { name: "Ship" });
    expect(slot.queryByRole("tab", { name: /Merge order/ })).toBeNull();
  });

  it("is a tab on a pull request project that has started, with no badge for pull requests that only have nothing before them", async () => {
    const slot = await mountOrder();
    await openView(slot, "Ship");
    const tab = await slot.findByRole("tab", { name: /Merge order/ });
    // A pull request at step 1 waits on its own review and checks, not on the human, so it is no badge.
    expect(tab.querySelector("[data-tab-badge]")).toBeNull();
    fireEvent.click(tab);
    await waitFor(() => expect(slot.container.querySelector("[data-merge-lead]")).not.toBeNull());
    expect(slot.container.querySelector("[data-badge-notice]")).toBeNull();
  });

  it("opens on Steps: what to merge first, what each waits on, and a warning for the approved stacked one", async () => {
    const slot = await mountOrder();
    await openView(slot, "Ship", /Merge order/);
    expect((await slot.findByText(/2 open pull requests merge in 2 steps\. 1 has nothing before it; none is ready yet: 1 needs a review\./)).hasAttribute("data-merge-lead")).toBe(true);
    expect([...slot.container.querySelectorAll("[data-merge-step]")].map((node) => node.getAttribute("data-merge-step"))).toEqual(["step-1", "step-2", "merged"]);
    const row = (key: string) => slot.container.querySelector<HTMLElement>(`[data-merge-row="${key}"]`)!;
    expect(within(row("CSV-1")).getByText("Needs review").getAttribute("data-merge-verdict")).toBe("first");
    expect(row("CSV-1").textContent).toContain("Unblocks CSV-2.");
    expect(row("CSV-2").textContent).toContain("↳ Builds on CSV-1's branch (#1). When that merges, Loom moves it to main and runs its checks again.");
    expect(slot.container.querySelector("[data-merge-trap]")!.textContent).toContain("#2 (CSV-2) targets CSV-1's branch. Merge #1 (CSV-1) first.");
    fireEvent.click(within(row("CSV-2")).getByRole("button", { name: "CSV-2" }));
    fireEvent.click(within(row("CSV-2")).getByRole("button", { name: "Open CSV-2's pull request" }));
    expect(slot.inspection.navigateCalls.slice(-2)).toEqual([pushed("csv/CSV-2"), { method: "openUrl", url: "https://github.com/acme/shop/pull/2" }]);
  });

  it("lays the pull requests out by repo and step, and says what to do with the one clicked", async () => {
    const slot = await mountOrder();
    await openView(slot, "Ship", /Merge order/);
    fireEvent.click(await slot.findByRole("button", { name: "By repo" }));
    expect([...slot.container.querySelectorAll("[data-merge-card]")].map((node) => node.getAttribute("data-merge-card"))).toEqual(["CSV-3", "CSV-1", "CSV-2"]);
    fireEvent.click(slot.container.querySelector<HTMLElement>('[data-merge-card="CSV-2"]')!);
    const detail = slot.container.querySelector<HTMLElement>('[data-merge-detail="CSV-2"]')!;
    expect(detail.textContent).toContain("⚠ After CSV-1");
    fireEvent.click(within(detail).getByRole("button", { name: "Open ticket" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv/CSV-2"));
  });

  it("says which pull requests conflict with their base and how far behind it each one is, warning once it is due a refresh", async () => {
    const fresh = order({
      entries: [
        entry({ key: "CSV-1", verdict: "first", holds: [{ code: "conflicts", base: "main" }], conflicts: true, behind: 12_374, refreshBehind: 5000 }),
        entry({ key: "CSV-2", behind: 40, refreshBehind: 5000 }),
        entry({ key: "CSV-3", behind: 0, refreshBehind: 5000 }),
      ],
      steps: 1,
      counts: { open: 3, first: 3, ready: 2, wrong: 0 },
    });
    const slot = await mountOrder(prView(fresh));
    await openView(slot, "Ship", /Merge order/);
    const row = (key: string) => slot.container.querySelector<HTMLElement>(`[data-merge-row="${key}"]`)!;
    await waitFor(() => expect(row("CSV-1")).not.toBeNull());
    expect(within(row("CSV-1")).getByText("conflicts with main").className).toContain("text-[var(--loom-bad)]");
    expect(within(row("CSV-1")).getByText("12,374 commits behind main").className).toContain("text-[var(--loom-warn)]");
    expect(within(row("CSV-1")).getByText("Conflicts with main").getAttribute("data-merge-verdict")).toBe("first");
    expect(within(row("CSV-2")).getByText("40 commits behind main").className).toContain("text-[var(--loom-muted)]");
    expect(row("CSV-3").textContent).not.toContain("behind");
    expect(slot.container.querySelector("[data-merge-lead]")!.textContent).toContain("2 pass review and checks: you can merge 2 now.");
    const alone = order({ entries: [entry({ key: "CSV-1", verdict: "first", holds: [{ code: "conflicts", base: "main" }], conflicts: true })], steps: 1, counts: { open: 1, first: 1, ready: 0, wrong: 0 } });
    expect(mergeLead(alone)).toBe("1 open pull request merges in 1 step. 1 has nothing before it; none is ready yet: 1 conflicts with its base.");
  });

  it("turns red for a pull request that merged into another ticket's branch, and says so first", async () => {
    const wrong = order({
      entries: [entry({ key: "CSV-1", verdict: "first", holds: [{ code: "draft" }] }), entry({ key: "CSV-2", state: "done", step: 0, verdict: "merged_elsewhere", mergedInto: "CSV-1", mergedIntoState: "pr_open" })],
      counts: { open: 1, first: 1, ready: 0, wrong: 1 },
    });
    const slot = await mountOrder(prView(wrong));
    await openView(slot, "Ship");
    const tab = await slot.findByRole("tab", { name: /Merge order/ });
    expect(tab.querySelector("[data-tab-badge]")!.getAttribute("data-tone")).toBe("destructive");
    fireEvent.click(tab);
    const alert = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>('[data-merged-elsewhere="CSV-2"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(alert.textContent).toContain("CSV-2's pull request #2 merged into CSV-1's branch, not main.");
    expect(alert.textContent).toContain("CSV-1 (#1) has not merged, so the change is not on main.");
    expect(alert.textContent).toContain("Loom counted CSV-2 as done before it checked where a pull request merged.");
  });

  it("explains the red badge at the top of the tab, and hides it once acknowledged until another pull request merges the wrong way", async () => {
    const elsewhere = (key: string) => entry({ key, state: "done", step: 0, verdict: "merged_elsewhere", mergedInto: "CSV-1", mergedIntoState: "pr_open", prUrl: `https://github.com/acme/shop/pull/${key.slice(4)}` });
    const wrong = (keys: string[], acked: string[]) =>
      projectView({ overview: overview({ strategy: "pr", branch: null }), badgeAcks: { merge: acked, rollout: [] }, mergeOrder: order({ entries: [entry({ key: "CSV-1", verdict: "first", holds: [{ code: "draft" }] }), ...keys.map(elsewhere)], counts: { open: 1, first: 1, ready: 0, wrong: keys.length } }) });
    let current = wrong(["CSV-2"], []);
    const ackBadge = vi.fn(() => (current = wrong(["CSV-2"], ["CSV-2"])));
    const { slot } = await mountPage("csv", { project: () => current, ackBadge });
    await openView(slot, "Ship", /Merge order/);
    const notice = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>('[data-badge-notice="merge"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(notice.textContent).toContain("1 pull request merged into another ticket's branch, so its change is not on the base.");
    expect(notice.textContent).toContain("A pull request leaves the count once the ticket whose branch it went into merges too.");
    fireEvent.click(within(notice).getByRole("button", { name: "CSV-2 merged into CSV-1's branch" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed("csv/CSV-2"));
    fireEvent.click(within(notice).getByRole("button", { name: "Open CSV-2's pull request" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "https://github.com/acme/shop/pull/2" });

    fireEvent.click(within(notice).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(ackBadge).toHaveBeenCalledWith({ slug: "csv", tab: "merge", items: ["CSV-2"], confirm: true }));
    await waitFor(() => expect(slot.container.querySelector('[data-tab-badge="merge"]')).toBeNull());
    expect(slot.container.querySelector("[data-badge-notice]")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Badge hidden until something new comes up");
  });

  it("acknowledges in one click exactly the items shown, so it never acknowledges one the human did not see", async () => {
    const elsewhere = (key: string) => entry({ key, state: "done", step: 0, verdict: "merged_elsewhere", mergedInto: "CSV-1", mergedIntoState: "pr_open" });
    const wrong = (keys: string[]) => projectView({ overview: overview({ strategy: "pr", branch: null }), mergeOrder: order({ entries: [entry({ key: "CSV-1", verdict: "first", holds: [{ code: "draft" }] }), ...keys.map(elsewhere)], counts: { open: 1, first: 1, ready: 0, wrong: keys.length } }) });
    let current = wrong(["CSV-2"]);
    const ackBadge = vi.fn(() => current);
    const { slot } = await mountPage("csv", { project: () => current, ackBadge });
    await openView(slot, "Ship", /Merge order/);
    const notice = () => slot.container.querySelector<HTMLElement>('[data-badge-notice="merge"]')!;
    await waitFor(() => expect(notice()).not.toBeNull());

    current = wrong(["CSV-2", "CSV-3"]);
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(notice().querySelector('[data-badge-item="CSV-3"]')).not.toBeNull());
    fireEvent.click(within(notice()).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(ackBadge).toHaveBeenCalledWith({ slug: "csv", tab: "merge", items: ["CSV-2", "CSV-3"], confirm: true }));
    expect(ackBadge).toHaveBeenCalledTimes(1);
  });
});

describe("rollout tab", () => {
  // One page at a time: a case that mounts several takes the last one down first.
  const unmountAll = () => {
    for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
    cleanup();
    document.body.replaceChildren();
  };
  const step = (over: Partial<RolloutStep> & Pick<RolloutStep, "key">): RolloutStep => ({
    title: `${over.key} title`,
    repo: null,
    state: "pr_open",
    stage: "expand",
    prUrl: `https://github.com/acme/shop/pull/${over.key.split("-")[1]}`,
    prNumber: over.key.split("-")[1]!,
    merge: "open",
    live: null,
    soaked: false,
    soakedAt: null,
    how: "The pipeline deploys main",
    onMerge: false,
    requires: [],
    release: null,
    releaseWith: [],
    dark: false,
    verify: null,
    rollback: null,
    lastCheck: null,
    liveConsumers: [],
    waiting: 0,
    ...over,
  });
  const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
    stages: [
      {
        name: "expand",
        goal: "Servers accept the header",
        soak: "1d",
        steps: [
          step({ key: "CSV-1", state: "done", merge: "merged", verify: "curl -f https://shop.example.com/health", lastCheck: { at: NOW - 60_000, exitCode: 1, output: "curl: (22) 503" }, rollback: "Revert the commit", waiting: 1 }),
          step({
            key: "CSV-2",
            onMerge: true,
            how: "The actuator applies on merge",
            requires: [
              { target: "CSV-1", kind: "ticket", title: "CSV-1 title", live: false, cancelled: false, unknown: false, viaStage: false, prUrl: "https://github.com/acme/shop/pull/1", prNumber: "1", how: "The pipeline deploys main" },
              { target: "traffic-low", kind: "milestone", title: "Old traffic is near zero", live: true, cancelled: false, unknown: false, viaStage: false, prUrl: null, prNumber: null, how: null },
            ],
          }),
        ],
        milestones: [],
        live: false,
        soakedAt: null,
        soaked: false,
      },
    ],
    milestones: [{ ref: "traffic-low", title: "Old traffic is near zero", stage: null, check: null, live: { at: NOW - HOUR, by: "human", evidence: "Dashboard" }, lastCheck: null, neededBy: ["CSV-2"] }],
    windows: [{ title: "Holiday freeze", from: "2026-01-09", to: "2026-01-12", note: null, active: true, startsIn: null, past: false }],
    next: { kind: "deploy", keys: ["CSV-1"], stage: "expand", until: null, text: "Deploy CSV-1 (The pipeline deploys main). 1 step waits on it." },
    warnings: [{ kind: "ships_on_merge", tone: "warning", keys: ["CSV-2"], text: "CSV-2 deploys when it merges, and CSV-1 is not live yet." }],
    counts: { steps: 2, live: 0, soaked: 0 },
    ...over,
  });
  const prView = (view: RolloutView | null = rollout()) => projectView({ overview: overview({ strategy: "pr", branch: null }), rollout: view });
  const mountRollout = async (rpc: Partial<Handlers> = {}, view = prView()) => {
    const mounted = await mountPage("csv", { project: () => view, ...rpc });
    // The rollout is a part of Ship.
    await openView(mounted.slot, "Ship");
    return mounted.slot;
  };

  it("is no tab for a project without a rollout", async () => {
    const slot = await mountRollout({}, prView(null));
    expect(slot.queryByRole("tab", { name: /Rollout/ })).toBeNull();
  });

  it("is a tab whose badge counts the warnings", async () => {
    const slot = await mountRollout();
    const badge = (await slot.findByRole("tab", { name: /Rollout/ })).querySelector("[data-tab-badge]")!;
    expect(badge.textContent).toBe("1");
    expect(badge.getAttribute("data-tone")).toBe("warning");
  });

  it("badges only warning-tone warnings, explains them on the tab, and hides the badge once acknowledged", async () => {
    const info = { kind: "milestone" as const, tone: "info" as const, keys: ["CSV-2"], text: "CSV-2 needs traffic-low to hold before it deploys, and it does not yet." };
    const quiet = await mountRollout({}, prView(rollout({ warnings: [info] })));
    expect((await quiet.findByRole("tab", { name: /Rollout/ })).querySelector("[data-tab-badge]")).toBeNull();
    unmountAll();

    const warned = (acked: string[]) => projectView({ overview: overview({ strategy: "pr", branch: null }), rollout: rollout({ warnings: [info, ...rollout().warnings] }), badgeAcks: { merge: [], rollout: acked } });
    let current = warned([]);
    const id = "ships_on_merge:CSV-2:CSV-2 deploys when it merges, and CSV-1 is not live yet.";
    const ackBadge = vi.fn(() => (current = warned([id])));
    const slot = await mountRollout({ ackBadge, project: () => current }, current);
    const tab = await slot.findByRole("tab", { name: /Rollout/ });
    expect(tab.querySelector("[data-tab-badge]")!.textContent).toBe("1");
    expect(tab.getAttribute("aria-description")).toBe("1 rollout warning before you merge or deploy");
    fireEvent.click(tab);
    const notice = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>('[data-badge-notice="rollout"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(notice.textContent).toContain("CSV-2 deploys when it merges, and CSV-1 is not live yet.");
    expect(notice.textContent).not.toContain("traffic-low");
    fireEvent.click(within(notice).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(ackBadge).toHaveBeenCalledWith({ slug: "csv", tab: "rollout", items: [id], confirm: true }));
    await waitFor(() => expect(tab.querySelector("[data-tab-badge]")).toBeNull());
  });

  const open = async (slot: Slot, key: string) => {
    const row = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>(`[data-rollout-row="${key}"], [data-rollout-milestone="${key}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(row.querySelector("button[aria-expanded]")!);
    return row;
  };
  const showTab = async (slot: Slot) => {
    await openView(slot, "Ship", /Rollout/);
    return waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-rollout]");
      expect(found).not.toBeNull();
      return found!;
    });
  };

  it("leads with the next step as a checklist, then what to hold off, the calendar and a column per stage", async () => {
    const slot = await mountRollout();
    const tab = await showTab(slot);
    const next = tab.querySelector<HTMLElement>('[data-rollout-next="deploy"]')!;
    // The Holiday freeze is on, so the next deploy is held rather than advised, and Mark live stays on CSV-1's own tile.
    expect(within(next).getByRole("heading", { name: "CSV-1 cannot deploy yet: Holiday freeze is on until Jan 12" })).toBeTruthy();
    expect(within(next).queryByRole("button", { name: "Mark CSV-1 live" })).toBeNull();
    expect([...next.querySelectorAll("[data-rollout-plan]")].map((row) => row.getAttribute("data-rollout-plan"))).toEqual(["merge", "deploy", "verify"]);
    expect(next.querySelector('[data-rollout-plan="merge"]')!.textContent).toContain("✓");
    expect(next.querySelector('[data-rollout-plan="deploy"]')!.textContent).toContain("The pipeline deploys mainNot yet: Holiday freeze is on until Jan 12.");
    expect(next.querySelector('[data-rollout-plan="verify"] code')!.textContent).toBe("curl -f https://shop.example.com/health");
    expect(next.querySelector("[data-rollout-then]")!.textContent).toBe("When it is live: 1 more step in Expand after this: CSV-2. CSV-2 waits on it.");
    const hold = tab.querySelector<HTMLElement>('[data-rollout-hold="CSV-2"]')!;
    expect(hold.getAttribute("data-rollout-hold-kind")).toBe("dont_merge");
    expect(hold.textContent).toContain("Don't merge CSV-2 yet");
    expect(hold.textContent).toContain("⚡ merging deploys it");
    expect(hold.textContent).toContain("CSV-1 is not live yet");
    expect(tab.querySelector("[data-rollout-calendar]")!.textContent).toContain("The Holiday freeze is on now, until Jan 12");
    expect(tab.querySelector('[data-rollout-window="Holiday freeze"]')!.textContent).toBe("Holiday freeze");
    const stage = tab.querySelector<HTMLElement>('[data-rollout-stage="expand"]')!;
    expect(stage.textContent).toContain("0 of 2 live");
    expect(stage.textContent).toContain("2 steps left, then it soaks 1 day");
    // CSV-1 goes first; CSV-2 needs it, so it sits under a "then" line; the milestone CSV-2 needs sits in its stage.
    expect([...stage.querySelectorAll("[data-rollout-row], [data-rollout-milestone]")].map((tile) => tile.getAttribute("data-rollout-row") ?? tile.getAttribute("data-rollout-milestone"))).toEqual(["traffic-low", "CSV-1", "CSV-2"]);
    expect(stage.querySelector('[data-rollout-row="CSV-1"] [data-rollout-status]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("Not yet Holiday freeze is on until Jan 12");
    expect(stage.querySelector('[data-rollout-row="CSV-2"] [data-rollout-status]')!.textContent).toContain("Don't merge yet");
    expect(stage.querySelector('[data-rollout-milestone="traffic-low"]')!.getAttribute("data-rollout-holds")).toBe("yes");
    expect(tab.querySelector("[data-rollout-repos]")!.textContent).toContain("after mergeThe pipeline deploys main");
  });

  it("opens a step's details in place: needs, deploy, verify with its output and rollback, and its ticket and pull request", async () => {
    const slot = await mountRollout();
    await showTab(slot);
    const one = await open(slot, "CSV-1");
    const detail = one.querySelector<HTMLElement>("[data-rollout-detail]")!;
    expect(detail.textContent).toContain("nothing first");
    expect(detail.textContent).toContain("After merge. The pipeline deploys main");
    expect(detail.textContent).toContain("Revert the commit");
    expect(detail.textContent).toContain("Unblocks");
    expect(within(detail).getByText("Output").closest("details")!.textContent).toContain("curl: (22) 503");
    const two = await open(slot, "CSV-2");
    expect(one.querySelector("[data-rollout-detail]")).toBeNull();
    expect(two.querySelector('[data-rollout-need="CSV-1"]')!.textContent).toBe("○ CSV-1 not live");
    expect(two.querySelector("[data-rollout-detail]")!.textContent).toContain("⚡ On merge. The actuator applies on merge");
    fireEvent.click(within(two).getByRole("button", { name: "Open ticket" }));
    fireEvent.click(within(two).getByRole("button", { name: "Open #2, CSV-2's pull request" }));
    expect(slot.inspection.navigateCalls.slice(-2)).toEqual([pushed("csv/CSV-2"), { method: "openUrl", url: "https://github.com/acme/shop/pull/2" }]);
  });

  it("marks a step live, and undoes a milestone's mark, each in one click with a toast", async () => {
    const slot = await mountRollout({ markLive: () => prView() });
    await showTab(slot);
    const row = await open(slot, "CSV-1");
    fireEvent.click(within(row).getByRole("button", { name: "Mark live" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked CSV-1 live"));
    const milestone = await open(slot, "traffic-low");
    expect(milestone.querySelector("[data-rollout-detail]")!.textContent).toContain("No command: mark it live once it holds.");
    fireEvent.click(within(milestone).getByRole("button", { name: "Undo live" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("traffic-low is no longer marked live"));
    expect(calls(slot, "markLive").map((call) => call.input)).toEqual([
      { slug: "csv", target: "CSV-1", confirm: true },
      { slug: "csv", target: "traffic-low", undo: true, confirm: true },
    ]);
  });

  it("highlights what a step needs and what waits on it on hover, and a remembered switch turns hovering off", async () => {
    const slot = await mountRollout();
    const tab = await showTab(slot);
    const row = (key: string) => tab.querySelector<HTMLElement>(`[data-rollout-row="${key}"]`)!;
    const links = () => [...tab.querySelectorAll("[data-rollout-link]")].map((link) => link.getAttribute("data-rollout-link"));
    fireEvent.pointerEnter(row("CSV-2"), { pointerType: "mouse" });
    expect(row("CSV-1").textContent).toContain("needed first");
    expect(tab.querySelector('[data-rollout-milestone="traffic-low"]')!.textContent).toContain("needed first");
    expect(links().sort()).toEqual(["CSV-1>CSV-2", "traffic-low>CSV-2"]);
    fireEvent.pointerLeave(row("CSV-2"), { pointerType: "mouse" });
    fireEvent.pointerEnter(row("CSV-1"), { pointerType: "mouse" });
    expect(row("CSV-2").textContent).toContain("waits on it");
    fireEvent.pointerLeave(row("CSV-1"), { pointerType: "mouse" });
    expect(links()).toEqual([]);

    const hover = within(tab).getByRole("switch", { name: "Highlight on hover" });
    expect(hover.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(hover);
    expect(hover.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("loom.rollout.hover")).toBe("false");
    fireEvent.pointerEnter(row("CSV-2"), { pointerType: "mouse" });
    expect(row("CSV-1").textContent).not.toContain("needed first");
    expect(links()).toEqual([]);
    // A step opened by a click still shows its links.
    fireEvent.click(row("CSV-2").querySelector("button[aria-expanded]")!);
    expect(row("CSV-1").textContent).toContain("needed first");
    fireEvent.click(row("CSV-2").querySelector("button[aria-expanded]")!);

    fireEvent.click(within(tab).getByRole("switch", { name: "Show every link" }));
    expect(localStorage.getItem("loom.rollout.links")).toBe("true");
    expect(links().sort()).toEqual(["CSV-1>CSV-2", "traffic-low>CSV-2"]);
  });

  it("reads each open pull request's review and checks from the merge order, on the tiles and in the checklist", async () => {
    const liveOne = rollout({
      stages: [
        {
          ...rollout().stages[0]!,
          steps: [
            step({ key: "CSV-1", state: "done", merge: "merged", live: { at: NOW - HOUR, by: "verify", evidence: null }, soakedAt: NOW + 23 * HOUR }),
            step({ key: "CSV-2", how: "The pipeline deploys main", requires: [{ target: "CSV-1", kind: "ticket", title: "CSV-1 title", live: true, cancelled: false, unknown: false, viaStage: false, prUrl: null, prNumber: "1", how: null }] }),
          ],
        },
      ],
      milestones: [],
      windows: [],
      warnings: [],
      next: { kind: "merge", keys: ["CSV-2"], stage: "expand", until: null, text: "Merge CSV-2 (#2), then deploy it (The pipeline deploys main)." },
      counts: { steps: 2, live: 1, soaked: 0 },
    });
    const entry: MergeEntry = {
      key: "CSV-2",
      title: "CSV-2 title",
      repo: null,
      state: "pr_open",
      base: "main",
      prUrl: "https://github.com/acme/shop/pull/2",
      prNumber: "2",
      prOpen: true,
      elsewhere: null,
      step: 1,
      stackedOn: null,
      waitsOn: [],
      unblocks: [],
      checks: { passed: 20, failed: 0, pending: 1 },
      draft: false,
      draftHold: null,
      publishWait: null,
      review: "REVIEW_REQUIRED",
      reviewRead: true,
      conflicts: false,
      behind: null,
      refreshBehind: null,
      verdict: "first",
      holds: [{ code: "needs_review" }],
      prHolds: [{ code: "needs_review" }],
      trap: false,
      mergedInto: null,
      mergedIntoState: null,
      blockedReason: null,
    };
    const view = projectView({ overview: overview({ strategy: "pr", branch: null }), rollout: liveOne, mergeOrder: { repos: [null], steps: 1, entries: [entry], counts: { open: 1, first: 1, ready: 0, wrong: 0 } } });
    const slot = await mountRollout({}, view);
    const tab = await showTab(slot);
    const next = tab.querySelector<HTMLElement>('[data-rollout-next="merge"]')!;
    // The merge order holds CSV-2 on its review, so the card says so, as Ship's Do next does, rather than "Merge CSV-2".
    expect(within(next).getByRole("heading", { name: "CSV-2 cannot merge yet: needs review" })).toBeTruthy();
    expect(next.querySelector('[data-rollout-plan="review"]')!.textContent).toContain("#2 needs review · 1 pending · ✓ 20 checks");
    expect(next.querySelector("[data-rollout-then]")!.textContent).toContain("Expand is all live and soaks 1 day");
    expect(tab.querySelector('[data-rollout-row="CSV-2"]')!.textContent).toContain("needs review · 1 pending · ✓ 20 checks");
    expect(tab.querySelector('[data-rollout-row="CSV-1"] [data-rollout-status]')!.getAttribute("data-rollout-status")).toBe("soaking");
    expect(tab.querySelector("[data-rollout-hold-off]")).toBeNull();
    expect(tab.querySelector("[data-rollout-calendar]")).toBeNull();
  });

  const nextCard = async (next: RolloutView["next"]) => (await showTab(await mountRollout({}, prView(rollout({ next }))))).querySelector<HTMLElement>("[data-rollout-next]")!;

  it("names a soak as what comes next, with when it ends", async () => {
    const base = rollout();
    const free = rollout({ stages: [{ ...base.stages[0]!, steps: [step({ key: "CSV-2" })] }], next: { kind: "soak", keys: ["CSV-2"], stage: "expand", until: NOW + 2 * HOUR, text: "" } });
    const card = (await showTab(await mountRollout({}, prView(free)))).querySelector<HTMLElement>("[data-rollout-next]")!;
    expect(within(card).getByRole("heading", { name: "Wait for Expand to soak" })).toBeTruthy();
    expect(card.textContent).toContain("2h from now. Then CSV-2 can go.");
  });

  it("names a milestone as what comes next, with its check and a Mark live", async () => {
    const card = await nextCard({ kind: "milestone", keys: ["traffic-low"], stage: "expand", until: null, text: "" });
    expect(within(card).getByRole("heading", { name: "Wait for traffic-low to hold" })).toBeTruthy();
    expect(card.textContent).toContain("Old traffic is near zero");
    expect(card.textContent).toContain("CSV-2 needs it.");
    expect(within(card).getByRole("button", { name: "Mark live" })).toBeTruthy();
  });

  it("says when everything is live", async () => {
    const card = await nextCard({ kind: "done", keys: [], stage: null, until: null, text: "Everything is live." });
    expect(within(card).getByRole("heading", { name: "Everything is live" })).toBeTruthy();
  });

  it("names each step's button by what it shows, and flips aria-expanded as it opens its details", async () => {
    const slot = await mountRollout();
    const tab = await showTab(slot);
    const button = within(tab).getByRole("button", { name: "CSV-2 deploys on merge #2 CSV-2 title Don't merge yet merging deploys it; needs CSV-1", expanded: false });
    expect(within(tab).getByRole("button", { name: "Milestone traffic-low Old traffic is near zero holds" })).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(tab.querySelector(`#${button.getAttribute("aria-controls")}`)!.querySelector("[data-rollout-detail]")).not.toBeNull();
    expect(within(tab).getAllByRole("separator", { name: "Then, after the steps above" }).length).toBeGreaterThan(0);
  });

  it("highlights on keyboard focus, never on a touch, and reads the switch back as it was left", async () => {
    const slot = await mountRollout();
    const tab = await showTab(slot);
    const row = (key: string) => tab.querySelector<HTMLElement>(`[data-rollout-row="${key}"]`)!;
    fireEvent.pointerEnter(row("CSV-2"), { pointerType: "touch" });
    expect(row("CSV-1").textContent).not.toContain("needed first");
    // A key press first, so the browser shows the focus ring a keyboard user sees.
    const keyboard = (button: HTMLElement) => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => button.focus());
      fireEvent.focus(button);
    };
    keyboard(row("CSV-2").querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(row("CSV-1").textContent).toContain("needed first");
    fireEvent.blur(row("CSV-2").querySelector<HTMLElement>("button[aria-expanded]")!);
    expect(row("CSV-1").textContent).not.toContain("needed first");

    unmountAll();
    localStorage.setItem("loom.rollout.hover", "false");
    reloadRemembered();
    const again = await showTab(await mountRollout());
    expect(within(again).getByRole("switch", { name: "Highlight on hover" }).getAttribute("aria-checked")).toBe("false");
    expect(again.textContent).not.toContain("Hover a step");
    keyboard(again.querySelector<HTMLElement>('[data-rollout-row="CSV-2"] button[aria-expanded]')!);
    expect(again.querySelector('[data-rollout-row="CSV-1"]')!.textContent).not.toContain("needed first");
  });

  // Faded to 35% the shown links measured 1.67 to 2.14:1; they recede by width instead, at full strength.
  it("thins the links off the chain when every link shows, and never fades them", async () => {
    localStorage.setItem("loom.rollout.links", "true");
    reloadRemembered();
    const tab = await showTab(await mountRollout());
    const link = (id: string) => tab.querySelector(`[data-rollout-link="${id}"]`)!;
    expect(link("CSV-1>CSV-2").getAttribute("stroke-width")).toBe("1");
    fireEvent.pointerEnter(tab.querySelector('[data-rollout-row="CSV-1"]')!, { pointerType: "mouse" });
    expect(link("CSV-1>CSV-2").getAttribute("stroke-width")).toBe("1.75");
    expect(link("traffic-low>CSV-2").getAttribute("stroke-width")).toBe("1");
    for (const each of tab.querySelectorAll("[data-rollout-link]")) expect(each.getAttribute("class") ?? "").not.toMatch(/opacity-/);
  });

  it("copies a command, and says so when the page has no clipboard", async () => {
    const slot = await mountRollout();
    await showTab(slot);
    const row = await open(slot, "CSV-1");
    fireEvent.click(within(row).getByRole("button", { name: "Copy the command curl -f https://shop.example.com/health" }));
    await waitFor(() => expect(within(row).getByText("Copy failed")).toBeTruthy());
    expect(within(row).getByRole("status").textContent).toBe("Could not copy the command");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      fireEvent.click(within(row).getByRole("button", { name: /^Copy the command/ }));
      await waitFor(() => expect(within(row).getByText("Copied")).toBeTruthy());
      expect(writeText).toHaveBeenCalledWith("curl -f https://shop.example.com/health");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("forgets an opened step that leaves the view, so nothing stays dimmed", async () => {
    let view = prView();
    const mounted = await mountPage("csv", { project: () => view });
    const slot = mounted.slot;
    await slot.findByRole("tab", { name: "Work" });
    await showTab(slot);
    await open(slot, "CSV-1");
    const only = rollout();
    view = prView(rollout({ stages: [{ ...only.stages[0]!, steps: [only.stages[0]!.steps[1]!] }], next: { kind: "merge", keys: ["CSV-2"], stage: "expand", until: null, text: "" } }));
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(slot.container.querySelector('[data-rollout-row="CSV-1"]')).toBeNull());
    expect(slot.container.querySelector('[data-rollout-row="CSV-2"]')!.getAttribute("class")).not.toContain("opacity-30");
  });

  const plan = (over: Partial<RolloutStep>, next: RolloutView["next"]["kind"], merge?: Partial<MergeEntry>) => {
    const base = rollout();
    const view = rollout({
      stages: [{ ...base.stages[0]!, steps: [step({ key: "CSV-1", ...over })] }],
      milestones: [],
      windows: [],
      warnings: [],
      next: { kind: next, keys: ["CSV-1"], stage: "expand", until: null, text: "" },
    });
    const entry: MergeEntry | undefined =
      merge === undefined
        ? undefined
        : {
            key: "CSV-1",
            title: "CSV-1 title",
            repo: null,
            state: "pr_open",
            base: "main",
            prUrl: "https://github.com/acme/shop/pull/1",
            prNumber: "1",
            prOpen: true,
            elsewhere: null,
            step: 1,
            stackedOn: null,
            waitsOn: [],
            unblocks: [],
            checks: null,
            draft: false,
            draftHold: null,
            publishWait: null,
            review: "APPROVED",
            reviewRead: true,
            conflicts: false,
            behind: null,
            refreshBehind: null,
            verdict: "ready",
            holds: [],
            prHolds: [],
            trap: false,
            mergedInto: null,
            mergedIntoState: null,
            blockedReason: null,
            ...merge,
          };
    return projectView({ overview: overview({ strategy: "pr", branch: null }), rollout: view, mergeOrder: entry === undefined ? null : { repos: [null], steps: 1, entries: [entry], counts: { open: 1, first: 1, ready: 0, wrong: 0 } } });
  };
  const card = async (view: ProjectView) => {
    unmountAll();
    return (await showTab(await mountRollout({}, view))).querySelector<HTMLElement>("[data-rollout-next]")!;
  };

  it("ticks Review only when the merge order calls the pull request ready", async () => {
    const draft = await card(plan({}, "merge", { draft: true, verdict: "first", holds: [{ code: "draft" }] }));
    expect(draft.querySelector('[data-rollout-plan="review"]')!.textContent).toBe("1Review#1 draft · approved");
    const ready = await card(plan({}, "merge", { verdict: "ready", checks: { passed: 3, failed: 0, pending: 0 } }));
    expect(ready.querySelector('[data-rollout-plan="review"]')!.textContent).toContain("✓");
    // The forge's review and checks pass; whether the person can merge it now is the Merge row's to say.
    expect(ready.querySelector('[data-rollout-plan="review"]')!.textContent).toContain("Its review and checks pass.");
    const unnumbered = await card(plan({ prNumber: null }, "merge", { prNumber: null, review: "REVIEW_REQUIRED", verdict: "first" }));
    expect(unnumbered.querySelector('[data-rollout-plan="review"]')!.textContent).toContain("Its pull request: needs review");
  });

  it("says a deploy-on-merge step goes live on merge, not when its verify passes", async () => {
    const merge = await card(plan({ onMerge: true, verify: "dig +short edge.example.com" }, "merge"));
    expect(within(merge).getByRole("heading", { name: "Merge CSV-1: merging deploys it" })).toBeTruthy();
    expect([...merge.querySelectorAll("[data-rollout-plan]")].map((row) => row.getAttribute("data-rollout-plan"))).toEqual(["merge", "verify"]);
    expect(merge.querySelector('[data-rollout-plan="verify"]')!.textContent).toContain("Loom marks CSV-1 live when it merges, without waiting for this command");
    const deploy = await card(plan({ state: "done", merge: "merged", verify: "curl -f https://shop.example.com/health" }, "deploy"));
    expect(deploy.querySelector('[data-rollout-plan="verify"]')!.textContent).toContain("Loom runs it every 15 minutes and marks CSV-1 live when it passes.");
  });

  it("names a blocked step, a step with no pull request and a step to wait for", async () => {
    const blocked = await card(plan({ state: "blocked" }, "blocked"));
    expect(within(blocked).getByRole("heading", { name: "CSV-1 is next, and it is blocked" })).toBeTruthy();
    const none = await card(plan({ merge: "no_pr", prUrl: null, prNumber: null, state: "queued" }, "pr"));
    expect(within(none).getByRole("heading", { name: "CSV-1 is next" })).toBeTruthy();
    expect(none.querySelector('[data-rollout-plan="review"]')!.textContent).toContain("Its pull request is not open yet");
    const wait = await card(plan({}, "wait"));
    expect(within(wait).getByRole("heading", { name: "Wait for CSV-1 to go live" })).toBeTruthy();
  });

  it("promises nothing after a soak for a step that still needs a milestone", async () => {
    const base = rollout();
    const needing = step({ key: "CSV-2", requires: [{ target: "traffic-low", kind: "milestone", title: "Old traffic is near zero", live: false, cancelled: false, unknown: false, viaStage: false, prUrl: null, prNumber: null, how: null }] });
    const view = prView(rollout({ stages: [{ ...base.stages[0]!, steps: [needing] }], next: { kind: "soak", keys: ["CSV-2"], stage: "expand", until: NOW + HOUR, text: "" } }));
    const soak = await card(view);
    expect(soak.textContent).toContain("Then the next stage starts, once what its steps need is live.");
    expect(soak.textContent).not.toContain("CSV-2 can go");
  });

  it("puts a freeze that is on now before one that starts later, whatever the spec's order", async () => {
    const windows: RolloutView["windows"] = [
      { title: "Launch freeze", from: "2026-01-20", to: "2026-01-25", note: null, active: false, startsIn: 10, past: false },
      { title: "Holiday freeze", from: "2026-01-09", to: "2026-01-12", note: "Ask the release manager", active: true, startsIn: null, past: false },
    ];
    const base = rollout();
    const view = rollout({
      stages: [{ ...base.stages[0]!, steps: [step({ key: "CSV-2", onMerge: true })] }],
      windows,
      warnings: [
        { kind: "window", tone: "info", keys: ["CSV-2"], text: "CSV-2 deploys on merge and has 10 days before the Launch freeze (Jan 20 to Jan 25)." },
        { kind: "window", tone: "warning", keys: ["CSV-2"], text: "CSV-2 deploys on merge, and the Holiday freeze is on until Jan 12." },
      ],
      next: { kind: "merge", keys: ["CSV-2"], stage: "expand", until: null, text: "" },
    });
    const tab = await showTab(await mountRollout({}, prView(view)));
    expect(tab.querySelector('[data-rollout-hold="CSV-2"]')!.textContent).toContain("CSV-2 deploys on merge during the Holiday freeze");
    expect(tab.querySelector("[data-rollout-calendar]")!.textContent).toContain("The Holiday freeze is on now, until Jan 12");
    expect(tab.querySelector('[data-rollout-window-row="Holiday freeze"]')!.textContent).toContain("Ask the release manager");
  });

  it("titles each kind of hold off by what to do", async () => {
    const base = rollout();
    const need = (target: string, kind: "ticket" | "milestone") => ({ target, kind, title: null, live: false, cancelled: false, unknown: false, viaStage: false, prUrl: null, prNumber: null, how: null });
    const view = rollout({
      stages: [
        { ...base.stages[0]!, name: "expand", steps: [step({ key: "CSV-1" })] },
        { ...base.stages[0]!, name: "migrate", steps: [step({ key: "CSV-2", stage: "migrate", state: "done", merge: "merged", requires: [need("CSV-1", "ticket")] }), step({ key: "CSV-3", stage: "migrate", requires: [need("traffic-low", "milestone")] }), step({ key: "CSV-4", stage: "migrate", state: "done", merge: "merged" })] },
      ],
      milestones: [{ ...base.milestones[0]!, live: null, neededBy: ["CSV-3"] }],
      windows: [],
      warnings: [
        { kind: "deploy_early", tone: "warning", keys: ["CSV-2"], text: "" },
        { kind: "milestone", tone: "info", keys: ["CSV-3"], text: "" },
        { kind: "soak", tone: "warning", keys: ["CSV-4"], text: "" },
      ],
      next: { kind: "merge", keys: ["CSV-1"], stage: "expand", until: null, text: "" },
    });
    const tab = await showTab(await mountRollout({}, prView(view)));
    const hold = (key: string) => tab.querySelector(`[data-rollout-hold="${key}"]`)!;
    expect(hold("CSV-2").textContent).toContain("Don't deploy CSV-2 yet");
    expect(hold("CSV-3").textContent).toContain("CSV-3 waits for traffic-low");
    expect(hold("CSV-3").textContent).toContain("Old traffic is near zero");
    expect(hold("CSV-4").textContent).toContain("CSV-4 is ahead of its stage");
    expect(hold("CSV-4").textContent).toContain("Expand is not all live yet, and CSV-4 is in Migrate");
  });

  it("folds a long stage goal to two lines, and opens it with a click", async () => {
    const tab = await showTab(await mountRollout());
    const goal = tab.querySelector<HTMLElement>('[data-rollout-stage="expand"] [data-rollout-goal]')!;
    expect(goal.getAttribute("aria-expanded")).toBe("false");
    // The clamp sits inside the button, whose own display would win over it.
    expect(goal.getAttribute("class")).not.toContain("line-clamp-2");
    expect(goal.querySelector(".line-clamp-2")!.textContent).toBe("Goal: Servers accept the header");
    fireEvent.click(goal);
    expect(goal.getAttribute("aria-expanded")).toBe("true");
    expect(goal.querySelector(".line-clamp-2")).toBeNull();
  });

  it("says a live step in a stage with no soak is live, not soaked, and that the next stage starts once it is all live", async () => {
    const base = rollout();
    const view = rollout({
      stages: [
        { ...base.stages[0]!, soak: null, steps: [step({ key: "CSV-1", state: "done", merge: "merged", live: { at: NOW - HOUR, by: "verify", evidence: null }, soakedAt: NOW - HOUR, soaked: true }), step({ key: "CSV-3" })] },
        { ...base.stages[0]!, name: "migrate", soak: null, steps: [step({ key: "CSV-2", stage: "migrate" })] },
      ],
      milestones: [],
      windows: [],
      warnings: [],
      next: { kind: "merge", keys: ["CSV-3"], stage: "expand", until: null, text: "" },
    });
    const tab = await showTab(await mountRollout({}, prView(view)));
    expect(tab.querySelector('[data-rollout-row="CSV-1"] [data-rollout-status]')!.textContent).toBe(" live");
    expect(tab.querySelector('[data-rollout-stage="migrate"]')!.textContent).toContain("Starts once Expand is all live");
  });

  it("stacks its parts on a narrow page and lets long text wrap", async () => {
    const slot = await mountRollout();
    const tab = await showTab(slot);
    const classes = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes(tab)).toContain("@container/rollout");
    // The cards and the stages stack until the tab is wide enough for them side by side.
    expect(classes(tab.querySelector("[data-rollout-next]")!.parentElement)).toContain("@3xl/rollout:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]");
    expect(classes(tab.querySelector("[data-rollout-columns]"))).toEqual(expect.arrayContaining(["grid", "@3xl/rollout:grid-cols-[repeat(var(--rollout-stages),minmax(12.5rem,1fr))]"]));
    expect((tab.querySelector("[data-rollout-columns]") as HTMLElement).style.getPropertyValue("--rollout-stages")).toBe("1");
    const two = tab.querySelector('[data-rollout-row="CSV-2"]')!;
    expect(classes(two.querySelector("[data-rollout-title]"))).toContain("[overflow-wrap:anywhere]");
    const detail = (await open(slot, "CSV-1")).querySelector("[data-rollout-detail] dl");
    expect(classes(detail)).toEqual(expect.arrayContaining(["grid-cols-[4rem_minmax(0,1fr)]", "@max-xl/loom:grid-cols-1"]));
    expect(classes(tab.querySelector("[data-rollout-check] pre"))).toEqual(expect.arrayContaining(["overflow-auto", "whitespace-pre-wrap", "[overflow-wrap:anywhere]"]));
  });
});

describe("about strip", () => {
  const about = (over: Partial<ProjectSummary["about"]> = {}) => ({ summary: "Export orders as a CSV file, so finance can reconcile them.", lead: "Implement items 1 to 3 of the issue.", doneWhen: ["People can download the file", "Empty exports have a header row"], links: ["https://github.com/acme/shop/issues/42"], nonGoals: 3, ...over });

  it("shows the summary, the goal's links and what done means, and opens the full goal and the planner", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ about: about() }) }) });
    const strip = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-about]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(strip.querySelector("[data-about-summary]")!.textContent).toBe("Export orders as a CSV file, so finance can reconcile them.");
    expect(strip.textContent).toContain("3 non-goals");
    fireEvent.click(within(strip).getByRole("button", { name: "shop#42" }));
    fireEvent.click(within(strip).getByRole("button", { name: "Done when (2)" }));
    expect([...strip.querySelectorAll("[data-about-done] li")].map((item) => item.textContent)).toEqual(["People can download the file", "Empty exports have a header row"]);
    fireEvent.click(within(strip).getByRole("button", { name: "Planner thread" }));
    expect(slot.inspection.navigateCalls.slice(-2)).toEqual([{ method: "openUrl", url: "https://github.com/acme/shop/issues/42" }, { method: "toThread", threadId: "thr_plan" }]);
    fireEvent.click(within(strip).getByRole("button", { name: "Full goal" }));
    await waitFor(() => expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("stands in the goal's first paragraph for a spec written before summaries, and says the next revision adds one", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ about: about({ summary: null, doneWhen: [] }) }) }) });
    const strip = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-about]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(strip.querySelector("[data-about-summary]")!.textContent).toBe("Implement items 1 to 3 of the issue.");
    expect(strip.textContent).toContain("This spec has no summary, so this is the goal's first paragraph. The planner's next revision of the spec has to add one.");
    expect(within(strip).queryByRole("button", { name: /Done when/ })).toBeNull();
  });

  it("shows the summary of a version that waits for approval, says it is not in force yet, and opens it", async () => {
    const pending = { version: 3, summary: "Export orders as CSV for finance.", doneWhen: ["The file downloads"] };
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ pendingVersion: 3, about: about({ summary: null, doneWhen: [] }), aboutPending: pending }) }), specVersion: () => specVersionView() });
    const strip = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-about]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(strip.querySelector("[data-about-summary]")!.textContent).toBe("Export orders as CSV for finance.");
    expect(strip.querySelector("[data-about-pending]")!.textContent).toContain("From v3, which waits for your approval; the version in force has no summary.");
    expect(strip.textContent).not.toContain("This spec has no summary");
    fireEvent.click(within(strip).getByRole("button", { name: "Done when (1)" }));
    expect(strip.querySelector("[data-about-done]")!.textContent).toBe("The file downloads");
    fireEvent.click(within(strip).getByRole("button", { name: "Review v3" }));
    await waitFor(() => expect(slot.getByRole("tab", { name: "Spec" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("keeps the summary in force and names the one a waiting version changes it to", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ pendingVersion: 3, about: about(), aboutPending: { version: 3, summary: "Export orders for finance.", doneWhen: [] } }) }) });
    const strip = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-about]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(strip.querySelector("[data-about-summary]")!.textContent).toBe("Export orders as a CSV file, so finance can reconcile them.");
    expect(strip.querySelector("[data-about-pending]")!.textContent).toContain("v3, which waits for your approval, changes the summary to: Export orders for finance.");
  });

});

describe("on a narrow page", () => {
  const classes = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);
  // jsdom lays nothing out, so a page measures as `width` wide with a ResizeObserver that never reports again.
  const measuring = async <T,>(width: number, run: () => Promise<T>): Promise<T> => {
    const observer = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
    try {
      return await run();
    } finally {
      Object.defineProperty(Element.prototype, "clientWidth", clientWidth);
      vi.stubGlobal("ResizeObserver", observer);
    }
  };

  it("brings a tab into the bar's view sideways only, and leaves one in view alone", () => {
    expect(sidewaysInto({ left: 0, right: 200 }, { left: 180, right: 260 }, 0)).toBe(76);
    expect(sidewaysInto({ left: 0, right: 200 }, { left: -50, right: 30 }, 120)).toBe(54);
    expect(sidewaysInto({ left: 0, right: 200 }, { left: -10, right: 70 }, 5)).toBe(0);
    expect(sidewaysInto({ left: 0, right: 200 }, { left: 20, right: 100 }, 40)).toBeNull();
  });

  it("names its page as the container the narrow layouts ask, and never scrolls it sideways", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView() });
    await slot.findByRole("tab", { name: "Work" });
    const scroller = slot.container.querySelector("[data-loom-scroll]");
    expect(classes(scroller)).toEqual(expect.arrayContaining(["@container/loom", "overflow-x-hidden", "overflow-y-auto"]));
  });

  it("keeps the views in one row that scrolls sideways by itself, stuck to the top, and scrolls the chosen view into view", async () => {
    const lefts = new WeakMap<Element, number>();
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", { configurable: true, get: function (this: Element) { return lefts.get(this) ?? 0; }, set: function (this: Element, next: number) { lefts.set(this, next); } });
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 28, width: right - left, height: 28, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    // The bar is 200 pixels wide and each view 80, 10 apart: History, the fifth, ends at 440.
    const boxes = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches('[role="tablist"][aria-label="Project views"]')) return rect(0, 200);
      const bar = this.parentElement;
      if (this.getAttribute("role") === "tab" && bar?.matches('[aria-label="Project views"]')) {
        const index = [...bar.children].indexOf(this);
        return rect(index * 90, index * 90 + 80);
      }
      return rect(0, 0);
    });
    try {
      const rpc = { project: () => projectView() };
      const first = await mountPage("csv", rpc);
      const bar = await first.slot.findByRole("tablist", { name: "Project views" });
      expect(classes(bar)).toEqual(expect.arrayContaining(["flex", "flex-nowrap", "min-w-0", "overflow-x-auto", "[scrollbar-width:none]"]));
      expect(classes(bar.closest("[data-view-row]"))).toEqual(expect.arrayContaining(["@max-xl/loom:sticky", "@max-xl/loom:top-0"]));
      for (const tab of within(bar).getAllByRole("tab")) expect(classes(tab)).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
      expect(bar.scrollLeft).toBe(0);
      fireEvent.click(within(bar).getByRole("tab", { name: "History" }));
      await waitFor(() => expect(bar.scrollLeft).toBe(256));
      fireEvent.click(within(bar).getByRole("tab", { name: "Work" }));
      expect(bar.scrollLeft).toBe(256);
      fireEvent.click(within(bar).getByRole("tab", { name: "History" }));
      first.slot.lifecycle.unmount();
      // Opened again on the view it was left on, the bar starts scrolled to it.
      const again = await mountPage("csv", rpc);
      const reopened = await again.slot.findByRole("tablist", { name: "Project views" });
      await waitFor(() => expect(within(reopened).getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true"));
      expect(reopened.scrollLeft).toBe(256);
    } finally {
      boxes.mockRestore();
      delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft;
    }
  });

  it("folds the health cards and the timeline into one row each, a click from the full view, and keeps the summary's first lines", async () => {
    const long = "Export orders as a CSV file from the admin page, so finance can reconcile them each month without asking an engineer.";
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: overview({ about: { summary: long, lead: long, doneWhen: [], links: ["https://github.com/acme/shop/issues/12"], nonGoals: 0 } }) }) });
    await slot.findByRole("tab", { name: "Work" });
    const summary = slot.container.querySelector<HTMLElement>("[data-health-summary]")!;
    const strip = () => slot.container.querySelector("[data-health-strip]");
    expect(classes(summary)).toEqual(expect.arrayContaining(["hidden", "@max-xl/loom:flex"]));
    expect(summary.textContent).toContain("8 of 14 done");
    expect(summary.textContent).toContain("1 blocked");
    expect(summary.textContent).toContain("1/2 workers");
    expect(classes(strip())).toContain("@max-xl/loom:hidden");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(classes(strip())).not.toContain("@max-xl/loom:hidden");

    // The ruler sits in the view row on every view; the full Timeline is History's Rewind, open at every width, so a
    // narrow page shows its moment controls and rows with no fold to open first.
    expect(slot.container.querySelector("[data-view-row] [data-time-ruler]")).not.toBeNull();
    await openView(slot, "History");
    const strip2 = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-timeline-strip]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(slot.container.querySelector("[data-timeline-folded]")).toBeNull();
    expect(classes(strip2)).not.toContain("@max-xl/loom:hidden");
    const full = strip2.querySelector<HTMLElement>("[data-timeline-open]")!;
    expect(full).not.toBeNull();
    expect(classes(full)).not.toContain("@xl/loom:hidden");
    expect(within(full).getByRole("button", { name: "Previous moment" })).toBeTruthy();
    expect(within(full).getByRole("combobox", { name: "Playback speed" })).toBeTruthy();
    expect(within(full).getByRole("group", { name: "Rows" })).toBeTruthy();
    expect(within(strip2).queryByRole("button", { name: "Fold the Timeline" })).toBeNull();

    await openView(slot, "Work");
    const about = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-about]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(classes(about.querySelector("[data-about-summary]"))).toContain("@max-xl/loom:line-clamp-3");
    expect(about.querySelector("[data-about-link]")!.textContent).toContain("shop#12");
    const more = about.querySelector<HTMLElement>("[data-about-more]")!;
    expect(classes(more)).toEqual(expect.arrayContaining(["hidden", "@max-xl/loom:inline"]));
    fireEvent.click(more);
    expect(more.textContent).toBe("Less");
    expect(classes(about.querySelector("[data-about-summary]"))).not.toContain("@max-xl/loom:line-clamp-3");
  });

  it("keeps the next step to one line with its reason a click away, and lists a skipped review's settings behind a disclosure", async () => {
    const repos = [repoOverview({ name: "web" }), repoOverview({ name: "api", bbProjectId: "proj_api" })];
    const paths = ["repo[0].forge.kind", "repo[1].forge.kind", "repo[0].refresh_behind"];
    const summary = overview({ pendingVersion: 2, repos });
    const next = nextStepOf({ overview: summary, board: [], version: 1, maxWorkers: 2, triage: true, startFailed: [], reviewRefused: [], specReview: { kind: "skipped", version: 2, against: 1, paths } })!;
    const { slot } = await mountPage("csv", { project: () => projectView({ overview: summary, next }) });
    const line = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>("[data-next-step]");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(within(line).getByRole("button", { name: "Approve v2" })).toBeTruthy();
    fireEvent.click(line.querySelector<HTMLElement>("[data-next-title]")!);
    const text = (await slot.findByRole("dialog", { name: "Next step" })).querySelector("[data-next-text]")!;
    expect(classes(text)).toContain("[overflow-wrap:anywhere]");
    expect(text.textContent).toContain("Loom skipped its spec review, because against v1 it changes only 3 operational settings: the forge on 2 repos and web's refresh_behind.");
    expect(text.textContent).not.toContain("repo[0]");
    const list = text.querySelector<HTMLDetailsElement>("[data-setting-paths]")!;
    expect(list.open).toBe(false);
    expect(list.querySelector("summary")!.textContent).toBe("The 3 settings it changes");
    expect([...list.querySelectorAll("[data-setting-path]")].map((item) => [item.getAttribute("data-setting-path"), item.textContent])).toEqual([
      ["repo[0].forge.kind", "web › forge › kind"],
      ["repo[1].forge.kind", "api › forge › kind"],
      ["repo[0].refresh_behind", "web › refresh behind"],
    ]);
  });


  it("stacks each agent's row, its facts named by their columns", async () => {
    const agents = [agent(), agent({ threadId: "thr_w0", state: "ended", startedAt: NOW - 9 * HOUR, endedAt: NOW - 7 * HOUR, endReason: "abandoned", timeoutAt: null })];
    const { slot } = await mountPage("csv", { project: () => projectView({ agents }) });
    await openView(slot, "History", "Agents");
    for (const id of ["thr_w1", "thr_w0"]) {
      const row = slot.container.querySelector(`[data-agent-row="${id}"]`)!;
      expect(classes(row)).toEqual(expect.arrayContaining(["@max-xl/loom:flex", "@max-xl/loom:flex-wrap"]));
      expect(classes(row.closest("table"))).toEqual(expect.arrayContaining(["@max-xl/loom:block", "@max-xl/loom:min-w-0"]));
      expect(classes(row.closest("table")!.querySelector("thead"))).toContain("@max-xl/loom:hidden");
    }
    const labels = (id: string) => [...slot.container.querySelectorAll(`[data-agent-row="${id}"] [data-label]`)].map((cell) => cell.getAttribute("data-label"));
    expect(labels("thr_w1")).toEqual(["Model", "Running for", "Tokens", "Retries"]);
    expect(labels("thr_w0")).toEqual(["Model", "Ran for", "Ended", "Tokens", "Retries"]);
    expect(classes(slot.container.querySelector('[data-agent-row="thr_w0"] [data-label="Ended"]'))).toContain("@max-xl/loom:before:content-[attr(data-label)]");
  });

  it("breaks a long name in an Insights row rather than run off the page", async () => {
    const { slot } = await mountPage("csv", { project: () => projectView(), insights: () => projectInsights(story().rows(), { now: at(60), strategy: "integration", maxWorkers: 2, maxTokens: null }) });
    await openView(slot, "History", "Insights");
    const rows = await waitFor(() => {
      const found = [...slot.container.querySelectorAll("[data-insights-story] li[data-chapter], [data-insights-story] li[data-current]")];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    for (const row of rows) expect(classes(row.children[1]!)).toEqual(expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"]));
  });

  it("wraps New project's merge plan choices", async () => {
    const { slot } = await mountPage("_new");
    const group = await slot.findByRole("group", { name: "Merge plan" });
    expect(classes(group)).toContain("flex-wrap");
    expect(classes(group.querySelector("[data-merge-choices]"))).toContain("flex-wrap");
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Ask me", "Integration branch", "PR per ticket"]);
  });

  it("leaves bb's title room on a phone: icons in the title bar, with Sync pull requests in the ⋯ menu alone", async () => {
    const view = { ...projectView({ overview: overview({ state: "paused", strategy: "pr", ticketCounts: { pr_open: 1, queued: 1 } }) }), next: null };
    const bar = (width: number) =>
      measuring(width, async () => {
        const { slot } = await mountPage("csv", { project: () => view });
        await slot.findByRole("heading", { name: "CSV export" });
        await waitFor(() => expect(narrowPage.get()).toBe(width < 576));
        await waitFor(() => expect(titleBar(slot)).not.toBeNull());
        const buttons = [...titleBar(slot).querySelectorAll(":scope > button")].map((button) => ({ name: button.getAttribute("aria-label") ?? button.textContent, text: button.textContent }));
        const jump = slot.getByRole("button", { name: /^Jump to/ });
        const menu = (await openMenu(slot)).queryAllByRole("menuitem").map((item) => item.textContent);
        slot.lifecycle.unmount();
        return { buttons, jump: { text: jump.textContent, kbd: jump.querySelector("kbd") !== null }, menu };
      });
    const phone = await bar(360);
    expect(phone.buttons).toEqual([
      { name: "Resume", text: "" },
      { name: "More project controls", text: "" },
    ]);
    expect(phone.jump).toEqual({ text: "", kbd: false });
    expect(phone.menu[0]).toContain("Sync pull requests");
    const wide = await bar(1300);
    expect(wide.buttons.map((button) => button.name)).toEqual(["Sync pull requests", "Resume", "More project controls"]);
    expect(wide.jump).toEqual({ text: "Jump to/", kbd: true });
  });

  it("names a ticket's project by its key in bb's title bar, and by its name on a wide page", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const titled = (width: number) =>
      measuring(width, async () => {
        const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(
          { component: app.navPanels[0]!.component, experimental_usePageTitle: app.navPanels[0]!.experimental_usePageTitle },
          { subPath: "csv/CSV-3" },
          { pluginId: "loom", rpc: handlers({ home: () => homeView({ projects: [homeProject()] }), ticket: () => ticketDetail() }) },
        );
        mounts.push(slot);
        await waitFor(() => expect(slot.inspection.experimental_pageTitle).not.toEqual({ breadcrumbs: [{ label: "csv", to: "/plugins/loom/loom/csv" }, { label: "CSV-3" }] }));
        const title = slot.inspection.experimental_pageTitle;
        slot.lifecycle.unmount();
        return title;
      });
    expect(await titled(360)).toEqual({ breadcrumbs: [{ label: "CSV", to: "/plugins/loom/loom/csv" }, { label: "CSV-3" }] });
    expect(narrowPage.get()).toBe(false);
    expect(await titled(1300)).toEqual({ breadcrumbs: [{ label: "CSV export", to: "/plugins/loom/loom/csv" }, { label: "CSV-3" }] });
  });

  // bb draws the project crumb as a link that never shrinks, so a long name painted through Loom's controls at 720 px.
  it("names a ticket's project by its key where its full name would run into Loom's controls in bb's title bar", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const Header = app.navPanels[0]!.headerContent!;
    const titled = async (nameWidth: number) => {
      const box = (left: number, width: number) => ({ left, width, right: left + width, top: 10, bottom: 38, height: 28, x: left, y: 10, toJSON: () => ({}) }) as DOMRect;
      const rects = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this.matches('a[href$="/loom/csv"]')) return box(100, nameWidth);
        if (this.hasAttribute("data-loom-header")) return box(356, 276);
        return box(0, 0);
      });
      try {
        // bb's title bar: its crumb link to the project, then Loom's controls.
        const Bar = (props: PluginNavPanelProps) => (
          <header>
            <a href="/plugins/loom/loom/csv">CSV export</a>
            <Header {...props} />
          </header>
        );
        const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>(
          { component: Bar, experimental_usePageTitle: app.navPanels[0]!.experimental_usePageTitle },
          { subPath: "csv/CSV-3" },
          { pluginId: "loom", rpc: handlers({ home: () => homeView({ projects: [homeProject()] }), ticket: () => ticketDetail() }) },
        );
        mounts.push(slot);
        // Until home arrives the crumb is the slug; then the project's key or its name.
        const title = await waitFor(() => {
          const shown = slot.inspection.experimental_pageTitle as { breadcrumbs: Array<{ label: string; to?: string }> };
          expect(shown.breadcrumbs.map((crumb) => crumb.to ?? crumb.label)).toEqual(["/plugins/loom/loom/csv", "CSV-3"]);
          expect(shown.breadcrumbs[0]!.label).not.toBe("csv");
          return shown;
        });
        slot.lifecycle.unmount();
        return { first: title.breadcrumbs[0]!.label, short: shortCrumb.get() };
      } finally {
        rects.mockRestore();
      }
    };
    // 100 + 400 px of name, a chevron and the key run past Loom's controls at 356 px.
    expect((await titled(400)).first).toBe("CSV");
    expect(shortCrumb.get()).toBe(false);
    // 100 + 100 px of name and the key end before them, so the name stays.
    expect((await titled(100)).first).toBe("CSV export");
  });
});
