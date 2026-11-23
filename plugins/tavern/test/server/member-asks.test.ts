// @vitest-environment node
import { expect, it } from "vitest";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";

it("projects only open user asks for the targeted member and clears them through the user answer RPC", async () => {
  const f = setup();
  try {
    const q = await seedQuest(f.k, "lead", "Atlas", "Atlas");
    for (const [threadId, waypointId] of [["maker", "w1"], ["other", null]] as const)
      f.k.bind(threadId, "smith", null, "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId, errand: false, title: "Survey",
        brief: { outcome: "Survey", doneWhen: "Read", mode: "make-it-work", outOfScope: "Send", context: [], questions: [], timeboxMinutes: null } });
    const ask = f.k.ask("lead", { boardQuestId: q.id, question: "Choose the source?", kind: "decision", effect: { type: "decision" }, why: "Only you know", meanwhile: "Survey", holds: ["w1"],
      options: [{ id: "a", label: "Survey A", detail: "", recommended: true }, { id: "b", label: "Survey B", detail: "", recommended: false }] });
    const current = f.k.store.get("asks", ask.id)!;
    for (const [id, effect] of [
      ["keeper-retry", { type: "retry-brief", threadId: "maker", briefId: "brief-1" }],
      ["keeper-block", { type: "scope-blocker", memberThreadId: "maker" }],
    ] as const) f.k.store.put("asks", id, { ...current, id, effect, kind: "blocker" });
    registerRpc(f.bb, f.runtime);
    const decor = (threadId: string) => f.harness.invokeRpc("decor", { threadId });
    const answer = { askId: ask.id, optionId: "a", note: null, via: "banner" };
    expect(await decor("maker")).toMatchObject({ memberAsks: [expect.objectContaining({ id: ask.id })] });
    expect(await decor("other")).toMatchObject({ memberAsks: [] });
    expect(await f.harness.invokeRpc("ledger", { threadId: "lead" })).toMatchObject({ keeperBlocks: [{ id: "keeper-retry" }, { id: "keeper-block" }] });
    await expect(f.harness.invokeRpc("answerAsk", answer, { experimental_caller: { kind: "plugin", pluginId: "fixture-agent" } })).rejects.toThrow();
    await f.harness.invokeRpc("answerAsk", answer);
    await f.runtime.settleWakes();
    expect(f.k.store.get("asks", ask.id)?.answer).toMatchObject({ by: "user", via: "banner" });
    expect(await decor("maker")).toMatchObject({ memberAsks: [] });
    expect(await decor("lead")).toMatchObject({ keeperView: { openAsks: [] } });
  } finally {
    f.k.store.db.close();
  }
});
