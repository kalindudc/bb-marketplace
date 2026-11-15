// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { KeeperRow, MemberReports, QuietNotice } from "../../../src/ui/kit";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { ledgerSchema } from "../../../src/shared/contract";
import type { Room } from "../../../src/shared/contract";
import { fixtureDecor, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { readmeDetail, registry, richRoom } from "../page/scenes";

// Each text reads "23:50" on the day and gains its date after midnight. The parts render once and nothing re-renders them from outside:
// no refetch, no new props. The change has to come from the kit's day clock, which is what a memoized parent leaves them with.
const AT = new Date(2026, 10, 14, 23, 50).getTime();
const BEFORE = new Date(2026, 10, 14, 23, 59, 30).getTime();
const dated = new Date(AT).toLocaleDateString(undefined, { month: "short", day: "numeric" });

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); vi.setSystemTime(BEFORE); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const pastMidnight = () => act(() => { vi.advanceTimersByTime(60_000); });

async function mount(node: () => ReactElement, rpc: Record<string, unknown> = {}) {
  const app = await loadPluginApp(definePluginApp(app => { app.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: node } as never); }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc } as never);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return slot;
}

describe("clock texts turn at midnight with no refetch", () => {
  it("QuietNotice: quiet since 23:50, then with its date", async () => {
    const slot = await mount(() => <QuietNotice threadId="keeper-1" since={AT} compact />);
    const time = () => slot.container.querySelector(".tq-since time")!.textContent;
    expect(time()).toBe("23:50");
    pastMidnight();
    expect(time()).toBe(`${dated} 23:50`);
  });

  it("catches up on return to the tab when a sleeping laptop missed the midnight timer", async () => {
    const slot = await mount(() => <QuietNotice threadId="keeper-1" since={AT} compact />);
    const time = () => slot.container.querySelector(".tq-since time")!.textContent;
    vi.setSystemTime(BEFORE + 8 * 3600_000);
    expect(time()).toBe("23:50");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(time()).toBe(`${dated} 23:50`);
  });

  it("KeeperRow: a same-name Keeper's start time becomes its date", async () => {
    type Keeper = Room["keepers"][number];
    const k = richRoom.keepers[0]!;
    const twinA: Keeper = { ...k, archived: false, member: { ...k.member, threadId: "thr-a" }, threadTitle: "Same title", threadCreatedAt: AT };
    const twinB: Keeper = { ...twinA, member: { ...k.member, threadId: "thr-b" }, threadCreatedAt: AT - 3600_000 };
    const room = { keepers: [twinA, twinB], decidedForYou: [] };
    const slot = await mount(() => <KeeperRow keeper={twinA} room={room} registry={registry} />);
    const text = () => slot.container.textContent ?? "";
    expect(text()).toContain("started 23:50");
    pastMidnight();
    expect(text()).toContain(`started 14 ${new Date(AT).toLocaleDateString("en", { month: "short" })}`);
    expect(text()).not.toContain("started 23:50");
  });

  it("MemberReports: a report's time gains its date", async () => {
    const member = readmeDetail.quest.members.find(m => readmeDetail.reports.some(r => r.memberThreadId === m.threadId))!;
    const reports = readmeDetail.reports.map(r => r.memberThreadId === member.threadId ? { ...r, createdAt: AT } : r);
    const detail = { ...readmeDetail, reports };
    const slot = await mount(() => <MemberReports detail={detail} member={member} registry={registry} />);
    const times = () => [...slot.container.querySelectorAll(".rv-rep-h time")].map(t => t.textContent);
    expect(times().length).toBeGreaterThan(0);
    expect(times().every(t => t === "23:50")).toBe(true);
    pastMidnight();
    expect(times().every(t => t === `${dated} 23:50`)).toBe(true);
  });

  it("the Ledger's rule row: widened 23:50, then with its date", async () => {
    const rule = { id: "r1", scope: "global", scopeId: null, text: "Never push to main", source: "user", active: true, widenedAt: AT, createdAt: AT - 86_400_000 };
    const ledger = ledgerSchema.parse({ ...fixtureLedger, rules: [rule] });
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const widened = () => [...slot.container.querySelectorAll(".rr-h .m.small")].map(e => e.textContent).find(t => t?.startsWith("widened"));
    expect(widened()).toBe("widened 23:50");
    pastMidnight();
    expect(widened()).toBe(`widened ${dated} 23:50`);
  });
});
