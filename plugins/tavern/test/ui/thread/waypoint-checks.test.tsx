// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import type { BoardQuestDetail } from "../../../src/shared/contract";
import { fixtureDecor, fixtureDetail, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { TalePage } from "../../../src/ui/page/tale";

const first = fixtureDetail.quest.waypoints[0]!;
const waypoints: BoardQuestDetail["quest"]["waypoints"] = [
  { ...first, title: "Watch the release channel", check: "none", state: "done" },
  { ...first, id: "w2", title: "Summarise risky changes", check: "keeper", state: "accepted", dependsOn: ["w1"], resolutionReason: "The source notes cover the whole release window", acceptedBy: "Wren" },
  { ...first, id: "w3", title: "Read the next shift's handover", check: "none", state: "skipped", dependsOn: ["w2"], optional: true, resolutionReason: "The watch ended before the next shift" },
];
const plan = { ...fixtureDetail.plans[0]!, goal: "Watch the release without changing anything", doneWhen: "The shift ends", reviewLoad: "Keeper acceptance", waypoints, party: [] };
const detail: BoardQuestDetail = { ...fixtureDetail, plans: [plan], quest: { ...fixtureDetail.quest, plan, waypoints, title: "Release watch", phase: "wrap", greenlitVersion: 1, openAsks: 0, move: { who: "keeper", text: "Ask to conclude" } } };
const proposed: BoardQuestDetail = { ...detail, quest: { ...detail.quest, phase: "greenlight", greenlitVersion: null, waypoints: waypoints.map(w => ({ ...w, state: "planned", resolutionReason: null })) } };

it("shows the checks beside owners and the resolution and reason in the Ledger without a verified mark", async () => {
  const capture = process.env.TAVERN_CHECKS_LAYOUT === "1";
  if (capture) vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
    observe() { this.callback([{ contentRect: { width: 1350 } }]); }
    disconnect() {}
  });
  const map = renderSlot({ component: () => <QuestMapCard detail={proposed} version={1} /> } as never, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry } });
  const ledger = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, asks: [], boardQuests: [detail.quest] }), decor: () => fixtureDecor, registry: () => fixtureRegistry, questAuthority: () => ({ rows: [], delegations: [], preapprovals: [], review: { used: 0, total: 3 } }) } });
  try {
    const route = within(map.getByRole("region", { name: "Route in order" }));
    expect(route.getByText("No Warden checks on this map")).toBeTruthy();
    fireEvent.click(map.getByRole("button", { name: "Quest map" }));
    const card = map.container;
    const target = () => card.querySelector(".qsvg .wp-check");
    await waitFor(() => expect(target()?.textContent).toBe("no check"));
    expect([...card.querySelectorAll(".qsvg .wp-check")].map(el => el.textContent)).toEqual(["no check", "Keeper accepts", "no check"]);
    expect(card.querySelectorAll(".qsvg .wp .ok")).toHaveLength(0);
    fireEvent.click(await ledger.findByRole("button", { name: /3 waypoints/ }));
    const rows = await within(ledger.container).findByRole("list", { name: "Waypoints in order" });
    expect(within(rows).getByText("accepted").closest("li")?.textContent).toContain(waypoints[1]!.resolutionReason);
    expect(within(rows).getByText("skipped").closest("li")?.textContent).toContain(waypoints[2]!.resolutionReason);
    expect(rows.textContent).not.toContain("✓");
    if (capture) {
      const panel = rows.closest(".lg-quest")!;
      process.stdout.write("CHECK_LAYOUT=" + JSON.stringify({ map: card.innerHTML, ledger: `<section class="tavern ledger">${panel.outerHTML}</section>` }) + "\n");
    }
  } finally { map.lifecycle.unmount(); ledger.lifecycle.unmount(); vi.unstubAllGlobals(); }
});

it("shows an unsealed Ranger map without pretending that the party needed approval", () => {
  const rangerPlan = { ...plan, party: [{ classId: "ranger", characterId: null, model: null, purpose: "Scout", waypointIds: ["w1"] }] };
  const research = { ...detail, asks: [], plans: [rangerPlan], quest: { ...detail.quest, plan: rangerPlan, greenlitVersion: null, checkPlanVersion: 1 } };
  const slot = renderSlot({ component: () => <QuestMapCard detail={research} version={1} /> } as never, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry } });
  try {
    expect(slot.getByText("No staffing greenlight needed")).toBeTruthy();
    expect(slot.queryByText("Sealed · party formed")).toBeNull();
    expect(slot.queryByText(/greenlight ask is not open/)).toBeNull();
    expect(slot.queryByRole("button", { name: /Form the party/ })).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

it("tells a three-waypoint watch as done with no check and no verified loot", async () => {
  const quest = { ...detail.quest, phase: "done" as const, endedAt: 2000, members: [], waypoints: waypoints.map(w => ({ ...w, check: "none" as const, state: "done" as const, resolutionReason: null })) };
  const slot = renderSlot({ component: () => <TalePage detail={{ ...detail, quest }} registry={fixtureRegistry} /> } as never, {}, { rpc: { registry: () => fixtureRegistry } });
  try {
    const done = await slot.findByRole("region", { name: "Done without a Warden check" });
    expect(within(done).getAllByText("done; no check was planned")).toHaveLength(3);
    expect(await slot.findByText("No verified loot.")).toBeTruthy();
    expect(slot.container.querySelector(".qsvg .wp .ok")).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});
