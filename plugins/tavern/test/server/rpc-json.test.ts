// @vitest-environment node
import { seedQuest, waypointEntry } from "./support";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
const location = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => location.home }));
import tavern, { rpcContract } from "../../server";
import { registerScopes } from "../../src/scope";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { planInput, fakePort } from "./support";
import { createFakePluginHost, makeThreadResponse } from "./host";
import { memberSchema, planSchema, askSchema, decisionSchema, ruleSchema, reportSchema, routeSchema, gateRecordSchema } from "../../src/shared/schema";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.unstubAllEnvs(); });
async function fixture() {
  location.home = mkdtempSync(join(tmpdir(), "tavern-rpc-json-"));
  vi.stubEnv("HOME", location.home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(location.home, "pi-agent"));
  const db = new Database(join(location.home, "data.db"));
  const f = createFakePluginHost({ pluginId: "tavern", sdk: {
    threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "lead" ? "active" : "idle" }), defaultExecutionOptions: async () => ({ model: "checked-model", reasoningLevel: "high" }), update: async () => ({}), getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}), events: { list: async () => [] }, queuedMessages: { list: async () => [] }, stop: async () => ({}) },
    plugins: { list: async () => ({ plugins: [] }) }, projects: { list: async () => [], get: async () => ({ sources: [] }) }, system: { config: async () => ({ primaryHostId: "host" }) },
    environments: { listProviders: async () => [] }, hosts: { list: async () => [], experimental_listProviders: async () => [] },
  } });
  const disposals: (() => unknown)[] = [];
  Object.assign(f.bb, {
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => db.exec(statements.join("\n")) },
    settings: { define: () => ({ get: async () => ({ scopes: "enforce" }), onChange: () => {} }) },
    ui: { registerMentionProvider: vi.fn() }, background: { service: vi.fn() },
    experimental_hooks: { ...f.bb.experimental_hooks, on: vi.fn() }, onDispose: (fn: () => unknown) => disposals.push(fn),
  });
  close = async () => { for (const dispose of disposals.reverse()) await dispose(); db.close(); rmSync(location.home, { recursive: true, force: true }); };
  const scopes = registerScopes(f.bb, { dataDir: location.home, installGuard: false, pathsForThread: () => ({}), onViolation: () => {} });
  for (const [id, role] of [["lead", "keeper"], ["member", "ranger"]]) await scopes.writeScope(id!, scopes.resolve(role!, {}).scope);
  await tavern(f.bb);
  const k = new Keeper(new KeeperStore(db), fakePort());
  k.bind("lead", "keeper", "wren", "project");
  const q = await seedQuest(k,"lead", "Sparse quest", "Sparse");
  const plan = planInput(q.id);
  k.plan("lead", { ...plan, waypoints: [...plan.waypoints, { ...plan.waypoints[0]!, id: "w2", title: "Outside contact", actor: "outside", owner: "Other team" }] });
  k.bind("member", "ranger", "pip", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: true, title: "Scout", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Changes", doneWhen: "Answer", context: [], questions: [], timeboxMinutes: null } });
  const ask = k.ask("lead", { kind: "decision", question: "Which reversible draft?", why: "Your choice", options: [{ id: "yes", label: "First draft", detail: "", recommended: false }], meanwhile: "Read", holds: [] });
  const decision = k.decide("lead", { text: "Use a private draft", why: "Reversible", reversible: true, source: "keeper" });
  const rule = k.addRule({ scope: "keeper", scopeId: "lead", text: "Do not publish", source: "user" });
  const route = routeSchema.parse({ id: "route_sparse", keeperThreadId: "lead", messageKey: "sparse", messageAt: Date.now(), kind: "aside", boardQuestId: null, boardQuestIds: [], summary: "A short answer", corrected: false, createdAt: Date.now() });
  k.store.put("routes", route.id, route);
  const report = reportSchema.parse({ id: "report_sparse", memberThreadId: "member", keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, status: "blocked", outcome: "Waiting", evidence: [], artifacts: [], confidence: null, voice: null, createdAt: Date.now(), deliveredAt: null });
  k.store.put("reports", report.id, report);
  k.memory.note("lead", { kind: "fact", text: "A retained fact" });
  k.memory.gate("lead", { boardQuestId: q.id, waypointId: "w2", askedWho: "Other team", via: "Private draft" });
  const recordSchemas = { members: memberSchema, plans: planSchema, asks: askSchema, decisions: decisionSchema, rules: ruleSchema, reports: reportSchema, routes: routeSchema, gates: gateRecordSchema };
  for (const [kind, schema] of Object.entries(recordSchemas)) {
    for (const row of db.prepare("SELECT id,data FROM tavern_records WHERE kind=?").all(kind) as { id: string; data: string }[]) {
      const value = JSON.parse(row.data);
      for (const [key, field] of Object.entries(schema.shape)) if (field instanceof z.ZodOptional) delete value[key];
      db.prepare("UPDATE tavern_records SET data=? WHERE kind=? AND id=?").run(JSON.stringify(value), kind, row.id);
    }
  }
  return { ...f, k, q, ask, decision, rule, route, report };
}

