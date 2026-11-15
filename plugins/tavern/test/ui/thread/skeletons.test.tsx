// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { definePluginApp, type ExperimentalThreadContextSegmentInput } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { fixtureDecor, fixtureDetail, fixtureJournal, fixtureLedger, fixtureMember, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { JournalTab, LedgerTab } from "../../../src/ui/thread/tabs";
import { ReportsTab } from "../../../src/ui/thread/reports-tab";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { JournalSegmentDetails, JournalSegmentSummary } from "../../../src/ui/thread/journal-segment";
import { SKELETON_DELAY_MS, readRemembered, rememberCount, writeRemembered } from "../../../src/ui/kit";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";

/**
 * The kit's skeleton delay is one setTimeout of SKELETON_DELAY_MS. The tests hold those timers and fire them by hand, so "before the
 * delay" holds however slow the machine is, and "after" never depends on a sleep outrunning React's commit.
 */
let held: (() => void)[] = [];
beforeEach(() => {
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== SKELETON_DELAY_MS) return real(fn, ms, ...rest);
    let live = true;
    held.push(() => { if (live) fn(); });
    return { cancel: () => { live = false; } } as never;
  }) as typeof setTimeout);
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id: unknown) => {
    if (id && typeof id === "object" && "cancel" in id) (id as { cancel(): void }).cancel(); else realClear(id as never);
  }) as typeof clearTimeout);
});
/** The kit's delay passes: every pending skeleton timer fires, inside act so React commits before the next line. */
const passDelay = () => act(() => { const due = held; held = []; due.forEach(f => f()); });
afterEach(() => { cleanup(); localStorage.clear(); held = []; vi.restoreAllMocks(); });

/** An RPC answer the test releases by hand, so the loading state can be looked at before and after the kit's delay. */
function gate<T>() {
  let release!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { release = res; fail = rej; });
  return { handler: () => promise, release, fail };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const region = (c: HTMLElement | Document = document) => c.querySelector<HTMLElement>(".sk-region");
/** Before the delay: the space is held, hidden, and says nothing. After it: shown, busy, named, and its shapes hold no text or focus. */
async function expectSkeletonTiming(label: string) {
  await waitFor(() => expect(region()).not.toBeNull());
  expect(region()!.dataset.skeleton).toBe("held");
  expect(region()!.getAttribute("aria-busy")).toBe("true");
  expect(document.body.textContent).not.toContain("Loading Tavern…");
  expect(held.length).toBeGreaterThan(0);
  passDelay();
  expect(region()!.dataset.skeleton).toBe("shown");
  expect(region()!.querySelector("[role=status]")!.textContent).toBe(`Loading ${label}`);
  const shapes = region()!.querySelector(".sk")!;
  expect(shapes.getAttribute("aria-hidden")).toBe("true");
  expect(shapes.querySelectorAll("button, a, input, select, textarea, [tabindex]")).toHaveLength(0);
  return shapes;
}
const message = { id: "m1", threadId: "keeper-1", turnId: null, projectId: null };

const base = fixtureJournal.entries[0]!;
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, id, order, description: `Entry ${id}`, status: "todo", ...over });
const entries = [entry("a1", 0, { status: "done" }), entry("a2", 1), entry("a3", 2, { status: "doing" }), entry("a4", 3), entry("a5", 4)];
const progress = { done: 1, total: 5, blocked: 0, current: { id: "a3", description: "Entry a3", status: "doing" as const } };
const journal = journalSchema.parse({ ...fixtureJournal, entries, progress });

