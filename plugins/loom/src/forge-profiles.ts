// Forge profiles: command forges kept in Loom's own database, which any spec names with forge = { profile = "<id>" }.
// A spec stores only the id, so an edit here reaches every project that uses the profile at its next forge call; each
// change is recorded with the profile's hash on every project that runs it, and on its open pull requests' tickets.
import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ProjectRow, Store } from "./db/store";
import { andList } from "./prompts";
import { loomPost } from "./posts";
import { LoomError } from "./projects";
import { repoSettings } from "./repos";
import { canonicalJson, forgeProfileSchema, profileProblems, profilesNamed, readSpec, storedSpecErrors, type ForgeProfile, type ForgeProfiles, type Spec } from "./spec";
import { HUMAN_ACTOR } from "./states";

/** A profile was saved with a new hash; one event on each project whose spec in force names it. */
export const PROFILE_CHANGED = "forge.profile_changed";

/** The first 12 hex digits of the sha256 of the profile's canonical JSON. */
export function profileHash(profile: ForgeProfile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex").slice(0, 12);
}

const issuesText = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) =>
  issues.map((issue) => `${issue.path.map(String).join(".") || "profile"}: ${issue.message}`).join("; ");

/** A profile as the settings form, the CLI or an import gives it, checked; refused with every problem named. */
export function parseProfile(raw: unknown): ForgeProfile {
  const parsed = forgeProfileSchema.safeParse(raw);
  if (!parsed.success) throw new LoomError("loom_invalid_input", `The forge profile is not valid: ${issuesText(parsed.error.issues)}.`);
  const problems = profileProblems(parsed.data);
  if (problems.length > 0) throw new LoomError("loom_invalid_input", `The forge profile is not valid: ${problems.join(" ")}`);
  return parsed.data;
}

/**
 * Refuses an edit that would leave a project unable to run: each stored version a project uses (in force, or newer and
 * not approved yet) is checked with the edited profile as loom_propose would check it, and only the errors the edit
 * brings count, so a version that had a problem before does not block an unrelated edit.
 */
function editErrors(store: Store, profile: ForgeProfile): void {
  const edited: ForgeProfiles = { forgeProfile: (id) => (id === profile.id ? profile : store.forgeProfile(id)), forgeProfileIds: () => store.forgeProfileIds() };
  for (const project of store.projects()) {
    if (project.state === "archived") continue;
    const latest = store.latestSpecVersion(project.id);
    const versions = [...new Set([project.approved_version, latest?.version ?? null].filter((version): version is number => version !== null))];
    for (const version of versions) {
      const row = store.specVersion(project.id, version)!;
      if (!named(row.spec_json).includes(profile.id)) continue;
      const before = new Set(storedSpecErrors(row.spec_json, row.toml, store));
      const added = storedSpecErrors(row.spec_json, row.toml, edited).filter((error) => !before.has(error));
      if (added.length > 0) throw new LoomError("loom_invalid_input", `Loom kept the forge profile ${profile.id} as it was: the edit would leave ${project.slug} (spec v${version}) unable to run: ${added.join(" ")}`);
    }
  }
}

/** Which projects name the profile: in the spec in force, or in a newer version not approved yet. Archived projects do not count. */
export interface ProfileUse {
  slug: string;
  name: string;
  state: ProjectRow["state"];
  /** Whether the spec in force names it; false when only a newer version does. */
  inForce: boolean;
}

const named = (json: string | undefined) => (json === undefined ? [] : profilesNamed(JSON.parse(json) as Spec));

export function profileUses(store: Store, id: string): ProfileUse[] {
  return store.projects().flatMap((project) => {
    if (project.state === "archived") return [];
    const inForce = project.approved_version === null ? undefined : store.specVersion(project.id, project.approved_version)?.spec_json;
    const latest = store.latestSpecVersion(project.id)?.spec_json;
    const now = named(inForce).includes(id);
    return now || named(latest).includes(id) ? [{ slug: project.slug, name: project.name, state: project.state, inForce: now }] : [];
  });
}

/** Records a changed profile on every project that runs it: an event with both hashes, and a post on each ticket whose pull request it follows. */
function recordChange(store: Store, profile: ForgeProfile, hash: string, was: string): string[] {
  const told: string[] = [];
  for (const use of profileUses(store, profile.id).filter((each) => each.inForce && each.state !== "done")) {
    const project = store.projectBySlug(use.slug)!;
    const spec = readSpec(store.specVersion(project.id, project.approved_version!)!.spec_json, store);
    store.event(project.id, null, PROFILE_CHANGED, HUMAN_ACTOR, { profile: profile.id, hash, was });
    for (const ticket of store.tickets(project.id, ["pr_open", "merging"])) {
      if (repoSettings(spec, ticket.repo).forge.profile !== profile.id) continue;
      loomPost(store, ticket, {
        kind: "system",
        body: `The forge profile ${profile.name} (${profile.id}) changed, from version ${was} to ${hash}: Loom runs its new commands from its next call to the forge.`,
        data: { outcome: "forge_profile_changed", profile: profile.id, hash, was },
      });
    }
    told.push(use.slug);
  }
  return told;
}

/**
 * Saves a profile from the form or the CLI. `original` is the id of the profile being edited, or null for a new one, whose
 * id must be free; an id cannot change. Returns the saved profile, its hash, and the projects told of the change.
 */
