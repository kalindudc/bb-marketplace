import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { buildOverview } from "../src/collect";
import { summarizeThread } from "../src/collect-all";
import { threadSummarySchema } from "../src/contract";
import { createEditIndex } from "../src/edits";
import { incompleteWarning } from "../src/incomplete";

type Thread = ReturnType<typeof makeThreadResponse>;
const thread = (overrides: Partial<Thread>): Thread =>
  makeThreadResponse({ id: "thr_x", title: "X", environmentId: null, ...overrides });

describe("ThreadSummary visibility", () => {
  it("marks a hidden thread and leaves a visible one as it was", () => {
    const hidden = summarizeThread(thread({ id: "thr_h", visibility: "hidden", parentThreadId: "thr_p" }), 1, "thr_p");
    expect(hidden).toMatchObject({ id: "thr_h", hidden: true });
    expect(hidden).not.toHaveProperty("companionOf");
    const visible = summarizeThread(thread({ id: "thr_v", visibility: "visible" }), 0, "thr_v");
    expect(visible).not.toHaveProperty("hidden");
    expect(threadSummarySchema.parse(hidden)).toEqual(hidden);
    expect(threadSummarySchema.parse(visible)).toEqual(visible);
  });

  it("confirms a Flare companion only from its origin, its hidden visibility and its owner being its parent", () => {
    const base = {
      id: "thr_flares",
      title: "Flares: Build the panel",
      visibility: "hidden" as const,
      parentThreadId: "thr_p",
      lifecycleOwnerThreadId: "thr_p",
      originPluginId: "flare",
    };
    expect(summarizeThread(thread(base), 1, "thr_p")).toMatchObject({ hidden: true, companionOf: "thr_p" });
    // A title alone, another plugin, a visible thread or another owner is not proof.
    for (const changed of [
      { originPluginId: "tavern" },
      { originPluginId: null },
      { visibility: "visible" as const },
      { lifecycleOwnerThreadId: "thr_other" },
      { lifecycleOwnerThreadId: null },
    ])
      expect(summarizeThread(thread({ ...base, ...changed }), 1, "thr_p")).not.toHaveProperty("companionOf");
  });
});

describe("per-thread incomplete records", () => {
  it("flags each archived thread whose recorded edits may be incomplete, and keeps the warning for the page", async () => {
    const edit = (seq: number, threadId: string) => ({
      id: `evt_${threadId}_${seq}`,
      scope: { kind: "thread" },
      threadId,
      seq,
      createdAt: seq * 1000,
      type: "item/completed",
      data: {
        item: {
          type: "fileChange",
          id: `item_${seq}`,
          status: "completed",
          approvalStatus: null,
          changes: [{ path: `${threadId}.ts`, kind: "add" }],
        },
      },
    });
    const rows: Record<string, ReturnType<typeof edit>[]> = {
      thr_root: [edit(1, "thr_root")],
      thr_old: [edit(1, "thr_old")],
      thr_done: [edit(1, "thr_done")],
    };
    const read = ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) =>
      (rows[threadId] ?? []).filter((row) => afterSeq === undefined || row.seq > Number(afterSeq));
    const list = vi.fn(async (args: { threadId: string; afterSeq?: string }) => read(args));
    const archived = new Set<string>();
    const { sdk } = createFakeSdk({
      pluginId: "vantage",
      overrides: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              parentThreadId: threadId === "thr_root" ? null : "thr_root",
              archivedAt: archived.has(threadId) ? 5 : null,
              environmentId: null,
            }),
          experimental_listDescendants: async () => ({
            threads: [{ threadId: "thr_root", descendantIds: ["thr_old", "thr_done"] }],
          }),
          events: { list },
        },
        projects: { list: async () => [] },
        hosts: { list: async () => [] },
      },
    });
    const host = vi.fn(async (): Promise<never> => {
      throw new Error("unexpected host call");
    });
    const deps = { sdk, host, edits: createEditIndex(sdk) };
    const input = { target: { kind: "tree", threadId: "thr_root" }, scope: "branch", includeArchived: true } as const;
    await buildOverview(deps, input);
    archived.add("thr_old");
    archived.add("thr_done");
    // thr_old's final read fails, so its records may be incomplete; thr_done's succeeds.
    list.mockImplementation(async (args: { threadId: string; afterSeq?: string }) => {
      if (args.threadId === "thr_old") throw new Error("event store unavailable");
      return read(args);
    });
    const overview = await buildOverview(deps, input);
    const byId = new Map(overview.threads.map((summary) => [summary.id, summary]));
    expect(byId.get("thr_old")).toMatchObject({ archived: true, recordsIncomplete: true });
    expect(byId.get("thr_done")).not.toHaveProperty("recordsIncomplete");
    expect(byId.get("thr_root")).not.toHaveProperty("recordsIncomplete");
    expect(overview.warnings).toEqual([incompleteWarning(1, "tree")]);
    expect(overview.warnings[0]).toBe(
      "Recorded edits may be incomplete for 1 archived thread. Select Refresh to continue.",
    );
    for (const summary of overview.threads) expect(threadSummarySchema.parse(summary)).toEqual(summary);
    expect(host).not.toHaveBeenCalled();
  });

  it("words the page's warning as before", () => {
    expect(incompleteWarning(1, "tree")).toBe(
      "Recorded edits may be incomplete for 1 archived thread. Select Refresh to continue.",
    );
    expect(incompleteWarning(10, "all")).toBe(
      "Recorded edits may be incomplete for 10 archived threads. Open the thread tree and select Refresh.",
    );
  });
});
