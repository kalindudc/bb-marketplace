// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureJournal, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";


/**
 * Which components rendered between two snapshots of React's fiber tree. A component that renders gets new props or new hook
 * state; one that bailed out (memo, or a parent that did not render) keeps both. Every component counted here uses hooks.
 */
type Fiber = { type?: unknown; memoizedProps: unknown; memoizedState: unknown; child: Fiber | null; sibling: Fiber | null; return: Fiber | null; tag: number; stateNode: { current: Fiber } | null; alternate: Fiber | null };
function tree(node: Element) {
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"))!;
  let f = (node as unknown as Record<string, Fiber>)[key]!;
  while (f.return) f = f.return;
  const out = new Map<Fiber, { props: unknown; state: unknown; name: string }>();
  const walk = (x: Fiber | null) => { for (; x; x = x.sibling) { const name = typeof x.type === "function" ? (x.type as { name: string }).name : ""; if (name) out.set(x, { props: x.memoizedProps, state: x.memoizedState, name }); walk(x.child); } };
  walk(f.stateNode!.current);
  return out;
}
function rendersSince(before: ReturnType<typeof tree>, after: ReturnType<typeof tree>) {
  const counts: Record<string, number> = {};
  for (const [f, now] of after) {
    const was = before.get(f) ?? (f.alternate ? before.get(f.alternate) : undefined);
    if (!was || was.props !== now.props || was.state !== now.state) counts[now.name] = (counts[now.name] ?? 0) + 1;
  }
  return counts;
}
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
const base = fixtureJournal.entries[0]!;
const NOW = Date.UTC(2026, 10, 15, 1, 0);
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, threadId: "k", id, order, description: `Entry ${id}`, status: "todo", owner: null, report: null, createdAt: NOW - 3_600_000, doneAt: null, ...over });
const entries = [entry("01", 0, { status: "done", doneAt: NOW - 5 * 60_000 }), entry("02", 1, { status: "done", doneAt: NOW - 9 * 60_000 }), entry("03", 2, { status: "doing" }), entry("04", 3)];
const changes = [{ id: 1, threadId: "k", at: NOW - 5 * 60_000, actor: { kind: "agent" as const, threadId: "thr_g" }, action: "done", entryIds: ["01"], text: "Agent ticked [01]", seen: true }];
const journal = journalSchema.parse({ ...fixtureJournal, threadId: "k", entries, changes, progress: { done: 2, total: 4, blocked: 0, current: { id: "03", description: "Entry 03", status: "doing" } } });
let decorCalls = 0, crestLabel = "Gaetano";
async function open() {
  decorCalls = 0; crestLabel = "Gaetano";
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); vi.setSystemTime(NOW);
  const slot = renderSlot({ component: JournalTab }, { threadId: "k", environment: null, params: null }, { rpc: { journal: () => journal, decor: () => (decorCalls++ === 0 ? fixtureDecor : { ...fixtureDecor, keeperView: null }), registry: () => fixtureRegistry, crests: () => ({ crests: [{ threadId: "thr_g", label: crestLabel }] }) as never } });
  await waitFor(() => expect(slot.container.querySelector(".journal-cur")?.textContent).toBe("Last done 5m ago"));
  await act(async () => {});
  return slot;
}

describe("what re-renders in the journal tab", () => {
  it("a minute tick re-renders the currency line, never the tally, the list or the tab", async () => {
    const slot = await open();
    const before = tree(slot.container.querySelector(".journal-list")!);
    act(() => { vi.advanceTimersByTime(60_000); });
    const r = rendersSince(before, tree(slot.container.querySelector(".journal-list")!));
    expect(slot.container.querySelector(".journal-cur")!.textContent).toBe("Last done 6m ago");
    expect(r.JournalCurrency).toBeGreaterThan(0);
    expect(r.TimeAgo).toBeGreaterThan(0);
    expect({ tab: r.JournalTab ?? 0, tally: r.Tally ?? 0, rows: r.EntryRow ?? 0 }).toEqual({ tab: 0, tally: 0, rows: 0 });
  });
  it("a change the journal doesn't show re-renders the tab but skips the tally, whose counts did not change", async () => {
    const slot = await open();
    const before = tree(slot.container.querySelector(".journal-list")!);
    await act(async () => { await slot.experimental_invalidateRpc(["tavern:thread:k"]); });
    // Wait for the decor change itself to re-render the tab, then read the tally in that same snapshot.
    const r = await waitFor(() => { const now = rendersSince(before, tree(slot.container.querySelector(".journal-list")!)); expect(now.JournalTab).toBeGreaterThan(0); return now; });
    expect(decorCalls).toBe(2);
    expect(r.Tally ?? 0).toBe(0);
  });
  it("another thread's change refreshes the names and re-renders only the parts that show them, 0 times the tab", async () => {
    const slot = await open();
    await waitFor(() => expect(slot.container.querySelector(".journal-history .who-n")?.textContent).toBe("Gaetano"));
    const before = tree(slot.container.querySelector(".journal-list")!);
    crestLabel = "Gaetano the cook";
    await act(async () => { await slot.experimental_invalidateRpc(["tavern:rows"]); });
    await waitFor(() => expect(slot.container.querySelector(".journal-history .who-n")?.textContent).toBe("Gaetano the cook"));
    const r = rendersSince(before, tree(slot.container.querySelector(".journal-list")!));
    expect(r.JournalHistoryList).toBeGreaterThan(0);
    expect({ tab: r.JournalTab ?? 0, tally: r.Tally ?? 0, rows: r.EntryRow ?? 0 }).toEqual({ tab: 0, tally: 0, rows: 0 });
  });
});
