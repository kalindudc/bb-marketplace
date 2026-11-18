import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../../src/shared/contract";
import { PhaseStrip, PhaseMark } from "../../../src/ui/kit";
import { QuestRoad, recordedStop } from "../../../src/ui/page/quest-road";
import { registerPageSurfaces } from "../../../src/ui/page/register";
import { registerRpc } from "../../../src/server/rpc";
import { setup } from "../../server/runtime-fixture";
import { seedQuest } from "../../server/support";
import { railDetail } from "./quest-rail-fixture";
import { registry } from "./scenes";

afterEach(cleanup);
it("M3 gives closing the shared Return step and waiting wording on all strips", () => {
  const slot = render(<><PhaseStrip phase="closing" /><PhaseMark phase="closing" /><QuestRoad phase="closing" /></>);
  for (const image of slot.getAllByRole("img")) expect(image.getAttribute("aria-label")).toContain("Waiting for you to conclude, 5 of 5");
  const step = within(slot.getByRole("list")).getByRole("listitem", { name: /Return, current/ });
  expect(step.getAttribute("aria-current")).toBe("step");
});
it.each(["held", "closing"] as const)("M3 puts a stop from %s on a recorded road step", phase => {
  const base = { at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "user" as const }, text: "Recorded" };
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const }, events: [{ ...base, id: 800, type: "quest.held", data: { phase: { from: "greenlight", to: "held" } } }, { ...base, id: 801, type: "quest.stopping", data: { phase: { from: phase, to: "stopping" } } }] };
  const stop = recordedStop(detail);
  expect(stop.position).toBe(phase === "held" ? "greenlight" : "closing");
  const slot = render(<QuestRoad phase="stopped" stoppedAt={stop.position} proven={stop.proven} />);
  expect(slot.getByRole("listitem", { name: phase === "held" ? /Form the party, stopped here/ : /Return, stopped here/ })).toBeTruthy();
});
it("M4 renders Stopped by you from a real stop and RPC projection", async () => {
  const f = setup({}, process.cwd()); registerRpc(f.bb, f.runtime); const q = await seedQuest(f.k, "lead", "Actual stop", "Actual stop");
  await f.runtime.stop(q.id);
  const detail = await f.harness.invokeRpc("boardQuest", { id: q.id });
  const room = await f.harness.invokeRpc("room", {});
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: `quest/${q.id}` }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { registry: () => structuredClone(registry), room: () => room, boardQuest: () => detail, ledger: () => f.harness.invokeRpc("ledger", { threadId: "lead" }) } as Partial<PluginRpcTestHandlers<typeof rpcContract>> as PluginRpcTestHandlers<typeof rpcContract> });
  try {
    const heading = await slot.findByRole("heading", { level: 1, name: "Actual stop" });
    expect(within(heading.closest("header")!).getByText("Stopped by you")).toBeTruthy();
  } finally { slot.lifecycle.unmount(); }
});
