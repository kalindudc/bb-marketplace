// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureJournal, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
const NOW = Date.now();
const min = 60_000;
const base = fixtureJournal.entries[0]!;
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, threadId: "k", id, order, description: `Entry ${id}`, status: "todo", owner: null, report: null, createdAt: NOW - 7 * 60 * min, doneAt: null, ...over });
const report = (ago: number) => ({ kind: "idle" as const, at: NOW - ago * min, threadId: "thr_g", summary: "SOURCE SETTLED for the hook", by: { kind: "tavern" as const } });
const delegatedEntries = [
  entry("01", 0, { description: "Round 3", status: "doing" }),
  entry("02", 0, { parentId: "01", description: "Owner hook", owner: "thr_g", status: "doing", report: report(12), evidence: [{ kind: "file", ref: "a.ts", detail: "", exitCode: null }, { kind: "file", ref: "b.ts", detail: "", exitCode: null }] }),
  entry("03", 1, { parentId: "01", description: "Title bar", owner: "thr_s", status: "doing" }),
  entry("04", 2, { parentId: "01", description: "Away fix", owner: "thr_t", status: "blocked" }),
  entry("05", 1, { description: "Old close", status: "done", doneAt: NOW - 120 * min }),
];
const progressOf = (entries: JournalEntry[]) => ({ done: entries.filter(e => e.status === "done").length, total: entries.length, blocked: entries.filter(e => e.status === "blocked").length, current: null });
const make = (entries: JournalEntry[]) => journalSchema.parse({ ...fixtureJournal, threadId: "k", entries, changes: [], progress: progressOf(entries) });
const open = (data: ReturnType<typeof make>, journalEdit = vi.fn(() => ({ ok: true, message: "Recorded" }))) =>
  ({ slot: renderSlot({ component: JournalTab }, { threadId: "k", environment: null, params: null }, { rpc: { journal: () => data, journalEdit, decor: () => fixtureDecor, registry: () => fixtureRegistry, crests: () => ({ crests: [{ threadId: "thr_g", label: "Gaetano" }, { threadId: "thr_s", label: "Steve" }] }) } }), journalEdit });

const cursor = (root: HTMLElement) => waitFor(() => { const el = root.querySelector(".journal-cur"); if (!el) throw new Error("no currency"); return el; });
describe("the journal's currency", () => {
  it("names the last close, and the oldest open entry in its title", async () => {
    const { slot } = open(make(delegatedEntries.map(e => e.id === "02" ? { ...e, report: null } : e)));
    const cur = await cursor(slot.container);
    expect(cur.textContent).toMatch(/^Last done 2h ago$/);
    expect(cur.getAttribute("title")).toBe("Oldest open entry: 7h");
    expect(cur.classList.contains("stale")).toBe(false);
  });
  it("says in words why it is marked, once a report has waited past ten minutes", async () => {
    const { slot } = open(make(delegatedEntries));
    const cur = await cursor(slot.container);
    expect(cur.classList.contains("stale")).toBe(true);
    expect(cur.textContent).toBe("Last done 2h ago · 1 report waiting");
  });
  it("is left out of a journal with nothing done yet", async () => {
    const { slot } = open(make([entry("01", 0)]));
    await slot.findByText("Entry 01");
    expect(slot.container.querySelector(".journal-cur")).toBeNull();
  });
});

describe("the Delegated view", () => {
  it("appears only when another thread owns open work", async () => {
    const { slot } = open(make([entry("01", 0), entry("02", 1, { owner: "k" })]));
    await slot.findByText("Entry 01");
    expect(slot.queryByRole("button", { name: /^Delegated/ })).toBeNull();
  });
  it("groups delegated entries as Reported, Working and Waiting, each heading explained, with owners by name", async () => {
    const { slot } = open(make(delegatedEntries));
    fireEvent.click(await slot.findByRole("button", { name: /^Delegated 3/ }));
    const groups = slot.container.querySelectorAll(".journal-group");
    expect([...groups].map(g => g.querySelector("h3")!.textContent)).toEqual(["Reported 1", "Working 1", "Blocked 1"]);
    expect(groups[0]!.querySelector("h3")!.getAttribute("title")).toMatch(/reported or went idle/);
    expect(groups[2]!.querySelector("h3")!.getAttribute("title")).toBe("The delegate is blocked; it needs you or something outside");
    const reported = within(groups[0] as HTMLElement);
    expect(reported.getByText("Owner hook")).toBeTruthy();
    expect(reported.getByText("Gaetano")).toBeTruthy();
    expect(groups[0]!.querySelector(".journal-reason")!.textContent).toBe("Went idle 12m ago: SOURCE SETTLED for the hook");
    expect(within(groups[1] as HTMLElement).getByText("Steve")).toBeTruthy();
    expect(slot.queryByText("Round 3")).toBeNull();
  });
});

describe("a delegate's report on a row", () => {
  it("carries a quiet report-in tag, and Still waiting clears it without closing", async () => {
    const { slot, journalEdit } = open(make(delegatedEntries));
    const row = (await slot.findByText("Owner hook")).closest(".journal-row") as HTMLElement;
    const tag = within(row).getByText("report in");
    expect(tag.tagName).toBe("SPAN");
    // The evidence count hides on phones, so the row's tooltip keeps it.
    expect(row.querySelector(".desc")!.getAttribute("title")).toBe("Owner hook · 2 evidence");
    fireEvent.click(row.querySelector(".desc")!);
    const rep = await waitFor(() => { const el = slot.container.querySelector(".journal-detail .journal-verdict.rep"); if (!el) throw new Error("no report"); return el as HTMLElement; });
    expect(rep.querySelector("p")!.textContent).toBe("Gaetano went idle 12m ago");
    expect(rep.querySelector(".why")!.textContent).toBe("SOURCE SETTLED for the hook");
    const wait = within(rep).getByRole("button", { name: "Still waiting" });
    expect(wait.className).toBe("btn sm");
    fireEvent.click(wait);
    await waitFor(() => expect(journalEdit).toHaveBeenCalled());
    expect((journalEdit.mock.calls[0] as unknown as [{ edit: unknown }])[0].edit).toEqual({ op: "wait", entryIds: ["02"] });
  });
});

describe("a narrow panel", () => {
  it("folds Stuck into More when Delegated is shown, and swaps them while Stuck is in use", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(cb: ResizeObserverCallback) { observers.push(cb); } observe() {} disconnect() {} });
    try {
      const { slot } = open(make(delegatedEntries));
      await slot.findByRole("button", { name: /^Delegated 3/ });
      expect(slot.getByRole("button", { name: /^Stuck 1/ })).toBeTruthy();
      const { act } = await import("@testing-library/react");
      act(() => observers.forEach(cb => cb([{ contentRect: { width: 360 } } as ResizeObserverEntry], {} as ResizeObserver)));
      expect(slot.queryByRole("button", { name: /^Stuck/ })).toBeNull();
      fireEvent.click(slot.getByText("More"));
      fireEvent.click(await slot.findByRole("menuitem", { name: "Stuck · 1" }));
      await waitFor(() => expect(slot.getByRole("button", { name: /^Stuck 1/ }).getAttribute("aria-pressed")).toBe("true"));
      expect(slot.queryByRole("button", { name: /^Delegated/ })).toBeNull();
    } finally { width.mockRestore(); vi.unstubAllGlobals(); }
  });
});
