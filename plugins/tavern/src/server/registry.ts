import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { scopeForClass } from "../scope/presets";
import { characterDefSchema, characterVoiceSchema, type CharacterDef, type CharacterVoice, type ClassDef } from "../shared/schema";
import { applyRegistryRecord, formatDefinition, formatPatch, parseRegistryRecord, withCharacterField, type Definition, type RegistryKind, type RegistryRecord } from "./registry-file";
import { LIMITS } from "./limits";

export interface RegistrySnapshot { classes: ClassDef[]; characters: CharacterDef[]; problems: { path: string; message: string }[] }
export interface RegistryFile { filename: string; source: Source; path: string | null; text: string }
export const CLASS_EDITABLE = ["label", "plain", "description", "body", "characters", "startable", "hireable", "scope"] as const;
export type ClassEdit = Partial<Pick<ClassDef, typeof CLASS_EDITABLE[number]>>;
export type CharacterEdit = Partial<CharacterVoice & Pick<CharacterDef, "avatar">>;
export type ClassTarget = { target: "global" | "project"; projectPath?: string | null };
type Source = "shipped" | ClassTarget["target"];
type Entry = { kind: RegistryKind; path: string; file: RegistryFile; record: RegistryRecord };
type Resolved = { entry: Entry; definition: Definition; fields: Map<string, Entry> };
type Problem = RegistrySnapshot["problems"][number];
type Layer = { source: Source; root: string; paths: Set<string>; entries: Entry[]; byKey: Map<string, Entry[]>; resolved: Map<string, Resolved>; poolProblems: Map<string, Problem> };
type Loaded = { at: number; layers: Layer[]; snapshot: RegistrySnapshot };
type Revision = ClassTarget & { revision: string };
export class RegistryConflict extends Error {}
const KIND_DIR = { class: "classes", character: "characters" } as const;
const keyFor = (kind: RegistryKind, id: string) => `${kind}/${id}`;
const entryKey = (entry: Entry) => keyFor(entry.kind, entry.record.id);
const value = (def: Definition | undefined, field: string): unknown => def ? Reflect.get(def, field) : undefined;
const fieldNames = (...defs: (Definition | undefined)[]) => [...new Set(defs.flatMap(def => Object.keys(def ?? {})))].filter(field => field !== "source" && field !== "id");
const scopeOrder = ["readonly", "checker", "worktree", "keeper", "open"];
const presetOf = (role: ClassDef) => (typeof role.scope === "string" ? role.scope : role.scope?.preset) ?? scopeForClass(role.id).preset;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const incompatible = (role: ClassDef, scope: Map<string, Resolved>) => role.characters.filter(id => !(scope.get(keyFor("character", id))?.definition as CharacterDef | undefined)?.classes.includes(role.id));
function poolError(role: ClassDef, ids: string[]) { return new Error(`Unknown or incompatible character in the ${role.label} pool: ${ids.join(", ")}`); }

function atomicWrite(path: string, raw: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, raw, { flag: "wx", mode: 0o600 });
  try { renameSync(tmp, path); } catch (error) { unlinkSync(tmp); throw error; }
}

export class Registry {
  private cache = new Map<string, Loaded>();
  private characterFiles = new WeakMap<CharacterDef, RegistryFile>();
  constructor(private readonly builtin: string, private readonly home = join(homedir(), ".agents/tavern"), private readonly now = Date.now) {}

