// @vitest-environment jsdom
// Phase 5's surfaces: Home (the four numbers, the Needs you queue across its sources, Since you looked, the projects with
// their ticket bar and the Finished fold), Loom's surfaces in bb's thread view, and the ticket pane's embedded threads.
import type React from "react";
import { useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { useBbNavigate, type PluginNavPanelProps, type PluginThreadActionItemInput } from "@get-bb/plugin-sdk/app";
import type { HomeFeed, HomeFeedRow, HomeView, PlanningSession, rpcContract, ThreadInfo } from "../src/contract";
import type { FeedKind } from "../src/feed-kinds";
import { changedTags } from "../src/rpc-tags";
import { focusNote, keysSheet, palette, rewind } from "../src/ui/dispatch";
import { reloadRemembered } from "../src/ui/remember";
import { queueOf } from "../src/ui/needs";
import { buttonLabel, threadButton, useDrawerKeyboard } from "../src/ui/thread-surfaces";
import { Since } from "../src/ui/home";
import { useStateNote } from "../src/ui/ticket-header";
import { projectViews } from "../src/ui/views";
import { HOUR, NOW, homeProject, homeView, need, plannerViewOf, projectView, threadInfo, ticketDetail, timeline } from "./fixtures";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const unexpected = (): never => {
  throw new Error("unexpected rpc call");
};
const noFeed: HomeFeed = { rows: [], counts: { shipped: 0, sentBack: 0, blocked: 0, asks: 0, phase: 0, you: 0 }, matched: 0, partial: [] };
const handlers = (over: Partial<Handlers> = {}): Handlers => ({
  projects: unexpected,
  home: () => homeView(),
  badge: () => ({ needsYou: 0, blocked: false, threadIds: [] }),
  project: unexpected,
  ticket: unexpected,
  runOutput: unexpected,
  insights: unexpected,
  timeline: () => timeline(),
  insightsAll: unexpected,
  threadInfo: () => null,
  threadInfos: () => ({}),
  homeFeed: () => noFeed,
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
  for (const slot of mounts.splice(0)) slot.lifecycle.unmount();
  cleanup();
  document.body.replaceChildren();
  palette.set(false);
  keysSheet.set(false);
  rewind.set(null);
  focusNote.set(null);
  localStorage.clear();
  reloadRemembered();
});

// The first page a file mounts imports the whole app: module loading, not what a test checks. Beside a full run that
// import alone took 2.2 to 5.4 s, inside the first mounting test's 5 s, so it loads once here under its own deadline.
beforeAll(async () => {
  await loadPluginApp(() => import("../app"));
}, 60_000);

async function mountPanel(subPath: string, rpc: Partial<Handlers> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const Panel = app.navPanels[0]!.component;
  const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: Panel }, { subPath }, { pluginId: "loom", rpc: handlers(rpc) });
  mounts.push(slot);
  return { slot, goTo: (next: string) => slot.lifecycle.rerender(<Panel subPath={next} />) };
}
async function mountHome(rpc: Partial<Handlers> = {}) {
  const { slot } = await mountPanel("_home", rpc);
  await slot.findByRole("region", { name: "Needs you" });
  return slot;
}
const calls = (slot: Slot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method);
const pushed = (subPath: string) => ({ method: "toPluginPanel", path: "loom", options: { subPath } });
const queue = (slot: Slot) => within(slot.getByRole("region", { name: "Needs you" }));
const rows = (slot: Slot) => [...slot.getByRole("region", { name: "Needs you" }).querySelectorAll<HTMLElement>("[data-need]")];

describe("Home's numbers", () => {
  it("shows four numbers for the day: what needs you with its oldest wait, running, done this week and tokens", async () => {
    const slot = await mountHome();
    const number = (id: string) => slot.container.querySelector<HTMLElement>(`[data-home-number="${id}"]`)!;
    expect([...slot.container.querySelectorAll("[data-home-number]")].map((node) => node.getAttribute("data-home-number"))).toEqual(["needs", "running", "done", "tokens"]);
    expect(number("needs").querySelector("[data-number]")!.textContent).toBe("4");
    expect(number("needs").textContent).toContain("oldest 3h");
    expect(number("running").textContent).toContain("5 of 8 slots busy");
    expect(number("running").textContent).toContain("· 1 paused");
    expect(number("done").querySelector("[data-number]")!.textContent).toBe("14");
    expect(number("done").textContent).toContain("9 the week before");
    expect(number("tokens").querySelector("[data-number]")!.textContent).toBe("3.1M");
    expect(number("tokens").textContent).toContain("≈ 220K per done ticket");
    expect(number("tokens").textContent).toContain("cost not recorded yet");
    expect(number("tokens").querySelector("[data-tokens-unreported]")).toBeNull();
  });

  it("reads missing token reports as missing, never as a measured zero, and says cost is not recorded", async () => {
    const totals = (over: Partial<HomeView["totals"]>) => ({ ...homeView().totals, ...over });
    const tokensOf = async (over: Partial<HomeView["totals"]>) => {
      const slot = await mountHome({ home: () => homeView({ totals: totals(over) }) });
      await slot.findByRole("region", { name: "Today" });
      const node = slot.container.querySelector<HTMLElement>('[data-home-number="tokens"]')!;
      const out = { big: node.querySelector("[data-number]")!.textContent, text: node.textContent, unreported: node.querySelector("[data-tokens-unreported]")?.textContent ?? null };
      cleanup();
      return out;
    };
    const some = await tokensOf({ tokens: 3_100_000, tokenThreads: 30, tokensUnreported: 4 });
    expect(some.big).toBe("3.1M");
    expect(some.unreported).toBe("4 of 30 threads unreported · ");
    expect(some.text).toContain("cost not recorded yet");
    const none = await tokensOf({ tokens: 0, tokenThreads: 12, tokensUnreported: 12 });
    expect([none.big, none.unreported]).toEqual(["not recorded", null]);
    expect(none.text).not.toContain("per done ticket");
    expect(none.text).toContain("cost not recorded yet");
    const before = await tokensOf({ tokens: 0, tokenThreads: 0, tokensUnreported: 0, perDoneTicket: null });
    expect(before.big).toBe("—");
  });
});