describe("journal tab skeleton", () => {
  it("shows nothing before 150 ms, then the notebook's header and the rows last seen here, then swaps to the list", async () => {
    rememberCount("skel:thread:journal:keeper-1", 4);
    const rpc = gate<typeof journal>();
    const slot = renderSlot({ component: JournalTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { journal: rpc.handler, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    // The title is real and outside the busy region, so the heading stays for a screen reader while the journal loads.
    expect(slot.getByRole("heading", { level: 2 }).closest("[aria-hidden=true], .sk-region")).toBeNull();
    const head = slot.container.querySelector<HTMLElement>(".journal-head")!;
    expect(head.querySelector<HTMLElement>(".journal-slate")!.style.visibility).toBe("hidden");
    const shapes = await expectSkeletonTiming("the journal");
    expect(shapes.querySelectorAll(".journal-list .journal-row")).toHaveLength(4);
    for (const part of [".journal-slate", ".journal-now", ".journal-filters"]) {
      const el = head.querySelector<HTMLElement>(part)!;
      expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.style.visibility).toBe("");
    }
    rpc.release(journal);
    await slot.findByRole("list", { name: "Journal entries" });
    expect(region()).toBeNull();
    expect(slot.container.querySelector("[aria-busy]")).toBeNull();
    // The list drew four open rows, which is what the next skeleton draws.
    await waitFor(() => expect(readRemembered("skel:thread:journal:keeper-1")).toBe(4));
  });

  it("puts the error with Retry in the skeleton's place", async () => {
    const rpc = gate<typeof journal>();
    const slot = renderSlot({ component: JournalTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { journal: rpc.handler, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(region()).not.toBeNull());
    rpc.fail(new Error("Tavern is not responding"));
    expect((await slot.findByRole("alert")).textContent).toMatch(/Tavern is not responding/);
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(region()).toBeNull();
  });

  it("shows an empty journal's empty state, never a skeleton", async () => {
    const slot = renderSlot({ component: JournalTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { journal: () => ({ ...journal, entries: [], changes: [], progress: { done: 0, total: 0, blocked: 0, current: null } }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await slot.findByText(/No journal entries yet/);
    expect(region()).toBeNull();
    await waitFor(() => expect(readRemembered("skel:thread:journal:keeper-1")).toBe(0));
  });
});

describe("widget row skeleton", () => {
  const keeperDecor = { ...fixtureDecor, member: { ...fixtureMember, role: "keeper" as const } };
  it("draws nothing while loading on a thread this device never saw a row on", async () => {
    const rpc = gate<typeof fixtureDecor>();
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: rpc.handler, registry: () => fixtureRegistry } });
    await sleep(20);
    passDelay();
    expect(slot.container.querySelector(".twidget")).toBeNull();
  });

  it("holds the row's frame from the first frame where a row was seen, shows its shapes at 150 ms, and swaps in place", async () => {
    rememberCount("skel:thread:widget:keeper-1", 2);
    const rpc = gate<typeof keeperDecor>();
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: rpc.handler, registry: () => fixtureRegistry } });
    const shapes = await expectSkeletonTiming("the Tavern row");
    expect(region()!.classList.contains("twidget")).toBe(true);
    expect(region()!.classList.contains("v-keeper")).toBe(true);
    expect(shapes.querySelector(".tw-row > .ibtn")).not.toBeNull();
    rpc.release(keeperDecor);
    await waitFor(() => expect(slot.container.querySelector("[data-part=TavernWidget]")).not.toBeNull());
    expect(region()).toBeNull();
  });

  it("remembers a plain thread as having no row, so its next load draws nothing", async () => {
    rememberCount("skel:thread:widget:keeper-1", 1);
    renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => ({ ...fixtureDecor, member: null, keeperView: null }), registry: () => fixtureRegistry } });
    await waitFor(() => expect(readRemembered("skel:thread:widget:keeper-1")).toBe(0));
  });
});