  private load(projectPath?: string | null, replacements: ReadonlyMap<string, string | null> = new Map()): Loaded {
    if (projectPath && !isAbsolute(projectPath)) throw new Error("The project registry needs an absolute checkout path.");
    const layers: Layer[] = [], problems: RegistrySnapshot["problems"] = [];
    const roots: [Source, string][] = [["shipped", this.builtin]];
    if (this.home !== this.builtin) roots.push(["global", this.home]);
    if (projectPath) roots.push(["project", join(projectPath, ".agents/tavern")]);
    for (const [source, root] of roots) {
      const lower = layers.at(-1)?.resolved, resolved = new Map(lower), entries: Entry[] = [], byKey = new Map<string, Entry[]>(), paths = new Set<string>();
      for (const kind of ["character", "class"] as const) {
        const dir = join(root, KIND_DIR[kind]);
        const files = new Map<string, Dirent | undefined>();
        try { for (const file of readdirSync(dir, { withFileTypes: true })) files.set(file.name, file); }
        catch (error) { if (!missing(error)) problems.push({ path: dir, message: String(error) }); }
        for (const path of replacements.keys()) if (dirname(path) === dir) files.set(relative(dir, path), undefined);
        for (const filename of [...files.keys()].filter(name => name.endsWith(".md")).sort()) {
          const path = join(dir, filename);
          const replaced = replacements.get(path);
          if (replaced === null) continue;
          paths.add(path);
          try {
            const file = files.get(filename);
            if (file && !file.isFile() && !(file.isSymbolicLink() && statSync(path).isFile())) throw new Error("Expected a regular registry file.");
            const text = replaced ?? readFileSync(path, "utf8");
            const record = parseRegistryRecord(kind, text, source === "shipped" ? "builtin" : path);
            const entry = { kind, path, record, file: { filename, source, path: source === "shipped" ? null : path, text } };
            entries.push(entry);
            const key = entryKey(entry), candidates = byKey.get(key) ?? [];
            if (candidates.length) problems.push({ path, message: `Duplicate ${kind} id ${record.id}: also in ${candidates[0]!.path}.` });
            candidates.push(entry); byKey.set(key, candidates);
            if (source === "shipped" && record.format === "patch") throw new Error("A shipped definition must be a full file.");
            const base = lower?.get(key), definition = applyRegistryRecord(kind, record, base?.definition, path);
            const fields = new Map(record.format === "patch" ? base?.fields : undefined);
            for (const field of record.format === "patch" ? Object.keys(record.fields) : fieldNames(definition)) fields.set(field, entry);
            resolved.set(key, { entry, definition, fields });
          } catch (error) { problems.push({ path, message: String(error) }); }
        }
      }
      const poolProblems = new Map<string, Problem>();
      for (const [key, row] of resolved) {
        if (row.entry.kind !== "class" || row.entry.record.format !== "patch") continue;
        const role = row.definition as ClassDef, invalid = incompatible(role, resolved);
        // A broken pool blocks hiring, not the patch's scope or any other saved field.
        if (invalid.length) poolProblems.set(key, { path: row.entry.path, message: poolError(role, invalid).message });
      }
      layers.push({ source, root, entries, byKey, paths, resolved, poolProblems });
    }
    const final = layers.at(-1)!;
    problems.push(...final.poolProblems.values());
    const active = [...final.resolved.values()];
    const classes = active.filter(row => row.entry.kind === "class").map(row => row.definition as ClassDef);
    const characters = active.filter(row => row.entry.kind === "character").map(row => row.definition as CharacterDef);
    for (const row of active) if (row.entry.kind === "character") this.characterFiles.set(row.definition as CharacterDef, row.entry.file);
    return { at: this.now(), layers, snapshot: { classes, characters, problems } };
  }
  olderClassOverrides(): { id: string; path: string }[] {
    return this.read().classes.flatMap(role => {
      const file = this.sourceFile("class", role.id);
      if (file.source !== "global" || !file.path || this.patchedFields("class", role.id)) return [];
      const shipped = join(this.builtin, "classes", `${role.id}.md`);
      const localTime = statSync(file.path, { throwIfNoEntry: false })?.mtimeMs;
      const shippedTime = statSync(shipped, { throwIfNoEntry: false })?.mtimeMs;
      return localTime !== undefined && shippedTime !== undefined && localTime < shippedTime && readFileSync(file.path, "utf8") !== readFileSync(shipped, "utf8")
        ? [{ id: role.id, path: file.path }] : [];
    });
  }

  private cached(projectPath?: string | null) {
    const key = projectPath ?? "", cached = this.cache.get(key);
    if (cached && this.now() - cached.at < LIMITS.registryCacheMs) return cached;
    const loaded = this.load(projectPath);
    this.cache.set(key, loaded);
    return loaded;
  }
  read(projectPath?: string | null): RegistrySnapshot { return this.cached(projectPath).snapshot; }
  directories() { return { builtin: this.builtin, global: this.home }; }
  invalidate() { this.cache.clear(); }
  private resolved(kind: RegistryKind, id: string, projectPath?: string | null) {
    const row = this.cached(projectPath).layers.at(-1)!.resolved.get(keyFor(kind, id));
    if (!row) throw new Error(`Unknown ${kind}: ${id}`);
    return row;
  }
  sourceFile(kind: RegistryKind, id: string, projectPath?: string | null): RegistryFile { return { ...this.resolved(kind, id, projectPath).entry.file }; }
  file(kind: RegistryKind, id: string, projectPath?: string | null): RegistryFile {
    const { entry, definition } = this.resolved(kind, id, projectPath);
    return { ...entry.file, ...(entry.record.format === "patch" ? { text: formatDefinition(definition) } : {}) };
  }
  fieldFile(kind: RegistryKind, id: string, field: string, projectPath?: string | null): RegistryFile {
    const { entry, fields } = this.resolved(kind, id, projectPath);
    return { ...(fields.get(field) ?? entry).file };
  }
  patchedFields(kind: RegistryKind, id: string, projectPath?: string | null) {
    const { entry } = this.resolved(kind, id, projectPath);
    return entry.record.format === "patch" ? Object.keys(entry.record.fields) : null;
  }
  // Prepared snapshots can outlive their cache entry; their source must not come from a newer read.
  characterFile(character: CharacterDef): RegistryFile {
    const file = this.characterFiles.get(character);
    if (!file) throw new Error(`Unknown character source: ${character.id}`);
    return { ...file };
  }

