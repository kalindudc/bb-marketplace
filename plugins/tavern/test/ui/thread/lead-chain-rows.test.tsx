import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { LeadChainRows } from "../../../src/ui/thread/lead-chain-rows";
import type { BoardQuestSummary } from "../../../src/shared/contract";

const chain: NonNullable<BoardQuestSummary["leadChain"]> = {
  seat: { parentQuestId: "parent", parentKeeperThreadId: "lead", parentTitle: "Service migration and rollback readiness", limits: { members: 4, rangers: 1, depth: 2 },
    parentDecisions: ["Plan v2"], authority: [{ kind: "merge", lane: "keeper" }, { kind: "cluster-write", lane: "user" }] },
  children: [{ linkId: "link", leadName: "Moss", waypointTitle: "Review the rollback outcome", state: "linked", current: true,
    quest: { id: "child", title: "Rollback readiness across two service environments", phase: "build" } }],
};

it("links the parent and child and shows computed authority without repeating asks", () => {
  const slot = renderSlot({ component: LeadChainRows }, { chain });
  try {
    expect(slot.getByText("Hiring Keeper decides")).toBeTruthy();
    expect(slot.getByText("Plan v2")).toBeTruthy();
    expect(slot.getByText(/4 members, 1 Ranger/)).toBeTruthy();
    expect(slot.queryByText(/2 layers/)).toBeNull();
    expect(slot.getByText("You decide")).toBeTruthy();
    expect(slot.getByText(/Cluster writes/)).toBeTruthy();
    expect(slot.queryByText(/read-only/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Side quest of Service migration/i }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "quest/parent" } });
    expect(slot.queryByRole("button", { name: /approve|answer/i })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /rollback readiness across/i }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "tavern", options: { subPath: "quest/child" } });
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the chain rows for measured layout", () => {
  const slot = renderSlot({ component: LeadChainRows }, { chain });
  try { process.stdout.write("CH5_CHAIN=" + JSON.stringify(slot.container.innerHTML) + "\n"); }
  finally { slot.lifecycle.unmount(); }
});