describe("journal segment skeleton", () => {
  const plainDecor = { ...fixtureDecor, member: null, keeperView: null, progress };
  const props = (isExpanded: boolean) => ({ threadId: "t", projectId: "p", environment: null, segments: [], isExpanded, onToggle: () => undefined });

  it("stays out of bb's row while loading unless this device last saw it there", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const useVisible = app.threadContextSegments.find(s => s.id === "journal")!.useVisible!;
    const Probe = (input: ExperimentalThreadContextSegmentInput) => <span data-testid="v">{String(useVisible(input))}</span>;
    for (const [seen, expected] of [[0, "false"], [96, "true"]] as const) {
      writeRemembered("skel:thread:segment:t", seen);
      const slot = renderSlot({ component: Probe }, { threadId: "t", projectId: "p", environment: null }, { threadContextKind: "banner", rpc: { decor: gate<typeof plainDecor>().handler } });
      await sleep(20);
      expect(slot.getByTestId("v").textContent).toBe(expected);
      slot.lifecycle.unmount();
    }
  });

  it("draws the summary at the width it last had, then the real summary in its place", async () => {
    writeRemembered("skel:thread:segment:t", 96);
    const rpc = gate<typeof plainDecor>();
    const slot = renderSlot({ component: JournalSegmentSummary }, props(false), { rpc: { decor: rpc.handler } });
    const shapes = await expectSkeletonTiming("the journal");
    expect(region()!.classList.contains("jseg-sum")).toBe(true);
    expect(shapes.querySelector<HTMLElement>(".jseg-skel-in")!.style.getPropertyValue("--jseg-w")).toBe("96px");
    rpc.release(plainDecor);
    await slot.findByRole("button", { name: /Journal \(checklist\): 1 of 5 done/ });
    expect(region()).toBeNull();
  });

  it("draws as many detail rows as the summary says are open, up to four", async () => {
    const rpc = gate<typeof journal>();
    renderSlot({ component: JournalSegmentDetails }, props(true), { rpc: { decor: () => plainDecor, journal: rpc.handler } });
    await waitFor(() => expect(document.querySelectorAll(".sk .jseg-row")).toHaveLength(4));
    const shapes = await expectSkeletonTiming("what is next in the journal");
    expect(shapes.querySelectorAll(".jseg-row")).toHaveLength(4);
  });
});

describe("ledger and reports tab skeletons", () => {
  it("draws a quest card per live quest this device last saw, then the ledger", async () => {
    rememberCount("skel:thread:ledger:keeper-1", 3);
    const rpc = gate<typeof fixtureLedger>();
    const keeperDecor = { ...fixtureDecor, member: { ...fixtureMember, role: "keeper" as const } };
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: rpc.handler, decor: () => keeperDecor, registry: () => fixtureRegistry } });
    const shapes = await expectSkeletonTiming("the ledger");
    expect(shapes.querySelectorAll(".lg-card.lg-quest")).toHaveLength(3);
    expect(slot.getByRole("heading", { level: 2 })).toBeTruthy();
    rpc.release(fixtureLedger);
    await waitFor(() => expect(region()).toBeNull());
    await waitFor(() => expect(readRemembered("skel:thread:ledger:keeper-1")).toBe(1));
  });

  it("draws a member's reports as last seen, then the reports", async () => {
    rememberCount("skel:thread:reports:member-1:vault", 2);
    const rpc = gate<typeof fixtureDetail>();
    renderSlot({ component: ReportsTab }, { threadId: "keeper-1", environment: null, params: { memberThreadId: "member-1", questId: "vault", reportId: null } }, { rpc: { boardQuest: rpc.handler, registry: () => fixtureRegistry } });
    const shapes = await expectSkeletonTiming("the reports");
    expect(shapes.querySelectorAll(".rv-rep")).toHaveLength(2);
    expect(shapes.querySelector(".rv-reps-h")).not.toBeNull();
  });
});

describe("read-as tag skeleton", () => {
  const meta = (threadId: string) => ({ message: { id: "msg-1", threadId, role: "user", initiator: "user", createdAt: 1000 } });
  async function readAs() {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    return app.messageMetadata.find(m => m.id === "read-as")!;
  }
  it("draws nothing while loading in a thread where this device never saw tags", async () => {
    const slot = renderSlot(await readAs(), meta("keeper-1") as never, { rpc: { decor: gate<typeof fixtureDecor>().handler, routes: gate<never>().handler } });
    await sleep(20);
    passDelay();
    expect(slot.container.querySelector(".readas")).toBeNull();
  });
  it("draws the tag's line in a Keeper thread where tags were seen, at the line's last width", async () => {
    rememberCount("skel:thread:readas:keeper-1", 1);
    writeRemembered("skel:thread:readas-w:msg-1", 300);
    const slot = renderSlot(await readAs(), meta("keeper-1") as never, { rpc: { decor: gate<typeof fixtureDecor>().handler, routes: gate<never>().handler } });
    const shapes = await expectSkeletonTiming("how the Keeper read this message");
    expect(shapes.querySelector(".ra-fix")).not.toBeNull();
    expect(shapes.querySelector(".ra-sum")).not.toBeNull();
    expect(slot.container.querySelector<HTMLElement>(".sk-readas-w")!.style.getPropertyValue("--ra-w")).toBe("300px");
  });
  it("remembers a plain thread as having no tags", async () => {
    rememberCount("skel:thread:readas:keeper-1", 1);
    renderSlot(await readAs(), meta("keeper-1") as never, { rpc: { decor: () => ({ ...fixtureDecor, member: null, keeperView: null }), routes: () => ({ routes: [], rules: [], boardQuests: [] }) } });
    await waitFor(() => expect(readRemembered("skel:thread:readas:keeper-1")).toBe(0));
  });
});

