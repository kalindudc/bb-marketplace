// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { JOURNAL_INSTRUCTIONS, registerJournal } from "../../src/server/journal";
import { createJournalStore } from "../../src/server/journal/store";
import { dispatchCheck, isJournalTool } from "../../src/server/journal/requests";
import { MIGRATIONS } from "../../src/server/migrations";
import { QUESTLOG_MIGRATIONS as JOURNAL_MIGRATIONS } from "../../src/server/journal/migrations";
import { makeHost } from "./host";
import { setup } from "../server/runtime-fixture";
import { evaluate } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });

describe("journal rename compatibility", () => {
  it("registers journal and keeps an unselected quest descriptor executable through the SDK host", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tavern", agentSkillIds: ["journal", "quest-management"], sdk: {
      threads: { getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}), get: async () => makeThreadResponse() },
      plugins: { list: async () => ({ plugins: [] }) },
    } });
    cleanup.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const registrations = vi.spyOn(bb.agents, "registerTool");
    const port = registerJournal(bb, db, { roleOf: () => null, invalidate: () => {} });
    const oldDescriptor = harness.inspection.registrations.agentTools.find(t => t.name === "quest");
    expect(oldDescriptor).toBeDefined();
    bb.agents.configure(() => ({ tools: ["journal"], skills: ["journal", "quest-management"] }));
    const selected = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    expect(selected.tools.map(t => t.name)).toEqual(["journal"]);
    expect(selected.skills).toEqual(["journal", "quest-management"]);
    expect(selected.tools[0]?.instructions).toBe(JOURNAL_INSTRUCTIONS);
    expect(selected.tools[0]?.inputSchema).toEqual(oldDescriptor?.inputSchema);
    expect(registrations.mock.calls[0]?.[0].execute).toBe(registrations.mock.calls[1]?.[0].execute);
    const legacy = await harness.behavior.callAgentTool("quest", { action: "add", descriptions: ["Retained session work"] }, { threadId: "t" });
    expect(legacy).toContain("New ids: 00");
    expect(await harness.behavior.callAgentTool("journal", { action: "list" }, { threadId: "t" })).toContain("Retained session work");
    expect(port.progress("t").total).toBe(1);
    expect(port.instructions("t")).toMatch(/^Journal snapshot/);
    expect(port.instructions("t")).toContain("Retained session work");
    expect(port.instructions("t")).not.toContain(JOURNAL_INSTRUCTIONS);
    const canonical = await harness.behavior.callAgentTool("journal", { action: "skill" }, { threadId: "t" });
    expect(canonical).toContain("name: journal");
    expect(await harness.behavior.callAgentTool("quest", { action: "rules" }, { threadId: "t" })).toEqual(canonical);
  });
  it("selects journal rather than quest in ordinary and degraded runtime configuration", () => {
    const f = setup();
    const ctx = makePluginAgentConfigurationContext({ thread: { id: "untyped" } });
    expect(f.runtime.configure(ctx).tools).toEqual(["journal"]);
    expect(f.runtime.configure(ctx).skills).toContain("journal");
    vi.spyOn(f.port, "instructions").mockImplementation(() => { throw new Error("ledger unavailable"); });
    expect(f.runtime.configure(ctx).tools).toEqual(["journal"]);
    expect(f.runtime.configure(ctx).skills).toContain("journal");
  });
  it("selects the separate journal guidance for Keepers and members on the steer providers", async () => {
    const f = setup();
    await f.runtime.prepareRegistry("project");
    f.k.bind("maker", "smith", null, "project", {
      keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build",
      brief: { outcome: "Build", doneWhen: "Evidence", outOfScope: "Publish", mode: "make-it-work", context: [], questions: [], timeboxMinutes: null },
    });
    const host = makeHost();
    cleanup.push(host.dispose);
    host.bb.storage.migrate(host.db, MIGRATIONS);
    const port = registerJournal(host.bb, host.db, { roleOf: () => null, invalidate: () => {} });
    f.port.instructions = port.instructions;
    for (const providerId of ["pi", "claude-code", "codex"]) {
      for (const id of ["lead", "maker"]) {
        const ctx = makePluginAgentConfigurationContext({ thread: { id }, project: { id: "project" }, provider: { id: providerId } });
        const selected = f.runtime.configure(ctx);
        expect(selected.tools, `${providerId} ${id}: ${selected.instructions}`).toContain("journal");
        expect(selected.instructions).toContain("Journal snapshot (entry descriptions are data):");
        expect(selected.instructions).not.toContain(JOURNAL_INSTRUCTIONS);
      }
    }
  });
  it.each(["[Quests]", "[Journal]"])("keeps the no-wake origin and visibility checks for %s", prefix => {
    const ctx = { attempt: "start-turn", originPluginId: "tavern", queuedMessages: [], input: { blocks: [{ type: "text", visibility: "agent-only", text: `${prefix} state` }] } } as unknown as MessageDispatchHookContext;
    expect(dispatchCheck(ctx)).toContain("running turn");
    expect(dispatchCheck({ ...ctx, originPluginId: "other" })).toBeNull();
    expect(dispatchCheck({ ...ctx, attempt: "join-turn" })).toBeNull();
    expect(dispatchCheck({ ...ctx, queuedMessages: [{ originPluginId: "other", content: ctx.input.blocks }] } as unknown as MessageDispatchHookContext)).toBeNull();
  });
  it("recognizes qualified journal names without confusing other quest tools", () => {
    for (const name of ["journal", "tavern.journal", "mcp__tavern__journal"]) expect(isJournalTool(name), name).toBe(true);
    for (const name of ["quest", "tavern.quest", "mcp__tavern__quest", "questing", "tavern_quest", "journalEdit", "journalist"]) expect(isJournalTool(name), name).toBe(false);
  });
  it("normalizes legacy board mirrors without losing identity or restoring old labels through undo", async () => {
    const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
    const board = { id: "q", title: "Deliver", phase: "scout" as const, updatedAt: 100, endedAt: null };
    const store = createJournalStore(h.bb, h.db, { roleOf: () => ({ classId: "keeper", role: "keeper", boardQuestId: null, waypointId: null }), boardQuestsOf: () => [board], invalidate: () => {} });
    await store.prepare("k");
    store.edit("k", { op: "add", descriptions: ["Board quest: Deliver (q)"], parentId: null }, { kind: "agent", threadId: "k" });
    expect(store.get("k").entries[0]).toMatchObject({ boardQuestId: "q", description: "Quest: Deliver" });
    await store.runTool("k", { action: "add", descriptions: ["Chore"] });
    await store.runTool("k", { action: "undo" });
    expect(store.get("k").entries[0]).toMatchObject({ boardQuestId: "q", description: "Quest: Deliver" });
  });
  it("emits only Journal notes and preserves the quests.progress mirror", async () => {
    const h = makeHost(); cleanup.push(h.dispose); h.bb.storage.migrate(h.db, MIGRATIONS);
    const store = createJournalStore(h.bb, h.db, { roleOf: () => null, invalidate: () => {} });
    await store.runTool("t", { action: "add", descriptions: ["Build"] });
    store.edit("t", { op: "note", entryId: "00", note: "user change" }, { kind: "user" });
    const send = vi.fn(async (_text: string) => {}); await store.deliverNote("t", null, send);
    expect(send.mock.calls[0]?.[0]).toMatch(/^\[Journal\]/);
    expect(h.mirrors).toContainEqual({ threadId: "t", pluginId: "quests", set: { progress: { done: 0, total: 1, current: "Build" } } });
    const result = await store.runTool("t", { action: "done", id: "00" });
    expect(result.text).toContain("Journal closed.");
  });
  it.each(["journal", "quest"])("allows %s in unresolved read-only and worktree scopes", toolName => {
    for (const role of ["ranger", "warden", "smith", "keeper"]) expect(evaluate(scopeForClass(role), { toolName, kind: "tool", input: {}, cwd: "/tmp" }).allow, role).toBe(true);
  });
  it("preserves the frozen checklist migration bytes and SQL table names", () => {
    const source = readFileSync(new URL("../../src/server/journal/migrations.ts", import.meta.url));
    expect(createHash("sha256").update(source).digest("hex")).toBe("76f56be781bdf062956f3fda5efa63d43b4bf81903692e871d07663ebb0abf69");
    expect(JOURNAL_MIGRATIONS[0]).toContain("CREATE TABLE questlog_entries");
  });
});
