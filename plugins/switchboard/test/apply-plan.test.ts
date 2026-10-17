import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGroups } from "../src/tree";
import { EMPTY_LAYOUT } from "../src/layout";
import { indexGroups, planDrop } from "../src/drop-plan";
import { applyPlan, type ApplyDeps } from "../src/apply-plan";
import { sidebarSection, sidebarThread } from "./fixtures";

const { notify, error } = vi.hoisted(() => ({ notify: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(notify, { error }) }));
afterEach(() => vi.clearAllMocks());

function fixture() {
  const index = indexGroups(buildGroups({ layout: EMPTY_LAYOUT, sections: [sidebarSection("s", "Section")], threads: [
    sidebarThread({ id: "a", displayTitle: "A", sectionId: "s", createdAt: 3 }),
    sidebarThread({ id: "b", displayTitle: "B", sectionId: "s", createdAt: 2 }),
    sidebarThread({ id: "p", displayTitle: "P", isPinned: true, pinnedAt: 10 }),
  ] }));
  const calls: string[] = [];
  const threads = {
    update: vi.fn(async (input: unknown) => { calls.push(`update:${(input as { threadId: string }).threadId}`); }),
    pin: vi.fn(async (input: unknown) => { calls.push(`pin:${(input as { threadId: string }).threadId}`); }),
    unpin: vi.fn(async (input: unknown) => { calls.push(`unpin:${(input as { threadId: string }).threadId}`); }),
    reorderPinned: vi.fn(async (input: unknown) => { calls.push(`reorder:${(input as { threadId: string }).threadId}`); }),
  };
  const layout = {
    setOrder: vi.fn((container: string) => { calls.push(`order:${container}`); }),
    setCollapsed: vi.fn((key: string) => { calls.push(`expand:${key}`); }),
    refetch: vi.fn(),
  };
  const announce = vi.fn();
  return { index, calls, threads, layout, announce,
    deps: { sdk: { threads }, layout, index, announce } as unknown as ApplyDeps };
}

function valid(plan: ReturnType<typeof planDrop>) {
  if (plan.ok !== true) throw new Error(`Expected valid move, got ${plan.ok}`);
  return plan;
}

describe("apply and undo", () => {
  it("expands first, writes optimistic orders, then SDK updates, and warns on parent changes", async () => {
    const f = fixture();
    const plan = valid(planDrop(f.index, ["a"], { kind: "row", threadId: "b", instruction: { kind: "child" } }));
    await applyPlan(plan, f.deps);
    expect(f.calls).toEqual(["expand:thread:b", "order:section:s", "order:parent:b", "update:a"]);
    expect(f.threads.update).toHaveBeenCalledWith({ threadId: "a", parentThreadId: "b" });
    expect(notify).toHaveBeenCalledWith(plan.summary, expect.objectContaining({
      description: "bb tells the parent's agent about this in 2 seconds. Undo before then and nothing is sent.",
      action: expect.objectContaining({ label: "Undo" }),
    }));
    expect(f.announce).toHaveBeenCalledWith(plan.summary);
    notify.mock.calls[0]![1].action.onClick();
    await vi.waitFor(() => expect(f.threads.update).toHaveBeenLastCalledWith({ threadId: "a", parentThreadId: null }));
    expect(f.layout.setOrder).toHaveBeenCalledWith("section:s", ["a", "b"]);
    expect(f.layout.setOrder).toHaveBeenCalledWith("parent:b", []);
  });

  it("stops after a rejected SDK update, reports the server error and refetches", async () => {
    const f = fixture();
    f.threads.update.mockRejectedValueOnce(new Error("parent_thread_invalid: archived"));
    const plan = valid(planDrop(f.index, ["a"], { kind: "row", threadId: "b", instruction: { kind: "child" } }));
    await applyPlan(plan, f.deps);
    expect(error).toHaveBeenCalledWith("parent_thread_invalid: archived");
    expect(f.layout.refetch).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it("undoes pinning, pinned neighbours and sections, without a parent warning", async () => {
    const f = fixture();
    const plan = valid(planDrop(f.index, ["a"], { kind: "group", key: "pinned" }));
    await applyPlan(plan, f.deps);
    expect(f.calls).toEqual(["expand:pinned", "order:section:s", "pin:a", "reorder:a"]);
    expect(f.threads.reorderPinned).toHaveBeenCalledWith({ threadId: "a", previousThreadId: null, nextThreadId: "p" });
    expect(notify.mock.calls[0]![1].description).toBeUndefined();
    notify.mock.calls[0]![1].action.onClick();
    await vi.waitFor(() => expect(f.threads.unpin).toHaveBeenCalledWith({ threadId: "a" }));
    expect(f.layout.setOrder).toHaveBeenCalledWith("section:s", ["a", "b"]);
  });
});