export function saveProfile(store: Store, raw: unknown, original: string | null): { profile: ForgeProfile; hash: string; changed: boolean; told: string[] } {
  const profile = parseProfile(raw);
  if (original !== null && original !== profile.id) throw new LoomError("loom_invalid_input", `A forge profile's id cannot change: ${original} is named by its projects' specs. Add a new profile instead.`);
  const saved = store.forgeProfileRow(profile.id);
  if (original === null && saved !== null) throw new LoomError("loom_invalid_input", `Loom has a forge profile ${profile.id} already. Edit it, or give the new one another id.`);
  if (original !== null && saved === null) throw new LoomError("loom_not_found", `Loom has no forge profile ${original}.`);
  const hash = profileHash(profile);
  if (saved !== null && saved.hash === hash) return { profile, hash, changed: false, told: [] };
  if (saved !== null) editErrors(store, profile);
  const told = store.tx(() => {
    store.putForgeProfile(profile, hash);
    return saved === null ? [] : recordChange(store, profile, hash, saved.hash);
  });
  for (const slug of told) store.changed(store.projectBySlug(slug)!.id);
  return { profile, hash, changed: true, told };
}

/** Every stored spec version that names the profile, of any project, archived ones too: each one Loom must still be able to read. */
export function profileNamedBy(store: Store, id: string): Array<{ slug: string; version: number }> {
  return store.projects().flatMap((project) => {
    const latest = store.latestSpecVersion(project.id)?.version ?? 0;
    const out: Array<{ slug: string; version: number }> = [];
    for (let version = 1; version <= latest; version += 1) {
      const row = store.specVersion(project.id, version);
      if (row !== null && named(row.spec_json).includes(id)) out.push({ slug: project.slug, version });
    }
    return out;
  });
}

/**
 * Deletes a profile no stored spec names. Every reader of a spec version fills its profiles in, and a profile that is
 * gone would leave that version, and an archived project's history, unreadable, so Loom keeps any profile one names.
 */
export function deleteProfile(store: Store, id: string): void {
  if (store.forgeProfileRow(id) === null) throw new LoomError("loom_not_found", `Loom has no forge profile ${id}.`);
  const uses = profileUses(store, id);
  if (uses.length > 0) throw new LoomError("loom_invalid_state", `The forge profile ${id} is in use by ${andList(uses.map((use) => use.slug))}, so Loom keeps it. Point their specs at another forge first.`);
  const named = profileNamedBy(store, id);
  if (named.length > 0) {
    const bySlug = [...new Set(named.map((each) => each.slug))].map((slug) => `${slug} (${named.filter((each) => each.slug === slug).map((each) => `v${each.version}`).join(", ")})`);
    throw new LoomError("loom_invalid_state", `The forge profile ${id} is named by a stored spec of ${andList(bySlug)}, so Loom keeps it: those versions read their forge from it. Edit it instead of deleting it.`);
  }
  store.deleteForgeProfile(id);
}

/** Every profile as TOML, one [[forge]] table each, in the shape `bb loom forge import` reads. */
export function profilesToml(store: Store): string {
  const forge = store.forgeProfileRows().map((row) => row.profile);
  return forge.length === 0 ? "" : `${stringifyToml({ forge })}\n`;
}

/** The profiles a TOML file holds, each checked. */
export function profilesFromToml(toml: string): ForgeProfile[] {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch (error) {
    throw new LoomError("loom_invalid_input", `The TOML does not parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const unknown = Object.keys(raw).filter((key) => key !== "forge");
  if (unknown.length > 0) throw new LoomError("loom_invalid_input", `Unknown table ${unknown.join(", ")}: a forge profile file holds only [[forge]] tables.`);
  const tables = raw.forge ?? [];
  if (!Array.isArray(tables)) throw new LoomError("loom_invalid_input", "forge must be an array of tables: write each profile as [[forge]].");
  const profiles = tables.map((table, index) => {
    try {
      return parseProfile(table);
    } catch (error) {
      throw new LoomError("loom_invalid_input", `forge[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.id)) throw new LoomError("loom_invalid_input", `The file has two forge profiles with the id ${profile.id}. Give each its own id.`);
    seen.add(profile.id);
  }
  return profiles;
}

/**
 * What importing the TOML would do, one line per profile it adds or changes, with the projects a change reaches; with
 * `apply`, it does it. A profile the file does not list is kept: an import never removes one.
 */
export function importProfiles(store: Store, toml: string, apply: boolean): { changes: string[] } {
  const profiles = profilesFromToml(toml);
  const changes: string[] = [];
  const todo: Array<{ profile: ForgeProfile; adds: boolean }> = [];
  for (const profile of profiles) {
    const saved = store.forgeProfileRow(profile.id);
    if (saved !== null && saved.hash === profileHash(profile)) continue;
    if (saved !== null) editErrors(store, profile);
    const uses = saved === null ? [] : profileUses(store, profile.id).filter((use) => use.inForce);
    changes.push(saved === null ? `adds forge profile ${profile.id}` : `changes forge profile ${profile.id}${uses.length === 0 ? "" : `, which ${andList(uses.map((use) => use.slug))} ${uses.length === 1 ? "uses" : "use"} now`}`);
    todo.push({ profile, adds: saved === null });
  }
  if (apply) for (const { profile, adds } of todo) saveProfile(store, profile, adds ? null : profile.id);
  return { changes };
}
