// @vitest-environment node
import { patchThreadFixture, withMemberFixtures } from "./member-fixture";
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { putQuestFixture } from "./support";
import { seedQuest } from "./support";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registrySchema } from "../../src/shared/contract";
import { reportSchema, type Report } from "../../src/shared/schema";
import { BackupRecords } from "../../src/server/backup/records";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { Registry } from "../../src/server/registry";
import { LIMITS } from "../../src/server/limits";
import { rpcHandlers } from "../../src/server/rpc";
import { tags } from "../../src/shared/contract";
import { TavernRuntime } from "../../src/server/runtime";
import { SettingsStore } from "../../src/server/settings/store";
import { setup } from "./runtime-fixture";
import { makePluginAgentConfigurationContext, makeThreadResponse } from "./host";
import { fakePort } from "./support";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
const builtin = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [], databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(fs.statSync).mockReset();
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const f = setup(); databases.push(f.k.store.db);
  const root = fs.mkdtempSync(join(tmpdir(), "tavern-character-presentation-")); dirs.push(root);
  const home = join(root, "global"), project = join(root, "project");
  let registryNow = 1_700_000_000_000;
  const registry = new Registry(builtin, home, () => registryNow);
  const runtime = new TavernRuntime(f.bb, f.k, registry), rpc = rpcHandlers(runtime);
  const override = (id: string, target = "global", filename = `${id}.md`, sourceId = id, at = 1_700_000_000_000) => {
    const dir = target === "project" ? join(project, ".agents/tavern/characters") : join(home, "characters");
    fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, filename), raw = fs.readFileSync(join(builtin, `characters/${sourceId}.md`), "utf8");
    fs.writeFileSync(path, raw.replace(new RegExp(`^id: ${sourceId}$`, "m"), `id: ${id}`));
    fs.utimesSync(path, new Date(at), new Date(at)); registry.invalidate(); return path;
  };
  const member = (id = "worker", characterId: string | null = "juno") => f.k.bind(id, "smith", characterId, "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Draft",
    brief: { outcome: "Draft", doneWhen: "Proved", mode: "make-it-work", outOfScope: "Publish", context: [], questions: [], timeboxMinutes: null },
  });
  const report = (input: Partial<Report> = {}) => {
    const value = reportSchema.parse({ id: "report-one", memberThreadId: "worker", keeperThreadId: "lead", boardQuestId: null, waypointId: null,
      status: "done", outcome: "Work proved", evidence: [], artifacts: [], confidence: null, voice: "An agent-written line", createdAt: f.time(), deliveredAt: null, ...input });
    f.k.store.put("reports", value.id, value); return value;
  };
  const read = async (projectId?: string) => registrySchema.parse(await rpc.registry({ projectId }));
  return { ...f, runtime, registry, rpc, read, override, member, report, home, project, advanceRegistry: (ms: number) => { registryNow += ms; } };
}

