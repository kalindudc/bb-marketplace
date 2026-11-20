// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { NeedsYouQueue } from "../../../src/ui/page/asks";
import type { AttentionItem } from "../../../src/shared/attention";
import { fixtureMember, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { richRoom } from "./scenes";

const title = "Prepare a deliberately long quest title that can still be read in full";
const item: AttentionItem = {
  id: "hand-back", kind: "hand-back", questId: fixtureQuest.id, keeperThreadId: fixtureMember.threadId,
  detail: { text: "The long quote. ".repeat(45).trim(), sourceMessageId: "origin", validUntil: null },
  since: 1, title: "Send the draft", action: "Done", seen: false,
  who: { state: "archived", startedAt: 1, questTitle: title },
};
function show(overrides: Partial<AttentionItem> = {}) {
  return renderSlot({ component: NeedsYouQueue }, { registry: fixtureRegistry, room: {
    ...richRoom, keepers: [{ member: fixtureMember, boardQuests: [{ ...fixtureQuest, title }], errands: [], status: "listening" }],
    asks: [], attention: { items: [{ ...item, ...overrides }], needYou: 1, heldByYou: 0, new: 0, counts: { ask: 0, hold: 0, "hand-back": 0, rule: 0, stopped: 1 } },
  } });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("keeps the quest title and older hand-back fallback, shows the stopped fact and labels its actions", () => {
  const slot = show();
  slot.container.querySelector("details")!.open = true;
  expect(slot.getByText("Wren handed this back to you.")).toBeTruthy();
  expect(slot.getByText("Archived")).toBeTruthy();
  expect(slot.getByText(/reads replies only if it runs again/i)).toBeTruthy();
  expect(slot.getByRole("button", { name: title }).closest("[data-ask]")).toBeTruthy();
  for (const [name, effect] of [["Done", /marks it handled and tells Wren/i], ["Reply", /opens Wren's thread with this quoted/i]] as const) {
    const button = slot.getByRole("button", { name });
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toMatch(effect);
  }
});
it("offers Read all only when cut and expands the original quote in place", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) { return this.textContent?.includes("long quote") ? 80 : 24; });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(24);
  const clipped = show();
  clipped.container.querySelector("details")!.open = true;
  const read = clipped.getByRole("button", { name: "Read all" });
  fireEvent.click(read);
  expect(clipped.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  expect(clipped.getByText(/The long quote/)).toBeTruthy();
  cleanup();
  const short = show({ detail: { ...item.detail!, text: "Short quote" } });
  short.container.querySelector("details")!.open = true;
  expect(short.queryByRole("button", { name: "Read all" })).toBeNull();
});
