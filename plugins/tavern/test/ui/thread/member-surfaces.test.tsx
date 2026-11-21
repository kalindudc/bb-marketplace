import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { type ThreadIdentity, identityLabel } from "../../../src/shared/identity";
import { QuestPage } from "../../../src/ui/page/quest";
import { TheMap } from "../../../src/ui/page/connections";
import { CommonRoom } from "../../../src/ui/page/room";
import { describeEvent, eventContext } from "../../../src/ui/page/model";
import { fixtureDecor } from "../../../src/ui/thread/fixtures";
import { juno, moss, registry, richDetails, richRoom, wren } from "../page/scenes";

const member = { ...juno, threadId: "thr_juno", displayName: "Juno II" };
const lead = { ...wren, displayName: "Wren II" };
const detail = { ...richDetails.vault!, quest: { ...richDetails.vault!.quest, members: [member] } };
const other = { ...member, threadId: "thr_other", keeperThreadId: moss.threadId, boardQuestId: "other-vault" };
const room = { ...richRoom, asks: [], keepers: [
  { ...richRoom.keepers[0]!, member: lead, boardQuests: [detail.quest], errands: [] },
  { ...richRoom.keepers[1]!, member: moss, boardQuests: [{ ...detail.quest, id: "other-vault", keeperThreadId: moss.threadId, members: [] }], errands: [{ ...other, boardQuestId: null, errand: true, title: "Read" }] },
], solos: [] };
const identity: ThreadIdentity = { threadId: member.threadId, name: member.displayName, role: "member", classId: "smith", className: "Smith", characterId: "juno", keeper: { threadId: lead.threadId, name: lead.displayName, sameParty: true }, relation: "child of this thread", life: "live", canOpen: true };
const short = identityLabel(member.threadId, identity);
const qualified = identityLabel(member.threadId, { ...identity, keeper: { ...identity.keeper!, sameParty: false } });

it("uses the journal label for a party row and qualifies the same member on the cross-Keeper map and in room events", () => {
  const party = renderSlot({ component: () => <div className="tavern tv-page"><QuestPage detail={detail} room={room} registry={registry} /></div> }, {}, {});
  const map = renderSlot({ component: () => <div className="tavern tv-page"><TheMap room={room} registry={registry} /></div> }, {}, {});
  try {
    expect(party.container.querySelector(".tv-party-identity .mi-name b")?.textContent).toBe(short);
    const node = map.container.querySelector(`[data-node="member:${member.threadId}"] .tv-mn-t`)!;
    expect(node.querySelector("b")?.textContent).toBe(short);
    expect(node.querySelector("span")?.textContent).toBe("Wren II's Smith (builder) · working");
    expect(map.getByRole("button", { name: /^Open Juno II's thread\..*Moss's Smith/ })).toBeTruthy();
    const event = { id: 1, at: 1, keeperThreadId: lead.threadId, boardQuestId: detail.quest.id, type: "member.hired", text: "Hired Juno II", data: { memberThreadId: member.threadId }, actor: { kind: "tavern" as const } };
    expect(describeEvent(event, eventContext(room, registry))?.head).toBe(`hired ${qualified}`);
  } finally { party.lifecycle.unmount(); map.lifecycle.unmount(); }
});

it.each(["archived", "unstaffed"] as const)("leaves the sole visible party's name bare with an %s Keeper", kind => {
  const singleParty = { ...room, keepers: [room.keepers[0]!, { ...room.keepers[1]!, archived: kind === "archived", errands: kind === "archived" ? room.keepers[1]!.errands : [] }] };
  const map = renderSlot({ component: () => <div className="tavern tv-page"><TheMap room={singleParty} registry={registry} /></div> }, {}, {});
  try {
    const node = map.container.querySelector(`[data-node="member:${member.threadId}"] .tv-mn-t`)!;
    expect(node.querySelector("b")?.textContent).toBe(short);
    expect(node.querySelector("span")?.textContent).toBe("Smith (builder) · working");
    expect(eventContext(singleParty, registry).memberName(member)).toBe(short);
  } finally { map.lifecycle.unmount(); }
});

it.each([false, true])("qualifies common-room history only when the visible rows name two parties (%s)", crossParty => {
  const hired = (m: typeof member, id: number) => ({ id, at: id, keeperThreadId: m.keeperThreadId, boardQuestId: m.boardQuestId, type: "member.hired", text: "Hired Juno II", data: { memberThreadId: m.threadId }, actor: { kind: "tavern" as const } });
  const recent = crossParty ? [hired(member, 1), hired({ ...other, boardQuestId: null }, 2)] : [hired(member, 1)];
  const slot = renderSlot({ component: () => <CommonRoom room={{ ...room, recent }} registry={registry} /> }, {}, {});
  try {
    const history = slot.container.querySelector("#rm-events")!;
    expect(history.textContent).toContain(crossParty ? `hired ${qualified}` : `hired ${short}`);
    if (!crossParty) expect(history.textContent).not.toContain(qualified);
  } finally { slot.lifecycle.unmount(); }
});

function widget(lastReportedWaypointId: string | null) {
  const decor = { ...fixtureDecor, threadId: member.threadId, characters: false, member: { ...member, waypointId: "w1" }, keeper: lead, keeperView: null, boardQuest: detail.quest, lastReportedWaypointId };
  return renderSlot({ component: ThreadWidget }, { threadId: member.threadId }, { rpc: { decor: () => decor, registry: () => registry } });
}

it.each(["w3", "w1", null])("shows the member label and a separate reported waypoint only when it differs (%s)", async lastReportedWaypointId => {
  const slot = widget(lastReportedWaypointId);
  try {
    await slot.findByText(short);
    expect(slot.container.querySelector(".tw-where")?.textContent).toMatch(/waypoint 1/i);
    const comparison = slot.container.querySelector(".tw-waypoints");
    if (lastReportedWaypointId === "w3") expect(comparison?.textContent).toContain("Last report: waypoint 3");
    else expect(comparison).toBeNull();
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_NAME_SURFACES_HARNESS === "1")("renders the party row, map node and widget for the layout harness", async () => {
  const party = renderSlot({ component: () => <div className="tavern tv-page"><QuestPage detail={detail} room={room} registry={registry} /></div> }, {}, {});
  const map = renderSlot({ component: () => <div className="tavern tv-page"><TheMap room={room} registry={registry} /></div> }, {}, {});
  const slot = widget("w3");
  try {
    await slot.findByText("Last report: waypoint 3");
    const partyRow = party.container.querySelector<HTMLElement>(`[data-member="${member.threadId}"]`)!;
    const mapNode = map.container.querySelector<HTMLElement>(`[data-node="member:${member.threadId}"]`)!.cloneNode(true) as HTMLElement;
    mapNode.style.left = "0";
    mapNode.style.top = "0";
    process.stdout.write("NAME_SURFACES=" + JSON.stringify({ party: partyRow.outerHTML, map: mapNode.outerHTML, widget: slot.container.innerHTML }) + "\n");
  } finally { party.lifecycle.unmount(); map.lifecycle.unmount(); slot.lifecycle.unmount(); }
});
