// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { registerCli } from "../../src/server/cli";
import { isNewsEvent } from "../../src/server/news";
import { registerRpc } from "../../src/server/rpc";
import { registerTools } from "../../src/server/tools";
import { setup } from "./runtime-fixture";
import { planInput, putQuestFixture, seedQuest, waypointEntry } from "./support";
import { roomSchema } from "../../src/shared/contract";
import { graphFor } from "../../src/ui/page/model";
import { registry } from "../../src/ui/page/fixtures";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const from = { title: "Restore the lantern", short: "Lantern" };
const to = { title: "Repair the signal lamp", short: "Signal lamp" };

async function fixture() {
  const f = setup();
  databases.push(f.k.store.db);
  registerTools(f.bb, f.runtime);
  registerRpc(f.bb, f.runtime);
  const q = await seedQuest(f.k, "lead", from.title, from.short);
  const tool = (threadId = "lead", names = to) => f.harness.behavior.invokeAgentTool("tavern_quest", { op: "rename", boardQuestId: q.id, ...names }, { threadId });
  const user = (names = to) => f.harness.invokeRpc("renameBoardQuest", { id: q.id, ...names });
  const events = () => f.k.store.events("lead").filter(e => e.type === "quest.renamed");
  return { ...f, q, tool, user, events };
}

it("renames in place, records one attributed transition, and exposes it in history and status", async () => {
  const f = await fixture();
  f.advance(10);
  expect(JSON.parse(String(await f.tool()))).toMatchObject(to);
  expect(f.k.quest(f.q.id)).toEqual({ ...f.q, ...to, updatedAt: f.time() });
  expect(f.events()).toEqual([expect.objectContaining({ at: f.time(), boardQuestId: f.q.id, actor: { kind: "agent", threadId: "lead" }, data: { from, to } })]);
  expect(await f.harness.invokeRpc("boardQuest", { id: f.q.id })).toMatchObject({ quest: to, events: expect.arrayContaining([expect.objectContaining({ type: "quest.renamed" })]) });
  const status = async (section: string) => JSON.parse(String(await f.harness.behavior.invokeAgentTool("tavern_status", { section, boardQuestId: f.q.id, limit: 10 }, { threadId: "lead" })));
  expect(await status("summary")).toMatchObject({ quests: [expect.objectContaining(to)] });
  expect((await status("events")).events).toContainEqual(expect.objectContaining({ type: "quest.renamed", data: { from, to } }));
  await f.tool();
  expect(f.events()).toHaveLength(1);
});

it("requires an explicit rename op and an existing quest id, while keeping the old opening input", async () => {
  const f = await fixture();
  const open = (input: object, threadId = "lead") => f.harness.behavior.invokeAgentTool("tavern_quest", input, { threadId });
  await expect(open({ op: "rename", ...to })).rejects.toThrow(/boardQuestId/);
  await expect(open({ boardQuestId: f.q.id, ...to })).rejects.toThrow(/boardQuestId/);
  f.k.bind("other", "keeper", null, "project");
  f.k.receiveUser("other", "Check the harbor bell");
  f.k.route("other", { kind: "new-quest", summary: "Check the bell", notes: [] });
  const legacy = await open({ title: "Check the harbor bell", short: "Bell" }, "other");
  expect(JSON.parse(String(legacy))).toMatchObject({ title: "Check the harbor bell", short: "Bell", phase: "scout" });
  expect(f.k.quest(f.q.id)).toMatchObject(from);
  expect(f.events()).toHaveLength(0);
});