  private revision(loaded: Loaded, key: string) {
    const hash = createHash("sha256");
    for (const layer of loaded.layers) {
      hash.update(`${layer.source}\0${layer.root}\0`);
      for (const entry of layer.byKey.get(key) ?? []) hash.update(`${entry.path}\0${entry.file.text}\0`);
    }
    return hash.digest("hex").slice(0, 32);
  }
  private layers(kind: RegistryKind, id: string, projectPath?: string | null) {
    const all = this.load(projectPath), key = keyFor(kind, id);
    const current = all.layers.at(-1)!.resolved.get(key)?.definition;
    if (!current) throw new Error(`Unknown ${kind}: ${id}`);
    const layers = all.layers.map(l => {
      const selected = l.byKey.get(key)?.at(-1);
      const definition = l.resolved.get(key)?.definition;
      return { source: l.source, path: selected?.path ?? join(l.root, KIND_DIR[kind], `${id}.md`), exists: !!selected,
        ...(selected ? { format: selected.record.format } : {}), ...(definition ? { definition } : {}) };
    });
    return { current, layers, revision: this.revision(all, key) };
  }
  classRevision(id: string, projectPath?: string | null) { return this.revision(this.cached(projectPath), keyFor("class", id)); }
  classLayers(id: string, projectPath?: string | null) {
    const { current, layers, revision } = this.layers("class", id, projectPath);
    return { current: current as ClassDef, layers: layers.map(({ definition, ...layer }) => ({ ...layer, ...(definition ? { definition: definition as ClassDef } : {}) })), revision };
  }
  characterLayers(id: string, projectPath?: string | null) { return this.layers("character", id, projectPath); }

