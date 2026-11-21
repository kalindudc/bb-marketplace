import { fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { LeadChainRows } from "../../../src/ui/thread/lead-chain-rows";
import type { BoardQuestSummary } from "../../../src/shared/contract";

const chain: NonNullable<BoardQuestSummary["leadChain"]> = {
  seat: { parentQuestId: "parent", parentTitle: "Service migration and rollback readiness", limits: { members: 4, rangers: 1, depth: 2 },
    parentDecisions: ["Plan v2"], authority: [{ kind: "merge", lane: "keeper" }, { kind: "cluster-write", lane: "user" }] },
  children: [{ linkId: "link", leadName: "Moss", waypointTitle: "Review the rollback outcome", checkState: "reported", state: "linked",
    quest: { id: "child", title: "Rollback readiness across two service environments", phase: "build", party: 2 } }],
  asks: [{ id: "ask", title: "Moss asks, for Wren’s migration: Approve the exact cluster change?", questId: "child" }],
};

it("links the parent and child and shows computed authority and read-only asks without answer controls", () => {
  const onOpenQuest = vi.fn();
  const slot = renderSlot({ component: LeadChainRows }, { chain, onOpenQuest });
  try {
    expect(slot.getByText("Hiring Keeper decides")).toBeTruthy();
    expect(slot.getByText("Plan v2")).toBeTruthy();
    expect(slot.getByText(/4 members, 1 Ranger, 2 layers/)).toBeTruthy();
    expect(slot.getByText("You decide")).toBeTruthy();
    expect(slot.getByText(/Cluster writes/)).toBeTruthy();
    expect(slot.getByText(/read-only/)).toBeTruthy();
    expect(slot.queryByRole("button", { name: /approve|answer/i })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /rollback readiness across/i }));
    expect(onOpenQuest).toHaveBeenCalledWith("child");
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_LAYOUT_HARNESS === "1")("renders the chain rows for measured layout", () => {
  const slot = renderSlot({ component: LeadChainRows }, { chain, onOpenQuest: () => {} });
  try { process.stdout.write("CH5_CHAIN=" + JSON.stringify(slot.container.innerHTML) + "\n"); }
  finally { slot.lifecycle.unmount(); }
});