it("refuses another Keeper, a party member, and plugin callers of the user RPC", async () => {
  const f = await fixture();
  f.k.bind("other", "keeper", "bram", "project");
  f.k.bind("maker", "smith", "vale", "project", { keeperThreadId: "lead", boardQuestId: f.q.id, waypointId: null, errand: false, title: "A task",
    brief: { outcome: "Draft", mode: "make-it-work", doneWhen: "Tests pass", outOfScope: "Deployment", context: [], questions: [], timeboxMinutes: null } });
  await expect(f.tool("other")).rejects.toThrow(/own board quests/);
  await expect(f.tool("maker")).rejects.toThrow(/Only a Tavern keeper/);
  await expect(f.harness.invokeRpc("renameBoardQuest", { id: f.q.id, ...to }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/explicit client action/);
  expect(f.k.quest(f.q.id)).toMatchObject(from);
  expect(f.events()).toHaveLength(0);
});

it.each([{ title: "", short: "Lamp" }, { title: "   ", short: "Lamp" }, { title: "a".repeat(201), short: "Lamp" }, { title: "Lamp", short: "" }, { title: "Lamp", short: "a".repeat(41) }])("refuses invalid names at both boundaries", async names => {
  const f = await fixture();
  await expect(f.tool("lead", names)).rejects.toThrow();
  await expect(f.user(names)).rejects.toThrow();
  expect(f.k.quest(f.q.id)).toMatchObject(from);
  expect(f.events()).toHaveLength(0);
});

it("renames at the exact limits from the user RPC and refuses the cellar", async () => {
  const f = await fixture();
  const names = { title: "a".repeat(200), short: "b".repeat(40) };
  await f.user(names);
  expect(f.events()).toEqual([expect.objectContaining({ actor: { kind: "user" }, data: expect.objectContaining({ from, to: names }) })]);
  expect(isNewsEvent(f.events()[0]!, "lead")).toBe(true);
  putQuestFixture(f.k.store, f.q.id, { ...f.k.quest(f.q.id), phase: "done", endedAt: f.time(), archivedAt: f.time() });
  await expect(f.tool()).rejects.toThrow(/archived/);
  await expect(f.user()).rejects.toThrow(/archived/);
  expect(f.events()).toHaveLength(1);
});

it("holds Keeper renames during Closing time and Stop all, but allows them during pause", async () => {
  const f = await fixture();
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "pause" }] });
  await expect(f.tool()).rejects.toThrow(/closed/i);
  f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, { kind: "explicit-return", threadId: null, refId: null });
  const config = f.runtime.config();
  const paused = vi.spyOn(f.runtime, "config").mockReturnValue({ ...config, tavern: { ...config.tavern, paused: true } });
  await f.tool();
  paused.mockRestore();
  await f.runtime.stopAll.stop({ kind: "user" });
  await expect(f.tool("lead", from)).rejects.toThrow(/stopped/i);
  expect(f.k.quest(f.q.id)).toMatchObject(to);
  expect(f.events()).toHaveLength(1);
  await f.user(from);
  expect(f.k.quest(f.q.id)).toMatchObject(from);
  expect(f.runtime.stopAll.snapshot().state).toBe("stopped");
});

it("allows a single-quest rename that Closing time permits while a message is pending", async () => {
  const f = await fixture();
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "drafts-ready" }], allowWatched: true });
  await f.tool();
  f.k.resetRoutes("lead");
  f.k.receiveUser("lead", "I have an unanswered question");
  await f.tool("lead", from);
  expect(f.k.quest(f.q.id)).toMatchObject(from);
  expect(f.events()).toHaveLength(2);
});

