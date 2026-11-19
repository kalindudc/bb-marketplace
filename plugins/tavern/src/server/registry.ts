import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { LIMITS } from "./limits";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stringify } from "yaml";
import { characterDefSchema, characterVoiceSchema, classDefSchema, type CharacterDef, type CharacterVoice, type ClassDef } from "../shared/schema";
import { parseRegistryDefinition, withCharacterField } from "./registry-file";

export interface RegistrySnapshot { classes: ClassDef[]; characters: CharacterDef[]; problems: { path: string; message: string }[] }
export interface RegistryFile { filename: string; source: "shipped" | "global" | "project"; path: string | null; text: string }
/**
 * The class fields the Classes page may edit. Everything else stays in the file or Settings: id and shape key files and crests; tools,
 * hires, budget, greenlight and environment widen what a Keeper may do; models are Settings' (which wins); and permission is moot,
 * because Tavern hires at full permission under Scopes and the scope preset is what limits a member.
 */
export const CLASS_EDITABLE = ["label", "plain", "description", "body", "characters", "startable", "hireable", "scope"] as const;
export type ClassEdit = Partial<Pick<ClassDef, typeof CLASS_EDITABLE[number]>>;
export type ClassTarget = { target: "global" | "project"; projectPath?: string | null };
export type ClassLayer = { source: "shipped" | "global" | "project"; path: string; exists: boolean };
/** The class files changed under the editor: another device, a text editor or a restore. Nothing was written. */
export class RegistryConflict extends Error {}
const SCOPE_ORDER = ["readonly", "checker", "worktree", "keeper", "open"] as const;
const presetOf = (scope: ClassDef["scope"]) => scope === undefined ? null : typeof scope === "string" ? scope : scope.preset;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export class Registry {
  private cache = new Map<string, { at: number; snapshot: RegistrySnapshot; files: Map<string, RegistryFile> }>();
  private characterFiles = new WeakMap<CharacterDef, RegistryFile>();
  constructor(private readonly builtin: string, private readonly home = join(homedir(), ".agents/tavern"), private readonly now = Date.now) {}
  read(projectPath?: string | null): RegistrySnapshot {
    const key = projectPath ?? "";
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < LIMITS.registryCacheMs) return cached.snapshot;
    const classes = new Map<string, ClassDef>();
    const characters = new Map<string, CharacterDef>();
    const files = new Map<string, RegistryFile>();
    const problems: RegistrySnapshot["problems"] = [];
    const roots = [this.builtin, this.home, ...(projectPath ? [join(projectPath, ".agents/tavern")] : [])];
    for (const root of roots) for (const kind of ["classes", "characters"] as const) {
      const dir = join(root, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        const path = join(dir, file);
        try {
          const raw = readFileSync(path, "utf8");
          const source = root === this.builtin ? "builtin" : path;
          let id: string;
          if (kind === "classes") {
            const parsed = parseRegistryDefinition("class", raw, source);
            classes.set(parsed.id, parsed); id = parsed.id;
          } else {
            const parsed = parseRegistryDefinition("character", raw, source);
            characters.set(parsed.id, parsed); id = parsed.id;
          }
          files.set(`${kind === "classes" ? "class" : "character"}/${id}`, { filename: file, source: root === this.builtin ? "shipped" : root === this.home ? "global" : "project", path: root === this.builtin ? null : path, text: raw });
        } catch (error) { problems.push({ path, message: String(error) }); }
      }
    }
    const snapshot = { classes: [...classes.values()], characters: [...characters.values()], problems };
    for (const character of snapshot.characters) this.characterFiles.set(character, files.get(`character/${character.id}`)!);
    this.cache.set(key, { at: this.now(), snapshot, files });
    return snapshot;
  }
  directories() { return { builtin: this.builtin, global: this.home }; }
  invalidate() { this.cache.clear(); }
  file(kind: "class" | "character", id: string, projectPath?: string | null): RegistryFile {
    this.read(projectPath);
    const file = this.cache.get(projectPath ?? "")?.files.get(`${kind}/${id}`);
    if (!file) throw new Error(`Unknown ${kind}: ${id}`);
    return { ...file };
  }
  // Prepared snapshots can outlive their cache entry; their source must not come from a newer read.
  characterFile(character: CharacterDef): RegistryFile {
    const file = this.characterFiles.get(character);
    if (!file) throw new Error(`Unknown character source: ${character.id}`);
    return { ...file };
  }
  saveVoice(characterId: string, voice: CharacterVoice): CharacterDef {
    return this.saveCharacterFields(characterId, characterVoiceSchema.parse(voice));
  }
  saveAvatar(characterId: string, avatar: string): CharacterDef {
    return this.saveCharacterFields(characterId, { avatar: characterDefSchema.shape.avatar.unwrap().parse(avatar) });
  }
  private saveCharacterFields(characterId: string, fields: Partial<CharacterVoice> & Pick<CharacterDef, "avatar">): CharacterDef {
    const file = this.file("character", characterId);
    const dir = join(this.home, "characters");
    const path = file.path ?? join(dir, `${characterId}.md`);
    let text = file.path ? readFileSync(path, "utf8") : file.text;
    const existing = parseRegistryDefinition("character", text, path);
    if (existing.id !== characterId) throw new Error("The character file changed. Reopen the editor before saving.");
    const expected = { ...existing };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const value = fields[key];
      if (value === undefined || isDeepStrictEqual(existing[key], value)) continue;
      text = withCharacterField(text, key, value);
      Object.assign(expected, { [key]: value });
    }
    const parsed = parseRegistryDefinition("character", text, path);
    if (!isDeepStrictEqual(parsed, expected)) throw new Error("The edit would change other character fields. No changes were saved.");
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    this.cache.clear();
    return parsed;
  }
  private classPath(target: ClassTarget["target"], id: string, projectPath?: string | null) {
    if (target === "project" && !projectPath) throw new Error("A project override needs a local project checkout.");
    return join(target === "global" ? this.home : join(projectPath!, ".agents/tavern"), "classes", `${id}.md`);
  }
  /** The class's three layers and one revision over all of them, so any change in any layer makes a save stale. */
  classLayers(id: string, projectPath?: string | null) {
    const current = this.read(projectPath).classes.find(c => c.id === id);
    if (!current) throw new Error(`Unknown class: ${id}`);
    const layers: ClassLayer[] = [
      { source: "shipped", path: join(this.builtin, "classes", `${id}.md`), exists: false },
      { source: "global", path: this.classPath("global", id), exists: false },
      ...(projectPath ? [{ source: "project" as const, path: this.classPath("project", id, projectPath), exists: false }] : []),
    ];
    const hash = createHash("sha256");
    for (const layer of layers) { layer.exists = existsSync(layer.path); hash.update(`${layer.source}\0${layer.exists ? readFileSync(layer.path, "utf8") : ""}\0`); }
    return { current, layers, revision: hash.digest("hex").slice(0, 32) };
  }
  private draftClass(id: string, edit: ClassEdit, where: ClassTarget) {
    const { current } = this.classLayers(id, where.projectPath);
    const fields = Object.fromEntries(Object.entries(edit).filter(([key]) => (CLASS_EDITABLE as readonly string[]).includes(key)));
    const merged = classDefSchema.parse({ ...current, ...fields, id: current.id });
    const known = new Set(this.read(where.projectPath).characters.filter(c => c.classes.includes(id)).map(c => c.id));
    const unknown = merged.characters.filter(c => !known.has(c));
    if (unknown.length) throw new Error(`Unknown or incompatible character in the pool: ${unknown.join(", ")}`);
    const path = this.classPath(where.target, id, where.projectPath);
    const { body, source: _source, ...frontmatter } = merged;
    const text = `---\n${stringify(frontmatter)}---\n${body}\n`;
    // The file must read back through the same parser the registry uses, or it is not saved.
    const draft = parseRegistryDefinition("class", text, path);
    return { current, draft, path, text };
  }
  /** What a save would change, read-only: each field from and to, the fields that widen what members may do, and a layer that would still win. */
  previewClass(id: string, edit: ClassEdit, where: ClassTarget) {
    const { current, draft, path } = this.draftClass(id, edit, where);
    const changes = CLASS_EDITABLE.filter(field => !same(current[field], draft[field])).map(field => ({ field, from: current[field] ?? null, to: draft[field] ?? null }));
    const widening = [
      ...(SCOPE_ORDER.indexOf(presetOf(draft.scope) ?? "readonly") > SCOPE_ORDER.indexOf(presetOf(current.scope) ?? "readonly") ? [{ field: "scope" as const, from: presetOf(current.scope), to: presetOf(draft.scope) }] : []),
    ];
    const shadowedBy = where.target === "global" && where.projectPath && existsSync(this.classPath("project", id, where.projectPath)) ? "project" as const : null;
    return { draft, path, changes, widening, shadowedBy };
  }
  saveClass(id: string, edit: ClassEdit, where: ClassTarget & { revision: string }): ClassDef {
    if (this.classLayers(id, where.projectPath).revision !== where.revision) throw new RegistryConflict("This class changed since you opened it.");
    const { draft, path, text } = this.draftClass(id, edit, where);
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
    this.cache.clear();
    return draft;
  }
  /** Deletes one override file the editor manages (global or project); the shipped file is never a target. */
  removeClassOverride(id: string, where: ClassTarget & { revision: string }) {
    if (this.classLayers(id, where.projectPath).revision !== where.revision) throw new RegistryConflict("This class changed since you opened it.");
    const path = this.classPath(where.target, id, where.projectPath);
    if (!existsSync(path)) throw new Error(`There is no ${where.target} override of ${id} to remove.`);
    unlinkSync(path);
    this.cache.clear();
    return path;
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
