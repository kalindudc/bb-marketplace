// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { readTale } from "../../src/server/tale";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { planInput, seedQuest, waypointEntry } from "./support";

const dbs: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture() {
  const f = setup();
  dbs.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", "Build", "Build");
  const optional = { ...planInput(q.id).waypoints[0]!, optional: true };
  f.k.plan("lead", { ...planInput(q.id), waypoints: [optional] });
  const entry = waypointEntry("maker", q.id);
  const get = f.port.get;
  f.port.get = id => ({ ...get(id), entries: id === "maker" ? [entry] : [] });
  f.port.linkedEntries = () => [entry];
  const wrap = (outcome = "Built it") => f.harness.behavior.invokeAgentTool(
    "tavern_wrap",
    { boardQuestId: q.id, outcome, left: "", next: [], skipped: [{ waypointId: "w1", reason: "Not needed" }] },
    { threadId: "lead" },
  ) as Promise<string>;
  const answer = (optionId: string) => {
    const ask = f.k.store.openAsks("lead", q.id).find(candidate => candidate.kind === "conclude")!;
    return f.runtime.answerAsk(ask.id, optionId, null, "page", true);
  };
  return { ...f, q, wrap, answer };
}

it("reports the summary and asks the user instead of concluding the quest", async () => {
  const f = await fixture();
  const reply = await f.wrap();
  expect(f.k.quest(f.q.id).phase).not.toBe("done");
  expect(f.k.store.events("lead").some(event => event.type === "quest.wrapped")).toBe(false);
  expect(readTale(f.k, f.k.summary(f.q.id))).toBeNull();
  expect(reply).toContain("The quest has NOT concluded");
  expect(reply).not.toContain("::tavern-tale");
  const ask = f.k.store.openAsks("lead", f.q.id).find(candidate => candidate.kind === "conclude")!;
  expect(ask.options.map(option => option.id)).toEqual(["conclude", "hold", "extensions"]);
  expect(ask.proceedAt).toBeNull();
  expect(reply).toContain(`::tavern-ask{id="${ask.id}"}`);
  expect(f.k.store.get("askMeta", ask.id)).toMatchObject({ wrapDraft: { outcome: "Built it" } });
});

it("concludes only after the user answers, then tells the tale", async () => {
  const f = await fixture();
  await f.wrap();
  await f.answer("conclude");
  expect(f.k.quest(f.q.id).phase).toBe("done");
  expect(f.k.store.events("lead").some(event => event.type === "quest.wrapped")).toBe(true);
  expect(readTale(f.k, f.k.summary(f.q.id))).toMatchObject({ outcome: "Built it" });
});

it.each(["hold", "extensions"] as const)("keeps the quest open and tells no tale on %s", async optionId => {
  const f = await fixture();
  await f.wrap();
  await f.answer(optionId);
  expect(f.k.quest(f.q.id).phase).not.toBe("done");
  expect(f.k.store.events("lead").some(event => event.type === "quest.wrapped")).toBe(false);
  expect(readTale(f.k, f.k.summary(f.q.id))).toBeNull();
  const ask = f.k.store.all("asks").find(candidate => candidate.boardQuestId === f.q.id && candidate.kind === "conclude")!;
  expect(ask.state).toBe("answered");
  const events = f.k.store.events("lead").map(event => event.type);
  expect(events).toContain(optionId === "hold" ? "quest.held" : "quest.extended");
});

it("refuses a second conclusion while the first answer is still open", async () => {
  const f = await fixture();
  const first = await f.wrap("First summary");
  await f.wrap("Second summary");
  const open = f.k.store.openAsks("lead", f.q.id).filter(candidate => candidate.kind === "conclude");
  expect(open).toHaveLength(1);
  expect(f.k.store.get("askMeta", open[0]!.id)).toMatchObject({ wrapDraft: { outcome: "Second summary" } });
  expect(first).toContain("The quest has NOT concluded");
});

it("retells an already returned quest without a new conclude ask", async () => {
  const f = await fixture();
  await f.wrap();
  await f.answer("conclude");
  const reply = await f.wrap("Told again");
  expect(reply).toContain("::tavern-tale");
  expect(f.k.store.openAsks("lead", f.q.id).filter(candidate => candidate.kind === "conclude")).toHaveLength(0);
  expect(readTale(f.k, f.k.summary(f.q.id))).toMatchObject({ outcome: "Told again" });
});