  private selected(kind: RegistryKind, id: string, where: ClassTarget, loaded = this.load(where.projectPath)) {
    const key = keyFor(kind, id), index = loaded.layers.findIndex(layer => layer.source === where.target);
    const layer = loaded.layers[index];
    if (!layer) throw new Error("A project override needs a local project checkout.");
    const entry = layer.byKey.get(key)?.at(-1);
    const below = loaded.layers[index - 1]?.resolved.get(key);
    const current = layer.resolved.get(key)?.definition;
    const shipped = loaded.layers[0]!.resolved.get(key)?.definition;
    const shadowed = where.target === "global" && loaded.layers.at(-1)?.source === "project" && loaded.layers.at(-1)?.resolved.get(key)?.entry.file.source === "project";
    if (!current) throw new Error(`Unknown ${kind}: ${id} in this scope.`);
    const path = entry?.path ?? join(layer.root, KIND_DIR[kind], `${id}.md`);
    return { key, layer, loaded, entry, below, current, shipped, path, shadowed, revision: this.revision(loaded, key) };
  }
  private mutationProblem(where: ClassTarget, selected: ReturnType<Registry["selected"]>) {
    for (const layer of selected.loaded.layers) {
      const entries = layer.byKey.get(selected.key) ?? [];
      if (entries.length > 1) return `Duplicate registry ID in ${layer.root}. Resolve the duplicate files before editing.`;
      const dir = join(layer.root, KIND_DIR[selected.key.startsWith("class/") ? "class" : "character"]);
      if (selected.loaded.snapshot.problems.some(problem => problem.path === dir)) return `Could not read ${dir}.`;
      const [entry] = entries;
      if (entry && layer.resolved.get(selected.key)?.entry !== entry) return `Cannot use invalid override ${entry.path}.`;
    }
    if (!selected.entry && selected.layer.paths.has(selected.path)) return `Another definition occupies ${selected.path}.`;
    if (where.target === "project") {
      try { if (!statSync(where.projectPath!).isDirectory()) return "The project checkout is unavailable."; }
      catch (error) { if (missing(error)) return "The project checkout is unavailable."; throw error; }
    }
    const stop = where.target === "project" ? join(where.projectPath!, ".") : dirname(this.home);
    for (let path = selected.path; path !== stop && dirname(path) !== path; path = dirname(path)) {
      try { if (lstatSync(path).isSymbolicLink()) return `Cannot change a registry override through a symbolic link: ${path}.`; }
      catch (error) { if (!missing(error)) throw error; }
    }
    return null;
  }
  overrideSheet(kind: RegistryKind, id: string, where: ClassTarget, loaded?: Loaded) {
    const s = this.selected(kind, id, where, loaded), record = s.entry?.record;
    const fields = fieldNames(s.shipped, s.current).filter(field => (s.shipped && !same(value(s.shipped, field), value(s.current, field))) || (record?.format === "patch" && Object.hasOwn(record.fields, field)));
    const problem = this.mutationProblem(where, s);
    return { definition: s.current, name: "label" in s.current ? s.current.label : s.current.name, revision: s.revision, path: s.entry?.path ?? null,
      format: record?.format ?? null, hasDefault: !!s.shipped, canReset: !!s.shipped && !!s.entry && !problem, shadowed: !!s.shadowed,
      fallback: s.below?.entry.file.source ?? null, problem: problem ?? s.layer.poolProblems.get(s.key)?.message ?? null,
      fields: fields.map(field => ({ field, shipped: value(s.shipped, field) ?? null, current: value(s.current, field) ?? null, saved: record?.format === "patch" && Object.hasOwn(record.fields, field) })) };
  }
  overrides(where: ClassTarget) {
    if (where.target === "project" && (!where.projectPath || !statSync(where.projectPath).isDirectory())) throw new Error("The project checkout is unavailable.");
    const loaded = this.load(where.projectPath), layer = loaded.layers.find(l => l.source === where.target)!;
    const rows = layer.entries.flatMap(({ kind, path, record }) => {
      try {
        const s = this.selected(kind, record.id, where, loaded);
        const def = applyRegistryRecord(kind, record, s.below?.definition, path);
        const fields = record.format === "patch" ? Object.keys(record.fields) : fieldNames(s.below?.definition, def).filter(field => !same(value(s.below?.definition, field), value(def, field)));
        return [{ kind, path, id: record.id, name: "label" in def ? def.label : def.name, format: record.format, fields,
          canReset: !!s.shipped && s.entry?.path === path && !this.mutationProblem(where, s), hasDefault: !!s.shipped }];
      } catch { return []; } // The load failure already has its own row in problems.
    });
    const scopeProblems = new Set(layer.poolProblems.values());
    return { rows, problems: loaded.snapshot.problems.filter(p => scopeProblems.has(p) || p.path === layer.root || p.path.startsWith(`${layer.root}/`)) };
  }

