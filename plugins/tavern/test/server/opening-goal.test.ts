// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makePluginAgentConfigurationContext } from "./host";
import { setup } from "./runtime-fixture";
import { registerTools } from "../../src/server/tools";

const goal = "@Keeper Build a small crossword helper";
const mentionContext = 'Context for @Keeper (resolved by plugin "tavern"):\n\nYou are a Keeper thread. Your role and journal instructions are supplied by Tavern in your instructions.';
function opening() {
  const ctx = dispatch049({ threadId: "new-keeper", status: "pending", submission: { pluginId: "tavern", data: { classId: "keeper" } } });
  ctx.input.blocks = [
    { type: "text", text: goal, mentions: [{ start: 0, end: 7, resource: { kind: "plugin", pluginId: "tavern", itemId: "classes:keeper", label: "Keeper" } }] },
    { type: "text", text: mentionContext, mentions: [], visibility: "agent-only" },
  ];
  ctx.input.text = goal + "\n" + mentionContext;
  return ctx;
}
const hint = "If this opening message contains a concrete user goal, route it with tavern_route kind new-quest";

describe("Keeper opening goals", () => {
  it("records only visible user words, with an explicit opening-goal hint in first configure and tick", async () => {
    const f = setup();
    expect(await f.runtime.dispatch(opening())).toEqual({ action: "proceed" });
    const pending = f.k.store.runtime("new-keeper").pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe(goal);
    expect(f.k.store.events("new-keeper").find(event => event.type === "user.message")?.text).toBe(goal);
    const config = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "new-keeper" } }));
    expect(config.instructions).toContain(hint);
    expect(config.instructions).toContain(goal);
    expect(config.instructions).not.toContain(mentionContext);
    f.advance(60_001);
    f.k.reanchor("new-keeper", "first tick");
    await f.runtime.tick("new-keeper");
    const tick = f.harness.inspection.sdk.callsTo("threads.send").find(call => JSON.stringify(call.args).includes("[Tavern tick]"));
    expect(JSON.stringify(tick?.args)).toContain(hint);
    const route = f.k.route("new-keeper", { kind: "new-quest", summary: "Build the crossword helper", notes: [] });
    expect(route.userText).toBe(goal);
    const quest = await f.k.openQuest("new-keeper", "Crossword helper", "Crossword");
    expect(f.k.store.get("routes", route.id)?.boardQuestId).toBe(quest.id);
  });

  it("strips mention context in queued, dispatched and drained passes without making duplicate receipts", async () => {
    const f = setup();
    await f.runtime.dispatch(opening());
    f.k.route("new-keeper", { kind: "new-quest", summary: "Build", notes: [] });
    f.advance(6000);
    const row = { ...queued049("follow-up", "Keep it offline", f.time()), threadId: "new-keeper", content: [
      { type: "text" as const, text: "Keep it offline", mentions: [] },
      { type: "text" as const, text: mentionContext, mentions: [], visibility: "agent-only" as const },
    ] };
    f.runtime.queued(row);
    await f.runtime.dispatch(dispatch049({ threadId: "new-keeper", rows: [row] }));
    f.runtime.dispatched(row);
    expect(f.k.store.runtime("new-keeper").pending.map(message => message.text)).toEqual(["Keep it offline"]);
    const route = f.k.route("new-keeper", { kind: "aside", summary: "Offline preference", notes: [] });
    expect(route.userText).toBe("Keep it offline");
    expect(f.k.store.events("new-keeper").filter(event => event.type === "user.message" && event.text === "Keep it offline")).toHaveLength(1);
  });

  it("keeps a human's literal mention-context text instead of stripping visible words by regex", async () => {
    const f = setup();
    const ctx = opening();
    ctx.input.blocks = [{ type: "text", text: goal + "\n" + mentionContext, mentions: [] }, ...ctx.input.blocks.slice(1)];
    await f.runtime.dispatch(ctx);
    expect(f.k.store.runtime("new-keeper").pending[0]!.text).toBe(goal + "\n" + mentionContext);
  });

  it("bounds the opening hint without losing the original goal", async () => {
    const f = setup();
    const ctx = opening();
    const text = goal.repeat(1000);
    ctx.input.blocks = [{ type: "text", text, mentions: [] }, ...ctx.input.blocks.slice(1)];
    await f.runtime.dispatch(ctx);
    expect(f.k.store.runtime("new-keeper").openingGoal?.text).toBe(text);
    const instructions = f.k.openingGoalHint("new-keeper")!;
    expect(instructions.length).toBeLessThan(2000);
    expect(instructions).toContain("More: read the original opening user message");
  });

  it("requires the route prompt to distinguish goals from durable notes", () => {
    const f = setup();
    registerTools(f.bb, f.runtime);
    const route = f.harness.inspection.registrations.agentTools.find(tool => tool.name === "tavern_route") as { description?: string };
    expect(route.description).toContain("The goal itself is never a note");
  });
});
