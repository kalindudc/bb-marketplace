// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { readStatus, statusInput } from "../../src/server/status";
import { boundedData, instructions } from "../../src/server/instructions";

const brief = {
  outcome: "Find two lunch options and ask which one the user prefers",
  mode: "make-it-work" as const,
  outOfScope: "Do not book or send anything",
  doneWhen: "Two options with evidence",
  context: [],
  questions: [],
  timeboxMinutes: null,
};
function helper(
  f: ReturnType<typeof setup>,
  id: string,
  keeper = "lead",
  errand = true,
) {
  return f.k.bind(id, "wanderer", "otto", "project", {
    keeperThreadId: keeper,
    boardQuestId: null,
    waypointId: null,
    errand,
    title: `Lunch options ${id}`,
    displayName: `Otto ${id}`,
    brief,
  });
}
function page(f: ReturnType<typeof setup>, offset = 0, limit = 3) {
  return readStatus(
    f.runtime,
    "lead",
    statusInput.parse({ section: "errands", offset, limit }),
  ) as {
    inFlight: {
      memberThreadId: string;
      owner: { threadId: string; name: string };
      ask: string | null;
      state: string;
      released: unknown;
    }[];
    recent: { memberThreadId: string; state: string; released: unknown }[];
    total: number;
    inFlightCount: number;
    recentCount: number;
    nextOffset: number | null;
  };
}
describe("Keeper errands status", () => {
  it("reads in-flight and recent errands with their owner, original ask and state, isolated to this Keeper", () => {
    const f = setup(),
      working = helper(f, "working"),
      done = helper(f, "done"),
      failed = helper(f, "failed");
    f.k.store.put("members", done.threadId, { ...done, state: "done" });
    f.k.store.put("members", failed.threadId, { ...failed, state: "failed" });
    helper(f, "not-an-errand", "lead", false);
    f.k.bind("other", "keeper", "wren", "project");
    helper(f, "other-helper", "other");
    const result = page(f);
    expect(result).toMatchObject({
      total: 3,
      inFlightCount: 1,
      recentCount: 2,
      nextOffset: null,
    });
    expect(result.inFlight).toMatchObject([
      {
        memberThreadId: working.threadId,
        owner: { threadId: working.threadId, name: "Otto working" },
        ask: brief.outcome,
        state: "idle",
      },
    ]);
    expect(result.recent.map((row) => row.state).sort()).toEqual([
      "done",
      "failed",
    ]);
    expect(JSON.stringify(result)).not.toContain("other-helper");
  });
  it("pages active errands first and then newest recent errands without omissions", () => {
    const f = setup();
    for (const id of ["old", "middle", "new"]) {
      const m = helper(f, id);
      f.k.store.put("members", id, { ...m, state: "done" });
      f.advance(1000);
    }
    helper(f, "active");
    const first = page(f, 0, 2),
      second = page(f, first.nextOffset!, 2);
    expect(first.inFlight.map((row) => row.memberThreadId)).toEqual(["active"]);
    expect(first.recent.map((row) => row.memberThreadId)).toEqual(["new"]);
    expect(second.recent.map((row) => row.memberThreadId)).toEqual([
      "middle",
      "old",
    ]);
    expect(second.nextOffset).toBeNull();
  });
  it("keeps a released helper in recent history even before its member state refreshes", () => {
    const f = setup();
    helper(f, "released");
    f.k.store.patch("released", {
      released: { reason: "No longer needed", decisionId: "release-decision" },
    });
    expect(page(f)).toMatchObject({
      inFlightCount: 0,
      recentCount: 1,
      inFlight: [],
      recent: [
        {
          memberThreadId: "released",
          released: { reason: "No longer needed" },
        },
      ],
    });
  });
  it("names the errands read-back section when its block or the whole configure ledger is cut", () => {
    const f = setup();
    for (let i = 0; i < 12; i++) helper(f, `long-${i}`);
    expect(f.k.restatement("lead")).toContain(
      "more errands; call tavern_status section=errands",
    );
    const configured = instructions(
      "Keeper",
      undefined,
      "",
      "Ledger and brief:\n```text\n" + "x".repeat(40000) + "\n```",
    );
    expect(configured).toContain("call tavern_status section=errands");
    expect(Buffer.byteLength(configured)).toBeLessThanOrEqual(32000);
    expect(boundedData("short", 100)).toBe("short");
  });
});