it.each([
  ["greenlight", "Form the party for Repair the signal lamp, plan v1?"],
  ["legacy greenlight", "Form the party for Repair the signal lamp, plan v1?"],
  ["conclude", "Can “Repair the signal lamp” conclude?"],
  ["close-early", "Can “Repair the signal lamp” close early?"],
] as const)("shows the new name in every live view of a %s ask", async (kind, question) => {
  const f = await fixture();
  const effect = kind === "legacy greenlight" ? "greenlight" : kind;
  if (effect !== "close-early") {
    const plan = planInput(f.q.id);
    f.k.plan("lead", { ...plan, waypoints: [{ ...plan.waypoints[0]!, check: "none" }] });
    if (kind === "conclude") {
      f.k.answerAsk(f.k.store.openAsks("lead", f.q.id)[0]!.id, "approve", null, "page", "user");
      f.port.linkedEntries = () => [waypointEntry("maker", f.q.id)];
    }
  }
  if (effect !== "greenlight") await f.runtime.proposeWrap("lead", f.q.id, "The lamp is ready", "");
  const ask = f.k.store.openAsks("lead", f.q.id).find(a => a.effect?.type === effect)!;
  expect(ask?.question).toContain(from.title);
  if (kind === "legacy greenlight") {
    const { effect: _, ...legacy } = ask;
    f.k.store.put("asks", ask.id, legacy);
    f.k.store.put("askMeta", ask.id, { planVersion: 1 });
  }
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "drafts-ready" }] });
  await f.user();
  const row = expect.objectContaining({ id: ask.id, question });
  const room = roomSchema.parse(await f.harness.invokeRpc("room", {}));
  expect(room.asks).toContainEqual(row);
  expect(room.attention?.items).toContainEqual(expect.objectContaining({ id: ask.id, title: question }));
  expect(graphFor(room, registry).nodes).toContainEqual(expect.objectContaining({ id: `ask:${ask.id}`, label: question }));
  expect(await f.harness.invokeRpc("ledger", { threadId: "lead" })).toMatchObject({ asks: expect.arrayContaining([row]) });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ keeperView: { openAsks: expect.arrayContaining([row]) } });
  expect(await f.harness.invokeRpc("boardQuest", { id: f.q.id })).toMatchObject({
    asks: expect.arrayContaining([row]), quest: { move: { text: expect.stringContaining(question) } },
  });
  expect(await f.harness.invokeRpc("awayDigest", {})).toMatchObject({ asks: expect.arrayContaining([expect.objectContaining({ ask: row })]) });
  registerCli(f.bb, f.runtime);
  const cli = await f.harness.inspection.registrations.cli[0]!.run(["status", "--thread", "lead"], {});
  expect(JSON.parse(cli.stdout ?? "")).toMatchObject({ asks: expect.arrayContaining([row]) });
});

it("keeps the stable quest id on a new durable memory note", async () => {
  const f = await fixture();
  await f.tool();
  const saved = await f.runtime.memory.tool({ op: "save", boardQuestId: f.q.id, note: {
    kind: "finding", title: "Replacement switch", body: "Use a weatherproof switch.", tags: [],
    source: { kind: "command", value: "npm test" }, appliesTo: { kind: "date", value: "2026-11-22" },
  } }, "lead", "project", new AbortController().signal);
  expect(saved).toMatchObject({ note: { quest: f.q.id, title: "Replacement switch" } });
});

it("projects the new name in the room, thread decor, Ledger, attention, summaries and away digest", async () => {
  const f = await fixture();
  f.k.postSummary("lead", { boardQuestId: f.q.id, title: "Found the broken switch", body: "The switch can be replaced.", links: [] });
  f.runtime.away.store.close({ revision: 0, until: f.time() + 60_000, quests: [{ questId: f.q.id, endState: "drafts-ready" }] });
  f.k.store.event(f.time(), "lead", f.q.id, "report.filed", "Draft ready");
  f.runtime.away.store.finish(f.runtime.away.store.snapshot().window!.id, { kind: "explicit-return", threadId: null, refId: null });
  const hold = f.k.setQuestHeld(f.q.id, true, { kind: "user" });
  expect(hold.phase).toBe("held");
  await f.user();
  expect(await f.harness.invokeRpc("room", {})).toMatchObject({ keepers: [expect.objectContaining({ boardQuests: [expect.objectContaining(to)] })],
    attention: { items: expect.arrayContaining([expect.objectContaining({ kind: "held", title: to.title })]) }, sinceVisit: { quests: [expect.objectContaining({ title: to.title })] } });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ keeperView: { boardQuests: [expect.objectContaining(to)] } });
  expect(await f.harness.invokeRpc("ledger", { threadId: "lead" })).toMatchObject({ boardQuests: [expect.objectContaining(to)] });
  expect(await f.harness.invokeRpc("awayDigest", {})).toMatchObject({ quests: [expect.objectContaining({ questId: f.q.id, ...to })] });
});