describe("chat card skeletons", () => {
  it("draws one report card per id in a digest", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const digest = app.messageDirectives.find(d => d.id === "tavern-reports")!;
    const rpc = gate<{ reports: typeof fixtureReport[] }>();
    const slot = renderSlot(digest, { attributes: { ids: "report-1,report-2,report-3" }, source: "reports", message, openWorkspaceFile: null }, { rpc: { reports: rpc.handler, crests: () => ({ crests: [] }) } });
    const shapes = await expectSkeletonTiming("the reports");
    expect(shapes.querySelectorAll(".tcard.report")).toHaveLength(3);
    rpc.release({ reports: [fixtureReport] });
    await slot.findByText("Staging green");
    expect(region()).toBeNull();
  });

  it("draws the confidence line on as many report shapes as last carried one on that card", async () => {
    rememberCount("skel:thread:card:reports:report-1:2:conf", 1);
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const digest = app.messageDirectives.find(d => d.id === "tavern-reports")!;
    renderSlot(digest, { attributes: { ids: "report-1,report-2" }, source: "reports", message, openWorkspaceFile: null }, { rpc: { reports: gate<never>().handler, crests: () => ({ crests: [] }) } });
    const shapes = await expectSkeletonTiming("the reports");
    expect([...shapes.querySelectorAll(".tcard.report")].map(c => !!c.querySelector(".conf"))).toEqual([true, false]);
  });

  it("draws an ask as this device last saw it: the open pointer by default, the receipt once answered", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const ask = app.messageDirectives.find(d => d.id === "tavern-ask")!;
    for (const [seen, shape] of [[0, ".pointer"], [2, ".receipt"]] as const) {
      if (seen) rememberCount("skel:thread:card:ask:send-luc", seen);
      const slot = renderSlot(ask, { attributes: { id: "send-luc" }, source: "ask", message, openWorkspaceFile: null }, { rpc: { ledger: gate<typeof fixtureLedger>().handler } });
      const shapes = await expectSkeletonTiming("the ask");
      expect(shapes.querySelector(shape)).not.toBeNull();
      slot.lifecycle.unmount();
    }
  });

  it("draws a quest map node per waypoint this device last saw on that quest, and remembers it per quest", async () => {
    const app = await loadPluginApp(definePluginApp(registerThreadSurfaces));
    const map = app.messageDirectives.find(d => d.id === "tavern-questmap")!;
    rememberCount("skel:thread:card:questmap:vault", 5);
    const rpc = gate<typeof fixtureDetail>();
    const slot = renderSlot(map, { attributes: { quest: "vault" }, source: "map", message, openWorkspaceFile: null }, { rpc: { boardQuest: rpc.handler, registry: () => fixtureRegistry } });
    const shapes = await expectSkeletonTiming("the quest map");
    expect(shapes.querySelectorAll(".sk-qmap .sk-node")).toHaveLength(5);
    rpc.release(fixtureDetail);
    await waitFor(() => expect(slot.container.querySelector("[data-part=QuestMapCard]")).not.toBeNull());
    expect(readRemembered("skel:thread:card:questmap:vault")).toBe(fixtureDetail.quest.plan!.waypoints.length);
  });
});
