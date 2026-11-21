// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import tavern from "../../server";
import { Keeper } from "../../src/server/keeper/service";
import { KeeperStore } from "../../src/server/keeper/store";
import { MIGRATIONS } from "../../src/server/migrations";
import { TavernRuntime } from "../../src/server/runtime";
import { settingsSchema } from "../../src/shared/settings";
import { createFakePluginHost, makeThreadResponse } from "./host";
import { providerSdk } from "./provider-fixture";
import { fakePort } from "./support";
import { setup } from "./runtime-fixture";

const location = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => location.home }));

it("bounds storage and host work in a steady sweep of 21 Keepers", async () => {
  location.home = mkdtempSync(join(tmpdir(), "tavern-sweep-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(location.home, "pi-agent"));
  const raw = new Database(join(location.home, "data.db"));
  const disposals: (() => unknown)[] = [];
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const ids = Array.from({ length: 21 }, (_, i) => `keeper-${i}`);
  const working = ids.at(-1);
  try {
    raw.exec(MIGRATIONS.join(";\n"));
    const store = new KeeperStore(raw), keeper = new Keeper(store, fakePort(), Date.now);
    for (const id of ids) {
      keeper.bind(id, "keeper", "wren", "project");
      store.patch(id, { eventSequence: 1 });
      store.event(Date.now(), id, null, "fixture.history", "Earlier work");
    }
    raw.exec(`CREATE TEMP TABLE identical_runtime_upserts (id TEXT);
      CREATE TEMP TRIGGER count_identical_runtime_upsert AFTER UPDATE ON tavern_runtime
      WHEN old.data IS new.data BEGIN INSERT INTO identical_runtime_upserts VALUES (new.thread_id); END`);
    const statementCalls: { sql: string; args: unknown[] }[] = [], prepared: string[] = [];
    const db = new Proxy(raw, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          prepared.push(sql);
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(stmt, op) {
              if (op === "get" || op === "all" || op === "run") return (...args: unknown[]) => {
                statementCalls.push({ sql, args });
                return stmt[op](...args);
              };
              return Reflect.get(stmt, op);
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const host = createFakePluginHost({ pluginId: "tavern", sdk: {
      providers: providerSdk(),
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === working ? "active" : "idle" }),
        events: { list: async () => [] }, queuedMessages: { list: async () => [] },
        defaultExecutionOptions: async () => null, send: async () => ({ delivery: "sent" }),
        getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}),
      },
      plugins: { list: async () => ({ plugins: [] }), callRpc: async () => ({ ok: true }) },
    } });
    let runtime!: TavernRuntime;
    const enableSettings = TavernRuntime.prototype.enableSettings;
    vi.spyOn(TavernRuntime.prototype, "enableSettings").mockImplementation(function (this: TavernRuntime, ...args) {
      runtime = this;
      enableSettings.apply(this, args);
    });
    Object.assign(host.bb, {
      storage: { database: () => db, migrate: () => {} },
      settings: { define: () => ({ get: async () => ({ scopes: "enforce" }), onChange: () => {} }) },
      ui: { registerMentionProvider: vi.fn() }, background: { service: vi.fn() },
      experimental_hooks: { ...host.bb.experimental_hooks, on: vi.fn() }, onDispose: (fn: () => unknown) => disposals.push(fn),
    });
    await tavern(host.bb);
    await runtime.reconcile();
    for (let i = 1; i <= 8; i++) {
      clock.mockReturnValue(1_000_000 + i * 5000);
      await runtime.sweep();
    }
    const getCalls = () => host.harness.inspection.sdk.callsTo("threads.get").length;
    const beforeGets = getCalls();
    const settingsJson = (raw.prepare("SELECT data FROM tavern_settings WHERE id=1").get() as { data: string }).data;
    let settingsParses = 0;
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (value === settingsJson) settingsParses++;
      return parse(value, reviver);
    });
    raw.exec("DELETE FROM identical_runtime_upserts");
    const warnings = vi.mocked(host.bb.log.warn).mock.calls.length;
    const seenPrepares = new Set(prepared);
    statementCalls.length = prepared.length = 0;
    const parseEffective = vi.spyOn(settingsSchema, "parse");
    clock.mockReturnValue(1_045_000);
    await runtime.sweep();
    expect(vi.mocked(host.bb.log.warn).mock.calls.slice(warnings)).toEqual([]);
    const runtimeReads = ids.map(id => statementCalls.filter(({ sql, args }) =>
      sql === "SELECT data FROM tavern_runtime WHERE thread_id=?" && args[0] === id).length);
    const counts = {
      statements: statementCalls.length, prepares: prepared.length, repeatedPrepares: prepared.filter(sql => seenPrepares.has(sql)).length,
      settingsParses, effectiveSettingsParses: parseEffective.mock.calls.length,
      settingsReads: statementCalls.filter(({ sql }) => sql === "SELECT revision,data FROM tavern_settings WHERE id=1").length,
      maxRuntimeReads: Math.max(...runtimeReads),
      identicalUpserts: (raw.prepare("SELECT count(*) AS n FROM identical_runtime_upserts").get() as { n: number }).n,
      threadGets: getCalls() - beforeGets,
    };
    console.info("steady sweep:", JSON.stringify(counts));
    expect(counts).toMatchObject({ repeatedPrepares: 0, settingsParses: 0, effectiveSettingsParses: 0, settingsReads: 0, identicalUpserts: 0 });
    expect(counts.statements).toBeLessThanOrEqual(410);
    expect(counts.maxRuntimeReads).toBeLessThanOrEqual(1);
    expect(counts.threadGets).toBe(21);
    expect(runtime.keeper.member(working!)?.state).toBe("working");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    try { for (const dispose of disposals.reverse()) await dispose(); }
    finally { raw.close(); rmSync(location.home, { recursive: true, force: true }); }
  }
});

it("checks the Keeper with bb only while a member has an initial brief recorded", async () => {
  const { runtime, k, harness, time } = setup();
  try {
    k.bind("child", "smith", "juno", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null,
      errand: true, title: "Build", brief: { outcome: "Build", mode: "make-it-work", outOfScope: "", doneWhen: "Tests", context: [], questions: [], timeboxMinutes: null } });
    const send = vi.spyOn(runtime, "sendInitialBrief").mockResolvedValue({ briefPending: false });
    await runtime.retryInitialBriefs("lead");
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    k.store.patch("child", { memberEngagement: { delivery: { id: "brief", text: "Build", attempts: 0,
      nextAttemptAt: time(), attemptedAt: null, error: null, hostAfterSeq: 0 } } });
    await runtime.retryInitialBriefs("lead");
    expect(harness.inspection.sdk.callsTo("threads.get").map(call => call.args[0])).toEqual([{ threadId: "lead" }]);
    expect(send).toHaveBeenCalledExactlyOnceWith("child", "Build");
  } finally { k.store.db.close(); }
});
