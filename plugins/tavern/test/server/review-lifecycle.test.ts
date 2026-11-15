// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "./host";

describe("queued lifecycle and safe configuration", () => {
  it("does not pair a new queued message with an earlier identical message already routed", async () => {
    const { runtime, k, time } = setup();
    await runtime.dispatch(dispatch049({ text: "same" }));
    k.route("lead", { kind: "aside", summary: "First message" });
    await runtime.dispatch(dispatch049({ text: "same", status: "active" }));
    const row = queued049("second", "same", time());
    runtime.queued(row);
    runtime.dispatched(row);
    expect(k.store.runtime("lead").pending).toHaveLength(1);
    expect(k.store.runtime("lead").pending[0]?.accepted).toBe(true);
    runtime.failed("lead");
    expect(k.store.runtime("lead").pending).toHaveLength(0);
  });
  it("pairs delayed queue creation by the outstanding inline receipt and clears cancellation", async () => {
    const { k, runtime, advance, time } = setup();
    await runtime.dispatch(dispatch049({ text: "Queued steer", status: "active" }));
    advance(60_000);
    const row = queued049("late", "Queued steer", time());
    runtime.queued(row);
    runtime.queued(row);
    expect(k.store.runtime("lead").pending).toHaveLength(1);
    runtime.cancelled(row);
    expect(k.store.runtime("lead").pending).toHaveLength(0);
    expect(k.store.events("lead").some((e) => e.type === "route.cancelled")).toBe(true);
  });
  it("does not expire a message that was queued while the preceding turn ended", async () => {
    const { k, runtime, time } = setup();
    await runtime.dispatch(dispatch049({ text: "Steer" }));
    const row = queued049("steer", "Steer", time());
    runtime.queued(row);
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "active" }));
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    expect(k.store.runtime("lead").pending).toHaveLength(1);
    runtime.dispatched(row);
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "active" }));
    runtime.updateThread(makeThreadResponse({ id: "lead", status: "idle" }));
    expect(k.store.runtime("lead").pending).toHaveLength(0);
  });
  it("expires an accepted message even when a failed attempt never became active", async () => {
    const { runtime, k } = setup();
    await runtime.dispatch(dispatch049({ text: "Steer" }));
    runtime.failed("lead");
    runtime.failed("lead");
    expect(k.store.runtime("lead").pending).toHaveLength(0);
    expect(k.store.events("lead").filter((e) => e.type === "reanchor.requested")).toHaveLength(1);
  });
  it("retains every role's tools when journal instruction assembly fails", async () => {
    const { k, runtime, port } = setup();
    k.bind("kid", "ranger", "otto", "project", {
      keeperThreadId: "lead",
      boardQuestId: null,
      waypointId: null,
      errand: true,
      title: "Read",
      brief: {
        outcome: "Read",
        mode: "make-it-work",
        outOfScope: "Writes",
        doneWhen: "Report",
        context: [],
        questions: [],
        timeboxMinutes: null,
      },
    });
    await runtime.prepareRegistry("project");
    port.instructions = () => {
      throw new Error("journal unavailable");
    };
    expect(
      runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).tools,
    ).toContain("tavern_route");
    expect(
      runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "kid" } })).tools,
    ).toEqual(["journal", "tavern_report"]);
    expect(
      runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "plain" } })).tools,
    ).toEqual(["journal"]);
  });
});
