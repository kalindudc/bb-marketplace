// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDetail, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";
import { QuestMapCard } from "../../../src/ui/thread/cards";
import { layoutWaypoints } from "../../../src/ui/kit";

afterEach(cleanup);
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));

async function card(detail = fixtureDetail) {
  await loadPluginApp(definePluginApp(registerThreadSurfaces));
  const slot = renderSlot({ component: () => <QuestMapCard detail={detail} version={1} /> } as never, {}, { composer: { scope: { kind: "thread", threadId: "keeper-1" } }, rpc: { registry: () => fixtureRegistry, answerAsk: () => ({ ok: true }) } });
  fireEvent.click(slot.getByRole("button", { name: "Quest map" }));
  await waitFor(() => expect(slot.container.querySelector(".qmap .qsvg")).not.toBeNull());
  return slot;
}

describe("the quest map's readability", () => {
  it("stretches the plan map across the greenlight card, and leaves the live map alone", async () => {
    const plan = await card();
    expect(plan.container.querySelector(".qmap .qsvg")!.closest(".qmap")!.classList.contains("stretch")).toBe(true);
    plan.lifecycle.unmount();
    const sealed = { ...fixtureDetail, quest: { ...fixtureDetail.quest, greenlitVersion: 1 } };
    const live = await card(sealed);
    expect(live.container.querySelector(".qmap .qsvg")!.closest(".qmap")!.classList.contains("stretch")).toBe(false);
    live.lifecycle.unmount();
  });

  it("names the current journal state in the plan card's waypoint list", async () => {
    const detail = structuredClone(fixtureDetail);
    detail.quest.waypoints[0]!.state = "reported";
    const plan = await card(detail);
    try {
      expect(plan.getAllByText("Waiting for a check").length).toBeGreaterThan(0);
    } finally { plan.lifecycle.unmount(); }
  });

  it("steps lanes 96 px apart, room for a three-line title before the next row", () => {
    const w = (id: string, dependsOn: string[] = []) => ({ ...fixtureDetail.quest.waypoints[0]!, id, dependsOn });
    const nodes = layoutWaypoints([w("a"), w("b")] as Parameters<typeof layoutWaypoints>[0]);
    expect(nodes.map((n) => n.lane)).toEqual([0, 1]);
    expect(Math.abs(nodes[1]!.y - nodes[0]!.y)).toBe(96);
  });

  it("writes the longer title clamp and the translucent label background in the kit's CSS", () => {
    expect(readFileSync("src/ui/kit/tavern.css", "utf8")).toContain(".tavern .map-label b.clamp { display: -webkit-box; -webkit-line-clamp: 3;");
    const rule = readFileSync("src/ui/kit/components.css", "utf8").match(/\.tavern \.map-label b, \.tavern \.map-label \.o \{[^}]*\}/)![0];
    expect(rule).toContain("color-mix(");
    expect(rule).toContain("text-shadow:");
  });
});
