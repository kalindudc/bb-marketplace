// @vitest-environment node
import { expect, it, vi } from "vitest";
import { defineCli } from "@get-bb/plugin-sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupCommands } from "../../src/server/backup/cli";
import { LIMITS } from "../../src/server/limits";
import { validateBundle } from "../../src/server/backup/codec";
import { fixture, override } from "./helpers";
function cli() {
  const f = fixture(), commands = defineCli({ name: "tavern", summary: "Tavern", commands: backupCommands(f.backup) });
  return { ...f, run: (args: string[], ctx = {}) => commands.run(args, ctx) };
}
it("exports one untruncated JSON bundle without a host, including with --json", async () => {
  const f = cli(), custom = override(f); writeFileSync(custom.file, custom.raw + "\n" + "Long private class body. ".repeat(4000));
  for (const flags of [[], ["--json"]]) {
    const result = await f.run(["backup", "export", ...flags]);
    expect(result.exitCode).toBe(0); expect(result.stdout!.length).toBeGreaterThan(60000);
    expect(validateBundle(result.stdout).files["classes/custom-name.md"]).toBe(readFileSync(custom.file, "utf8"));
  }
});
it("lets an agent save and inspect a backup with stable JSON results", async () => {
  const f = cli();
  const saved = await f.run(["backup", "save", "--with-data", "--json"], { threadId: "agent" });
  expect(saved.exitCode).toBe(0); const body = JSON.parse(saved.stdout!);
  expect(body).toMatchObject({ code: "ok", manifest: { data: { included: true } } });
  expect(body.path).toBe(join(f.backup.dir, body.backup.name));
  expect(JSON.parse((await f.run(["backup", "list", "--json"])).stdout!).backups).toHaveLength(1);
  expect(JSON.parse((await f.run(["backup", "show", body.backup.name, "--json"])).stdout!).manifest).toEqual(body.manifest);
});
it("previews named restores, applies explicitly, and refuses agent restore mutations", async () => {
  const f = cli(), saved = await f.backup.save({});
  const before = f.settings.snapshot().revision;
  const preview = await f.run(["backup", "restore", saved.backup!.name, "--json"]);
  expect(preview.exitCode).toBe(0); expect(JSON.parse(preview.stdout!).code).toBe("preview"); expect(f.settings.snapshot().revision).toBe(before);
  const denied = await f.run(["backup", "restore", saved.backup!.name, "--apply", "--json"], { threadId: "agent" });
  expect(denied.exitCode).toBe(2); expect(JSON.parse(denied.stdout!).code).toBe("forbidden");
  expect(JSON.parse((await f.run(["backup", "restore", saved.backup!.name, "--apply", "--json"])).stdout!).code).toBe("applied");
});
it("returns exit 3 for stale preview hashes and exit 2 for ambiguous or invalid input", async () => {
  const f = cli(), exported = await f.backup.export({});
  const stale = await f.run(["backup", "restore", "--bundle", exported.json!, "--apply", "--preview-hash", "old", "--json"]);
  expect(stale.exitCode).toBe(3); expect(JSON.parse(stale.stdout!).code).toBe("stale");
  const ambiguous = await f.run(["backup", "restore", "name", "--bundle", exported.json!, "--json"]);
  expect(ambiguous.exitCode).toBe(2); expect(JSON.parse(ambiguous.stdout!).code).toBe("invalid");
  expect((await f.run(["backup", "export", "--parts", "secrets", "--json"])).exitCode).toBe(2);
});
it("returns exit 1 for an operational save failure and never reports a partial success", async () => {
  const f = cli(); vi.spyOn(f.backup, "save").mockResolvedValue({ code: "error", backup: null, path: null, manifest: null, pruned: [], problem: "Injected disk full" });
  const result = await f.run(["backup", "save", "--json"]);
  expect(result.exitCode).toBe(1); expect(JSON.parse(result.stdout!)).toMatchObject({ code: "error", problem: "Injected disk full" });
});
it("uses the core-safe stdout cap and returns typed too-large without partial JSON", async () => {
  const f = cli(); const spy = vi.spyOn(f.backup, "export").mockResolvedValue({ code: "too-large", filename: null, json: null, counts: { classes: 0, characters: 0, records: 20 }, bytes: LIMITS.backupCliBytes + 1, limit: LIMITS.backupCliBytes });
  const result = await f.run(["backup", "export", "--with-data", "--json"]);
  expect(result.exitCode).toBe(2); expect(JSON.parse(result.stdout!)).toMatchObject({ code: "too-large", json: null, limit: LIMITS.backupCliBytes });
  expect(spy.mock.calls[0]![1]).toBe(LIMITS.backupCliBytes);
});
