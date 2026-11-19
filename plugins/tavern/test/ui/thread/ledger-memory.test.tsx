import { withAttention } from "../attention-fixture";
// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureJournal, fixtureLedger, fixtureMember, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab, LedgerTab } from "../../../src/ui/thread/tabs";
import type { Ledger } from "../../../src/shared/contract";
import { PartyPicture } from "../../../src/ui/kit";
afterEach(cleanup);

// Due times read "by 12:40" today and "by Nov 15 00:30" past midnight, so the clock is pinned: only Date is faked, timers stay real for findBy.
const NOON = new Date(2026, 10, 14, 12, 0).getTime();
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOON);
afterAll(() => { vi.useRealTimers(); });

const now = Date.now();
const note = (id: string, kind: "fact" | "commitment" | "waiting-on-user", text: string, extra: Record<string, unknown> = {}, now = NOON) => ({ id, keeperThreadId: "keeper-1", boardQuestId: "vault", kind, text, dueAt: null, condition: null, validUntil: null, sourceMessageId: null, routeId: null, state: "open" as const, createdAt: now - 60_000, updatedAt: now - 60_000, doneAt: null, dueNotifiedAt: null, ...extra });
const gate = { keeperThreadId: "keeper-1", boardQuestId: "vault", waypointId: "w1", planVersion: 1, askedWho: "Luc", via: "Slack DM", askedAt: now - 20 * 60_000, answer: "After lunch", answeredAt: now - 5 * 60_000 };
const ledgerAt = (now: number) => ({
  ...fixtureLedger,
  boardQuests: [{ ...fixtureQuest, waypoints: fixtureQuest.waypoints.map((w, i) => i === 0 ? { ...w, gate } : w) }],
  notes: [
    note("n1", "commitment", "Send the comms draft", { dueAt: now + 40 * 60_000 }, now),
    note("n2", "commitment", "Post the record count", { dueAt: now - 12 * 60_000 }, now),
    note("n3", "fact", "Luc is out Friday after 15:00", {}, now),
    note("n4", "fact", "vault-b serves the old cookie", {}, now),
    note("n5", "fact", "The train leaves on the hour", {}, now),
    note("n6", "fact", "Lark stays read-only", { createdAt: now - 1000 }, now),
    note("n7", "waiting-on-user", "Share the on-call doc link", {}, now),
  ],
  notesTotal: 7,
});
const ledger = ledgerAt(now);
const renderLedger = (data: Ledger = ledger) => renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => withAttention(data), decor: () => fixtureDecor, registry: () => fixtureRegistry } });

