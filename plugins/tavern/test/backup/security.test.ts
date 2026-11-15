// @vitest-environment node
import { expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackupService } from "../../src/server/backup/service";
import { fileHash } from "../../src/server/settings/files";
import { recordsSnapshotSchema } from "../../src/server/backup/records";
import { LIMITS } from "../../src/server/limits";
import type { BackupBundle } from "../../src/shared/backup";
import { memberSchema } from "../../src/shared/schema";
import { levelFromWins } from "../../src/ui/page/model";
import { fixture, override } from "./helpers";

it("does not leak unselected class error snippets into a characters-only bundle", async () => {
  const f = fixture(); mkdirSync(join(f.home, "classes"));
  writeFileSync(join(f.home, "classes/broken.md"), "---\nid: broken\nlabel: [UNSELECTED_PRIVATE_MARKER\n---\nBody\n");
  const result = await f.backup.export({ parts: ["characters"] });
  expect(result.code).toBe("ok"); expect(result.json).not.toContain("UNSELECTED_PRIVATE_MARKER");
});
it("checks definition sizes before the registry reads even an unselected large file", async () => {
  const f = fixture(), custom = override(f); writeFileSync(custom.file, custom.raw + "x".repeat(LIMITS.backupFileBytes + 1));
  const read = vi.spyOn(f.registry, "read");
  await expect(f.backup.export({ parts: ["characters"] })).rejects.toThrow("limit");
  expect(read).not.toHaveBeenCalled();
});
it("never prunes the backup it just returned when the clock moves backwards", async () => {
  const f = fixture(); f.settings.update({ revision: 0, patch: { data: { backupKeep: 1 } }, why: "Keep one" });
  let now = 2_000_000_000_000;
  const backup = new BackupService({ ...f.backup.options, now: () => now });
  const first = await backup.save({}); now = 1000;
  const second = await backup.save({});
  expect(second.code).toBe("ok"); expect(existsSync(second.path!)).toBe(true);
  expect(second.pruned).toEqual([first.backup!.name]);
});
it("uses private directory and file modes for the saved bundle", async () => {
  const f = fixture(); override(f);
  const saved = await f.backup.save({ withData: true });
  expect(statSync(saved.path!).mode & 0o777).toBe(0o700);
  for (const file of ["manifest.json", "records.json", "settings.toml", "classes/custom-name.md"]) expect(statSync(join(saved.path!, file)).mode & 0o777).toBe(0o600);
});
it("checks saved SHA-256 hashes even when the file's size did not change", async () => {
  const f = fixture(), custom = override(f), saved = await f.backup.save({});
  writeFileSync(join(saved.path!, "classes/custom-name.md"), custom.raw.replace("My smith", "My smitH"));
  expect(() => f.backup.show(saved.backup!.name)).toThrow("SHA-256");
  expect((await f.backup.restore({ from: { name: saved.backup!.name }, apply: false })).code).toBe("invalid");
});
it("preserves a character's verified wins and derived level in a fresh-database round trip", async () => {
  const source = fixture(), character = source.registry.read().characters.find(character => character.classes.includes("smith"))!;
  const member = memberSchema.parse({ threadId: "maker", classId: "smith", characterId: character.id, role: "solo", keeperThreadId: null, boardQuestId: null, waypointId: null, errand: false, title: "Verified work", place: "rest", state: "done", doing: null, createdAt: 1000, lastActiveAt: null, lastReportAt: 1000, strikes: 0, verifiedWins: 17 });
  source.db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES(\'members\',?,?)").run(member.threadId, JSON.stringify(member));
  const exported = await source.backup.export({ withData: true }), target = fixture(), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false });
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  const row = target.db.prepare("SELECT data FROM tavern_records WHERE kind=\'members\' AND id=\'maker\'").get() as { data: string }, restored = memberSchema.parse(JSON.parse(row.data));
  expect(restored.characterId).toBe(character.id); expect(restored.verifiedWins).toBe(17); expect(levelFromWins(restored.verifiedWins)).toBe(3);
});
it("prevalidates a bad final SQL row without changing files, settings or records", async () => {
  const source = fixture(); override(source);
  source.settings.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Source setting" });
  source.db.prepare("INSERT INTO questlog_logs(thread_id,next_id,hydrated) VALUES('thread',3,1)").run();
  const exported = await source.backup.export({ withData: true }), bundle = JSON.parse(exported.json!) as BackupBundle;
  const data = recordsSnapshotSchema.parse(JSON.parse(bundle.files["records.json"]!));
  data.tables.questlog_history!.rows.push({ id: 1, thread_id: "thread", before_data: '{}', after_data: '{}', action: "bad", actor: '{"kind":"user"}', state: "invalid" });
  const text = JSON.stringify(data), file = bundle.manifest.files.find(file => file.kind === "records")!;
  bundle.files["records.json"] = text; file.bytes = Buffer.byteLength(text); file.sha256 = fileHash(text); bundle.manifest.data.bytes = file.bytes; bundle.manifest.counts.records = bundle.manifest.counts.records! + 1;
  const target = fixture(), preview = await target.backup.restore({ from: { bundle: JSON.stringify(bundle) }, apply: false });
  expect(preview.code).toBe("invalid"); expect(preview.problems.join(" ")).toContain("CHECK");
  expect(target.backup.records.empty()).toBe(true); expect(target.settings.read().tavern.voice).toBe("full");
  expect(existsSync(join(target.home, "classes/custom-name.md"))).toBe(false); expect(target.changed).not.toHaveBeenCalled();
});
it("refuses incompatible record schemas but permits the configuration restore", async () => {
  const source = fixture(); override(source);
  source.settings.update({ revision: 0, patch: { tavern: { voice: "off" } }, why: "Source setting" });
  const exported = await source.backup.export({ withData: true }), bundle = JSON.parse(exported.json!) as BackupBundle;
  bundle.manifest.migrations[0] = fileHash("Different SQL schema");
  const target = fixture(), from = { bundle: JSON.stringify(bundle) }, preview = await target.backup.restore({ from, apply: false });
  expect(preview.code).toBe("preview"); expect(preview.records.action).toBe("refused"); expect(preview.records.reason).toContain("different");
  expect((await target.backup.restore({ from, apply: true, previewHash: preview.previewHash })).code).toBe("applied");
  expect(target.settings.read().tavern.voice).toBe("off"); expect(readFileSync(join(target.home, "classes/custom-name.md"), "utf8")).toContain("My smith");
});
it("never substitutes an untrusted manifest path for an unavailable native project", async () => {
  const source = fixture(), custom = override(source, true), exported = await source.backup.export({ projects: true });
  writeFileSync(custom.file, "Do not overwrite this source checkout");
  const target = fixture(); target.backup.options.projects = async () => [];
  const preview = await target.backup.restore({ from: { bundle: exported.json! }, apply: false });
  expect(preview.code).toBe("invalid"); expect(preview.problems.join(" ")).toContain("No current local project");
  expect(readFileSync(custom.file, "utf8")).toBe("Do not overwrite this source checkout");
});
it("rechecks even same-file targets if they change after planning but before the transaction", async () => {
  const source = fixture(); override(source);
  const exported = await source.backup.export({}), target = fixture(), custom = override(target), from = { bundle: exported.json! };
  const preview = await target.backup.restore({ from, apply: false }), atomic = target.settings.atomic.bind(target.settings);
  vi.spyOn(target.settings, "atomic").mockImplementation(action => { writeFileSync(custom.file, "External edit after planning"); return atomic(action); });
  const result = await target.backup.restore({ from, apply: true, previewHash: preview.previewHash });
  expect(result.code).toBe("stale"); expect(readFileSync(custom.file, "utf8")).toBe("External edit after planning");
});
