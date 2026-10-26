import { describe, expect, it } from "vitest";
import { rpcContract, type ThreadInfo, type TicketDetail } from "../src/contract";
import type { PlannerView } from "../src/planner-view";
import { ANY, changedTags, projectTag } from "../src/rpc-tags";
import { contract } from "../src/ui/contract-client";

const tags = (method: keyof typeof rpcContract, input: unknown, output: unknown = null) => (rpcContract[method] as { tags?(input: unknown, output: unknown): readonly string[] }).tags?.(input, output);
const invalidates = (method: keyof typeof rpcContract, input: unknown, output: unknown = null) => (rpcContract[method] as { invalidates?(input: unknown, output: unknown): readonly string[] }).invalidates?.(input, output);

describe("the page's contract", () => {
  it("has every method of the server's, with the same tags", () => {
    expect(Object.keys(contract).sort()).toEqual(Object.keys(rpcContract).sort());
    for (const [method, entry] of Object.entries(rpcContract)) {
      const copy = contract[method as keyof typeof contract] as typeof entry;
      expect(copy.tags, method).toBe(entry.tags);
      expect(copy.invalidates, method).toBe(entry.invalidates);
    }
  });

  it("passes every value through, for the server to check", async () => {
    expect(await contract.control.input["~standard"].validate({ anything: true })).toEqual({ value: { anything: true } });
  });
});

describe("tags", () => {
  it("refreshes a change to a project's reads and the reads of no one project, and a change outside any project only the latter", () => {
    expect(changedTags("csv")).toEqual([projectTag("csv"), ANY]);
    expect(changedTags(null)).toEqual([ANY]);
  });

  it("tags a live project read with its project and leaves a rewound one untagged", () => {
    expect(tags("project", { slug: "csv" })).toEqual(["project:csv"]);
    expect(tags("project", { slug: "csv", at: 12 })).toEqual([]);
    expect(tags("insights", { slug: "csv", at: 12 })).toEqual([]);
    expect(tags("ticket", { key: "CSV-1" }, { slug: "csv" } as TicketDetail)).toEqual(["project:csv"]);
    expect(tags("ticket", { key: "CSV-1", at: 4 }, { slug: "csv" } as TicketDetail)).toEqual([]);
  });

  it("tags a thread's reads by its project once it has one, and by ANY before", () => {
    expect(tags("threadInfo", { threadId: "thr_1" }, null)).toEqual([ANY]);
    expect(tags("threadInfo", { threadId: "thr_1" }, { role: "planner", slug: null, key: null, state: "planning" } satisfies ThreadInfo)).toEqual([ANY]);
    expect(tags("threadInfo", { threadId: "thr_1" }, { role: "worker", slug: "csv", key: "CSV-1", state: "working" } satisfies ThreadInfo)).toEqual(["project:csv"]);
    expect(tags("plannerView", { threadId: "thr_1" }, { slug: "csv" } as PlannerView)).toEqual(["project:csv"]);
  });

  it("has each change refresh the project it changed", () => {
    expect(invalidates("control", { slug: "csv" })).toEqual(["project:csv", ANY]);
    expect(invalidates("ticketAction", { key: "CSV-1" }, { slug: "csv" } as TicketDetail)).toEqual(["project:csv", ANY]);
    expect(invalidates("messagePlanner", { threadId: "thr_1" }, null)).toEqual([ANY]);
    expect(invalidates("startPlanning", {})).toEqual([ANY]);
  });
});
