// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { KeeperRow, PartyPicture, QuestMap } from "../../../src/ui/kit";
import { NeedsYouQueue } from "../../../src/ui/page/asks";
import { fixtureDecor, fixtureRegistry, fixtureQuest, fixtureMember, fixtureAsk } from "../../../src/ui/thread/fixtures";
import { richRoom } from "../page/scenes";

afterEach(cleanup);
const member = { ...fixtureMember, displayName: "Wren II" };
const quest = { ...fixtureQuest, members: [member], waypoints: fixtureQuest.waypoints.map((w, i) => i === 0 ? { ...w, ownerMember: member } : w) };
const keeper = { ...richRoom.keepers[0]!, member, boardQuests: [quest], openAsks: [fixtureAsk] };
const room = { ...richRoom, keepers: [keeper], asks: [fixtureAsk] };
it("keeps the numeralled name in room rows, the Ledger's party picture and asks", () => {
  const slot = renderSlot({ component: () => <><KeeperRow keeper={keeper} room={room} registry={fixtureRegistry} /><PartyPicture members={[member]} registry={fixtureRegistry} /><NeedsYouQueue room={room} registry={fixtureRegistry} /></> }, {}, { rpc: { decor: () => fixtureDecor } });
  expect(slot.container.querySelector(".krow")?.textContent).toContain("Wren II");
  expect(slot.container.querySelector(".party")?.textContent).toContain("Wren II");
  expect(slot.container.querySelector(".tv-asks")?.textContent).toContain("Wren II asks");
  slot.lifecycle.unmount();
});
it("keeps the numeralled name on the map's live owner", async () => {
  const slot = renderSlot({ component: () => <QuestMap quest={quest} mode="live" /> }, {}, { rpc: { registry: () => fixtureRegistry } });
  await waitFor(() => expect(slot.container.querySelector(".o-member")?.textContent).toContain("Wren II"));
  slot.lifecycle.unmount();
});