describe("UI-only character presentation", () => {
  it("marks shipped characters as shipped with no claimed file date and no stats", async () => {
    const f = fixture(); vi.mocked(fs.statSync).mockClear();
    const result = await f.read();
    expect(result.characterAuthorship).toHaveLength(result.characters.length);
    expect(result.characterAuthorship?.every(row => row.source === "shipped" && row.changedAt === null)).toBe(true);
    expect(result.characterReportVoices).toEqual([]);
    expect(fs.statSync).not.toHaveBeenCalled();
  });
  it("reports the effective user file's modification time, not an invented edit time", async () => {
    const f = fixture(), path = f.override("wren"); vi.mocked(fs.statSync).mockClear();
    const result = await f.read();
    expect(result.characterAuthorship?.find(row => row.characterId === "wren")).toEqual({ characterId: "wren", source: "global", changedAt: 1_700_000_000_000 });
    expect(fs.statSync).toHaveBeenCalledTimes(1); expect(fs.statSync).toHaveBeenCalledWith(path);
  });
  it("uses the selected project's effective file, including a filename different from its id", async () => {
    const f = fixture(); f.override("wren");
    const path = f.override("wren", "project", "my-voice.md", "wren", 1_710_000_000_000);
    vi.spyOn(f.runtime, "prepareRegistry").mockImplementation(async () => f.registry.read(f.project));
    vi.spyOn(f.runtime, "projectPath").mockReturnValue(f.project);
    vi.mocked(fs.statSync).mockClear();
    expect((await f.read("project")).characterAuthorship?.find(row => row.characterId === "wren")).toEqual({ characterId: "wren", source: "project", changedAt: 1_710_000_000_000 });
    expect(fs.statSync).toHaveBeenCalledTimes(1); expect(fs.statSync).toHaveBeenCalledWith(path);
    expect((await f.read()).characterAuthorship?.find(row => row.characterId === "wren")?.source).toBe("global");
  });
  it("does not mark a shipped definition as user-authored when its override is invalid", async () => {
    const f = fixture(), path = f.override("wren"); fs.writeFileSync(path, "not a character"); f.registry.invalidate();
    expect((await f.read()).characterAuthorship?.find(row => row.characterId === "wren")).toEqual({ characterId: "wren", source: "shipped", changedAt: null });
    expect(fs.statSync).not.toHaveBeenCalled();
  });
  it("exposes an unknown date and a problem if an effective file's metadata cannot be read", async () => {
    const f = fixture(), path = f.override("wren"); f.registry.read();
    vi.mocked(fs.statSync).mockImplementationOnce(() => { throw new Error("File metadata unavailable"); });
    const result = await f.read();
    expect(result.characterAuthorship?.find(row => row.characterId === "wren")).toEqual({ characterId: "wren", source: "global", changedAt: null });
    expect(result.problems).toContainEqual({ path, message: expect.stringContaining("File metadata unavailable") });
    expect(f.runtime.snapshot().problems).toEqual([]);
  });
  it("keeps the snapshot's file metadata when a later project layer appears", async () => {
    const f = fixture(); f.override("wren");
    vi.spyOn(f.runtime, "projectPath").mockReturnValue(f.project);
    vi.spyOn(f.runtime, "prepareRegistry").mockImplementation(async () => {
      const snapshot = f.runtime.snapshot("project");
      f.override("wren", "project", "later.md", "wren", 1_710_000_000_000);
      f.advanceRegistry(LIMITS.registryCacheMs + 1);
      return snapshot;
    });
    expect((await f.read("project")).characterAuthorship?.find(row => row.characterId === "wren")).toEqual({ characterId: "wren", source: "global", changedAt: 1_700_000_000_000 });
  });
  it("survives a character removal after the snapshot even when the cache has expired", async () => {
    const f = fixture(), path = f.override("custom-juno", "global", "custom.md", "juno");
    vi.spyOn(f.runtime, "prepareRegistry").mockImplementation(async () => {
      const snapshot = f.runtime.snapshot(); fs.unlinkSync(path);
      f.advanceRegistry(LIMITS.registryCacheMs + 1); return snapshot;
    });
    const read = vi.spyOn(f.registry, "read");
    const result = await f.read("project");
    expect(result.characterAuthorship?.find(row => row.characterId === "custom-juno")).toEqual({ characterId: "custom-juno", source: "global", changedAt: null });
    expect(result.problems).toContainEqual({ path, message: expect.stringMatching(/^Character presentation: /) });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("keeps the registry usable when report-voice presentation cannot be read", async () => {
    const f = fixture(), original = f.k.store.db.prepare.bind(f.k.store.db);
    vi.spyOn(f.k.store.db, "prepare").mockImplementation(sql => {
      if (sql.includes("voice_reports")) throw new Error("Report history unavailable");
      return original(sql);
    });
    const result = await f.read();
    expect(result.characters).toHaveLength(12);
    expect(result.characterReportVoices).toEqual([]);
    expect(result.problems).toContainEqual({ path: "reports", message: expect.stringContaining("Character presentation: Report history unavailable") });
  });
  it("recognises a voice saved through the existing editor without adding persisted metadata", async () => {
    const f = fixture(), original = f.registry.read().characters.find(c => c.id === "wren")!;
    const { name, hue, charge, temper, style, quirks, lines } = original;
    const says = { greet: ["Clear morning for {quest}."] };
    await f.rpc.saveCharacterVoice({ characterId: "wren", voice: { name, hue, charge, temper, style, quirks, lines, says } }, { experimental_caller: { kind: "client" } } as ExperimentalPluginRpcHandlerContext);
    const refreshed = await f.read();
    expect(refreshed.characters.find(c => c.id === "wren")?.says).toEqual(says);
    const result = refreshed.characterAuthorship?.find(row => row.characterId === "wren");
    expect(result?.source).toBe("global"); expect(result?.changedAt).toEqual(expect.any(Number));
    expect(fs.readFileSync(join(f.home, "characters/wren.md"), "utf8")).not.toMatch(/changedAt|editedAt|characterAuthorship/);
  });
  it("refreshes the registry and character surfaces after keeping an avatar", async () => {
    const f = fixture();
    f.member("worker", "juno");
    expect((await f.read()).characters.find(c => c.id === "juno")?.avatar).toBeUndefined();
    const invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate");
    const kept = await f.rpc.saveCharacterAvatar({ characterId: "juno", avatar: "7gqda" }, { experimental_caller: { kind: "client" } } as ExperimentalPluginRpcHandlerContext);
    expect(kept.avatar).toBe("7gqda");
    expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining([tags.registry(), tags.rows(), tags.room(), tags.thread("worker")]));
    expect((await f.read()).characters.find(c => c.id === "juno")?.avatar).toBe("7gqda");
  });
  it("returns prototype-like character ids as array values through strict JSON", async () => {
    const f = fixture(); f.override("constructor", "global", "constructor.md", "juno");
    f.member("worker", "constructor"); f.report();
    const result = registrySchema.parse(JSON.parse(JSON.stringify(await f.read())));
    expect(result.characterAuthorship?.find(row => row.characterId === "constructor")?.source).toBe("global");
    expect(result.characterReportVoices?.find(row => row.characterId === "constructor")?.voices).toHaveLength(1);
  });
  it("reads only the latest three nonempty done-report voices, with stable ordering", async () => {
    const f = fixture(); f.member();
    for (const id of ["a", "b", "c", "d"]) f.report({ id, voice: `Written ${id}` });
    f.report({ id: "blocked", status: "blocked", voice: "Not a success voice", createdAt: f.time() + 1 });
    f.report({ id: "decision", status: "needs-decision", voice: "Not a done report", createdAt: f.time() + 2 });
    f.report({ id: "empty", voice: " \t\n\u00a0", createdAt: f.time() + 3 });
    f.report({ id: "none", voice: null, createdAt: f.time() + 4 });
    expect((await f.read()).characterReportVoices).toEqual([{ characterId: "juno", voices: ["d", "c", "b"].map(id => ({ reportId: id, line: `Written ${id}`, at: f.time(), threadId: "worker", questId: null })) }]);
  });
  it("ranks reports across member threads separately for each character", async () => {
    const f = fixture(); f.member(); f.member("second"); f.member("third", "bram");
    f.report({ id: "old" }); f.report({ id: "new", memberThreadId: "second", createdAt: f.time() + 1 });
    f.report({ id: "other", memberThreadId: "third", createdAt: f.time() + 2 });
    const result = (await f.read()).characterReportVoices;
    expect(result?.find(row => row.characterId === "juno")?.voices.map(voice => voice.reportId)).toEqual(["new", "old"]);
    expect(result?.find(row => row.characterId === "bram")?.voices.map(voice => voice.reportId)).toEqual(["other"]);
  });
  it("does not turn stock lines, hires or a characterless report into said-in-a-report history", async () => {
    const f = fixture(); f.member("worker", null); f.report();
    f.k.store.event(f.time(), "lead", null, "member.hired", "Hired", { memberThreadId: "worker" });
    expect((await f.read()).characterReportVoices).toEqual([]);
  });
  it.each([false, true])("keeps archived report text/date but drops only deleted thread links (deleted=%s)", async deleted => {
    const f = fixture(); f.member(); const report = f.report();
    patchThreadFixture(f.k.store, "worker", { archivedAt: f.time(), ...(deleted ? { deletedAt: f.time() } : {}) });
    expect((await f.read()).characterReportVoices).toEqual([{ characterId: "juno", voices: [{ reportId: report.id, line: report.voice, at: report.createdAt, threadId: deleted ? null : "worker", questId: null }] }]);
  });
  it("keeps a cellar quest reference and removes a missing quest's link", async () => {
    const f = fixture(); f.member(); const quest = await seedQuest(f.k,"lead", "Retained work", "Result");
    putQuestFixture(f.k.store, quest.id, { ...quest, phase: "done", endedAt: f.time() }); f.k.archiveQuests([quest.id], true, { kind: "user" });
    f.report({ boardQuestId: quest.id });
    expect((await f.read()).characterReportVoices?.[0]?.voices[0]?.questId).toBe(quest.id);
    f.k.store.db.prepare("DELETE FROM tavern_records WHERE kind='quests' AND id=?").run(quest.id);
    expect((await f.read()).characterReportVoices?.[0]?.voices[0]?.questId).toBeNull();
  });
  it("refreshes the registry once for a newly stored report voice, not a duplicate retry", () => {
    const f = fixture(); f.member();
    const invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate");
    const input = { status: "done" as const, outcome: "Proved", voice: "An actual report line", evidence: [], artifacts: [], confidence: null };
    const report = f.k.report("worker", input);
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toHaveLength(1);
    expect(f.k.report("worker", input).id).toBe(report.id);
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toHaveLength(1);
  });
  it.each(["blocked", "needs-decision", "empty", "characterless"])("does not refresh registry for a %s report voice", kind => {
    const f = fixture(); f.member("worker", kind === "characterless" ? null : "juno");
    const invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate");
    f.k.report("worker", { status: kind === "blocked" || kind === "needs-decision" ? kind : "done", outcome: "Result", voice: kind === "empty" ? " \t\u00a0" : "An agent line", evidence: [], artifacts: [], confidence: null });
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toEqual([]);
  });
  it.each([
    { update: false, record: false }, { update: true, record: false },
    { update: false, record: true }, { update: true, record: true },
  ])("refreshes once on first deletion, including both native paths ($update, service record=$record)", async ({ update, record }) => {
    const f = fixture(); f.member(); f.report();
    if (record) f.k.store.put("serviceRecords", "past", { version: 1, questId: "past", title: "Past work", short: "Past", phase: "done", endedAt: f.time(), keeperThreadId: "lead", backfilledAt: null, completeSince: f.time(),
      credits: [{ characterId: "juno", role: "maker", verifiedWaypoints: 1, checks: 0, independentChecks: 0, sameFamilyChecks: 0, caught: 0, threadIds: ["worker"] }] });
    const invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate");
    const payload = makeThreadResponse({ id: "worker", deletedAt: f.time(), status: "idle" });
    if (update) f.runtime.updateThread(payload); else f.runtime.threadGone("worker");
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toHaveLength(1);
    f.runtime.threadGone("worker"); f.runtime.updateThread(payload);
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toHaveLength(1);
    expect((await f.read()).characterReportVoices?.[0]?.voices[0]?.threadId).toBeNull();
  });
  it("adds no writes or copied records when the registry is read repeatedly", async () => {
    const f = fixture(); f.member(); f.report(); f.runtime.serviceRecords.read();
    const before = f.k.store.db.prepare("SELECT kind,id,data FROM tavern_records ORDER BY kind,id").all();
    await f.read(); await f.read();
    expect(f.k.store.db.prepare("SELECT kind,id,data FROM tavern_records ORDER BY kind,id").all()).toEqual(before);
  });
  it("does one bounded report-history query per registry read, not one per character", async () => {
    const f = fixture(); f.member(); f.report();
    const prepare = vi.spyOn(f.k.store.db, "prepare");
    await f.read();
    const history = prepare.mock.calls.filter(([sql]) => sql.includes("voice_reports"));
    expect(history).toHaveLength(1);
  });
  it("does no file stats or presentation-history work on agent snapshots, configuration or ticks", async () => {
    const f = fixture(); f.override("wren"); f.member(); f.report();
    const prepare = vi.spyOn(f.k.store.db, "prepare"), invalidate = vi.spyOn(f.bb.rpc, "experimental_invalidate"); vi.mocked(fs.statSync).mockClear();
    const snapshot = f.runtime.snapshot();
    f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } }));
    await f.runtime.tick("lead");
    expect(snapshot).not.toHaveProperty("characterAuthorship"); expect(snapshot).not.toHaveProperty("characterReportVoices");
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("voice_reports"))).toEqual([]);
    expect(invalidate.mock.calls.filter(([tags]) => tags.includes("tavern:registry"))).toEqual([]);
  });
  it("derives the same voices from a data backup without any new record kinds", async () => {
    const f = fixture(); f.member(); f.report(); patchThreadFixture(f.k.store, "worker", { deletedAt: f.time() });
    const before = (await f.read()).characterReportVoices;
    expect(before).toEqual([{ characterId: "juno", voices: [{ reportId: "report-one", line: "An agent-written line", at: f.time(), threadId: null, questId: null }] }]);
    const source = new BackupRecords(f.k.store.db, new SettingsStore(f.k.store.db));
    const snapshot = source.capture(), db = new Database(":memory:"); databases.push(db);
    for (const sql of MIGRATIONS) db.exec(sql);
    new BackupRecords(db, new SettingsStore(db)).restore(snapshot);
    const keeper = withMemberFixtures(new Keeper(new KeeperStore(db), fakePort(), f.time));
    const runtime = new TavernRuntime(f.bb, keeper, f.registry);
    expect(registrySchema.parse(await rpcHandlers(runtime).registry({})).characterReportVoices).toEqual(before);
    expect(db.prepare("SELECT DISTINCT kind FROM tavern_records WHERE kind LIKE '%voice%' OR kind LIKE '%Voice%'").all()).toEqual([]);
  });
});
