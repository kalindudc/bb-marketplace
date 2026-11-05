// @vitest-environment node
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { CompanionMarks } from "../src/marks";
import { RENDER_MARKER, renderPrompt } from "../src/provider";

type Row = { seq: number; type: string; scope: { kind: string; turnId?: string }; data: Record<string, unknown> };

const requested = (seq: number, requestId: string, text: string): Row => ({
  seq,
  type: "client/turn/requested",
  scope: { kind: "thread" },
  data: { requestId, input: [{ type: "text", text, mentions: [] }] },
});
const accepted = (seq: number, requestId: string, turnId: string): Row => ({ seq, type: "turn/input/accepted", scope: { kind: "turn", turnId }, data: { clientRequestId: requestId } });

describe("CompanionMarks", () => {
  it("maps each companion turn to the flare its prompt named, reading only new events each time", async () => {
    const events: Row[] = [requested(1, "r1", renderPrompt("fl_a", "A")), accepted(2, "r1", "t1"), requested(3, "r2", `${RENDER_MARKER}legacy`), accepted(4, "r2", "t2")];
    const { bb, harness } = createFakePluginHost({
      pluginId: "flare",
      sdk: {
        threads: {
          events: { list: async ({ afterSeq }: { afterSeq?: string }) => events.filter((row) => row.seq > Number(afterSeq ?? 0)) },
        },
      },
    });
    const marks = new CompanionMarks(bb);
    expect(Object.fromEntries(await marks.read("thr_c"))).toEqual({ t1: "fl_a" });
    events.push(requested(5, "r3", renderPrompt("fl_b", "B")), accepted(6, "r3", "t3"));
    expect(Object.fromEntries(await marks.read("thr_c"))).toEqual({ t1: "fl_a", t3: "fl_b" });
    const calls = harness.inspection.sdk.callsTo("threads.events.list").map((args) => (args[0] as { afterSeq: string }).afterSeq);
    expect(calls).toEqual(["0", "4"]);
  });
});
