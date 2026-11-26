// @vitest-environment node
import { patchThreadFixture, withMemberFixtures } from "./member-fixture";
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
import { memoryNote } from "../../src/shared/memory";
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
  const restored = new Map<string, string>();
  const f = createFakePluginHost({ pluginId: "tavern", sdk: {
    threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "lead" ? "active" : "idle", ...(restored.has(threadId) ? { createdAt: Date.now(), visibility: "visible", originPluginId: "tavern", sourceThreadId: null, lifecycleOwnerThreadId: null } : {}) }), defaultExecutionOptions: async () => ({ model: "checked-model", reasoningLevel: "high" }), update: async () => ({}), getPluginMetadata: async ({ threadId }: { threadId: string }) => restored.has(threadId) ? { keeperSuccession: restored.get(threadId)! } : ({}), updatePluginMetadata: async () => ({}), events: { list: async () => [] }, queuedMessages: { list: async () => [] }, stop: async () => ({}) },
    plugins: { list: async () => ({ plugins: [{ id: "push-notifications", enabled: true }] }), callRpc: async ({ pluginId }: { pluginId: string }) => pluginId === "burn" ? { report: null } : { ok: true, channels: ["fixture"] } }, projects: { list: async () => [], get: async () => ({ sources: [] }) }, system: { config: async () => ({ primaryHostId: "host" }) },
    environments: { listProviders: async () => [] }, hosts: { list: async () => [], experimental_listProviders: async () => [] },
  } });
  const disposals: (() => unknown)[] = [];
  Object.assign(f.bb, {
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); } },
    settings: { define: () => ({ get: async () => ({ scopes: "enforce" }), onChange: () => {} }) },
    ui: { registerMentionProvider: vi.fn() }, background: { service: vi.fn() },
    experimental_hooks: { ...f.bb.experimental_hooks, on: vi.fn() }, onDispose: (fn: () => unknown) => disposals.push(fn),
  });
  close = async () => { for (const dispose of disposals.reverse()) await dispose(); db.close(); rmSync(location.home, { recursive: true, force: true }); };
  const scopes = registerScopes(f.bb, { dataDir: location.home, installGuard: false, pathsForThread: () => ({}), onViolation: () => {} });
  for (const [id, role] of [["lead", "keeper"], ["member", "ranger"]]) await scopes.writeScope(id!, scopes.resolve(role!, {}).scope);
  await tavern(f.bb);
  const k = withMemberFixtures(new Keeper(new KeeperStore(db), fakePort()));
  k.bind("lead", "keeper", "wren", "project");
  const q = await seedQuest(k,"lead", "Sparse quest", "Sparse");
  const plan = planInput(q.id);
  k.plan("lead", { ...plan, waypoints: [...plan.waypoints, { ...plan.waypoints[0]!, id: "w2", title: "Outside contact", actor: "outside", owner: "Other team" }] });
  k.bind("member", "ranger", "pip", "project", { keeperThreadId: "lead", boardQuestId: q.id, waypointId: null, errand: true, title: "Scout", brief: { outcome: "Read", mode: "make-it-work", outOfScope: "Changes", doneWhen: "Answer", context: [], questions: [], timeboxMinutes: null } });
  const ask = k.ask("lead", { effect: {type:"decision"}, kind: "decision", question: "Which reversible draft?", why: "Your choice", options: [{ id: "yes", label: "First draft", detail: "", recommended: false }], meanwhile: "Read", holds: [] });
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
      for (const [key, field] of Object.entries(schema.shape)) {
        if (kind === "members" && key === "engagement" && value.role !== "keeper") continue;
        if (field instanceof z.ZodOptional) delete value[key];
      }
      k.store.writeRecords("UPDATE tavern_records SET data=? WHERE kind=? AND id=?", JSON.stringify(value), kind, row.id);
    }
  }
  return { ...f, k, q, ask, decision, rule, route, report, restored };
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
  patchThreadFixture(f.k.store, "member", { archivedAt: Date.now(), lastBriefAt: f.report.createdAt + 1, released: { decisionId: f.decision.id, reason: "Returned" } });
  expect(await decor()).toMatchObject({ moodSignals: { released: true, archived: true, report: null } });
  f.k.memory.note("lead", { kind: "waiting-on-user", text: "Choose the next trail", action: "Choose the next trail", need: "Choose the next trail." });
  expect(await f.harness.invokeRpc("decor", { threadId: "lead" })).toMatchObject({ moodSignals: { handBack: true } });
});

