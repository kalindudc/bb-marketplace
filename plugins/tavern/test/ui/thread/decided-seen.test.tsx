// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Decision } from "../../../src/shared/schema";
import { DecidedForYou, useRemembered } from "../../../src/ui/kit";
import { fixtureDecor, fixtureJournal, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab, LedgerTab } from "../../../src/ui/thread/tabs";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const decision = (id: string, text: string, extra: Partial<Decision> & { seenAt?: number | null } = {}): Decision => ({ id, keeperThreadId: "keeper-1", boardQuestId: null, text, why: "Reversible, so the Keeper went ahead", source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: Date.now() - 60_000, ...extra }) as Decision;
const two = [decision("d1", "Hired a Ranger for the DNS check"), decision("d2", "Picked staging first")];
const box = (ui: React.ReactElement) => render(<div className="tavern">{ui}</div>);

describe("Decided for you: OK and Mark all seen", () => {
  it("marks one row seen, leaves a receipt with Undo, and brings it back on Undo", async () => {
    const onSeen = vi.fn(async (ids: string[]) => ({ ids, undoToken: "tok-1" }));
    const onUnseen = vi.fn(async () => ({ ok: true }));
    const view = box(<DecidedForYou decisions={two} onUndo={() => {}} onSeen={onSeen} onUnseen={onUnseen} />);
    fireEvent.click(view.getByRole("button", { name: "Mark seen: Picked staging first" }));
    expect(onSeen).toHaveBeenCalledWith(["d2"], false);
    await view.findByText("Marked 1 seen");
    expect(view.queryByText("Picked staging first")).toBeNull();
    expect(view.getByText("Hired a Ranger for the DNS check")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Undo: mark 1 decision unseen again/ }));
    expect(onUnseen).toHaveBeenCalledWith("tok-1");
    await view.findByText("Picked staging first");
    expect(view.getByRole("status").textContent).toContain("Back in Decided for you");
  });

  it("sends exactly the ids on screen for Mark all seen, and all only when the list is clipped", async () => {
    const onSeen = vi.fn(async (ids: string[]) => ({ ids, undoToken: "t" }));
    const view = box(<DecidedForYou decisions={two} onUndo={() => {}} onSeen={onSeen} onUnseen={async () => ({})} />);
    fireEvent.click(view.getByRole("button", { name: /Mark all seen/ }));
    expect(onSeen).toHaveBeenCalledWith(["d1", "d2"], false);
    await view.findByText("Marked 2 seen");
    cleanup();
    const clipped = box(<DecidedForYou decisions={two} total={140} onUndo={() => {}} onSeen={onSeen} onUnseen={async () => ({})} />);
    expect(clipped.getByLabelText("140 decisions")).toBeTruthy();
    fireEvent.click(clipped.getByRole("button", { name: /Mark all seen/ }));
    expect(onSeen).toHaveBeenLastCalledWith(["d1", "d2"], true);
  });

  it("says Already seen with no Undo when nothing changed, and keeps errors in place", async () => {
    const view = box(<DecidedForYou decisions={two} onUndo={() => {}} onSeen={async () => ({ ids: [], undoToken: null })} onUnseen={async () => ({})} />);
    fireEvent.click(view.getByRole("button", { name: "Mark seen: Picked staging first" }));
    await view.findByText("Already seen");
    expect(view.queryByRole("button", { name: /^Undo: mark/ })).toBeNull();
    cleanup();
    const failing = box(<DecidedForYou decisions={two} onUndo={() => {}} onSeen={async () => { throw new Error("offline"); }} onUnseen={async () => ({})} />);
    fireEvent.click(failing.getByRole("button", { name: "Mark seen: Picked staging first" }));
    expect((await failing.findByRole("alert")).textContent).toContain("Couldn’t mark seen: offline");
    expect(failing.getByText("Picked staging first")).toBeTruthy();
  });

  it("renders as before without onSeen, and shows a seen row as Seen", () => {
    const plain = box(<DecidedForYou decisions={two} onUndo={() => {}} />);
    expect(plain.queryByRole("button", { name: /Mark seen|Mark all seen/ })).toBeNull();
    cleanup();
    const full = box(<DecidedForYou decisions={[decision("d3", "Kept the old cookie", { seenAt: Date.now() }), two[0]!]} onUndo={() => {}} onSeen={async ids => ({ ids, undoToken: null })} />);
    expect(full.getByText("Seen")).toBeTruthy();
    expect(full.queryByRole("button", { name: "Mark seen: Kept the old cookie" })).toBeNull();
    expect(full.queryByRole("button", { name: /Mark all seen/ })).toBeNull();
  });
});

