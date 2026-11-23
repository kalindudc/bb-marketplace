import Sqlite from "better-sqlite3";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/server/settings/store";
import { SettingsFiles } from "../../src/server/settings/files";
import { settingsHandlers } from "../../src/server/settings/rpc";
import { settingsContract } from "../../src/shared/settings";
import { MIGRATIONS } from "../../src/server/migrations";
import type { Database } from "../../src/server/ports";
const close: (() => void)[] = [];
const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
function fixture() {
  const db = new Sqlite(":memory:"); db.exec(MIGRATIONS.join(";\n"));
  const directory = mkdtempSync(join(tmpdir(), "tavern-settings-"));
  close.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new SettingsStore(db as unknown as Database);
  const file = join(directory, "settings.toml");
  const files = new SettingsFiles(store, file);
  const handlers = settingsHandlers(store, files);
  return { store, file, files, handlers };
}
afterEach(() => close.splice(0).forEach(fn => fn()));
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, value) => {
    if (value === undefined) throw new Error("Undefined RPC property");
    return value;
  }));
}

describe("settings files and RPC", () => {
  it("does not create or silently apply a settings file", async () => {
    const { store, file, files } = fixture();
    expect(files.status()).toMatchObject({ exists: false, differs: false, error: null });
    writeFileSync(file, "[tavern]\npaused = true\n");
    expect(files.status()).toMatchObject({ exists: true, differs: true, changedKeys: ["tavern.paused"] });
    expect(store.read().tavern.paused).toBe(false);
    const preview = files.load(false);
    expect(preview.applied).toBe(false);
    expect(store.read().tavern.paused).toBe(false);
  });
  it("requires a fresh revision and file hash before applying a file preview", () => {
    const { store, file, files } = fixture();
    writeFileSync(file, "[tavern]\npaused = true\n");
    const hash = files.status().hash!;
    writeFileSync(file, '[tavern]\nvoice = "off"\n');
    expect(files.load(true, 0, hash).code).toBe("stale");
    expect(store.read().tavern.voice).toBe("full");
    expect(files.load(true, 0, files.status().hash!).code).toBe("applied");
    expect(store.read().tavern.voice).toBe("off");
  });
  it("saves explicit settings atomically and reports malformed files", () => {
    const { store, file, files } = fixture();
    store.update({ revision: 0, patch: { attention: { reviewBudget: 5 } }, why: "Review budget" });
    files.save(1, false, null);
    expect(readFileSync(file, "utf8")).toContain("review_budget = 5");
    expect(files.status().differs).toBe(false);
    writeFileSync(file, "[broken");
    expect(files.status().error).toMatch(/TOML|parse|table|Invalid/i);
    expect(files.load(true, 1, files.status().hash!).code).toBe("invalid");
    expect(store.read().attention.reviewBudget).toBe(5);
  });
  it("reports an unusable Git program and clears the diagnostic once it is executable", async () => {
    const { handlers, file } = fixture(), path = file + "-git";
    const saved = await handlers.settingsUpdate({ revision: 0, patch: { tavern: { gitProgram: path } }, why: "Choose Git" }, client);
    expect(saved).toMatchObject({ code: "ok", settings: { gitProgramProblem: expect.stringContaining(path) } });
    const view = async () => settingsContract.settings.output.parse(await handlers.settings(null, client));
    expect((await view()).gitProgramProblem).toContain("missing or not executable");
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o644 });
    expect((await view()).gitProgramProblem).toContain("missing or not executable");
    chmodSync(path, 0o755);
    expect((await view()).gitProgramProblem).toBeUndefined();
  });
  it("round-trips every RPC result as JSON and parses its public output schema", async () => {
    const { handlers } = fixture();
    const calls = {
      settings: null, settingsUpdate: { revision: 0, patch: { tavern: { paused: true } }, why: "Pause" },
      settingsUndo: { id: "missing", revision: 1, why: "Undo" }, settingsExport: {},
      settingsImport: { toml: "", apply: false }, settingsFile: { action: "status" },
      settingsApplySuggestion: { key: "tickSeconds", revision: 1 },
    };
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
      const output = await (handlers[key] as (input: unknown, context: typeof client) => unknown)(settingsContract[key].input.parse(calls[key]), client);
      expect(() => settingsContract[key].output.parse(json(output))).not.toThrow();
    }
  });
  it("returns typed stale and line-level invalid previews rather than mutating", async () => {
    const { store, handlers } = fixture();
    expect(await handlers.settingsUpdate({ revision: 99, patch: { tavern: { paused: true } }, why: "Stale" }, client)).toMatchObject({ code: "stale", revision: 0 });
    expect(await handlers.settingsImport({ toml: "[knobs]\ntick_seconds = 1", apply: true, revision: 0 }, client)).toMatchObject({ code: "invalid", problems: [expect.objectContaining({ line: 2, allowed: "30 to 300" })] });
    expect(store.read().tavern.paused).toBe(false);
  });
});
