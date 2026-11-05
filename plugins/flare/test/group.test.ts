// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FlareDto, RunDto } from "../src/contract";
import { groupFlares } from "../src/ui/group";

const flare = (id: string, createdAt: number, overrides: Partial<FlareDto> = {}): FlareDto => ({
  id,
  threadId: "thr_a",
  kind: "finding",
  title: id,
  body: "",
  urgent: false,
  source: "tool",
  createdAt,
  runId: null,
  fromChild: null,
  pushed: false,
  forwarded: false,
  ...overrides,
});

const run = (id: string, startedAt: number, endedAt: number | null): RunDto => ({ id, startedAt, endedAt, outcome: endedAt === null ? "running" : "done", error: null, prompt: null });

describe("groupFlares", () => {
  it("puts each flare under its turn, newest turn first and each turn in order", () => {
    const sections = groupFlares({
      runs: [run("run_2", 200, null), run("run_1", 100, 150)],
      flares: [flare("c", 210, { runId: "run_2" }), flare("b", 120, { runId: "run_1" }), flare("a", 110, { runId: "run_1" })],
    });
    expect(sections.map((section) => [section.key, section.flares.map((item) => item.id)])).toEqual([
      ["run_2", ["c"]],
      ["run_1", ["a", "b"]],
    ]);
  });

  it("places a child thread's flare in the parent's turn that was running, and the rest outside a turn", () => {
    const child = { threadId: "thr_child", title: "Child" };
    const sections = groupFlares({
      runs: [run("run_1", 100, 150)],
      flares: [flare("late", 400, { fromChild: child, runId: "run_child" }), flare("during", 120, { fromChild: child, runId: "run_child" })],
    });
    expect(sections.map((section) => [section.key, section.flares.map((item) => item.id)])).toEqual([
      ["outside", ["late"]],
      ["run_1", ["during"]],
    ]);
  });
});
