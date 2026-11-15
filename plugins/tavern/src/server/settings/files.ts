import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { settingsFileSchema, settingsPreviewSchema } from "../../shared/settings";
import { LIMITS } from "../limits";
import { exportToml, previewToml } from "./toml";
import { SettingsConflict, type SettingsStore } from "./store";

export type SettingsPreview = z.infer<typeof settingsPreviewSchema>;
export type SettingsFile = z.infer<typeof settingsFileSchema>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export const fileHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function importSettings(store: SettingsStore, toml: string, apply: boolean, revision?: number, why = "Imported settings TOML", threadId: string | null = null): SettingsPreview {
  const snapshot = store.snapshot(), parsed = previewToml(toml, snapshot);
  const result: SettingsPreview = { code: parsed.problems.length ? "invalid" : "preview", revision: snapshot.revision,
    applied: false, changes: parsed.changes, problems: parsed.problems };
  if (!apply || parsed.problems.length) return result;
  if (revision === undefined) return { ...result, code: "invalid", problems: [{ line: 0, key: "revision", message: "Preview first and supply its settings revision." }] };
  try {
    store.replace(parsed.user, parsed.pinned, parsed.tuned, revision, why, threadId);
    return { ...result, code: "applied", applied: true, revision: store.snapshot().revision };
  } catch (error) {
    if (error instanceof SettingsConflict) return { ...result, code: "stale", revision: error.revision };
    throw error;
  }
}
export class SettingsFiles {
  constructor(readonly store: SettingsStore, readonly path = join(homedir(), ".agents/tavern/settings.toml")) {}
  private text() {
    if (statSync(this.path).size > LIMITS.tomlBytes) throw new Error(`Settings file exceeds ${LIMITS.tomlBytes} UTF-8 bytes.`);
    return readFileSync(this.path, "utf8");
  }
  status(): SettingsFile {
    try {
      const source = this.text(), preview = previewToml(source, this.store.snapshot());
      return { path: this.path, exists: true, differs: preview.problems.length > 0 || preview.changes.length > 0,
        error: preview.problems.length ? preview.problems.map(problem => `Line ${problem.line}: ${problem.message}`).join("; ").slice(0, 2000) : null,
        changedKeys: preview.changes.map(change => change.key), hash: fileHash(source) };
    } catch (error) {
      return { path: this.path, exists: !missing(error), differs: false, error: missing(error) ? null : String(error), changedKeys: [], hash: null };
    }
  }
  load(apply = false, revision?: number, expectedHash?: string | null): SettingsPreview {
    const status = this.status();
    if (apply && expectedHash === undefined) return { code: "invalid", revision: this.store.snapshot().revision, applied: false, changes: [],
      problems: [{ line: 0, key: "file", message: "Preview the file and supply its hash before applying it." }] };
    if (apply && expectedHash !== status.hash) return { code: "stale", revision: this.store.snapshot().revision, applied: false, changes: [], problems: [] };
    if (!status.exists) return { code: "invalid", revision: this.store.snapshot().revision, applied: false, changes: [], problems: [{ line: 0, key: "file", message: "Settings file does not exist." }] };
    return importSettings(this.store, this.text(), apply, revision, "Loaded settings file");
  }
  save(revision: number, withTuned = false, expectedHash?: string | null) {
    const snapshot = this.store.snapshot();
    if (revision !== snapshot.revision) throw new SettingsConflict(snapshot.revision);
    if (expectedHash !== undefined && expectedHash !== this.status().hash) throw new SettingsConflict(snapshot.revision);
    let target = this.path;
    try {
      lstatSync(this.path);
      target = realpathSync(this.path);
    } catch (error) {
      if (!missing(error)) throw error;
      try { if (lstatSync(this.path).isSymbolicLink()) throw new Error("Settings path is a broken symlink. Repair it before saving."); }
      catch (linkError) { if (!missing(linkError)) throw linkError; }
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, exportToml(snapshot, withTuned), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
    return this.status();
  }
}
