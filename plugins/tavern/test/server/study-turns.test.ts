// @vitest-environment node
import { expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { turnKind, type NativeEvents } from "../../src/server/study-turns";

type NativeEvent = NativeEvents[number];
const row = (seq: number, type: string, data: unknown, turnId?: string) =>
  ({ seq, id: String(seq), type, data, createdAt: 1_000_000 + seq, ...(turnId && { scope: { kind: "turn", turnId } }) }) as NativeEvent;
const request = (seq: number, kind: string, data: Record<string, unknown>) => row(seq, "client/turn/requested", { requestId: kind, ...data });
const usage = (seq: number, turnId: string, total: number, last = total) => {
  const tokens = (n: number) => ({ inputTokens: n, cachedInputTokens: n * 2, outputTokens: n * 3 });
  return row(seq, "thread/tokenUsage/updated", { tokenUsage: { total: tokens(total), last: tokens(last) } }, turnId);
};

it("uses accepted input, not a later steer, and separates missing usage from zero", async () => {
  const events = [
    request(1, "tick", { originPluginId: "tavern", input: [{ type: "text", text: "[Tavern tick] private" }] }),
    row(2, "turn/started", {}, "a"), row(3, "turn/input/accepted", { clientRequestId: "tick" }, "a"),
    usage(4, "a", 3),
    request(5, "steer", { initiator: "user", input: [] }), row(6, "turn/input/accepted", { clientRequestId: "steer" }, "a"),
    usage(7, "a", 5, 2), row(8, "turn/completed", { status: "completed" }, "a"),
    row(9, "turn/started", {}, "b"), row(10, "turn/completed", { status: "failed" }, "b"),
    row(11, "turn/started", {}, "c"), usage(12, "c", 1), row(13, "turn/completed", { status: "completed" }, "c"),
  ] as NativeEvents;
  const { runtime } = setup({ threads: { events: { list: async ({ afterSeq }: { afterSeq: string }) => events.filter(event => event.seq > Number(afterSeq)) } } });
  await runtime.studyTurns.observe("lead", 13);
  await runtime.studyTurns.observe("lead", 13);
  expect(runtime.study.page(0).events).toMatchObject([
    { type: "turn.usage", data: { turnId: "a", turnKind: "tick", input: 5, cached: 10, output: 15 } },
    { type: "turn.usage", data: { turnId: "b", turnKind: "other", input: null, cached: null, output: null } },
    { type: "turn.usage", data: { turnId: "c", turnKind: "other", input: 1, cached: 2, output: 3 } },
  ]);
  expect(JSON.stringify(runtime.study.page(0))).not.toContain("private");
});

it("does not mistake user text for a system checkpoint and identifies member outcomes by subject", () => {
  const input: Parameters<typeof turnKind>[0]["input"] = [{ type: "text", text: "Memory checkpoint before compaction", mentions: [] }];
  expect(turnKind({ input, initiator: "user", senderThreadId: null }, "tavern", () => true)).toBe("user-message");
  expect(turnKind({ input, initiator: "system", senderThreadId: null }, "tavern", () => false)).toBe("memory-checkpoint");
  const child = { input: [], initiator: "system", senderThreadId: null, systemMessageKind: "child-completed", systemMessageSubject: { kind: "thread", threadId: "child", threadName: "A member" } } satisfies Parameters<typeof turnKind>[0];
  expect(turnKind(child, "tavern", id => id === "child")).toBe("member-report");
  expect(turnKind(child, "tavern", () => false)).toBe("other");
});