describe("Home's Needs you queue", () => {
  it("lists every item oldest first, each with its source's word, its facts and its age, and 'age unknown' where Loom does not know it", async () => {
    const needsYou = [...homeView().needsYou, need({ kind: "rollout", slug: "srch", project: "Search revamp", projectKey: "SRCH", title: "2 rollout warnings before you merge or deploy", text: "Deploy LANE-4 first · Freeze window", startedAt: null })];
    const slot = await mountHome({ home: () => homeView({ needsYou }) });
    expect(rows(slot).map((row) => [row.getAttribute("data-need"), row.querySelector("[data-need-age]")!.textContent])).toEqual([
      ["paused", "3h"],
      ["land", "1h"],
      ["approve", "12m"],
      ["blocked", "5m"],
      ["rollout", "age unknown"],
    ]);
    const blocked = rows(slot)[3]!;
    expect(within(blocked).getByRole("button").textContent).toBe("CSV-7Export endpointBlocked · unblocks 1 · 2 in all");
    expect(within(rows(slot)[2]!).getByRole("button").textContent).toBe("AUD v1Audit logDraft · has a draft spec v1 with 9 tickets");
    // A plain list of named row buttons, not a listbox.
    expect(slot.getByRole("list", { name: "Needs you, oldest first" })).toBeTruthy();
    expect(slot.queryByRole("listbox")).toBeNull();
  });

  it("opens a blocked ticket with its note focused, and a draft on Spec", async () => {
    const slot = await mountHome();
    fireEvent.click(within(rows(slot)[3]!).getByRole("button"));
    expect(focusNote.get()).toBe("CSV-7");
    fireEvent.click(within(rows(slot)[2]!).getByRole("button"));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-7"), pushed("audit")]);
  });

  it("answers a project Loom paused in place: Resume is one click, through the project's control", async () => {
    const control = vi.fn(() => projectView());
    const slot = await mountHome({ control });
    const row = rows(slot)[0]!;
    const open = within(row).getByRole("button");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const reader = row.querySelector<HTMLElement>("[data-need-reader]")!;
    expect(reader.textContent).toContain("The token budget is used up: 900 of 900 tokens.");
    expect(reader.textContent).toContain("From: paused");
    expect(within(reader).getByRole("button", { name: "Change the budget in Spec" })).toBeTruthy();
    fireEvent.click(within(reader).getByRole("button", { name: "Resume BILL" }));
    await waitFor(() => expect(control).toHaveBeenCalledWith({ slug: "bill", action: "resume", confirm: true }));
  });

  it("offers Spec only for a budget or deadline pause; any other pause opens its project", async () => {
    const paused = need({ kind: "paused", slug: "otlp", project: "OTLP labels", projectKey: "OTLP", text: "Reading the pull request of OTLP-18 stopped: the host was replaced", startedAt: NOW - HOUR });
    const slot = await mountHome({ home: () => homeView({ needsYou: [paused] }) });
    fireEvent.click(within(rows(slot)[0]!).getByRole("button"));
    const reader = rows(slot)[0]!.querySelector<HTMLElement>("[data-need-reader]")!;
    expect(within(reader).queryByRole("button", { name: /budget/ })).toBeNull();
    fireEvent.click(within(reader).getByRole("button", { name: "Open OTLP" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("otlp")]);
  });

  it("draws the planner's ask as Planner does, with each step's action, Mark done and Set aside", async () => {
    const ask = { id: 7, at: NOW - HOUR, why: "v2 fixes the fixture", open: true, steps: [{ action: "approve" as const, version: 2, text: "Approve v2", done: false }, { action: "requeue" as const, key: "CSV-7", text: "Requeue CSV-7", done: false }, { action: "other" as const, text: "Watch the alert", done: false }] };
    const askItem = need({ kind: "ask", id: "ask:csv:7", ask: 7, version: 2, title: "Approve v2 · Requeue CSV-7 · Watch the alert", text: "v2 fixes the fixture", sources: ["planner ask, 3 steps", "spec v2 waits for approval"], startedAt: NOW - HOUR });
    const askStepDone = vi.fn(() => plannerViewOf({ ask }));
    const dismissAsk = vi.fn(() => plannerViewOf({ ask: null }));
    const slot = await mountHome({
      home: () => homeView({ needsYou: [askItem] }),
      project: () => projectView({ overview: { ...projectView().overview, pendingVersion: 2, state: "running" } }),
      plannerView: () => plannerViewOf({ ask, pendingVersion: 2, projectState: "running" }),
      askStepDone,
      dismissAsk,
    });
    expect(within(rows(slot)[0]!).getByRole("button").textContent).toContain("Planner asks · planner ask, 3 steps · with spec v2's approval");
    fireEvent.click(within(rows(slot)[0]!).getByRole("button"));
    const card = await slot.findByRole("region", { name: "The planner asks you to" });
    expect([...card.querySelectorAll("[data-ask-step]")].map((step) => step.getAttribute("data-ask-step"))).toEqual(["approve", "requeue", "other"]);
    // Requeue waits for the approval listed before it.
    expect(card.querySelector('[data-ask-step="requeue"] [data-ask-wait]')!.textContent).toBe("after step 1");
    const third = card.querySelector<HTMLElement>('[data-ask-step="other"]')!;
    fireEvent.click(within(third).getByRole("button", { name: "Mark done" }));
    fireEvent.click(within(third).getByRole("button", { name: "Yes, mark step 3 done" }));
    await waitFor(() => expect(askStepDone).toHaveBeenCalledWith({ slug: "csv", ask: 7, step: 2, confirm: true }));
    fireEvent.click(within(card).getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(dismissAsk).toHaveBeenCalledWith({ slug: "csv", ask: 7, confirm: true }));
  });

  describe("on a phone, the reader docks the answer at the bottom", () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth")!;
    const phone = async <T,>(run: () => Promise<T>) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
      try {
        return await run();
      } finally {
        Object.defineProperty(window, "innerWidth", width);
      }
    };
    const dock = (slot: Slot) => slot.container.ownerDocument.querySelector<HTMLElement>("[data-phone-reader] [data-answer-dock]")!;
    const body = (slot: Slot) => slot.container.ownerDocument.querySelector<HTMLElement>("[data-phone-reader] .overflow-y-auto")!;

    it("docks Release draft and Confirm merge with their armed Yes and Back, and leaves the facts above", () =>
      phone(async () => {
        const draft = need({ kind: "draft", id: "draft:CSV-3", key: "CSV-3", keys: ["CSV-3"], prUrl: "https://github.com/o/r/pull/3", title: "Export rows", text: "held as a draft until you release it", sources: ["held draft"], clears: "Clears when you release the draft." });
        const merge = need({ kind: "merge", id: "merge:CSV-4", key: "CSV-4", keys: ["CSV-4"], prUrl: "https://github.com/o/r/pull/4", sha: "3f9a2c71e0b4d5a6", title: "Import rows", text: "ready to merge", sources: ["manual merge"] });
        const slot = await mountHome({ home: () => homeView({ needsYou: [draft, merge] }) });
        fireEvent.click(within(rows(slot)[0]!).getByRole("button"));
        await waitFor(() => expect(within(dock(slot)).getByRole("button", { name: "Release draft", hidden: true })).toBeTruthy());
        expect(within(dock(slot)).getByRole("button", { name: "Open CSV-3", hidden: true })).toBeTruthy();
        expect(body(slot).textContent).toContain("Held as a draft: you release it.");
        expect(within(body(slot)).queryByRole("button", { name: "Release draft", hidden: true })).toBeNull();
        fireEvent.click(within(dock(slot)).getByRole("button", { name: "Release draft", hidden: true }));
        expect(within(dock(slot)).getByRole("button", { name: "Yes, mark it ready for review", hidden: true })).toBeTruthy();
        fireEvent.click(within(dock(slot)).getByRole("button", { name: "Back", hidden: true }));
        expect(within(dock(slot)).getByRole("button", { name: "Release draft", hidden: true })).toBeTruthy();
        fireEvent.keyDown(slot.container.ownerDocument.querySelector("[data-phone-reader]")!, { key: "Escape" });
        await waitFor(() => expect(slot.container.ownerDocument.querySelector("[data-phone-reader]")).toBeNull());
        await waitFor(() => expect(slot.container.ownerDocument.activeElement).toBe(within(rows(slot)[0]!).getByRole("button")));
        fireEvent.click(within(rows(slot)[1]!).getByRole("button"));
        await waitFor(() => expect(within(dock(slot)).getByRole("button", { name: "Confirm merge", hidden: true })).toBeTruthy());
        fireEvent.click(within(dock(slot)).getByRole("button", { name: "Confirm merge", hidden: true }));
        expect(within(dock(slot)).getByRole("button", { name: "Yes, merge 3f9a2c71e0b4", hidden: true })).toBeTruthy();
        expect(body(slot).textContent).toContain("Ready to merge at 3f9a2c71e0b4.");
      }));

    it("docks the ask's current step, keeps the later steps in the card with their wait, and does not repeat the steps above it", () =>
      phone(async () => {
        const ask = { id: 7, at: NOW - HOUR, why: "v2 fixes the fixture", open: true, steps: [{ action: "approve" as const, version: 2, text: "Approve v2", done: false }, { action: "requeue" as const, key: "CSV-7", text: "Requeue CSV-7", done: false }] };
        const askItem = need({ kind: "ask", id: "ask:csv:7", ask: 7, version: 2, title: "Approve v2 · Requeue CSV-7", text: "v2 fixes the fixture", sources: ["planner ask, 2 steps"], startedAt: NOW - HOUR });
        const slot = await mountHome({
          home: () => homeView({ needsYou: [askItem] }),
          project: () => projectView({ overview: { ...projectView().overview, pendingVersion: 2, state: "running" } }),
          plannerView: () => plannerViewOf({ ask, pendingVersion: 2, projectState: "running" }),
        });
        fireEvent.click(within(rows(slot)[0]!).getByRole("button"));
        await waitFor(() => expect(within(dock(slot)).getByRole("button", { name: "Approve v2", hidden: true })).toBeTruthy());
        expect(dock(slot).textContent).toContain("Step 1 of 2");
        expect(within(dock(slot)).getByRole("button", { name: "Mark done", hidden: true })).toBeTruthy();
        const card = body(slot).querySelector<HTMLElement>("[data-planner-asks]")!;
        expect(card.querySelector('[data-ask-step="requeue"] [data-ask-wait]')!.textContent).toBe("after step 1");
        expect(within(card.querySelector<HTMLElement>('[data-ask-step="approve"]')!).queryByRole("button", { hidden: true })).toBeNull();
        expect(body(slot).textContent!.split("Approve v2").length - 1).toBe(1);
        fireEvent.click(within(dock(slot)).getByRole("button", { name: "Approve v2", hidden: true }));
        expect(within(dock(slot)).getByRole("button", { name: "Back", hidden: true })).toBeTruthy();
      }));
  });

  it("adds a thread bb shows waiting on you, aged from its open interaction, and counts it", async () => {
    const home = homeView({ threads: [{ threadId: "thr_plan", role: "planner", slug: "csv", project: "CSV export", projectKey: "CSV", key: null }] });
    const items = queueOf(home, new Set(["thr_plan"]), new Map([["thr_plan", { at: NOW - 2 * HOUR, count: 2 }]]));
    expect(items.map((item) => [item.kind, item.startedAt])).toEqual([
      ["paused", NOW - 3 * HOUR],
      ["question", NOW - 2 * HOUR],
      ["land", NOW - HOUR],
      ["approve", NOW - 12 * 60_000],
      ["blocked", NOW - 5 * 60_000],
    ]);
    expect(items[1]).toMatchObject({ title: "The planner asks", text: "2 rounds wait for your answer", threadId: "thr_plan" });
    // Without bb's time, it goes after the known ones, as age unknown.
    expect(queueOf(home, new Set(["thr_plan"]), new Map()).at(-1)).toMatchObject({ kind: "question", startedAt: null });
  });

  it("shows six items and the rest behind N more, and says when they flood in", async () => {
    const many = Array.from({ length: 14 }, (_, index) => need({ kind: "blocked", key: `CSV-${index + 10}`, text: "stuck", startedAt: NOW - (index + 1) * 30_000 }));
    const slot = await mountHome({ home: () => homeView({ needsYou: many }) });
    expect(rows(slot)).toHaveLength(6);
    expect(queue(slot).getByRole("status").textContent).toBe("flood: 14 in 10 min");
    fireEvent.click(queue(slot).getByRole("button", { name: "8 more" }));
    expect(rows(slot)).toHaveLength(14);
  });

  it("moves between rows with j and k", async () => {
    const slot = await mountHome();
    const buttons = rows(slot).map((row) => within(row).getByRole("button"));
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "j" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: "k" });
    expect(document.activeElement).toBe(buttons[0]);
  });
});