  private validateChange(kind: RegistryKind, id: string, where: ClassTarget, path: string, text: string | null, baseline: Loaded) {
    const result = this.load(where.projectPath, new Map([[path, text]]));
    const failure = result.snapshot.problems.find(p => p.path === path);
    if (failure) throw new Error(failure.message);
    for (const layer of result.layers.filter(l => l.source !== "shipped" && (where.target === "global" || l.source === "project"))) {
      const previous = baseline.layers.find(old => old.source === layer.source);
      for (const [key, problem] of layer.poolProblems) {
        if (!same(previous?.poolProblems.get(key), problem)) throw new Error(problem.message);
      }
      for (const row of layer.resolved.values()) {
        if (row.entry.kind !== "class") continue;
        const role = row.definition as ClassDef;
        if (kind === "class" ? role.id !== id : !role.characters.includes(id)) continue;
        const invalid = incompatible(role, layer.resolved);
        if (invalid.length) throw poolError(role, invalid);
      }
    }
    return result;
  }
  private draft(kind: RegistryKind, id: string, fields: Record<string, unknown>, where: ClassTarget, revision?: string) {
    const s = this.selected(kind, id, where);
    if (revision !== undefined && revision !== s.revision) throw new RegistryConflict("This definition changed since you opened it.");
    const unsafe = this.mutationProblem(where, s);
    if (unsafe) throw new Error(unsafe);
    const changes = Object.entries(fields).filter(([field, next]) => next !== undefined && !same(value(s.current, field), next))
      .map(([field, to]) => ({ field, from: value(s.current, field) ?? null, to }));
    const edit = Object.fromEntries(changes.map(({ field, to }) => [field, to]));
    const source = s.path;
    let text: string | null = null, definition = s.current;
    if (changes.length) {
      if (s.entry?.record.format === "full") {
        text = kind === "class" ? formatDefinition({ ...s.current, ...edit }) : changes.reduce((raw, change) => withCharacterField(raw, change.field, change.to), s.entry.file.text);
        definition = applyRegistryRecord(kind, parseRegistryRecord(kind, text, source), undefined, source);
        if (kind === "character" && !same(definition, { ...s.current, ...edit })) throw new Error("The edit would change other character fields. No changes were saved.");
      } else {
        const patch = { ...s.entry?.record.fields };
        for (const { field, to } of changes) { if (same(to, value(s.below?.definition, field))) delete patch[field]; else patch[field] = to; }
        if (Object.keys(patch).length) {
          text = formatPatch(id, patch);
          definition = applyRegistryRecord(kind, parseRegistryRecord(kind, text, source), s.below?.definition, source);
        } else definition = s.below!.definition;
      }
      this.validateChange(kind, id, where, s.path, text, s.loaded);
    }
    if (kind === "class" && !changes.length) {
      const invalid = incompatible(definition as ClassDef, s.layer.resolved);
      if (invalid.length) throw poolError(definition as ClassDef, invalid);
    }
    return { definition, text, changes, path: s.path, shadowedBy: s.shadowed ? "project" as const : null };
  }
  previewClass(id: string, edit: ClassEdit, where: ClassTarget, revision?: string) {
    const out = this.draft("class", id, Object.fromEntries(Object.entries(edit).filter(([key]) => (CLASS_EDITABLE as readonly string[]).includes(key)).map(([key, value]) => [key, key === "body" && typeof value === "string" ? value.trim() : value])), where, revision);
    const scope = out.changes.find(change => change.field === "scope");
    const preset = (value: unknown) => (typeof value === "string" ? value : (value as { preset?: string } | null)?.preset) ?? scopeForClass(id).preset;
    const from = preset(scope?.from), to = preset(scope?.to);
    return { ...out, draft: out.definition as ClassDef, widening: scope && scopeOrder.indexOf(to) > scopeOrder.indexOf(from) ? [{ field: "scope" as const, from, to }] : [] };
  }
  saveClass(id: string, edit: ClassEdit, where: Revision): ClassDef {
    const out = this.previewClass(id, edit, where, where.revision);
    this.writeChange(out);
    return out.draft;
  }
  previewCharacter(id: string, edit: CharacterEdit, where: ClassTarget, revision?: string) {
    const { avatar, ...voice } = edit;
    return this.draft("character", id, { ...characterVoiceSchema.strict().partial().parse(voice), ...(avatar === undefined ? {} : { avatar: characterDefSchema.shape.avatar.unwrap().parse(avatar) }) }, where, revision);
  }
  saveCharacter(id: string, edit: CharacterEdit, where: Revision): CharacterDef {
    const out = this.previewCharacter(id, edit, where, where.revision);
    this.writeChange(out);
    return out.definition as CharacterDef;
  }
  saveVoice(id: string, voice: CharacterVoice) {
    return this.saveCharacter(id, voice, { target: "global", revision: this.characterLayers(id).revision });
  }
  saveAvatar(id: string, avatar: string) {
    return this.saveCharacter(id, { avatar }, { target: "global", revision: this.characterLayers(id).revision });
  }
  private writeChange(out: { path: string; text: string | null; changes: unknown[] }) {
    if (!out.changes.length) return;
    if (out.text === null) unlinkSync(out.path); else atomicWrite(out.path, out.text);
    this.invalidate();
  }

