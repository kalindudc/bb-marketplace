// @vitest-environment node
import { describe, expect, it } from "vitest";
import { setup } from "./runtime-fixture";
import { dispatch049, queued049 } from "./dispatch-fixture";
import { makePluginAgentConfigurationContext } from "./host";
import { classSelectionOnly } from "../../src/server/dispatch";

function selected(text = "Keeper", suffix = "") {
  return [{ type: "text" as const, text: text + suffix, mentions: [{ start: 0, end: text.length, resource: { kind: "plugin" as const, pluginId: "tavern", itemId: "classes:keeper", label: "Keeper" } }] }, { type: "text" as const, text: "Context: you are a Keeper and should follow Tavern rules", mentions: [], visibility: "agent-only" as const }];
}
function opening(suffix = "") {
  const ctx = dispatch049({ threadId: "new-keeper", status: "pending", submission: { pluginId: "tavern", data: { classId: "keeper", route: "new-quest" } } });
  ctx.input.blocks = selected("Keeper", suffix);
  ctx.input.text = ctx.input.blocks.map(block => block.type === "text" ? block.text : "").join("\n");
  return ctx;
}

describe("class selection is setup, not a goal", () => {
  it("recognizes native class mention ranges, not literal words or agent-only context", () => {
    expect(classSelectionOnly(selected(), "keeper")).toBe(true);
    expect(classSelectionOnly(selected("Keeper", " Build labelCount"), "keeper")).toBe(false);
    const [visible, ...context] = selected("Keeper", " Build labelCount");
    const repeated = [{ ...visible!, mentions: [...visible!.mentions, ...visible!.mentions] }, ...context];
    expect(classSelectionOnly(repeated, "keeper")).toBe(false);
    expect(classSelectionOnly([...selected(), { type: "image", url: "https://example.test/input.png" }], "keeper")).toBe(false);
    expect(classSelectionOnly([{ type: "text", text: "Keeper", mentions: [] }], "keeper")).toBe(false);
    expect(classSelectionOnly(selected(), "smith")).toBe(false);
    expect(classSelectionOnly([{ type: "text", text: "Keeper", mentions: [{ start: -1, end: 20, resource: { kind: "plugin", pluginId: "tavern", itemId: "classes:keeper", label: "Keeper" } }] }], "keeper")).toBe(false);
  });

  it("binds B as a Keeper, gives it no opening goal, and refuses a placeholder", async () => {
    const f = setup();
    expect(await f.runtime.dispatch(opening())).toEqual({ action: "proceed" });
    expect(f.k.member("new-keeper")?.classId).toBe("keeper");
    expect(f.k.store.runtime("new-keeper").openingGoal).toBeUndefined();
    const instructions = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "new-keeper" } })).instructions!;
    expect(instructions).toContain("No goal was supplied");
    expect(() => f.k.route("new-keeper", { kind: "new-quest", summary: "Opening goal", notes: [] })).toThrow(/class selection.*not a goal/i);
    await expect(f.k.openQuest("new-keeper", "Keeper goal (awaiting detail)", "Keeper")).rejects.toThrow(/unbound new-quest.*user/i);
    expect(f.k.store.all("quests")).toHaveLength(0);
    f.k.route("new-keeper", { kind: "aside", summary: "Selected Keeper; ask for the goal", notes: [] });
    expect(f.k.store.runtime("new-keeper").pending).toHaveLength(0);
    expect(f.k.store.all("routes")[0]).toMatchObject({ kind: "aside", classSelectionOnly: true });
  });

  it("accepts a real goal after the class-only start exactly once", async () => {
    const f = setup();
    await f.runtime.dispatch(opening());
    f.k.route("new-keeper", { kind: "aside", summary: "Select Keeper", notes: [] });
    f.k.receiveUser("new-keeper", "Build labelCount with tests");
    f.k.route("new-keeper", { kind: "new-quest", summary: "Build labelCount", notes: [] });
    await f.k.openQuest("new-keeper", "Build labelCount", "Labels");
    await expect(f.k.openQuest("new-keeper", "Another placeholder", "Again")).rejects.toThrow(/unbound new-quest.*user/i);
    expect(f.k.store.all("quests")).toHaveLength(1);
  });

  it("keeps a mention-plus-task intact and opens its real quest", async () => {
    const f = setup(); const ctx = opening(" Build labelCount with tests");
    await f.runtime.dispatch(ctx);
    expect(f.k.store.runtime("new-keeper").pending[0]?.text).toBe("Keeper Build labelCount with tests");
    const route = f.k.route("new-keeper", { kind: "new-quest", summary: "Build labelCount", notes: [] });
    const q = await f.k.openQuest("new-keeper", "Build labelCount", "Labels");
    expect(f.k.store.get("routes", route.id)?.boardQuestId).toBe(q.id);
  });

  it("retains the selection-only classification across queued/dispatched retries", async () => {
    const f = setup();
    const row = { ...queued049("class-only", "Keeper", f.time()), threadId: "lead", content: selected() };
    f.runtime.queued(row);
    f.runtime.dispatched(row);
    f.runtime.dispatched(row);
    expect(f.k.store.runtime("lead").pending).toHaveLength(1);
    expect(() => f.k.route("lead", { kind: "new-quest", summary: "Placeholder", notes: [] })).toThrow(/class selection.*not a goal/i);
    f.k.route("lead", { kind: "aside", summary: "Select Keeper", notes: [] });
    expect(f.k.store.all("routes")).toHaveLength(1);
  });

  it("answers a question or greeting without granting quest-creation authority", async () => {
    for (const [text, kind] of [["Hello", "aside"], ["What can you do?", "question"]] as const) {
      const f = setup(); f.k.receiveUser("lead", text);
      f.k.route("lead", { kind, summary: "Answer conversationally", notes: [] });
      await expect(f.k.openQuest("lead", "Goal awaiting detail", "Goal")).rejects.toThrow(/unbound new-quest.*user/i);
    }
  });

  it("requires a genuine accepted native receipt, not merely a route-shaped record", async () => {
    const f = setup();
    await expect(f.k.openQuest("lead", "Unsourced", "No")).rejects.toThrow(/unbound new-quest.*user/i);
    f.k.receiveUser("lead", "Build labelCount");
    const route = f.k.route("lead", { kind: "new-quest", summary: "Build", notes: [] });
    f.k.store.put("routes", route.id, { ...route, sourceMessageId: "missing-receipt" });
    await expect(f.k.openQuest("lead", "Forged", "No")).rejects.toThrow(/user receipt/i);
    expect(f.k.store.all("quests")).toHaveLength(0);
  });

  it("refuses a genuine receipt belonging to another Keeper", async () => {
    const f = setup();
    f.k.bind("other", "keeper", "wren", "project");
    f.k.receiveUser("other", "Build something else");
    const foreign = f.k.route("other", { kind: "new-quest", summary: "Other goal", notes: [] });
    f.k.receiveUser("lead", "Build labelCount");
    const route = f.k.route("lead", { kind: "new-quest", summary: "Build", notes: [] });
    f.k.store.put("routes", route.id, { ...route, sourceMessageId: foreign.sourceMessageId });
    await expect(f.k.openQuest("lead", "Wrong owner", "No")).rejects.toThrow(/user receipt/i);
    expect(f.k.store.all("quests")).toHaveLength(0);
  });

  it("does not let two concurrent opens consume the same source goal", async () => {
    const f = setup(); f.k.receiveUser("lead", "Build labelCount");
    f.k.route("lead", { kind: "new-quest", summary: "Build", notes: [] });
    const results = await Promise.allSettled([f.k.openQuest("lead", "First", "One"), f.k.openQuest("lead", "Second", "Two")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.k.store.all("quests")).toHaveLength(1);
  });
});