describe("Home's Since you looked", () => {
  const feed: HomeFeed = {
    rows: [
      { id: 9, at: NOW - 5 * 60_000, slug: "csv", projectKey: "CSV", ticketKey: "CSV-3", kind: "shipped", text: "CSV-3 moved from merging to done." },
      { id: 8, at: NOW - 10 * 60_000, slug: "csv", projectKey: "CSV", ticketKey: "CSV-7", kind: "blocked", text: "CSV-7 moved from working to blocked." },
      ...Array.from({ length: 6 }, (_, index) => ({ id: 7 - index, at: NOW - (20 + index) * 60_000, slug: "csv", projectKey: "CSV", ticketKey: null, kind: "you" as const, text: "You ran resume." })),
    ],
    counts: { shipped: 1, sentBack: 0, blocked: 1, asks: 0, phase: 0, you: 6 },
    matched: 8,
    partial: [],
  };

  // A server as homeFeed is: it counts every event, filters by the kind asked for, and sends the newest `limit` of them.
  const serve =
    (all: readonly HomeFeedRow[], partial: HomeFeed["partial"] = []) =>
    ({ kind, limit }: { since: number; kind?: FeedKind | null; limit?: number }): HomeFeed => {
      const counts = { shipped: 0, sentBack: 0, blocked: 0, asks: 0, phase: 0, you: 0 };
      for (const row of all) counts[row.kind] += 1;
      const matching = all.filter((row) => kind == null || row.kind === kind);
      return { rows: matching.slice(0, limit ?? 60), counts, matched: matching.length, partial };
    };

  it("reads every project's events since the last visit, filters them by kind, and folds the older ones", async () => {
    localStorage.setItem("loom.home.lookedAt", String(NOW - HOUR));
    const slot = await mountHome({ homeFeed: serve(feed.rows) });
    const since = await slot.findByRole("region", { name: "Since you looked" });
    expect(calls(slot, "homeFeed")).toEqual([{ method: "homeFeed", input: { since: NOW - HOUR, kind: null, limit: 60 } }]);
    await waitFor(() => expect(since.querySelectorAll("li")).toHaveLength(6));
    const kinds = within(since).getByRole("group", { name: "Event kinds" });
    expect(within(kinds).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Shipped, 1", "Blocked, 1", "You, 6"]);
    fireEvent.click(within(kinds).getByRole("button", { name: "Blocked, 1" }));
    await waitFor(() => expect([...since.querySelectorAll("li")].map((item) => item.textContent)).toEqual([expect.stringContaining("CSV-7 moved from working to blocked.")]));
    expect(calls(slot, "homeFeed").at(-1)!.input).toEqual({ since: NOW - HOUR, kind: "blocked", limit: 60 });
    fireEvent.click(within(kinds).getByRole("button", { name: "Blocked, 1" }));
    fireEvent.click(await within(since).findByRole("button", { name: "2 earlier" }));
    expect(since.querySelectorAll("li")).toHaveLength(8);
    fireEvent.click(within(since).getAllByRole("button", { name: /CSV-3/ })[0]!);
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-3")]);
  });

  // The review's case: 60 newer events of one kind used to push the 3 blocked ones out of the rows the page filtered.
  const mixed: HomeFeedRow[] = [
    ...Array.from({ length: 60 }, (_, index) => ({ id: 200 - index, at: NOW - (index + 1) * 60_000, slug: "csv", projectKey: "CSV", ticketKey: null, kind: "you" as const, text: `You ran step ${index}.` })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: 100 - index, at: NOW - (90 + index) * 60_000, slug: "csv", projectKey: "CSV", ticketKey: `CSV-${index + 1}`, kind: "blocked" as const, text: `CSV-${index + 1} moved from working to blocked.` })),
  ];

  // Since mounted on its own, and its controls found by their own attributes: on the whole Home page, role queries
  // computed the accessible name of every one of 60 row buttons each time, and the test ran past 5 s in two loaded runs.
  it("a kind's count always opens its events: 63 mixed events, the 3 blocked ones older than 60 others", async () => {
    localStorage.setItem("loom.home.lookedAt", String(NOW - 2 * HOUR));
    const slot = renderSlot({ component: () => <Since now={NOW} go={() => {}} /> }, {}, { pluginId: "loom", rpc: handlers({ homeFeed: serve(mixed) }) });
    mounts.push(slot);
    const since = slot.container.querySelector<HTMLElement>("[data-since]")!;
    const rows = () => [...since.querySelectorAll(":scope > ul > li")];
    const button = (label: string) => since.querySelector<HTMLButtonElement>(`[role="group"][aria-label="Event kinds"] button[aria-label="${label}"]`);
    const fold = () => since.querySelector<HTMLButtonElement>("button[aria-expanded]");
    await waitFor(() => expect(rows()).toHaveLength(6));
    expect(since.querySelector("header")!.textContent).toContain("63");
    fireEvent.click(button("Blocked, 3")!);
    await waitFor(() => expect(rows().map((item) => item.textContent)).toEqual([1, 2, 3].map((n) => expect.stringContaining(`CSV-${n} moved from working to blocked.`))));
    expect(since.querySelector("ul")!.getAttribute("aria-label")).toBe("Blocked events, newest first");
    fireEvent.click(button("Blocked, 3")!);
    await waitFor(() => expect(fold()?.textContent).toBe("54 earlier"));
    fireEvent.click(fold()!);
    expect(rows()).toHaveLength(60);
    // The rest are a working continuation, not a promise: the page asks for the next 60.
    expect(since.querySelector("[data-feed-more]")!.textContent).toBe("Load 3 more · 3 not shown yet");
    fireEvent.click(since.querySelector("[data-feed-more]")!);
    await waitFor(() => expect(rows()).toHaveLength(63));
    expect(calls(slot, "homeFeed").at(-1)!.input).toEqual({ since: NOW - 2 * HOUR, kind: null, limit: 120 });
    expect(since.querySelector("[data-feed-more]")).toBeNull();
  });

  it("names a project whose events it could not read to the end, and opens its History", async () => {
    localStorage.setItem("loom.home.lookedAt", String(NOW - 2 * HOUR));
    const slot = await mountHome({ homeFeed: serve(feed.rows, [{ slug: "csv", projectKey: "CSV", from: NOW - 30 * 60_000 }]) });
    const since = await slot.findByRole("region", { name: "Since you looked" });
    const partial = await within(since).findByRole("list", { name: "Not counted" });
    expect(partial.textContent).toContain("CSV: counted from");
    expect(partial.textContent).toContain("earlier events are not in these counts.");
    fireEvent.click(within(partial).getByRole("button", { name: "Open CSV's History" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
    expect(projectViews.get().csv).toBe("history");
  });

  // The re-check's case: every event Loom read was of no kind it shows, but the project has older events it did not read.
  it("never says nothing new while a project was read only in part, and still names it with its History", async () => {
    localStorage.setItem("loom.home.lookedAt", String(NOW - 2 * HOUR));
    const slot = await mountHome({ homeFeed: serve([], [{ slug: "csv", projectKey: "CSV", from: NOW - 30 * 60_000 }]) });
    const since = await slot.findByRole("region", { name: "Since you looked" });
    const partial = await within(since).findByRole("list", { name: "Not counted" });
    expect(partial.textContent).toContain("CSV: counted from");
    expect(since.textContent).not.toMatch(/Nothing new/);
    expect(since.textContent).toContain("None in the events Loom read.");
    expect(within(since).queryByRole("group", { name: "Event kinds" })).toBeNull();
    fireEvent.click(within(partial).getByRole("button", { name: "Open CSV's History" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
  });

  it("says nothing new when every project was read to the end and none of its events are shown kinds", async () => {
    localStorage.setItem("loom.home.lookedAt", String(NOW - 2 * HOUR));
    const slot = await mountHome({ homeFeed: serve([]) });
    const since = await slot.findByRole("region", { name: "Since you looked" });
    await within(since).findByText(/Nothing new since then/);
    expect(within(since).queryByRole("list", { name: "Not counted" })).toBeNull();
  });

  it("shows the last day on a first visit, and marks the visit looked when you leave Home", async () => {
    const slot = await mountHome();
    const since = await slot.findByRole("region", { name: "Since you looked" });
    expect(within(since).getByRole("heading").textContent).toBe("Last 24 hours");
    expect(calls(slot, "homeFeed")[0]!.input).toEqual({ since: expect.any(Number), kind: null, limit: 60 });
    expect(localStorage.getItem("loom.home.lookedAt")).toBeNull();
    slot.lifecycle.unmount();
    expect(Number(localStorage.getItem("loom.home.lookedAt"))).toBeGreaterThan(0);
  });
});

describe("Home's projects", () => {
  const slugs = (slot: Slot) => [...slot.container.querySelectorAll("[data-project-row]")].map((row) => row.getAttribute("data-project-row"));

  it("draws each project's ticket bar, state, facts and need count, needs first, and its name opens it", async () => {
    const projects = [homeProject({ slug: "calm", name: "Calm one", key: "CALM" }), homeProject({ phase: { index: 1, count: 3, title: "Large exports", done: 4, total: 12 }, failed: 2 }), homeProject({ slug: "bill", name: "Billing API", key: "BILL", state: "paused", reason: "The token budget is used up." })];
    const slot = await mountHome({ home: () => homeView({ projects }) });
    expect(slugs(slot)).toEqual(["csv", "bill", "calm"]);
    const csv = slot.container.querySelector<HTMLElement>('[data-project-row="csv"]')!;
    expect(csv.querySelector("[data-ticket-bar]")!.getAttribute("aria-label")).toBe("CSV CSV export: 1 done · 1 in progress · 2 up next");
    expect(csv.querySelector("[data-project-facts]")!.textContent).toBe("phase 2 of 3 · 4/12 · 2 failed");
    expect(csv.querySelector('[aria-label="1 thing needs you"]')).not.toBeNull();
    // Paused by Loom sizes to its words and never shrinks (L1).
    const pill = slot.container.querySelector<HTMLElement>('[data-project-row="bill"] [data-state-badge]')!;
    expect(pill.textContent).toBe("Paused by Loom");
    expect(pill.className).toContain("shrink-0");
    expect(pill.className).toContain("whitespace-nowrap");
    fireEvent.click(within(csv).getByRole("button", { name: /CSV export/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
  });

  it("folds done and archived projects into a Finished group it remembers, and searches every project", async () => {
    const projects = [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "done" }), homeProject({ slug: "old", name: "Old importer", key: "LEGACY", state: "archived" })];
    const slot = await mountHome({ home: () => homeView({ projects, needsYou: [] }) });
    expect(slugs(slot)).toEqual(["csv"]);
    const fold = within(slot.container.querySelector<HTMLElement>("[data-finished]")!).getByRole("button", { name: /Finished · 2/ });
    fireEvent.click(fold);
    expect(slugs(slot)).toEqual(["csv", "docs", "old"]);
    expect(localStorage.getItem("loom.home.showFinished")).toBe("true");
    fireEvent.click(fold);
    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "legacy" } });
    expect(slugs(slot)).toEqual(["old"]);
    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "zzz" } });
    expect(slot.container.querySelector("[data-projects-empty]")!.textContent).toBe('No project matches "zzz".');
  });

  it("keeps Insights, New project and How Loom works on Home for a page without Loom's sidebar", async () => {
    const slot = await mountHome();
    const nav = within(slot.getByRole("navigation", { name: "Home" }));
    for (const [name, to] of [["How Loom works", "_guide"], ["Insights", "_insights"], ["New project", "_new"]] as const) {
      fireEvent.click(nav.getByRole("button", { name }));
      expect(slot.inspection.navigateCalls.at(-1)).toEqual(pushed(to));
    }
    expect(slot.container.querySelector('nav[aria-label="Home"]')!.className).toContain("@4xl/loom:hidden");
  });

  it("lists a planning conversation without a project as a row that opens it", async () => {
    const slot = await mountHome({ planning: () => [{ threadId: "thr_p1", title: "Rate limits", startedAt: NOW - 4 * 60_000, slug: null, projectState: null }] });
    const row = await waitFor(() => slot.container.querySelector<HTMLElement>('[data-planning-row="thr_p1"]')!);
    fireEvent.click(within(row).getByRole("button", { name: /Rate limits/ }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_plan/thr_p1")]);
  });
});

describe("Loom in bb's thread view", () => {
  const navigate = { toPluginPanel: vi.fn() };
  const item = (info: ThreadInfo | undefined) => threadButton({ thread: { id: "thr_w" }, data: info === undefined ? {} : { thr_w: info }, navigate } as unknown as PluginThreadActionItemInput<Record<string, ThreadInfo>>);

  it("puts a header button on Loom's threads only, naming the ticket and its state, the project, or Planning", () => {
    expect(item(undefined)).toBeNull();
    expect(item(threadInfo())).toMatchObject({ label: "CSV-3 · in review", icon: "loom/loom", detail: "Open CSV-3 in Loom" });
    expect(buttonLabel(threadInfo({ role: "planner", key: null, state: "running", attempt: null }))).toBe("CSV");
    expect(buttonLabel(threadInfo({ role: "planner", slug: null, key: null, state: "planning", project: null, attempt: null }))).toBe("Planning");
    void item(threadInfo())!.run({} as never);
    expect(navigate.toPluginPanel).toHaveBeenCalledWith("loom", { subPath: "csv/CSV-3" });
  });

  it("reads every header's thread in one call", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const registration = app.threadActions[0]!;
    const Probe = ({ ids }: { ids: string[] }) => {
      const data = registration.useData!({ threadIds: ids }) as Record<string, ThreadInfo>;
      return <span data-probe>{Object.keys(data).join(",")}</span>;
    };
    const slot = renderSlot<{ ids: string[] }, typeof rpcContract>({ component: Probe }, { ids: ["thr_a", "thr_b"] }, { pluginId: "loom", rpc: handlers({ threadInfos: ({ threadIds }) => ({ [threadIds[0]!]: threadInfo() }) }) });
    mounts.push(slot);
    await waitFor(() => expect(slot.container.querySelector("[data-probe]")!.textContent).toBe("thr_a"));
    expect(calls(slot, "threadInfos")).toEqual([{ method: "threadInfos", input: { threadIds: ["thr_a", "thr_b"] } }]);
  });

  // The registered header button as bb draws it: one read for every header on screen, then a button per Loom thread.
  const mountHeader = async (threadInfos: Handlers["threadInfos"], ids: string[]) => {
    const app = await loadPluginApp(() => import("../app"));
    const registration = app.threadActions[0]!;
    const Header = ({ ids: shown }: { ids: string[] }) => {
      const navigate = useBbNavigate();
      const data = registration.useData!({ threadIds: shown }) as Record<string, ThreadInfo>;
      return (
        <>
          {shown.map((id) => {
            const action = registration.item({ thread: { id }, data, navigate } as never) as { label: string; detail: string; run(): void } | null;
            return action === null ? null : (
              <button key={id} type="button" data-thread={id} title={action.detail} onClick={() => void action.run()}>
                {action.label}
              </button>
            );
          })}
        </>
      );
    };
    const slot = renderSlot<{ ids: string[] }, typeof rpcContract>({ component: Header }, { ids }, { pluginId: "loom", rpc: handlers({ threadInfos }) });
    mounts.push(slot);
    return { slot, show: (next: string[]) => slot.lifecycle.rerender(<Header ids={next} />) };
  };
  const labels = (slot: Slot) => Object.fromEntries([...slot.container.querySelectorAll<HTMLElement>("[data-thread]")].map((button) => [button.dataset.thread, button.textContent]));

  it("opens each role's place from the header: a worker's and a reviewer's ticket, a planner's project, a planning conversation", async () => {
    const infos: Record<string, ThreadInfo> = {
      thr_w: threadInfo(),
      thr_r: threadInfo({ role: "reviewer", key: "CSV-4", state: "checking", attempt: 2 }),
      thr_p: threadInfo({ role: "planner", key: null, state: "running", attempt: null }),
      thr_new: threadInfo({ role: "planner", slug: null, key: null, state: "planning", project: null, attempt: null }),
    };
    const { slot } = await mountHeader(({ threadIds }) => Object.fromEntries(threadIds.filter((id) => id in infos).map((id) => [id, infos[id]!])), ["thr_w", "thr_r", "thr_p", "thr_new", "thr_plain"]);
    await waitFor(() => expect(Object.keys(labels(slot))).toHaveLength(4));
    expect(labels(slot)).toEqual({ thr_w: "CSV-3 · in review", thr_r: expect.stringMatching(/^CSV-4 · /), thr_p: "CSV", thr_new: "Planning" });
    for (const id of ["thr_w", "thr_r", "thr_p", "thr_new"]) fireEvent.click(slot.container.querySelector(`[data-thread="${id}"]`)!);
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-3"), pushed("csv/CSV-4"), pushed("csv"), pushed("_plan/thr_new")]);
    expect(calls(slot, "threadInfos")).toHaveLength(1);
  });

  it("reads the header again on any change: a planning conversation becomes its project, and a ticket's state stays current", async () => {
    let planner = threadInfo({ role: "planner", slug: null, key: null, state: "planning", project: null, attempt: null });
    let worker = threadInfo({ state: "review" });
    const { slot } = await mountHeader(() => ({ thr_p: planner, thr_w: worker }), ["thr_p", "thr_w"]);
    await waitFor(() => expect(labels(slot)).toEqual({ thr_p: "Planning", thr_w: "CSV-3 · in review" }));
    planner = threadInfo({ role: "planner", key: null, state: "draft", attempt: null });
    worker = threadInfo({ state: "approved" });
    await slot.experimental_invalidateRpc(changedTags("csv"));
    await waitFor(() => expect(labels(slot)).toEqual({ thr_p: "CSV", thr_w: expect.stringMatching(/^CSV-3 · /) }));
    expect(labels(slot).thr_w).not.toBe("CSV-3 · in review");
    fireEvent.click(slot.container.querySelector('[data-thread="thr_p"]')!);
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv")]);
    // One read serves every header, so a change anywhere reads it again; the old chip read only on its own project's.
    const before = calls(slot, "threadInfos").length;
    await slot.experimental_invalidateRpc(changedTags("other"));
    await waitFor(() => expect(calls(slot, "threadInfos").length).toBe(before + 1));
  });

  describe("a header read that arrives after the threads on screen changed", () => {
    const mountSwitching = async () => {
      const late: Array<(infos: Record<string, ThreadInfo>) => void> = [];
      const { slot, show } = await mountHeader(({ threadIds }): Record<string, ThreadInfo> | Promise<Record<string, ThreadInfo>> => {
        if (threadIds.includes("thr_next")) return { thr_next: threadInfo({ key: "CSV-2", state: "working" }) };
        if (threadIds.includes("thr_other")) return {};
        return new Promise((resolve) => late.push(resolve));
      }, ["thr_loom"]);
      await waitFor(() => expect(late).toHaveLength(1));
      return { slot, late, show };
    };

    it("never puts the previous thread's button on a thread that is not Loom's", async () => {
      const { slot, late, show } = await mountSwitching();
      show(["thr_other"]);
      await waitFor(() => expect(calls(slot, "threadInfos").at(-1)?.input).toEqual({ threadIds: ["thr_other"] }));
      await act(async () => late[0]!({ thr_loom: threadInfo({ key: "CSV-1" }) }));
      expect(labels(slot)).toEqual({});
    });

    it("keeps the previous read only for its own threads while the next one is out", async () => {
      const pending: Array<(infos: Record<string, ThreadInfo>) => void> = [];
      const { slot, show } = await mountHeader(({ threadIds }): Record<string, ThreadInfo> | Promise<Record<string, ThreadInfo>> => (threadIds.includes("thr_loom") ? { thr_loom: threadInfo({ key: "CSV-1" }) } : new Promise((resolve) => pending.push(resolve))), ["thr_loom"]);
      await waitFor(() => expect(labels(slot)).toEqual({ thr_loom: "CSV-1 · in review" }));
      show(["thr_slow"]);
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(labels(slot)).toEqual({});
      await act(async () => pending[0]!({ thr_slow: threadInfo({ key: "CSV-2", state: "working" }) }));
      await waitFor(() => expect(labels(slot)).toEqual({ thr_slow: "CSV-2 · working" }));
    });

    it("never replaces the new thread's button with the previous thread's", async () => {
      const { slot, late, show } = await mountSwitching();
      show(["thr_next"]);
      await waitFor(() => expect(labels(slot)).toEqual({ thr_next: "CSV-2 · working" }));
      await act(async () => late[0]!({ thr_loom: threadInfo({ key: "CSV-1" }) }));
      expect(labels(slot)).toEqual({ thr_next: "CSV-2 · working" });
    });
  });

  it("names the ticket, role, phase and state above the composer, and opens to where the ticket stands", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const segment = app.threadContextSegments[0]!;
    const info = threadInfo({ key: "CSV-11", state: "blocked", phase: { index: 1, count: 3, title: "Large exports" }, attempt: 2 });
    const rpc = handlers({ threadInfo: () => info, ticket: () => ticketDetail({ key: "CSV-11", state: "blocked", blockedReason: "The fixture does not fit on the runner." }) });
    let expanded = false;
    const Both = () => {
      const props = { threadId: "thr_w", projectId: "proj_1", environment: null, segments: [], isExpanded: expanded, onToggle: () => undefined };
      const Summary = segment.summary;
      const Details = segment.details!;
      return (
        <>
          <Summary {...props} />
          <Details {...props} />
        </>
      );
    };
    const slot = renderSlot({ component: Both }, {}, { pluginId: "loom", rpc });
    mounts.push(slot);
    const button = await slot.findByRole("button", { name: "CSV-11, worker, phase 2 of 3, attempt 2, blocked" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(slot.container.querySelector("[data-loom-segment-details]")).toBeNull();
    expanded = true;
    slot.lifecycle.rerender(<Both />);
    await waitFor(() => expect(slot.container.querySelector("[data-loom-segment-details]")!.textContent).toContain("Blocked: The fixture does not fit on the runner."));
    fireEvent.click(slot.getByRole("button", { name: "Open in Loom" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("csv/CSV-11")]);
  });

  it("shows a worker's ticket in the Loom tab without its own conversation again, and a planner's project with what it needs", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const Tab = app.tabs[0]!.component as React.ComponentType<{ threadId: string }>;
    const worker = renderSlot({ component: Tab }, { threadId: "thr_w" }, { pluginId: "loom", rpc: handlers({ threadInfo: () => threadInfo(), ticket: () => ticketDetail({ key: "CSV-3" }) }) });
    mounts.push(worker);
    await worker.findAllByRole("tab");
    expect(worker.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Activity", "Brief", "Agents"]);
    worker.lifecycle.unmount();
    document.body.replaceChildren();

    const planner = renderSlot({ component: Tab }, { threadId: "thr_plan" }, { pluginId: "loom", rpc: handlers({ threadInfo: () => threadInfo({ role: "planner", key: null, state: "running", attempt: null }) }) });
    mounts.push(planner);
    const queueRegion = await planner.findByRole("region", { name: "Needs you" });
    expect([...queueRegion.querySelectorAll("[data-need]")].map((row) => row.getAttribute("data-need-id"))).toEqual(["blocked:CSV-7"]);
    fireEvent.click(planner.getByRole("button", { name: /Open in Loom/ }));
    expect(planner.inspection.navigateCalls).toEqual([pushed("csv")]);
  });
});

describe("the ticket pane's Threads", () => {
  it("lists each attempt's worker and reviewer threads newest first, embeds the chosen one's conversation, and keeps the reply under it", async () => {
    const threads = [
      { threadId: "thr_w1", role: "worker" as const, attempt: 1, reviewRound: 0, state: "ended" as const, startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR, endReason: "handed_back" },
      { threadId: "thr_r1", role: "reviewer" as const, attempt: null, reviewRound: 1, state: "ended" as const, startedAt: NOW - 4 * HOUR, endedAt: NOW - 3 * HOUR, endReason: "done" },
      { threadId: "thr_w2", role: "worker" as const, attempt: 2, reviewRound: 1, state: "active" as const, startedAt: NOW - HOUR, endedAt: null, endReason: null },
    ];
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot<PluginNavPanelProps, typeof rpcContract>({ component: app.navPanels[0]!.component }, { subPath: "csv/CSV-3" }, { pluginId: "loom", rpc: handlers({ project: () => projectView(), ticket: () => ticketDetail({ key: "CSV-3", threads }) }) });
    mounts.push(slot);
    const tab = await slot.findByRole("tab", { name: /Threads/ });
    expect(tab.textContent).toBe("Threads3");
    fireEvent.click(tab);
    const list = slot.getByRole("list", { name: "CSV-3's threads, newest first" });
    expect(within(list).getAllByRole("button").map((button) => [button.querySelector(".truncate")!.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["Worker · attempt 2", "true"],
      ["Reviewer · round 1", "false"],
      ["Worker · attempt 1", "false"],
    ]);
    expect(slot.container.querySelector("[data-thread-chat]")!.getAttribute("data-thread-chat")).toBe("thr_w2");
    fireEvent.click(within(list).getAllByRole("button")[1]!);
    expect(slot.container.querySelector("[data-thread-chat]")!.getAttribute("data-thread-chat")).toBe("thr_r1");
    fireEvent.click(within(slot.getByRole("region", { name: "Reviewer · round 1's conversation" })).getByRole("button", { name: /Open/ }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_r1", options: undefined }]);
    expect(slot.getByRole("textbox", { name: "New reply" })).toBeTruthy();
  });
});

describe("Home, as before phase 5", () => {
  const session = (over: Partial<PlanningSession> = {}): PlanningSession => ({ threadId: "thr_p1", title: "Rate limits for the public API", startedAt: NOW - 4 * 60_000, slug: null, projectState: null, ...over });
  const three = () => homeView({ needsYou: [], projects: [homeProject(), homeProject({ slug: "docs", name: "Docs site", key: "DOC", state: "done" }), homeProject({ slug: "old", name: "Old importer", key: "LEGACY", state: "archived" })] });
  const slugs = (slot: Slot) => [...slot.container.querySelectorAll("[data-project-row]")].map((row) => row.getAttribute("data-project-row"));
  const finished = (slot: Slot, count: number) => within(slot.container.querySelector<HTMLElement>("[data-finished]")!).getByRole("button", { name: new RegExp(`Finished · ${count}`) });

  it("shows the guide when there are no projects and no planning conversations, and its button opens New project", async () => {
    const { slot } = await mountPanel("_home", { home: () => homeView({ projects: [], needsYou: [] }) });
    expect(await slot.findByRole("heading", { name: "Welcome to Loom" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Start your first project" }));
    expect(slot.inspection.navigateCalls).toEqual([pushed("_new")]);
  });

  it("shows a conversation instead of the guide when it is the only thing there is", async () => {
    const { slot } = await mountPanel("_home", { home: () => homeView({ projects: [], needsYou: [] }), planning: () => [session()] });
    await slot.findByText("Rate limits for the public API");
    expect(slot.container.querySelector("[data-guide]")).toBeNull();
    expect(slot.container.querySelector("[data-projects-empty]")).toBeNull();
  });

  it("remembers the Finished group open across visits", async () => {
    const slot = await mountHome({ home: three });
    fireEvent.click(finished(slot, 2));
    slot.lifecycle.unmount();
    const again = await mountHome({ home: three });
    expect(slugs(again)).toEqual(["csv", "docs", "old"]);
    expect(finished(again, 2).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(finished(again, 2));
    expect(slugs(again)).toEqual(["csv"]);
    expect(localStorage.getItem("loom.home.showFinished")).toBe("false");
  });

  it("keeps a finished project that still needs you among the active rows", async () => {
    const needsYou = [need({ kind: "land", slug: "docs", project: "Docs site", projectKey: "DOC", text: "finished all 3 tickets; land the integration branch", startedAt: NOW })];
    const slot = await mountHome({ home: () => ({ ...three(), needsYou }) });
    expect(slugs(slot)).toEqual(["docs", "csv"]);
    expect(finished(slot, 1)).toBeTruthy();
  });

  it("filters by name, key or slug as the human types", async () => {
    const slot = await mountHome({ home: three });
    const search = slot.getByRole("searchbox", { name: "Search projects" });
    for (const [query, shown] of [["importer", ["old"]], ["legacy", ["old"]], ["docs", ["docs"]], ["  CSV ", ["csv"]]] as const) {
      fireEvent.change(search, { target: { value: query } });
      expect(slugs(slot), query).toEqual(shown);
    }
  });

  it("opens the Finished group and says so when every project is done or archived", async () => {
    const slot = await mountHome({ home: () => homeView({ projects: [homeProject({ state: "done" })], needsYou: [] }) });
    expect(slot.container.querySelector("[data-projects-empty]")!.textContent).toBe("Every project is done or archived.");
    expect(slugs(slot)).toEqual(["csv"]);
    expect(within(slot.container.querySelector<HTMLElement>("[data-finished]")!).queryByRole("button", { name: /Finished/ })).toBeNull();
  });

  it("reads the overview and the planning conversations, not the project list, and reads them again on a change", async () => {
    const slot = await mountHome();
    await waitFor(() => expect(calls(slot, "planning")).toHaveLength(1));
    expect(calls(slot, "home")).toEqual([{ method: "home", input: null }]);
    expect(calls(slot, "projects")).toEqual([]);
    await slot.experimental_invalidateRpc(changedTags("docs"));
    await waitFor(() => expect(calls(slot, "home")).toHaveLength(2));
    await slot.experimental_invalidateRpc(changedTags(null));
    await waitFor(() => expect(calls(slot, "planning").length).toBeGreaterThanOrEqual(2));
  });

  it("lists only the conversations that have no project yet, and search reaches them", async () => {
    const planning = () => [session(), session({ threadId: "thr_p2", title: "CSV export plan", slug: "csv", projectState: "draft" })];
    const slot = await mountHome({ planning });
    await slot.findByText("Rate limits for the public API");
    expect([...slot.container.querySelectorAll("[data-planning-row]")].map((row) => row.getAttribute("data-planning-row"))).toEqual(["thr_p1"]);
    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "csv" } });
    expect(slot.container.querySelector("[data-planning-row]")).toBeNull();
    fireEvent.change(slot.getByRole("searchbox", { name: "Search projects" }), { target: { value: "rate limits" } });
    expect(slot.container.querySelectorAll("[data-planning-row]")).toHaveLength(1);
    expect(slot.container.querySelector("[data-project-row]")).toBeNull();
  });

  it("shows the guide at _guide without reading a project", async () => {
    const { slot, goTo } = await mountPanel("_home");
    await slot.findByRole("region", { name: "Needs you" });
    goTo("_guide");
    expect(await slot.findByRole("heading", { name: "Welcome to Loom" })).toBeTruthy();
    expect(calls(slot, "project")).toEqual([]);
  });
});

describe("a thread surface's read that arrives after the thread changed", () => {
  const worker = (key: string): ThreadInfo => threadInfo({ key, state: "working" });
  const mountSwitching = async () => {
    const app = await loadPluginApp(() => import("../app"));
    const segment = app.threadContextSegments[0]!;
    const late: Array<(info: ThreadInfo | null) => void> = [];
    const read = ({ threadId }: { threadId: string }): ThreadInfo | null | Promise<ThreadInfo | null> => {
      if (threadId === "thr_other") return null;
      if (threadId === "thr_next") return worker("CSV-2");
      return new Promise((resolve) => late.push(resolve));
    };
    const Summary = ({ threadId }: { threadId: string }) => <segment.summary threadId={threadId} projectId="proj_1" environment={null} segments={[]} isExpanded={false} onToggle={() => undefined} />;
    const slot = renderSlot<{ threadId: string }, typeof rpcContract>({ component: Summary }, { threadId: "thr_loom" }, { pluginId: "loom", rpc: handlers({ threadInfo: read }) });
    mounts.push(slot);
    await waitFor(() => expect(late).toHaveLength(1));
    return { slot, late, switchTo: (threadId: string) => slot.lifecycle.rerender(<Summary threadId={threadId} />) };
  };

  it("does not show the previous thread's segment on a thread that is not a Loom thread", async () => {
    const { slot, late, switchTo } = await mountSwitching();
    switchTo("thr_other");
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)?.input).toEqual({ threadId: "thr_other" }));
    await waitFor(() => expect(slot.queryByRole("button")).toBeNull());
    await act(async () => late[0]!(worker("CSV-1")));
    expect(slot.queryByRole("button")).toBeNull();
  });

  it("does not replace the new thread's segment with the previous thread's", async () => {
    const { slot, late, switchTo } = await mountSwitching();
    switchTo("thr_next");
    await slot.findByRole("button", { name: /^CSV-2,/ });
    await act(async () => late[0]!(worker("CSV-1")));
    expect(slot.getByRole("button").getAttribute("aria-label")).toMatch(/^CSV-2,/);
  });
});

describe("the Loom tab in bb's phone drawer", () => {
  // bb's drawer moves Tab focus itself over a[href], button and [tabindex] outside [inert], with preventScroll.
  function Drawer() {
    const ref = useRef<HTMLDivElement>(null);
    useDrawerKeyboard(ref);
    return (
      <div ref={ref} data-drawer>
        <details data-notes>
          <summary>The reviewer's notes</summary>
          <div data-body>
            <button type="button">Show all</button>
          </div>
        </details>
        <button type="button" data-low>
          Reply
        </button>
      </div>
    );
  }

  it("reaches every summary, skips a closed body, and brings what takes focus into view", async () => {
    const view = render(<Drawer />);
    const details = view.container.querySelector<HTMLDetailsElement>("[data-notes]")!;
    const body = view.container.querySelector("[data-body]")!;
    expect(details.querySelector("summary")!.getAttribute("tabindex")).toBe("0");
    expect(body.hasAttribute("inert")).toBe(true);
    details.open = true;
    await waitFor(() => expect(body.hasAttribute("inert")).toBe(false));
    details.open = false;
    await waitFor(() => expect(body.hasAttribute("inert")).toBe(true));

    const drawer = view.container.querySelector<HTMLElement>("[data-drawer]")!;
    const low = view.container.querySelector<HTMLElement>("[data-low]")!;
    vi.spyOn(drawer, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 800, left: 0, right: 320, width: 320, height: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(low, "getBoundingClientRect").mockReturnValue({ top: 1007, bottom: 1051, left: 0, right: 100, width: 100, height: 44, x: 0, y: 1007, toJSON: () => ({}) } as DOMRect);
    const scroll = vi.fn();
    low.scrollIntoView = scroll;
    low.focus();
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    vi.restoreAllMocks();
  });
});

describe("the open ticket's state, announced", () => {
  function Note({ ticket, word }: { ticket: string; word: string }) {
    return <p role="status">{useStateNote(ticket, word)}</p>;
  }
  it("says nothing when a ticket opens, and one sentence when its state changes while it is open", () => {
    const view = render(<Note ticket="CSV-7" word="working" />);
    expect(view.getByRole("status").textContent).toBe("");
    view.rerender(<Note ticket="CSV-7" word="in review" />);
    expect(view.getByRole("status").textContent).toBe("CSV-7 is now in review.");
    view.rerender(<Note ticket="CSV-8" word="queued" />);
    expect(view.getByRole("status").textContent).toBe("");
  });
});
