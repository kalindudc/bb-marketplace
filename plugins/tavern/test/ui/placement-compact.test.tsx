import { renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PartyPicture } from "../../src/ui/page/room";
import { QuestPage } from "../../src/ui/page/quest";
import { MachinesPage } from "../../src/ui/page/machines";
import { detail, registry, room } from "../../src/ui/page/fixtures";
import { pendingPlacement, readyPlacement, blockedPlacement, placementHolds } from "./fixtures/placement";
import { machinesCatalog, previewFixture } from "./fixtures/machines";
import { settingsView } from "../../src/ui/page/fixtures-insights";
import { rpcContract } from "../../src/shared/contract";
import { settingsContract } from "../../src/shared/settings";
import { placementContract, placementPreviewInputSchema } from "../../src/shared/placement-rpc";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); window.localStorage.clear(); });
const smith = { ...detail.quest.members.find(m => m.classId === "smith")!, displayName: "Juno" };
const contract = { ...rpcContract, ...placementContract, ...settingsContract };

it.each([pendingPlacement, readyPlacement])("keeps ordinary $phase placement details out of the mini party picture", placement => {
  const component = () => <PartyPicture mini members={[{ ...smith, placement }]} registry={registry} quests={[]} />;
  const slot = renderSlot({ component }, {});
  slots.push(slot);
  expect(slot.container.querySelector('[data-part="PlacementFacts"]')).toBeNull();
  expect(slot.queryByText(placement.where.label)).toBeNull();
  expect(slot.queryByText(placement.posture.label)).toBeNull();
});
it.each([blockedPlacement, { ...pendingPlacement, phase: "blocked", hold: placementHolds.find(h => h.kind === "transfer-slots")! }])("keeps a mini blocker or hold actionable without full facts", async placement => {
  const retry = vi.fn(async () => ({ ok: true as const, message: null }));
  const component = () => <PartyPicture mini members={[{ ...smith, placement }]} registry={registry} quests={[]} />;
  const slot = renderSlot({ component }, {}, { experimental_rpcContract: contract, rpc: { placementRetry: retry } });
  slots.push(slot);
  const message = placement.hold?.message ?? placement.blocker!.message;
  expect(slot.getByText(message).closest('[role="status"]')).not.toBeNull();
  expect(slot.queryByText(placement.where.label)).toBeNull();
  expect(slot.queryByRole("link", { name: placement.rule!.label })).toBeNull();
  expect(slot.queryByText(placement.posture.label)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Retry placement for Juno" }));
  await waitFor(() => expect(retry).toHaveBeenCalledWith({ placementId: placement.placementId, generation: placement.generation }));
});
it("shows only one status line without Retry on each owned waypoint", async () => {
  const member = { ...smith, placement: blockedPlacement };
  const quest = { ...detail.quest, phase: "build" as const, members: [member], waypoints: ["w1", "w2", "w3"].map(id => ({ ...detail.quest.waypoints[0]!, id, dependsOn: [], state: "doing" as const, ownerMember: member })) };
  const component = () => <QuestPage detail={{ ...detail, quest }} registry={registry} />;
  const slot = renderSlot({ component }, {});
  slots.push(slot);
  const rows = slot.container.querySelectorAll<HTMLElement>(".tv-item");
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(within(row).getByText(blockedPlacement.blocker!.message).closest('[role="status"]')).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Retry placement for Juno" })).toBeNull();
    expect(within(row).queryByText(blockedPlacement.where.label)).toBeNull();
    expect(within(row).queryByText(blockedPlacement.posture.label)).toBeNull();
  }
  expect(slot.getAllByRole("button", { name: "Retry placement for Juno" })).toHaveLength(1);
});
it("does not list released placements under Where members run now", async () => {
  const active = { ...smith, threadId: "active", displayName: "Juno active", placement: readyPlacement };
  const released = { ...smith, threadId: "released", displayName: "Juno released", placement: { ...readyPlacement, placementId: "released", phase: "released" } };
  const currentRoom = { ...room, keepers: [{ ...room.keepers[0]!, boardQuests: [{ ...detail.quest, members: [active, released] }], errands: [] }], solos: [] };
  const slot = renderSlot({ component: MachinesPage }, {}, { pluginId: "tavern", experimental_rpcContract: contract, rpc: {
    room: () => currentRoom, registry: () => registry, settings: () => settingsView, placementCatalog: () => machinesCatalog,
    placementPreview: input => previewFixture(settingsView.effective.machines, placementPreviewInputSchema.parse(input)),
  } });
  slots.push(slot);
  await slot.findByRole("heading", { name: "Where members run now" });
  const section = slot.container.querySelector(".mx-members") as HTMLElement;
  expect(within(section).getByText("Juno active")).toBeTruthy();
  expect(within(section).queryByText("Juno released")).toBeNull();
});