it("returns compact mood signals and the voice setting in the thread widget", async () => {
  const f = await fixture();
  const decor = () => f.harness.invokeRpc("decor", { threadId: "member" });
  await f.harness.invokeRpc("settingsUpdate", { revision: 0, patch: { tavern: { voice: "light" } }, why: "Test voice" },
    { experimental_caller: { kind: "client" } });
  expect(await decor()).toMatchObject({ voice: "light", moodSignals: {
    released: false, archived: false, handBack: false,
    report: { status: "blocked", createdAt: f.report.createdAt }, verdict: null,
  } });
  f.k.bind("reviewer", "warden", "vex", "project");
  const at = f.report.createdAt + 1;
  const entry = { ...waypointEntry("member", f.q.id), status: "verified", updatedAt: at + 1,
    review: { actor: { kind: "agent", threadId: "reviewer" }, at, evidence: [], reason: null, previousNote: null, memberEvidenceAt: null } };
  f.k.store.db.prepare("INSERT INTO questlog_entries(thread_id, id, board_quest_id, data) VALUES (?, ?, ?, ?)")
    .run(entry.threadId, entry.id, f.q.id, JSON.stringify(entry));
  expect(await decor()).toMatchObject({ moodSignals: { verdict: { status: "verified", at, checkerName: "Vex", waypointTitle: planInput(f.q.id).waypoints[0]!.title } } });
  f.k.store.patch("member", { archivedAt: Date.now(), lastBriefAt: f.report.createdAt + 1, released: { decisionId: f.decision.id, reason: "Returned" } });
  expect(await decor()).toMatchObject({ moodSignals: { released: true, archived: true, report: null } });
  f.k.memory.note("lead", { kind: "waiting-on-user", text: "Choose the next trail" });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ moodSignals: { handBack: true } });
});

