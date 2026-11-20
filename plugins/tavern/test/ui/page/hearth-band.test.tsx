import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommonRoom } from "../../../src/ui/page/room";
import { motion } from "../../../src/ui/kit/motion";
import { withAttention } from "../attention-fixture";
import { richRoom, registry } from "./scenes";

function show() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const room = withAttention(richRoom);
  return renderSlot({ component: CommonRoom }, { room, registry });
}
afterEach(() => { cleanup(); motion.reset(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-motion"); });

it("draws the Keeper whose move is yours still, with no speech, and lets you open the thread", () => {
  const slot = show();
  const band = slot.container.querySelector(".tv-hearth-band")!;
  expect(band).toBeTruthy();
  const sprite = within(band as HTMLElement).getByRole("button", { name: /Open Wren's thread.*needs you/ });
  expect(sprite.dataset).toMatchObject({ mood: "waiting", pose: "still" });
  expect(band.querySelector(".twalk-speech")).toBeNull();
  fireEvent.click(sprite);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-wren" });
  expect(band.querySelector(".tv-hearth-summary")?.textContent).toMatch(/Wren is waiting at the table.*4 members on the road.*rest by the hearth/);
});

it("does not treat a visit's phase change or summary as a waiting Keeper", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const source = richRoom.keepers[0]!;
  const keeper = { ...source, boardQuests: source.boardQuests.map(q => ({ ...q, move: { who: "keeper" as const, text: "Preparing the next step" } })) };
  const item = { id: "change", kind: "quest-changed" as const, title: "Vault cutover", action: "Open", since: 1, seen: false, keeperThreadId: keeper.member.threadId, questId: keeper.boardQuests[0]!.id };
  const room = { ...richRoom, asks: [], keepers: [keeper], attention: { items: [item], needYou: 0, new: 1, heldByYou: 0, decided: 1 }, sinceVisit: { quests: [], changedQuests: 0, summaries: 0, decided: 1 } };
  const slot = renderSlot({ component: CommonRoom }, { room, registry });
  const band = within(slot.getByRole("group", { name: "Status" }));
  expect(band.getByRole("button", { name: /Open Wren's thread: idle/ })).toBeTruthy();
  expect(band.queryByRole("button", { name: /decided/ })).toBeNull();
  expect(slot.getByRole("button", { name: "1 call decided for you" })).toBeTruthy();
});

it("leaves every sprite and both count areas still under reduced motion", () => {
  document.documentElement.dataset.motion = "reduced";
  const slot = show();
  const band = slot.container.querySelector(".tv-hearth-band")!;
  const getSprites = () => [...band.querySelectorAll<HTMLButtonElement>("[data-page-scene-actor] button")];
  const sprites = getSprites();
  expect(sprites.length).toBeGreaterThan(2);
  expect(sprites.every(sprite => sprite.dataset.pose === "still")).toBe(true);
  expect(band.querySelectorAll(".tv-hero[class*='mo-'], .tv-facts [class*='mo-'], .tv-facts[class*='mo-']")).toHaveLength(0);
  expect(motion.snapshot().running).toHaveLength(0);
});