it("stops and queues the party for archive without archiving its Keeper", async () => {
  const f = await fixture();
  f.k.store.put("members", "lead", { ...f.k.member("lead")!, boardQuestId: f.q.id });
  expect(await f.harness.invokeRpc("stopBoardQuest", { id: f.q.id })).toMatchObject({ phase: "stopped", unconfirmed: 0 });
  expect(f.k.member("member")).toMatchObject({ engagement: "archiving", disposition: "stopped" });
  expect(f.k.store.runtime("lead").archivePending).toBeFalsy();
  expect(f.k.member("lead")?.engagement).toBeUndefined();
});

it("returns strict JSON from EVERY registered RPC with optional record fields absent", async () => {
  const f = await fixture();
  const call = (name: string, input: unknown) => f.harness.invokeRpc(name, input);
  const registry = await call("registry", {}) as { characters: { id: string; name: string; hue: string; charge: string; temper: string; style: string; quirks: string[]; lines: unknown }[] };
  const character = registry.characters[0]!;
  const { name, hue, charge, temper, style, quirks, lines } = character;
  let seenUndoToken: string | null = null;
  let awayWindowId: string | null = null;
  let alertTestId = 0;
  const propose = async (why: string) => {
    const result = await f.harness.inspection.registrations.cli[0]!.run(["setup", "propose", "--toml", "[tavern]\nrepeat_seconds = 35", "--reasons", JSON.stringify({ "tavern.repeatSeconds": why })], {});
    expect(result.exitCode).toBe(0);
    const { id } = JSON.parse(result.stdout!) as { id: string };
    return { id };
  };
  const pendingSetup = await propose("Verify Strict JSON for a pending setup.");
  const cases = {
    setupProposal: () => call("setupProposal", { id: pendingSetup.id }),
    setupPending: () => call("setupPending", null),
    setupProjects: () => call("setupProjects", null),
    setupDismiss: () => call("setupDismiss", { id: pendingSetup.id }),
    setupApply: async () => call("setupApply", await propose("Verify Strict JSON for an applied setup.")),
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
    identities: () => call("identities", { ids: ["lead", "member", "untyped"], viewer: "lead" }),
    journal: () => call("journal", { threadId: "member" }),
    journalEdit: () => call("journalEdit", { threadId: "member", edit: { op: "add", descriptions: ["Check sparse output"] } }),
    resumeKeeper: () => call("resumeKeeper", { threadId: "lead" }),
    resolveHandBack: () => {
      const note = f.k.memory.note("lead", { kind: "waiting-on-user", text: "Access pending", action: "Approve access", need: "Please approve access." });
      return call("resolveHandBack", { noteId: note.id, how: "done" });
    },
    ledger: () => call("ledger", { threadId: "lead" }),
    askHistory: () => call("askHistory", { threadId: "lead", cursor: null }),
    routes: () => call("routes", { threadId: "lead" }),
    boardQuest: () => call("boardQuest", { id: f.q.id }),
    setTaleKept: () => call("setTaleKept", { questId: f.q.id, characterId: character.id, kept: false }),
    room: () => call("room", {}),
    attentionCount: () => call("attentionCount", {}),
    stopAllStatus: () => call("stopAllStatus", {}),
    stopAll: () => call("stopAll", {}),
    resumeAll: () => call("resumeAll", {}),
    stopKeeperGoneQuests: async () => {
      f.k.bind("gone", "keeper", "wren", "project");
      const quest = await seedQuest(f.k, "gone", "Gone", "Gone");
      f.k.store.patch("gone", { archivedAt: f.k.now() });
      return f.harness.invokeRpc("stopKeeperGoneQuests", { ids: [quest.id] }, { experimental_caller: { kind: "client" } });
    },
    away: () => call("away", {}),
    awayDigest: () => call("awayDigest", {}),
    awayClose: async () => {
      const result = await call("awayClose", { revision: 0, until: Date.now() + 3_600_000, quests: [] }) as { state: { window: { id: string } } };
      awayWindowId = result.state.window.id;
      return result;
    },
    awayReturn: () => call("awayReturn", { windowId: awayWindowId! }),
    reports: () => call("reports", {}),
    recordCardSignals: () => call("recordCardSignals", [{ threadId: "lead", messageId: "message", cardId: "v1", cardType: "questmap", questId: f.q.id, action: "first-seen" }]),
    releaseCheckerHandoff: async () => {
      f.k.receiveUser("lead", "Hold the checker handoff for my explicit signal");
      f.k.route("lead", { kind: "steer", boardQuestId: f.q.id, summary: "Hold checking", notes: [], checkerHandoffHold: { reason: "Wait for my signal" } });
      return call("releaseCheckerHandoff", { boardQuestId: f.q.id, holdId: f.k.quest(f.q.id).checkerHandoffHold!.id, via: "page" });
    },
    questAuthority: () => call("questAuthority", { boardQuestId: f.q.id }),
    delegateQuest: () => call("delegateQuest", { boardQuestId: f.q.id, kind: "merge", via: "page" }),
    preapproveQuest: () => call("preapproveQuest", { boardQuestId: f.q.id, greenlight: null, placement: false, conclude: false, endsAt: null, via: "page" }),
    revokeQuestAuthority: () => call("revokeQuestAuthority", { boardQuestId: f.q.id, id: f.k.quest(f.q.id).delegations![0]!.id, via: "page" }),
    revokeShellGrant: () => {
      f.k.store.put("shellGrants", "fixture", { id: "fixture", keeperThreadId: "lead", memberThreadId: "member", boardQuestId: f.q.id, target: { act: "publish", command: "npm publish", cwd: "/repo", digest: "a".repeat(64) }, scope: "quest", state: "issued", by: "user", issuedAt: 1, changedAt: 1 });
      return call("revokeShellGrant", { threadId: "member", id: "fixture" });
    },
    updateMemberSchedule: () => {
      const member = f.k.member("member")!;
      f.k.store.put("members", member.threadId, { ...member, permanent: { why: "Watch", decisionId: f.decision.id,
        schedules: [{ id: "watch", cadence: "daily", at: "07:00", duty: "Read", nextAt: Date.now() }] } });
      return call("updateMemberSchedule", { threadId: "member", id: "watch", action: "pause" });
    },
    clusterRunStatus: () => call("clusterRunStatus", { askId: f.ask.id }),
    answerAsk: () => call("answerAsk", { askId: f.ask.id, optionId: "yes", via: "page" }),
    searchAnswers: () => call("searchAnswers", { query: "" }),
    unansweredMessages: () => call("unansweredMessages", { boardQuestId: f.q.id }),
    olderSummaries: () => call("olderSummaries", { boardQuestId: f.q.id, beforeId: "absent" }),
    summary: () => call("summary", { id: "absent", threadId: "lead" }),
    markVisitSeen: () => call("markVisitSeen", { summaryIds: [], changeIds: ["quest-change:999"] }),
    markSummariesSeen: () => call("markSummariesSeen", { boardQuestId: f.q.id, ids: ["absent"] }),
    markDecisionsSeen: async () => {
      const result = await call("markDecisionsSeen", { ids: [f.decision.id] }) as { undoToken: string | null };
      seenUndoToken = result.undoToken;
      return result;
    },
    markDecisionsUnseen: () => call("markDecisionsUnseen", { undoToken: seenUndoToken }),
    decisionHistory: () => call("decisionHistory", { keeperThreadId: "lead" }),
    undoDecision: () => call("undoDecision", { decisionId: f.decision.id }),
    resetUndoLane: () => call("resetUndoLane", { threadId: "lead", kind: "merge" }),
    correctRoute: () => call("correctRoute", { routeId: f.route.id, kind: "aside", boardQuestId: null }),
    addRule: () => call("addRule", { scope: "keeper", scopeId: "lead", text: "Keep drafts private", source: "user" }),
    confirmRule: () => call("confirmRule", { ruleId: f.rule.id, active: true }),
    widenRule: () => call("widenRule", { ruleId: f.rule.id, scope: "global" }),
    allowReview: () => call("allowReview", { id: f.q.id }),
    questSpend: () => call("questSpend", { id: f.q.id }),
    setSpendBudget: () => call("setSpendBudget", { id: f.q.id, budgetCents: 500 }),
    renameBoardQuest: () => call("renameBoardQuest", { id: f.q.id, title: "Repair the signal lamp", short: "Lamp" }),
    holdBoardQuest: () => call("holdBoardQuest", { id: f.q.id }),
    resumeBoardQuest: () => call("resumeBoardQuest", { id: f.q.id }),
    stopBoardQuest: () => call("stopBoardQuest", { id: f.q.id }),
    archiveBoardQuests: () => call("archiveBoardQuests", { ids: [f.q.id], archived: true }),
    deleteBoardQuest: () => call("deleteBoardQuest", { id: f.q.id }),
    deletedBoardQuests: () => call("deletedBoardQuests", {}),
    deletedQuestCount: () => call("deletedQuestCount", {}),
    restoreDeletedQuest: () => call("restoreDeletedQuest", { id: f.q.id }),
    prepareTellKeepers: () => call("prepareTellKeepers", { keeperIds: ["lead"] }),
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
    registryOverrides: () => call("registryOverrides", {}),
    registryDefinition: () => call("registryDefinition", { kind: "class", id: "smith", projectId: null, target: "global" }),
    previewOverrideReset: () => call("previewOverrideReset", { kind: "character", id: character.id, projectId: null, target: "global" }),
    resetOverride: () => call("resetOverride", { kind: "class", id: "smith", projectId: null, target: "global", revision: "stale" }),
    typing: () => call("typing", { threadId: "lead" }),
    scopeCallPage: () => call("scopeCallPage", { threadId: "lead", before: 1 }),
    placementModelFailures: () => call("placementModelFailures", {}),
    placementModelFailureClear: () => call("placementModelFailureClear", { id: "missing" }),
    settings: () => call("settings", null),
    memorySettings: () => call("memorySettings", null),
    memoryProjects: () => call("memoryProjects", null),
    memoryList: () => call("memoryList", { project: "project", text: "", kind: null, status: null, memory: null, limit: 3, offset: 0 }),
    memoryPrevious: () => call("memoryPrevious", { project: "project", id: "missing" }),
    memoryConfigure: () => call("memoryConfigure", { revision: 0, config: { active: "builtin", profiles: [] } }),
    memoryManage: () => {
      const note = memoryNote.parse({ id: "rpc-note", project: "project", quest: null, title: "RPC note", body: "Fixture body",
        kind: "reference", source: { kind: "file", value: "README.md" }, appliesTo: { kind: "release", value: "preview" },
        tags: [], author: { thread: "lead", classId: "keeper" }, curator: "lead", status: "accepted", supersedes: null,
        memory: "included", exclusionReason: null, reviewedBy: null, reviewedAt: null, createdAt: 1, updatedAt: 1 });
      f.k.store.db.prepare("INSERT INTO tavern_memory_notes(id,store,data) VALUES(?,'builtin',?)").run(note.id, JSON.stringify(note));
      return call("memoryManage", { action: "retire", id: note.id, expectedUpdatedAt: note.updatedAt });
    },
    alertRoute: () => call("alertRoute", null),
    alertTestSend: async () => {
      const result = await call("alertTestSend", {}) as { lastTest: { id: number } };
      alertTestId = result.lastTest.id;
      return result;
    },
    alertTestConfirm: () => call("alertTestConfirm", { id: alertTestId, arrived: true }),
    settingsUpdate: () => call("settingsUpdate", { revision: 0, patch: {}, why: "Sparse fixture" }),
    settingsUndo: () => call("settingsUndo", { id: "missing", revision: 0, why: "Sparse fixture" }),
    settingsExport: () => call("settingsExport", {}),
    settingsImport: () => call("settingsImport", { toml: "" }),
    settingsFile: () => call("settingsFile", { action: "status" }),
    settingsEndOverride: () => call("settingsEndOverride", { revision: 0, boardQuestId: "missing", key: "staleMinutes" }),
    settingsApplySuggestion: () => call("settingsApplySuggestion", { key: "staleMinutes", revision: 0 }),
    insights: () => call("insights", { range: "7d" }),
    wardenQuality: () => call("wardenQuality", null),
    backupList: () => call("backupList", {}),
    backupSave: () => call("backupSave", {}),
    backupExport: () => call("backupExport", {}),
    backupRestore: () => call("backupRestore", { from: { name: "missing-backup.json" } }),
    registryFile: () => call("registryFile", { kind: "class", id: "smith" }),
    registryExportFolder: () => call("registryExportFolder", { kind: "class" }),
    refreshKeeper: () => call("refreshKeeper", { threadId: "lead" }),
    cancelKeeperRefresh: () => call("cancelKeeperRefresh", { threadId: "lead", successionId: f.k.succession.operationFor("lead")!.id }),
    finishKeeperHandover: () => {
      f.k.bind("restore-lead", "keeper", null, "project");
      const op = f.k.succession.propose("restore-lead", { kind: "user" }, "Restore test");
      f.k.succession.prepare(op.id, []);
      f.k.succession.bindCandidate(op.id, "restore-successor");
      const done = f.k.succession.cutover(op.id, [({ successor }) => { f.k.bind(successor, "keeper", null, "project"); }]);
      f.k.store.put("keeperSuccessions", op.id, { ...done, restored: true });
      f.restored.set("restore-successor", op.id);
      return call("finishKeeperHandover", { threadId: "restore-successor", successionId: op.id });
    },
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
  expect(f.k.store.get("reports", f.report.id)).not.toHaveProperty("headline");
  f.k.store.event(Date.now(), "lead", f.q.id, "quest.wrapped", "The sparse tale is retained.", { outcome: "The sparse tale is retained.", left: "" });
  const detail = await call("boardQuest", { id: f.q.id });
  expect(detail).toMatchObject({ tale: { outcome: "The sparse tale is retained.", left: null, skipped: [] }, memberCredits: [{ memberThreadId: "member", madeWaypointIds: [], verifiedWaypointIds: [] }] });
  expect(() => z.json().parse(detail)).not.toThrow();
  expect(JSON.parse(JSON.stringify(detail))).toStrictEqual(detail);
  const decor = await call("decor", { threadId: "member" });
  expect((decor as { scope: unknown }).scope).toBeNull();
});
