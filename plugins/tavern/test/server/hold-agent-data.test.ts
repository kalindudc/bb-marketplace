// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TavernEvent } from "../../src/shared/schema";
import { agentData } from "../../src/server/agent-data";
import { setup } from "./runtime-fixture";

function facts() {
  const f = setup();
  const loop = (f.runtime as unknown as { loop: { fact(event: TavernEvent): { text: string } } }).loop;
  return { ...f, fact: (type: string, data: Record<string, unknown>) => {
    f.k.store.event(f.time(), "lead", null, type, "An event", data);
    const event = f.k.store.events("lead", 0, 1)[0]!;
    return { event, text: loop.fact(event).text };
  } };
}
describe("Agent hold-control projection", () => {
  it.each(["checker-handoff.held", "checker-handoff.released"])("hides the control id from a %s tick fact", type => {
    const f = facts();
    const { text } = f.fact(type, { holdId: "private-hold", routeId: "route", via: "page", askId: "ask" });
    expect(text).not.toContain("private-hold");
    expect(text).toBe(`Fact (data): ${JSON.stringify({ type, text: "An event", data: { routeId: "route", via: "page", askId: "ask" } })}`);
  });
  it.each(["promise.due", "report.filed", "ask.answered", "scope.widened", "arbitrary-other"])("leaves every field byte-identical for a non-hold %s fact", type => {
    const f = facts();
    const data = { holdId: "application-data", releaseHoldId: "not-a-control", checkerHandoffHold: { id: "also-application-data" }, nested: [null, true, 42, "quote \\ \""] };
    const { event, text } = f.fact(type, data);
    expect(text).toBe(`Fact (data): ${JSON.stringify({ type, text: event.text, data: event.data })}`);
    expect(agentData(data, type)).toBe(data);
  });
  it("projects only known hold, ask and event controls without changing source words", () => {
    const data = { id: "quest", checkerHandoffHold: { id: "private-hold", reason: "Keep the original words", createdAt: 7 }, asks: [{ id: "ask", kind: "blocker", keeperThreadId: "lead", options: [], releaseHoldId: "private-hold" }], events: [{ type: "checker-handoff.held", data: { holdId: "private-hold", routeId: "route" } }], other: { holdId: "application-data", releaseHoldId: "application-data" } };
    expect(agentData(data)).toEqual({ id: "quest", checkerHandoffHold: { reason: "Keep the original words", createdAt: 7 }, asks: [{ id: "ask", kind: "blocker", keeperThreadId: "lead", options: [] }], events: [{ type: "checker-handoff.held", data: { routeId: "route" } }], other: data.other });
  });
});