describe("Ledger: what the Keeper keeps in mind", () => {
  it("shows each resting member’s keep reason and time", async () => {
    const restNote = "kept until 13:00: expect a follow-up.";
    const slot = renderLedger({ ...ledger, boardQuests: [{ ...ledger.boardQuests[0]!, members: [{ ...fixtureMember, restNote }] }] });
    expect(await slot.findByText(restNote, { exact: false })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("counts hand-backs under Needs you by kind, so the number never reads as more asks", async () => {
    const slot = renderLedger();
    const needs = await slot.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("2 need you")).toBeTruthy();
    expect(within(within(needs).getByRole("list", { name: "Waiting on you" })).getByText("Share the on-call doc link")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("lists promises overdue first and facts word for word, folding past three", async () => {
    const slot = renderLedger();
    const promises = await slot.findByRole("list", { name: "Promises the Keeper made" });
    const rows = within(promises).getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("Post the record count");
    expect(rows[0]!.textContent).toContain("overdue");
    expect(rows[1]!.textContent).toMatch(/by \d\d:\d\d/);
    expect(rows[1]!.textContent).toContain("by 12:40");
    const facts = slot.getByRole("list", { name: "Facts the Keeper keeps" });
    expect(within(facts).getAllByRole("listitem")).toHaveLength(3);
    expect(within(facts).getAllByRole("listitem")[0]!.textContent).toContain("“Lark stays read-only”");
    fireEvent.click(slot.getByRole("button", { name: /Show all 4/ }));
    expect(within(slot.getByRole("list", { name: "Facts the Keeper keeps" })).getAllByRole("listitem")).toHaveLength(4);
    slot.lifecycle.unmount();
  });

  it("dates a promise that falls due after midnight", async () => {
    const late = new Date(2026, 10, 14, 23, 50).getTime();
    vi.setSystemTime(late);
    try {
      const slot = renderLedger(ledgerAt(late));
      const rows = within(await slot.findByRole("list", { name: "Promises the Keeper made" })).getAllByRole("listitem");
      const day = new Date(late + 40 * 60_000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      expect(rows[1]!.textContent).toContain(`by ${day} 00:30`);
      expect(rows[1]!.textContent).not.toMatch(/by \d\d:\d\d/);
      slot.lifecycle.unmount();
    } finally { vi.setSystemTime(NOON); }
  });

  it("shows each outside gate on its quest with who was asked and the answer", async () => {
    const slot = renderLedger();
    const gates = await slot.findByRole("list", { name: "Outside gates" });
    expect(within(gates).getByText("Luc")).toBeTruthy();
    expect(within(gates).getByText("answered")).toBeTruthy();
    expect(gates.textContent).toContain("Slack DM");
    expect(gates.textContent).toContain("“After lunch”");
    slot.lifecycle.unmount();
  });
});

describe("Ledger: older promises", () => {
  it("counts aged promises the server leaves out and says who can list them", async () => {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...ledger, olderPromises: 2 }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const kept = await slot.findByRole("region", { name: "Kept in mind" });
    expect(kept.textContent).toContain("Older promises: 2");
    expect(kept.textContent).toContain("ask the Keeper to list them");
    slot.lifecycle.unmount();
  });

  it("keeps the section when only older promises remain", async () => {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...ledger, notes: [], notesTotal: 0, olderPromises: 1 }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const kept = await slot.findByRole("region", { name: "Kept in mind" });
    expect(kept.textContent).toContain("Older promises: 1");
    slot.lifecycle.unmount();
  });
});

describe("Ledger: text you act on", () => {
  it("shows a proposed rule in full beside Confirm, never as a truncated tooltip", async () => {
    const rule = { id: "r9", scope: "keeper" as const, scopeId: "keeper-1", text: "Keep every Ranger time box to 20 minutes, and report what was found before asking for more time", source: "keeper-proposed" as const, active: false, createdAt: now - 60_000 };
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => withAttention({ ...ledger, rules: [rule] }), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const needs = await slot.findByRole("region", { name: "Needs you" });
    const text = within(needs).getByText(rule.text);
    expect(text.getAttribute("title")).toBeNull();
    expect(text.closest("li")!.className).toContain("proposed");
    expect(within(needs).getByRole("button", { name: `Confirm the rule: ${rule.text}` })).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Kit details", () => {
  it("keeps a short member summary as plain text, not a control", () => {
    const member = { ...fixtureMember, threadId: "m1", role: "member" as const, keeperThreadId: "keeper-1", boardQuestId: "vault", place: "road" as const, state: "working" as const, doing: "Adding the retry" };
    const view = render(<div className="tavern"><PartyPicture members={[member]} registry={fixtureRegistry} /></div>);
    expect(view.getByText("Adding the retry").closest("button")).toBeNull();
  });

  it("groups the journal filters in one segmented control with More outside it", async () => {
    const slot = renderSlot({ component: JournalTab }, { threadId: "keeper-1", environment: null, params: null }, { rpc: { journal: () => fixtureJournal } });
    const group = await slot.findByRole("group", { name: "Show" });
    expect(within(group).getByRole("button", { name: /All/ }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: /Open/ })).toBeTruthy();
    expect(within(group).queryByText("More")).toBeNull();
    expect(slot.getByText("More")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});

describe("Quiet Keeper", () => {
  it("says since when, resumes through resumeKeeper, then hides and leaves one receipt", async () => {
    const since = new Date(2026, 10, 14, 3, 12).getTime();
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...ledger, quietSince: since }), decor: () => fixtureDecor, registry: () => fixtureRegistry, resumeKeeper: () => ({ ok: true as const }) } });
    const notice = await slot.findByRole("group", { name: /Quiet since you stopped it/ });
    expect(notice.textContent).toContain("03:12");
    fireEvent.click(within(notice).getByRole("button", { name: "Resume this Keeper" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.find(c => c.method === "resumeKeeper")?.input).toEqual({ threadId: "keeper-1" }));
    await waitFor(() => expect(slot.queryByRole("group", { name: /Quiet since/ })).toBeNull());
    expect(slot.getByRole("status").textContent).toContain("Resumed");
    slot.lifecycle.unmount();
  });

  it("shows nothing when the Keeper is not quiet", async () => {
    const slot = renderLedger();
    await slot.findByRole("region", { name: "Needs you" });
    expect(slot.queryByRole("group", { name: /Quiet since/ })).toBeNull();
    slot.lifecycle.unmount();
  });
});
