import { commitUserAct, type UserActReceipt } from "../authority";
import { KeeperStore } from "../keeper/store";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { backupContract, backupManifestSchema, type BackupBundle, type BackupEntry, type BackupManifest, type BackupPart, type BackupRestore } from "../../shared/backup";
import type { Registry } from "../registry";
import { parseRegistryDefinition } from "../registry-file";
import type { SettingsStore } from "../settings/store";
import { SettingsConflict } from "../settings/store";
import { fileHash } from "../settings/files";
import { withoutForgeCommands } from "../settings/forge-cli";
import { exportToml, previewToml } from "../settings/toml";
import { MIGRATIONS } from "../migrations";
import { LIMITS } from "../limits";
import { atomicWrite } from "../../scope/store";
import { policySchema } from "../../scope/policy";
import { BackupRecords, recordsSnapshotSchema, type RecordsSnapshot } from "./records";
import { backupName, bundleHash, managedBackupName, safePayloadPath, sealBundle, validateBundle, type BackupFile } from "./codec";

type Input = { withData?: boolean; projects?: boolean; parts?: BackupPart[] };
export interface BackupProject { id: string; name: string; path: string }
export interface ProjectInventory { projects: BackupProject[]; problems: string[] }
export interface BackupOptions { settings: SettingsStore; registry: Registry; version: string; projects: () => Promise<BackupProject[] | ProjectInventory>; now?: () => number; changed?: () => void; warn?: (message: string) => void }
type Target = { path: string; logical: string; before: string | null; text: string; kind: "class" | "character" | "scopes" };
type SaveResult = { code: "ok" | "error"; backup: BackupEntry | null; path: string | null; manifest: BackupManifest | null; pruned: string[]; problem: string | null };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const problem = (error: unknown) => String(error).slice(0, 2000);
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
function readText(file: string, limit: number) {
  const info = statSync(file);
  if (!info.isFile() || info.size > limit) throw new Error(`Not a regular file within the ${limit}-byte limit: ${file}`);
  return readFileSync(file, "utf8");
}
function optionalText(file: string, limit: number) {
  try { lstatSync(file); } catch (error) { if (missing(error)) return null; throw error; }
  return readText(file, limit);
}
function physical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!missing(error)) throw error;
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Repair the broken symbolic link before restoring: ${path}`); }
    catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physical(parent), basename(path));
  }
}
function archiveText(directory: string, path: string, limit: number) {
  if (!safePayloadPath(path)) throw new Error(`Invalid backup path: ${path}`);
  let current = directory;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Saved backup contains a symbolic link: ${path}`);
  }
  return readText(current, limit);
}
function writeDirectory(parent: string, base: string, files: Record<string, string>) {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, ".tavern-"));
  let reserved: string | null = null;
  try {
    for (const [path, text] of Object.entries(files)) {
      if (!safePayloadPath(path)) throw new Error(`Invalid export path: ${path}`);
      const target = join(stage, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    for (let suffix = 0; suffix < 1000; suffix++) {
      const target = join(parent, base + (suffix ? `-${suffix}` : ""));
      try { mkdirSync(target, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      reserved = target; renameSync(stage, target); reserved = null; return target;
    }
    throw new Error("Too many exports share this minute; try again later.");
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (reserved !== null) rmSync(reserved, { recursive: true, force: true });
  }
}
class RestoreStale extends Error {}
export class BackupService {
  readonly records: BackupRecords;
  readonly dir: string;
  private readonly root: string;
  private readonly now: () => number;
  constructor(readonly options: BackupOptions) {
    this.records = new BackupRecords(options.settings.db, options.settings, options.now);
    this.root = options.registry.directories().global; this.dir = join(this.root, "backups"); this.now = options.now ?? Date.now;
  }
  private warn(message: string) { (this.options.warn ?? console.warn)(message); }
  private notify() { try { this.options.changed?.(); } catch (error) { this.warn(`Tavern backup committed but UI refresh failed: ${problem(error)}`); } }
  private entry(name: string, manifest: BackupManifest): BackupEntry {
    return { name, createdAt: manifest.createdAt, withData: manifest.data.included, projects: manifest.projects.length > 0, bytes: Buffer.byteLength(JSON.stringify(manifest, null, 2)) + manifest.files.reduce((n, file) => n + file.bytes, 0), tavernVersion: manifest.tavernVersion, counts: manifest.counts, problems: [...manifest.problems] };
  }
  private peek(name: string) {
    if (!managedBackupName(name)) throw new Error("Not a managed Tavern backup name");
    const directory = join(this.dir, name), info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error("Saved backup is a symbolic link");
    if (!info.isDirectory()) throw new Error("Saved backup is not a directory");
    const manifest = backupManifestSchema.parse(JSON.parse(archiveText(directory, "manifest.json", LIMITS.backupRpcBytes)));
    for (const file of manifest.files) {
      if (!safePayloadPath(file.path)) throw new Error(`Invalid backup path: ${file.path}`);
      let path = directory;
      for (const part of file.path.split("/")) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Error("Saved backup contains a symbolic link"); }
      if (!statSync(path).isFile() || statSync(path).size !== file.bytes) throw new Error(`Saved backup file has changed size: ${file.path}`);
    }
    return { directory, manifest, entry: this.entry(name, manifest) };
  }
  private scan() {
    let names: string[];
    try { names = readdirSync(this.dir).filter(managedBackupName); } catch (error) { if (missing(error)) return []; throw error; }
    return names.map(name => {
      try { return { entry: this.peek(name).entry, healthy: true }; }
      catch (error) { return { entry: { name, createdAt: 0, withData: false, projects: false, bytes: 0, tavernVersion: "unknown", counts: { classes: 0, characters: 0, records: null }, problems: [problem(error)] } as BackupEntry, healthy: false }; }
    }).sort((a, b) => b.entry.createdAt - a.entry.createdAt || b.entry.name.localeCompare(a.entry.name, "en", { numeric: true }));
  }
  list() {
    let backups: BackupEntry[] = [], error: string | null = null, dataBytes: number | null = null;
    try { backups = this.scan().map(row => row.entry); } catch (cause) { error = problem(cause); }
    try { dataBytes = this.records.estimateBytes() + 131072; } catch (cause) { this.warn(`Tavern backup size is unknown: ${problem(cause)}`); }
    return { dir: this.dir, keep: this.options.settings.read().data.backupKeep, backups, error, dataBytes, exportLimitBytes: LIMITS.backupRpcBytes };
  }
  private load(name: string) {
    const { directory, manifest } = this.peek(name);
    return validateBundle({ manifest, files: Object.fromEntries(manifest.files.map(file => [file.path, archiveText(directory, file.path, file.kind === "records" ? LIMITS.backupBundleBytes : LIMITS.backupFileBytes)])) });
  }
  show(name: string) { const bundle = this.load(name); return { path: join(this.dir, name), manifest: bundle.manifest, backup: this.entry(name, bundle.manifest) }; }
  private preflightDefinitions(projects: BackupProject[] = []) {
    const directories = this.options.registry.directories();
    for (const root of new Set([directories.builtin, directories.global, ...projects.map(project => join(project.path, ".agents/tavern"))])) {
      for (const kind of ["classes", "characters"]) {
        const directory = join(root, kind);
        let names: string[];
        try { names = readdirSync(directory); } catch (error) { if (missing(error)) continue; throw error; }
        for (const name of names.filter(name => name.endsWith(".md"))) {
          const path = join(directory, name), info = statSync(path);
          if (!info.isFile() || info.size > LIMITS.backupFileBytes) throw new Error(`Definition exceeds its regular-file size limit: ${path}`);
        }
      }
    }
  }
  private async projects(): Promise<ProjectInventory> {
    const value = await this.options.projects();
    return Array.isArray(value) ? { projects: value, problems: [] } : value;
  }
  private async capture(input: Input): Promise<BackupBundle> {
    const parts = [...new Set<BackupPart>(input.parts ?? ["settings", "classes", "characters", "scopes"])];
    const inventory = input.projects ? await this.projects() : { projects: [], problems: [] };
    const projects = inventory.projects, files: BackupFile[] = [], problems = new Set(inventory.problems);
    const add = (file: BackupFile) => { files.push(file); if (files.length > LIMITS.backupFiles) throw new Error("Too many backup files"); };
    this.preflightDefinitions(projects);
    this.options.registry.invalidate();
    for (const context of [null, ...projects]) {
      const root = context ? join(context.path, ".agents/tavern") : this.root;
      for (const kind of ["class", "character"] as const) {
        const directory = kind === "class" ? "classes" : "characters";
        if (!parts.includes(directory)) continue;
        const path = join(root, directory);
        let names: string[];
        try { names = readdirSync(path).filter(name => name.endsWith(".md")).sort(); } catch (error) { if (missing(error)) names = []; else throw error; }
        for (const name of names) {
          const text = readText(join(path, name), LIMITS.backupFileBytes);
          let id: string | null = null;
          try { id = parseRegistryDefinition(kind, text, join(path, name)).id; } catch (error) { problems.add(`${join(path, name)}: ${problem(error)}`); }
          add({ path: `${context ? `projects/${encodeURIComponent(context.id)}/` : ""}${directory}/${name}`, kind, effective: false, source: context ? "project" : "global", projectId: context?.id ?? null, id, text });
        }
      }
      const registry = this.options.registry.read(context?.path);
      for (const issue of registry.problems) {
        const kind = basename(dirname(issue.path));
        if ((kind === "classes" || kind === "characters") && parts.includes(kind)) problems.add(`${issue.path}: ${issue.message}`.slice(0, 2000));
      }
      for (const kind of ["class", "character"] as const) {
        const directory = kind === "class" ? "classes" : "characters";
        if (!parts.includes(directory)) continue;
        for (const definition of registry[directory]) {
          const file = this.options.registry.file(kind, definition.id, context?.path);
          add({ path: `effective/${context ? `projects/${encodeURIComponent(context.id)}/` : ""}${directory}/${definition.id}.md`, kind, effective: true, source: file.source, projectId: context?.id ?? null, id: definition.id, text: file.text });
        }
      }
    }
    if (parts.includes("settings")) add({ path: "settings.toml", kind: "settings", effective: false, source: "global", projectId: null, id: null, text: exportToml(this.options.settings.snapshot()) });
    if (parts.includes("scopes")) {
      const text = optionalText(join(this.root, "scopes.yml"), LIMITS.backupFileBytes);
      if (text !== null) add({ path: "scopes.yml", kind: "scopes", effective: false, source: "global", projectId: null, id: null, text });
    }
    let records: number | null = null;
    if (input.withData) {
      const snapshot = this.records.capture(); records = Object.values(snapshot.tables).reduce((n, table) => n + table.rows.length, 0);
      add({ path: "records.json", kind: "records", effective: false, source: "global", projectId: null, id: null, text: JSON.stringify(snapshot) });
    }
    const counts = { classes: new Set(files.filter(file => file.kind === "class" && file.id !== null).map(file => file.id)).size, characters: new Set(files.filter(file => file.kind === "character" && file.id !== null).map(file => file.id)).size, records };
    return sealBundle({ format: "tavern-backup/1", tavernVersion: this.options.version, createdAt: this.now(), schemaVersion: MIGRATIONS.length, migrations: MIGRATIONS.map(fileHash), machine: { hostname: hostname(), platform: platform(), arch: arch() }, projects, parts, counts, problems: [...problems] }, files);
  }
  async save(input: Input): Promise<SaveResult> {
    let bundle: BackupBundle, path: string;
    try { bundle = await this.capture(input); path = writeDirectory(this.dir, backupName(bundle.manifest.createdAt), { "manifest.json": JSON.stringify(bundle.manifest, null, 2), ...bundle.files }); }
    catch (error) { return { code: "error", backup: null, path: null, manifest: null, pruned: [], problem: problem(error) }; }
    const pruned: string[] = [];
    let warning: string | null = null;
    try {
      const keep = this.options.settings.read().data.backupKeep;
      if (keep) for (const row of this.scan().filter(row => row.healthy && row.entry.name !== basename(path)).slice(keep - 1)) {
        const target = join(this.dir, row.entry.name);
        if (lstatSync(target).isSymbolicLink()) continue;
        rmSync(target, { recursive: true }); pruned.push(row.entry.name);
      }
    } catch (error) { warning = `Backup saved, but retention failed: ${problem(error)}`; }
    this.notify();
    return { code: "ok", backup: this.entry(basename(path), bundle.manifest), path, manifest: bundle.manifest, pruned, problem: warning };
  }
  async export(input: Input, limit: number = LIMITS.backupRpcBytes) {
    const bundle = await this.capture(input), json = JSON.stringify(bundle), bytes = Buffer.byteLength(json);
    return bytes > limit ? { code: "too-large" as const, filename: null, json: null, counts: bundle.manifest.counts, bytes, limit } : { code: "ok" as const, filename: `tavern-backup-${backupName(bundle.manifest.createdAt)}.json`, json, counts: bundle.manifest.counts, bytes, limit };
  }
  registryFile(kind: "class" | "character", id: string) { this.preflightDefinitions(); this.options.registry.invalidate(); return this.options.registry.file(kind, id); }
  registryExportFolder(kind: "class" | "character", ids?: string[]) {
    this.preflightDefinitions(); this.options.registry.invalidate();
    const definitions = this.options.registry.read()[kind === "class" ? "classes" : "characters"];
    const selected = ids ?? definitions.map(definition => definition.id);
    if (!selected.length || new Set(selected).size !== selected.length) throw new Error("Choose at least one distinct registry id");
    const files = Object.fromEntries(selected.map(id => [`${id}.md`, this.options.registry.file(kind, id).text]));
    return { path: writeDirectory(join(this.root, "exports"), `${kind}-${backupName(this.now())}`, files), files: Object.keys(files) };
  }
  private target(logical: string, text: string, kind: Target["kind"]): Target {
    const path = physical(logical); return { path, logical, text, kind, before: optionalText(path, LIMITS.backupFileBytes) };
  }
  private async plan(bundle: BackupBundle) {
    const settings = this.options.settings.snapshot(), targets: Target[] = [], problems: string[] = [];
    const settingsFile = bundle.manifest.files.find(file => file.kind === "settings");
    const filtered = settingsFile ? withoutForgeCommands(bundle.files[settingsFile.path]!, settings) : null;
    const parsed = settingsFile ? previewToml(filtered?.toml ?? bundle.files[settingsFile.path]!, settings) : null;
    if (parsed) problems.push(...parsed.problems.map(issue => `Settings line ${issue.line}, ${issue.key}: ${issue.message}`));
    const needsProjects = bundle.manifest.files.some(file => !file.effective && file.source === "project"), projects = needsProjects ? (await this.projects()).projects : [];
    for (const file of bundle.manifest.files) {
      if (file.effective || file.kind === "settings" || file.kind === "records") continue;
      try {
        const kind = file.kind, text = bundle.files[file.path]!;
        const project = file.projectId === null ? null : projects.find(project => project.id === file.projectId);
        if (file.projectId !== null && !project) throw new Error(`No current local project matches ${file.projectId}; the manifest path is never used as a destination`);
        const root = project ? join(project.path, ".agents/tavern") : this.root;
        const logical = kind === "scopes" ? join(root, "scopes.yml") : join(root, kind === "class" ? "classes" : "characters", basename(file.path));
        if (kind === "scopes") { const document = parseDocument(text); if (document.errors.length) throw document.errors[0]; policySchema.parse(document.toJS()); }
        else if (parseRegistryDefinition(kind, text, logical).id !== file.id) throw new Error("Definition id does not match its manifest");
        const target = this.target(logical, text, kind), existing = targets.find(other => other.path === target.path);
        if (existing && existing.text !== text) throw new Error(`Conflicting files target ${target.path}`);
        if (!existing) targets.push(target);
      } catch (error) { problems.push(`${file.path}: ${problem(error)}`); }
    }
    let data: RecordsSnapshot | null = null;
    const records: BackupRestore["records"] = { action: "none", counts: {}, reason: null };
    if (bundle.manifest.data.included) {
      try {
        data = recordsSnapshotSchema.parse(JSON.parse(bundle.files["records.json"]!));
        records.counts = Object.fromEntries(Object.entries(data.tables).map(([name, table]) => [name, table.rows.length]));
        if (total(records.counts) !== bundle.manifest.counts.records) throw new Error("Records count does not match the manifest");
        const compatible = bundle.manifest.migrations.every((hash, index) => MIGRATIONS[index] !== undefined && fileHash(MIGRATIONS[index]!) === hash);
        if (!compatible) { records.action = "refused"; records.reason = "The records require a different Tavern database schema. Configuration can still restore."; }
        else if (!this.records.empty()) { records.action = "refused"; records.reason = "Records require an empty Tavern database. Existing records will not be overwritten; configuration can still restore."; }
        else { this.records.validate(data); records.action = "restore"; }
      } catch (error) { problems.push(`Records: ${problem(error)}`); }
    }
    const previewHash = fileHash(JSON.stringify({ bundle: bundleHash(bundle), revision: settings.revision, files: targets.map(target => ({ path: target.path, logical: target.logical, before: target.before === null ? null : fileHash(target.before) })), records: data ? this.records.counts() : null }));
    const result: BackupRestore = { code: problems.length ? "invalid" : "preview", previewHash, settings: { changes: parsed?.changes ?? [] }, ...(filtered ? { skippedForgeProfiles: filtered.skipped } : {}), files: targets.map(target => ({ path: target.path, kind: target.kind, action: target.before === target.text ? "same" : target.before === null ? "add" : "change" })), records, problems };
    return { result, targets, parsed, revision: settings.revision, data };
  }
  async restore(input: { from: { name: string } | { bundle: string }; apply: boolean; previewHash?: string }, receipt?: UserActReceipt): Promise<BackupRestore> {
    const invalid = (error: unknown): BackupRestore => ({ code: "invalid", previewHash: "", settings: { changes: [] }, files: [], records: { action: "none", counts: {}, reason: null }, problems: [problem(error)] });
    try {
      const request = backupContract.backupRestore.input.parse(input);
      if (request.apply && !request.previewHash) return invalid("Preview first and supply its previewHash before applying.");
      const bundle = "name" in request.from ? this.load(request.from.name) : validateBundle(request.from.bundle), plan = await this.plan(bundle);
      if (!request.apply || plan.result.code === "invalid") return plan.result;
      if (request.previewHash !== plan.result.previewHash) return { ...plan.result, code: "stale" };
      const written: Target[] = [];
      try {
        commitUserAct(new KeeperStore(this.options.settings.db), () => this.options.settings.now(), receipt, () => this.options.settings.atomic(() => {
          if (plan.result.records.action === "restore" && plan.data) this.records.restore(plan.data);
          for (const target of plan.targets) {
            const latest = this.target(target.logical, target.text, target.kind);
            if (latest.path !== target.path || latest.before !== target.before) throw new RestoreStale("Files changed after preview");
            if (target.before === target.text) continue;
            mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 }); atomicWrite(target.path, target.text); written.push(target);
          }
          this.options.registry.invalidate();
          if (plan.parsed) this.options.settings.replace(plan.parsed.user, plan.parsed.pinned, plan.parsed.tuned, plan.revision, "Restored Tavern backup");
        }));
      } catch (error) {
        const rollbackProblems: string[] = [];
        for (const target of written.reverse()) {
          try {
            if (optionalText(target.path, LIMITS.backupFileBytes) !== target.text) throw new Error("File changed outside Tavern; it was not overwritten during rollback");
            if (target.before === null) unlinkSync(target.path); else atomicWrite(target.path, target.before);
          } catch (error) { rollbackProblems.push(`${target.path}: ${problem(error)}`); }
        }
        this.options.registry.invalidate();
        return { ...plan.result, code: error instanceof RestoreStale || error instanceof SettingsConflict ? "stale" : "invalid", problems: [problem(error), ...rollbackProblems] };
      }
      this.notify(); return { ...plan.result, code: "applied" };
    } catch (error) { return invalid(error); }
  }
}