describe("Thread tabs remember their view per thread", () => {
  function Probe({ k }: { k: string }) {
    const [v, set] = useRemembered<"a" | "b">(k, "a", (x): x is "a" | "b" => x === "a" || x === "b");
    return <button type="button" onClick={() => set("b")}>{v}</button>;
  }

  it("keeps a remembered value across a remount, per key, and rejects a stale one", () => {
    const first = render(<Probe k="t:one" />);
    fireEvent.click(first.getByRole("button"));
    first.unmount();
    expect(render(<Probe k="t:one" />).getByRole("button").textContent).toBe("b");
    cleanup();
    expect(render(<Probe k="t:two" />).getByRole("button").textContent).toBe("a");
    cleanup();
    window.localStorage.setItem("tavern:view:t:three", JSON.stringify("zzz"));
    expect(render(<Probe k="t:three" />).getByRole("button").textContent).toBe("a");
  });

  it("reopens the Journal on the filter chosen for that thread only", async () => {
    const open = (threadId: string) => renderSlot({ component: JournalTab }, { threadId, environment: null, params: null }, { rpc: { journal: () => ({ ...fixtureJournal, threadId }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const a = open("keeper-1");
    fireEvent.click(await a.findByRole("button", { name: /^Open \d/ }));
    a.lifecycle.unmount();
    cleanup();
    const again = open("keeper-1");
    expect((await again.findByRole("button", { name: /^Open \d/ })).getAttribute("aria-pressed")).toBe("true");
    again.lifecycle.unmount();
    cleanup();
    const other = open("member-1");
    expect((await other.findByRole("button", { name: /^All \d/ })).getAttribute("aria-pressed")).toBe("true");
    other.lifecycle.unmount();
  });

  it("reopens the Ledger's folds as they were left", async () => {
    const open = () => renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => fixtureLedger, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const first = open();
    const fold = await waitFor(() => { const d = first.container.querySelector<HTMLDetailsElement>('details[data-fold="routes"]'); if (!d) throw new Error("no fold yet"); return d; });
    expect(fold.open).toBe(false);
    await act(async () => { fold.open = true; fold.dispatchEvent(new Event("toggle")); await new Promise(r => setTimeout(r, 40)); });
    first.lifecycle.unmount();
    cleanup();
    const again = open();
    const reopened = await waitFor(() => { const d = again.container.querySelector<HTMLDetailsElement>('details[data-fold="routes"]'); if (!d) throw new Error("no fold yet"); return d; });
    expect(reopened.open).toBe(true);
    again.lifecycle.unmount();
  });
});

describe("Ledger and widget use the server's attention list and counts", () => {
  const attention = [decision("d1", "Hired a Ranger for the DNS check"), decision("d2", "Picked staging first")];
  const history = [...attention, decision("h3", "Asked Luc about the window", { source: "steer" })];
  const ledger = { ...fixtureLedger, decidedForYou: attention, decidedCount: 7, decidedThroughId: "d1", decisions: history, decisionsTotal: 150, decisionsNextCursor: "c1" };
  const older = { decisions: [decision("o1", "Kept the old cookie")], nextCursor: null, total: 150 };

  it("marks a row and a clipped list through the server, and counts the uncapped total", async () => {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry, markDecisionsSeen: (input: unknown) => ({ ok: true as const, ids: (input as { ids?: string[] }).ids ?? ["d1", "d2"], undoToken: "tok" }), markDecisionsUnseen: () => ({ ok: true as const, ids: ["d2"] }) } });
    expect((await slot.findByLabelText("What the Keeper knows now")).textContent).toContain("7 decided for you");
    fireEvent.click(await slot.findByRole("button", { name: "Mark seen: Picked staging first" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find(c => c.method === "markDecisionsSeen")?.input).toEqual({ ids: ["d2"] }));
    fireEvent.click(await slot.findByRole("button", { name: /Undo: mark 1 decision unseen again/ }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find(c => c.method === "markDecisionsUnseen")?.input).toEqual({ undoToken: "tok" }));
    fireEvent.click(await slot.findByRole("button", { name: /Mark all seen/ }));
    await waitFor(() => expect(slot.inspection.rpcCalls.filter(c => c.method === "markDecisionsSeen").at(-1)?.input).toEqual({ all: true, keeperThreadId: "keeper-1", throughId: "d1" }));
    slot.lifecycle.unmount();
  });

  it("pages older decisions into All decisions with Show more", async () => {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry, decisionHistory: () => older } });
    const fold = await waitFor(() => { const d = slot.container.querySelector<HTMLDetailsElement>('details[data-fold="decisions"]'); if (!d) throw new Error("no fold"); return d; });
    expect(fold.querySelector("summary")!.textContent).toContain("150");
    fireEvent.click(await slot.findByRole("button", { name: "Show older decisions: 3 of 150 shown" }));
    await slot.findByText("Kept the old cookie");
    expect(slot.inspection.rpcCalls.find(c => c.method === "decisionHistory")?.input).toMatchObject({ keeperThreadId: "keeper-1", cursor: "c1" });
    expect(slot.queryByRole("button", { name: /Show older decisions/ })).toBeNull();
    slot.lifecycle.unmount();
  });
});