it("returns strict JSON from EVERY registered RPC with optional record fields absent", async () => {
  const f = await fixture();
  const call = (name: string, input: unknown) => f.harness.invokeRpc(name, input);
  const registry = await call("registry", {}) as { characters: { id: string; name: string; hue: string; charge: string; temper: string; style: string; quirks: string[]; lines: unknown }[] };
  const character = registry.characters[0]!;
  const { name, hue, charge, temper, style, quirks, lines } = character;
  let seenUndoToken: string | null = null;
  let awayWindowId: string | null = null;
  const cases = {
    registry: () => call("registry", {}),
    classExecution: () => call("classExecution", { classId: "ranger", projectId: "project", mode: "start" }),
    classExecutions: () => call("classExecutions", {}),
    applyClassExecution: () => {
      f.k.store.patch("lead", { classNotice: { message: "Class choice", settings: true, switchExecution: { model: "checked-model", reasoningLevel: "high" } } });
      return call("applyClassExecution", { threadId: "lead" });
    },
    dismissClassNotice: () => call("dismissClassNotice", { threadId: "lead" }),
    placementCatalog: () => call("placementCatalog", {}),
    placementRetry: () => call("placementRetry", { placementId: "missing", generation: 1 }),
    placementPreview: () => call("placementPreview", { projectId: "project", keeperThreadId: "lead", keeperPath: null, classId: "ranger", questId: null }),
    decor: () => call("decor", { threadId: "member" }),
    crests: () => call("crests", { threadIds: ["lead", "member", "untyped"] }),
    journal: () => call("journal", { threadId: "member" }),
    journalEdit: () => call("journalEdit", { threadId: "member", edit: { op: "add", descriptions: ["Check sparse output"] } }),
    resumeKeeper: () => call("resumeKeeper", { threadId: "lead" }),
    ledger: () => call("ledger", { threadId: "lead" }),
    routes: () => call("routes", { threadId: "lead" }),
    boardQuest: () => call("boardQuest", { id: f.q.id }),
    setTaleKept: () => call("setTaleKept", { questId: f.q.id, characterId: character.id, kept: false }),
    room: () => call("room", {}),
    stopAllStatus: () => call("stopAllStatus", {}),
    stopAll: () => call("stopAll", {}),
    resumeAll: () => call("resumeAll", {}),
    away: () => call("away", {}),
    awayDigest: () => call("awayDigest", {}),
    awayClose: async () => {
      const result = await call("awayClose", { revision: 0, until: Date.now() + 3_600_000, quests: [] }) as { state: { window: { id: string } } };
      awayWindowId = result.state.window.id;
      return result;
    },
    awayReturn: () => call("awayReturn", { windowId: awayWindowId! }),
    reports: () => call("reports", {}),
    releaseCheckerHandoff: async () => {
      f.k.receiveUser("lead", "Hold the checker handoff for my explicit signal");
      f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Hold checking", notes: [], checkerHandoffHold: { reason: "Wait for my signal" } });
      return call("releaseCheckerHandoff", { boardQuestId: f.q.id, holdId: f.k.quest(f.q.id).checkerHandoffHold!.id, via: "page" });
    },
    answerAsk: () => call("answerAsk", { askId: f.ask.id, optionId: "yes", via: "page" }),
    markDecisionsSeen: async () => {
      const result = await call("markDecisionsSeen", { ids: [f.decision.id] }) as { undoToken: string | null };
      seenUndoToken = result.undoToken;
      return result;
    },
    markDecisionsUnseen: () => call("markDecisionsUnseen", { undoToken: seenUndoToken }),
    decisionHistory: () => call("decisionHistory", { keeperThreadId: "lead" }),
    undoDecision: () => call("undoDecision", { decisionId: f.decision.id }),
    correctRoute: () => call("correctRoute", { routeId: f.route.id, kind: "aside", boardQuestId: null }),
    addRule: () => call("addRule", { scope: "keeper", scopeId: "lead", text: "Keep drafts private", source: "user" }),
    confirmRule: () => call("confirmRule", { ruleId: f.rule.id, active: true }),
    widenRule: () => call("widenRule", { ruleId: f.rule.id, scope: "global" }),
    holdBoardQuest: () => call("holdBoardQuest", { id: f.q.id }),
    resumeBoardQuest: () => call("resumeBoardQuest", { id: f.q.id }),
    stopBoardQuest: () => call("stopBoardQuest", { id: f.q.id }),
    archiveBoardQuests: () => call("archiveBoardQuests", { ids: [f.q.id], archived: true }),
    deleteBoardQuest: () => call("deleteBoardQuest", { id: f.q.id }),
    deletedBoardQuests: () => call("deletedBoardQuests", {}),
    restoreDeletedQuest: () => call("restoreDeletedQuest", { id: f.q.id }),
    mapHistory: () => call("mapHistory", {}),
    archivedBoardQuests: () => call("archivedBoardQuests", {}),
    setHidden: () => call("setHidden", { threadId: "member", hidden: true }),
    saveCharacterVoice: async () => {
      const says = { working: ["Fair road as far as {waypoint}."] };
      const result = await call("saveCharacterVoice", { characterId: character.id, voice: { name, hue, charge, temper, style, quirks, lines, says } });
      expect(result).toMatchObject({ says });
      return result;
    },
    saveCharacterAvatar: () => call("saveCharacterAvatar", { characterId: character.id, avatar: "3v41" }),
    classEditor: () => call("classEditor", { classId: "smith", projectId: null }),
    classPreview: () => call("classPreview", { classId: "smith", projectId: null, target: "global", edit: { label: "Mason" } }),
    // A revision that cannot match: the write path is exercised without touching any override file.
    saveClass: () => call("saveClass", { classId: "smith", projectId: null, target: "global", edit: { label: "Mason" }, revision: "stale" }),
    removeClassOverride: () => call("removeClassOverride", { classId: "smith", projectId: null, target: "global", revision: "stale" }),
    typing: () => call("typing", { threadId: "lead" }),
    settings: () => call("settings", null),
    settingsUpdate: () => call("settingsUpdate", { revision: 0, patch: {}, why: "Sparse fixture" }),
    settingsUndo: () => call("settingsUndo", { id: "missing", revision: 0, why: "Sparse fixture" }),
    settingsExport: () => call("settingsExport", {}),
    settingsImport: () => call("settingsImport", { toml: "" }),
    settingsFile: () => call("settingsFile", { action: "status" }),
    settingsApplySuggestion: () => call("settingsApplySuggestion", { key: "staleMinutes", revision: 0 }),
    insights: () => call("insights", { range: "7d" }),
    backupList: () => call("backupList", {}),
    backupSave: () => call("backupSave", {}),
    backupExport: () => call("backupExport", {}),
    backupRestore: () => call("backupRestore", { from: { name: "missing-backup.json" } }),
    registryFile: () => call("registryFile", { kind: "class", id: "smith" }),
    registryExportFolder: () => call("registryExportFolder", { kind: "class" }),
    voiceCheck: () => call("voiceCheck", { characterId: character.id }),
    // The fixture's SDK offers no personal project, so the check ends at once as couldn't run and spawns nothing.
    voiceCheckStart: () => call("voiceCheckStart", { characterId: character.id, draft: { name, style, quirks } }),
    voiceCheckCancel: () => call("voiceCheckCancel", { characterId: character.id, runId: "missing" }),
  } satisfies Record<keyof typeof rpcContract, () => Promise<unknown>>;
  expect(f.harness.inspection.registrations.rpcMethods.sort()).toEqual(Object.keys(rpcContract).sort());
  expect(Object.keys(cases).sort()).toEqual(Object.keys(rpcContract).sort());
  expect(f.k.member("member")).not.toHaveProperty("guardPosture");
  expect(f.k.member("member")).not.toHaveProperty("displayName");
  for (const [method, invoke] of Object.entries(cases)) {
    const result = await invoke().catch(error => { throw new Error(`${method}: ${String(error)}`, { cause: error }); });
    expect(() => z.json().parse(result), method).not.toThrow();
    expect(JSON.parse(JSON.stringify(result)), method).toStrictEqual(result);
  }
  for (const threadId of ["lead", "untyped"]) {
    for (const method of ["decor", "journal"]) {
      const result = await call(method, { threadId });
      expect(() => z.json().parse(result), `${method}:${threadId}`).not.toThrow();
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
    }
  }
  await vi.waitFor(() => expect(f.k.store.all("voiceChecks").map((r) => [r.state, r.reason])).toEqual([["couldnt-run", "No personal project is available to run the check in."]]));
  expect(f.harness.inspection.sdk.callsTo("threads.spawn").filter((call) => (call.args[0] as { pluginMetadata?: { voiceCheck?: unknown } }).pluginMetadata?.voiceCheck)).toEqual([]);
  expect(f.k.store.get("reports", f.report.id)).not.toHaveProperty("headline");
  f.k.store.event(Date.now(), "lead", f.q.id, "quest.wrapped", "The sparse tale is retained.", { outcome: "The sparse tale is retained.", left: "" });
  const detail = await call("boardQuest", { id: f.q.id });
  expect(detail).toMatchObject({ tale: { outcome: "The sparse tale is retained.", left: null, skipped: [] }, memberCredits: [{ memberThreadId: "member", madeWaypointIds: [], verifiedWaypointIds: [] }] });
  expect(() => z.json().parse(detail)).not.toThrow();
  expect(JSON.parse(JSON.stringify(detail))).toStrictEqual(detail);
  const decor = await call("decor", { threadId: "member" });
  expect((decor as { scope: unknown }).scope).toBeNull();
});