  private resetPlan(kind: RegistryKind, id: string, where: ClassTarget, field?: string) {
    const s = this.selected(kind, id, where), unsafe = this.mutationProblem(where, s);
    if (unsafe) throw new Error(unsafe);
    const entry = s.entry;
    if (!entry) throw new Error(`There is no ${where.target} override of ${id} to remove.`);
    if (!s.shipped || !s.below) throw new Error("Custom definition: no Tavern default. Reset does not delete a custom definition.");
    const { record } = entry, fields = record.format === "patch" ? Object.keys(record.fields) : fieldNames(s.current, s.below.definition).filter(key => !same(value(s.current, key), value(s.below?.definition, key)));
    let text: string | null = null;
    if (field !== undefined) {
      if (record.format !== "patch") throw new Error("A whole-file override can only be reset as a whole.");
      if (!Object.hasOwn(record.fields, field)) throw new Error(`The override does not save ${field}.`);
      const remaining = Object.fromEntries(Object.entries(record.fields).filter(([key]) => key !== field));
      if (Object.keys(remaining).length) text = formatPatch(id, remaining);
    }
    const after = this.validateChange(kind, id, where, s.path, text, s.loaded);
    const next = after.layers.find(l => l.source === where.target)!.resolved.get(s.key)!;
    const beforeRole = s.current as ClassDef, nextRole = next.definition as ClassDef;
    const wider = (before: ClassDef, next: ClassDef) => scopeOrder.indexOf(presetOf(next)) > scopeOrder.indexOf(presetOf(before)) ||
      (typeof before.scope === "object" && !same(before.scope, next.scope));
    const lastBefore = s.loaded.layers.at(-1)!.resolved.get(s.key)?.definition as ClassDef | undefined;
    const lastAfter = after.layers.at(-1)!.resolved.get(s.key)?.definition as ClassDef | undefined;
    const widening = kind === "class" && (wider(beforeRole, nextRole) || (!!lastBefore && !!lastAfter && wider(lastBefore, lastAfter)));
    const fallback = field === undefined ? s.below.entry.file.source : (s.below.fields.get(field) ?? s.below.entry).file.source;
    const revision = createHash("sha256").update(JSON.stringify([s.revision, where.target, field ?? null])).digest("hex");
    return { path: s.path, revision, name: "label" in s.current ? s.current.label : s.current.name,
      fields: field === undefined ? fields : [field], fallback, shadowed: !!s.shadowed, widening, format: record.format, text, before: entry.file.text };
  }
  previewReset(kind: RegistryKind, id: string, where: ClassTarget, field?: string) {
    const { text: _text, before: _before, ...preview } = this.resetPlan(kind, id, where, field);
    return preview;
  }
  resetOverride(kind: RegistryKind, id: string, where: Revision, field?: string, commit: (apply: () => void) => void = apply => apply()) {
    const loaded = this.load(where.projectPath);
    const revision = createHash("sha256").update(JSON.stringify([this.revision(loaded, keyFor(kind, id)), where.target, field ?? null])).digest("hex");
    if (revision !== where.revision) throw new RegistryConflict("This definition changed since you opened it.");
    const plan = this.resetPlan(kind, id, where, field);
    if (plan.revision !== where.revision) throw new RegistryConflict("This definition changed since you opened it.");
    let written = false;
    try {
      commit(() => {
        if (plan.text === null) unlinkSync(plan.path); else atomicWrite(plan.path, plan.text);
        written = true;
      });
    } catch (error) {
      if (written) atomicWrite(plan.path, plan.before);
      throw error;
    } finally { if (written) this.invalidate(); }
    return plan.path;
  }
  removeClassOverride(id: string, where: Revision) {
    if (this.classLayers(id, where.projectPath).revision !== where.revision) throw new RegistryConflict("This class changed since you opened it.");
    const preview = this.previewReset("class", id, where);
    return this.resetOverride("class", id, { ...where, revision: preview.revision });
  }
  validateRestore(files: ReadonlyMap<string, string>, projectPath?: string | null) {
    const loaded = this.load(projectPath, files);
    return loaded.snapshot.problems.filter(problem => files.has(problem.path));
  }
  character(classId: string, busy: (string | null)[], projectPath?: string | null, requested?: string | null): CharacterDef | null {
    const { classes, characters } = this.read(projectPath);
    const role = classes.find(c => c.id === classId);
    if (!role) throw new Error(`Unknown class: ${classId}`);
    const pool = role.characters.map(id => {
      const character = characters.find(character => character.id === id && character.classes.includes(classId));
      if (!character) throw new Error(`Unknown or incompatible character for ${classId}: ${id}`);
      return character;
    });
    if (!pool.length && !requested) return null;
    const character = requested ? pool.find(c => c.id === requested) : pool.find(c => !busy.includes(c.id)) ?? pool[0];
    if (!character) throw new Error(`No compatible character for ${classId}${requested ? `: ${requested}` : ""}`);
    return character;
  }
}
