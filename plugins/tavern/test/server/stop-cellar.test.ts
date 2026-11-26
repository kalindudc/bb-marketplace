// @vitest-environment node
import { expect, it } from "vitest";
import { rpcHandlers } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { seedLegacyQuest, seedQuest } from "./support";
import { makeThreadResponse } from "./host";

const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
const stop = (f: ReturnType<typeof setup>) => (rpcHandlers(f.runtime) as unknown as {
  stopKeeperGoneQuests(input: { ids: string[] }, context: unknown): Promise<unknown>;
}).stopKeeperGoneQuests;

it.each([
  { experimental_caller: { kind: "plugin", pluginId: "other" } },
  { ...client, threadId: "lead" },
  { ...client, origin: { kind: "cli", agentThreadId: "lead" } },
])("refuses a plugin or an agent shell without stopping quests: %j", async context => {
  const f = setup();
  const quest = await seedQuest(f.k, "lead", "Archived Keeper", "A narrow goal");
  f.k.store.patch("lead", { archivedAt: f.time() });
  await expect(async () => stop(f)({ ids: [quest.id] }, context)).rejects.toThrow(/explicit client action/);
  expect(f.k.quest(quest.id).phase).toBe("scout");
  expect(f.k.store.events().filter(e => e.type === "tavern.cellar-stop-receipt")).toHaveLength(0);
});

it("stops and cellars only the confirmed quests and records one receipt naming each", async () => {
  const f = setup();
  const first = await seedQuest(f.k, "lead", "First named quest", "A narrow goal");
  const second = seedLegacyQuest(f.k, "lead", "Second named quest", "Another goal");
  const excluded = seedLegacyQuest(f.k, "lead", "Not in the confirmation", "A later scope");
  f.k.store.patch("lead", { archivedAt: f.time() });
  const result = await stop(f)({ ids: [first.id, second.id] }, client);
  const entries = [first, second].map(q => ({ questId: q.id, title: q.title }));
  expect(result).toMatchObject({ entries: entries.map(entry => ({ ...entry, state: "cellared" })) });
  for (const quest of [first, second]) expect(f.k.quest(quest.id)).toMatchObject({ phase: "stopped", archivedAt: f.time() });
  expect(f.k.quest(excluded.id)).toMatchObject({ phase: "scout", archivedAt: null });
  const receipts = f.k.store.events().filter(e => e.type === "tavern.cellar-stop-receipt");
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ actor: { kind: "user" }, data: { entries } });
});

it("refuses a stale scope atomically when one Keeper is still present", async () => {
  const f = setup();
  const first = await seedQuest(f.k, "lead", "Archived Keeper", "A narrow goal");
  f.k.bind("other", "keeper", "moss", "project");
  const second = await seedQuest(f.k, "other", "Still live", "A narrow goal");
  f.k.store.patch("lead", { archivedAt: f.time() });
  await expect(async () => stop(f)({ ids: [first.id, second.id] }, client)).rejects.toThrow('The “Needs a Keeper” list changed. Review the quests and confirm again.');
  for (const quest of [first, second]) expect(f.k.quest(quest.id)).toMatchObject({ phase: "scout", archivedAt: null });
});

it("leaves an unconfirmed stop on the board and cellars it after the normal retry", async () => {
  let idle = false;
  const f = setup({ threads: {
    get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: idle ? "idle" : "active" }),
    stop: async () => ({}), archive: async () => ({}),
  } });
  const quest = await seedQuest(f.k, "lead", "Wait for a confirmed stop", "A narrow goal");
  f.k.bind("scout", "ranger", "lark", "project", { keeperThreadId: "lead", boardQuestId: quest.id, waypointId: null, errand: false, title: "Scout", brief: { outcome: "Scout", doneWhen: "Findings", mode: "make-it-work", outOfScope: "Production", context: [], questions: [], timeboxMinutes: null } });
  f.k.store.patch("lead", { archivedAt: f.time() });
  expect(await stop(f)({ ids: [quest.id] }, client)).toMatchObject({ entries: [{ state: "stopping" }] });
  expect(f.k.quest(quest.id)).toMatchObject({ phase: "stopping", archivedAt: null });
  idle = true;
  await f.runtime.retryStops("lead", quest.id, true);
  expect(f.k.quest(quest.id)).toMatchObject({ phase: "stopped", archivedAt: f.time() });
  expect(f.k.store.events().filter(e => e.type === "tavern.cellar-stop-receipt")).toHaveLength(1);
});
