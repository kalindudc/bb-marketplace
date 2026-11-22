import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { QuestPage } from "../../../src/ui/page/quest";
import { TheMap } from "../../../src/ui/page/connections";
import { QuestRow } from "../../../src/ui/kit/rows";
import { fixtureDecor, fixtureLedger } from "../../../src/ui/thread/fixtures";
import { juno, registry, richDetails, richRoom } from "../page/scenes";

const member = { ...juno, displayName: "Juno II" };
const steer = { memberThreadId: member.threadId, at: new Date(2026, 10, 20, 14, 2).getTime(), excerpt: "use two columns" };
const fixture = richDetails.vault!;
function mount({ changed = true, removed = 1, behind = true } = {}) {
  const quest = { ...fixture.quest, members: [member], ...(behind ? { briefSteers: [steer] } : {}), ...(changed ? { pathChange: { added: 2, removed } } : {}) };
  const page = renderSlot({ component: () => <div className="tavern tv-page"><QuestPage detail={{ ...fixture, quest }} registry={registry} /></div> }, {}, {});
  const ledger = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ({ ...fixtureLedger, boardQuests: [quest] }), decor: () => fixtureDecor, registry: () => registry } });
  return { page, ledger, quest, close: () => { page.lifecycle.unmount(); ledger.lifecycle.unmount(); } };
}
const warning = /Juno II's brief predates your steer of.*14:02.*use two columns/;
it("shows the missing steer in the member card and Ledger, but not in Needs you", async () => {
  const f = mount();
  try {
    expect(f.page.getByText(warning).closest(".tv-party-identity")).not.toBeNull();
    const line = await f.ledger.findByText(warning);
    expect(line.closest("[data-attention-group='need']")).toBeNull();
  } finally { f.close(); }
});

it("shows the pending brief separately from the member's current work", async () => {
  const pending = { id: "brief_demo_pending", state: "blocked" as const, attempts: 1, receiptChecks: 5, ageMs: 65_000, createdAt: Date.now() - 65_000, firstLine: "Check the amended criteria" };
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, memberBriefs: [{ memberThreadId: member.threadId, name: "Juno II", doing: "Checking the first draft", pendingBrief: pending }] }),
    decor: () => fixtureDecor, registry: () => registry,
  } });
  try {
    const section = await slot.findByRole("region", { name: "Pending member briefs" });
    expect(section.textContent).toContain("Juno II");
    expect(section.textContent).toContain("Current work: Checking the first draft");
    expect(section.textContent).toContain("Pending: Check the amended criteria");
    expect(section.textContent).toContain("Blocked");
    expect(section.textContent).toContain("1 attempt");
    expect(section.textContent).toContain(pending.id);
    expect(section.querySelector("time")?.dateTime).toBe(new Date(pending.createdAt).toISOString());
    if (process.env.TAVERN_BRIEF_PATH_HARNESS === "1") process.stdout.write("PENDING_BRIEF=" + JSON.stringify(section.outerHTML) + "\n");
  } finally { slot.lifecycle.unmount(); }
});

it.each([true, false])("adds path changes beside the count only when present (%s)", changed => {
  const f = mount({ changed, behind: false });
  try {
    if (changed) expect(f.page.getByText("2 added, 1 removed since the greenlight")).not.toBeNull();
    else expect(f.page.queryByText(/since the greenlight/)).toBeNull();
    expect(f.page.queryByText(warning)).toBeNull();
  } finally { f.close(); }
});

it.runIf(process.env.TAVERN_BRIEF_PATH_HARNESS === "1")("renders the member card, Ledger line and quest path from fixtures", async () => {
  const f = mount({ removed: 0 });
  try {
    const line = await f.ledger.findByText(warning);
    const card = f.page.getByText(warning).closest("[data-member]")!;
    const path = f.page.getByText("2 added since the greenlight").parentElement!;
    const keeper = { ...richRoom.keepers[0]!, boardQuests: [f.quest] };
    const room = { ...richRoom, keepers: [keeper], asks: [] };
    const layout = renderSlot({ component: () => <div className="tavern tv-page"><QuestRow quest={f.quest} keeper={keeper} room={room} registry={registry} showKeeper /><TheMap room={room} registry={registry} /></div> }, {}, {});
    try {
      const board = layout.container.querySelector(".qrow")!;
      const map = layout.container.querySelector<HTMLElement>(`[data-node="quest:${f.quest.id}"]`)!.cloneNode(true) as HTMLElement;
      map.style.left = "0";
      map.style.top = "0";
      expect(board.textContent).toContain("2 added since the greenlight");
      expect(map.textContent).toContain("2 added since the greenlight");
      process.stdout.write("BRIEF_PATH=" + JSON.stringify({ party: card.outerHTML, ledger: line.outerHTML, path: path.outerHTML, board: board.outerHTML, map: map.outerHTML }) + "\n");
    } finally { layout.lifecycle.unmount(); }
  } finally { f.close(); }
});
