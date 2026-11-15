// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { SkWidget, ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { clearThreadState } from "../../../src/ui/thread/state";

afterEach(() => { cleanup(); clearThreadState(); });
it("reserves the Keeper name in its skeleton", () => {
  const slot = renderSlot({ component: () => <SkWidget keeper shown /> }, {}, {});
  expect(slot.container.querySelector(".tw-id .tw-name")).not.toBeNull();
  slot.lifecycle.unmount();
});
it.each(["keeper", "member"] as const)("shows the %s display name in bold before its quest, retaining the tooltip", async role => {
  const decor = { ...fixtureDecor, member: { ...fixtureDecor.member!, role, displayName: "Wren II" }, ...(role === "member" ? { keeperView: null, boardQuest: fixtureDecor.keeperView!.boardQuests[0] } : {}) };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => decor, registry: () => fixtureRegistry } });
  await waitFor(() => expect(slot.container.querySelector(".tw-id .tw-name b")?.textContent).toBe("Wren II"));
  expect(slot.container.querySelector(".tw-id")?.getAttribute("title")).toContain(`${role === "keeper" ? "This thread: " : ""}Wren II, Keeper (lead)`);
  if (role === "keeper") expect(slot.container.querySelector(".tw-id .sr")?.textContent).toBe("Keeper, idle");
  expect(slot.container.querySelector(".tw-row")?.textContent).toMatch(/Wren II.*Vault/s);
  slot.lifecycle.unmount();
});
