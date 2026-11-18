import type { PlacementRule, PlacementSettings } from "../../shared/placement-settings";
import type { Room } from "../../shared/contract";
import { memberName } from "../../shared/member-name";
import type { PlacementCatalog, PlacementPreview, PlacementPreviewInput } from "./machines-contract";
import type { PlacementWarning } from "../../shared/placement-rpc";

export type Rule = PlacementRule;
export type Match = Rule["match"];
export type MatchField = keyof Match;
export type Target = Rule["target"];
export type ProviderTarget = Extract<Target, { kind: "provider" }>;
export type Machine = ProviderTarget["machine"];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Problem = { line?: number; key: string; message: string; allowed?: string };

import { POSTURE } from "../../shared/placement-view";
export { POSTURE } from "../../shared/placement-view";
export const TEMPLATES = ["{keeper.branch}", "{source.commit}", "{source.base}", "{member.branch}", "{quest.id}"] as const;
export const MAX_RULES = 50;
export const MATCH_FIELDS: MatchField[] = ["projectIds", "repoRemotes", "keeperPathGlobs", "keeperEnvironmentProviders", "classes", "questIds"];
const FIELD_WORDS: Record<MatchField, [string, string]> = {
  projectIds: ["Project", "Projects"], repoRemotes: ["Repository", "Repositories"], keeperPathGlobs: ["Keeper path", "Keeper paths"],
  keeperEnvironmentProviders: ["Keeper environment", "Keeper environments"], classes: ["Class", "Classes"], questIds: ["Quest", "Quests"],
};
export const fieldWord = (f: MatchField, n = 1) => FIELD_WORDS[f][n === 1 ? 0 : 1];

/** Everything the page can name. The catalog is null until the server serves it; names then fall back to ids. */
export type Names = {
  catalog: PlacementCatalog | null;
  envs: Map<string, { displayName: string; description: string | null; machineProviderId: string | null }>;
  classes: Map<string, { label: string; plain: string }>;
  quests: Map<string, string>;
};
export function makeNames(catalog: PlacementCatalog | null, envs: readonly { id: string; displayName: string; description: string | null; machineProviderId: string | null }[], classes: readonly { id: string; label: string; plain: string }[], room: Room | undefined, characters: readonly { id: string; name: string }[] = []): Names {
  const envMap = new Map(envs.map((e) => [e.id, e]));
  for (const e of catalog?.environments ?? []) envMap.set(e.id, e);
  return { catalog, envs: envMap, classes: new Map(classes.map((c) => [c.id, c])), quests: room ? questLabels(room, Date.now(), { characters, classes }) : new Map() };
}
export const classWord = (n: Names, id: string) => { const c = n.classes.get(id); return c ? `${c.label} (${c.plain})` : id; };
const projectName = (n: Names, id: string) => n.catalog?.projects.find((p) => p.id === id)?.name ?? id;
const machineName = (n: Names, id: string) => n.catalog?.machines.find((m) => m.id === id)?.displayName ?? id;

/** A Keeper by its name, its thread title when another live Keeper shares the name, and its start time when both repeat. */
/** A Keeper's name, and what tells it apart from Keepers with the same name (its thread title, then its start time), or null. */
export function keeperParts(room: Room, threadId: string, name: (k: Room["keepers"][number]) => string, now = Date.now()): { name: string; detail: string | null } {
  const k = room.keepers.find((x) => x.member.threadId === threadId);
  if (!k) return { name: threadId, detail: null };
  const same = room.keepers.filter((o) => o !== k && name(o) === name(k));
  const title = k.threadTitle ?? null;
  const twin = same.some((o) => (o.threadTitle ?? null) === title);
  const detail = [same.length && title ? title : null, twin ? started(k.threadCreatedAt ?? null, now) : null].filter(Boolean).join(" · ");
  return { name: name(k), detail: detail || null };
}
export function keeperWords(room: Room, threadId: string, name: (k: Room["keepers"][number]) => string, now = Date.now()): string {
  const { name: n, detail } = keeperParts(room, threadId, name, now);
  return detail ? `${n} · ${detail}` : n;
}
/** The guard line for a hire that runs where it runs today: a posture label from the contract by name, anything else in general words. */
export function todayGuard(posture: string | null): string {
  return posture && (Object.values(POSTURE) as string[]).includes(posture) ? `${posture} still applies, as it does today.` : "The guard this hire gets today still applies.";
}
// Each coded warning in plain words. `detail` says whether the server's own text adds something (an error or a path) worth showing.
const WARNING_CODE: Record<PlacementWarning["code"], { words: string; detail: boolean }> = {
  "no-keeper": { words: "There's no Keeper behind this hire yet, so its project and path are assumed: a real hire can still land differently.", detail: false },
  "source-unreadable": { words: "Tavern couldn't read this Keeper's checkout, so a rule that matches its path, home or remote may not catch it.", detail: true },
  "identity-unreadable": { words: "Tavern couldn't tell which environment this Keeper runs in, so a rule that matches the environment may not catch it.", detail: true },
  "provider-unverified": { words: "Whether this provider can make a machine isn't confirmed yet; it's checked again when one is made.", detail: false },
  "discovery-failed": { words: "Tavern couldn't list this provider's machines, so the preview can't say whether one is free.", detail: true },
};
// A backend from before warning codes sends only text: the one string with words keeps them, any other shows as sent.
const LEGACY_WORDS: Record<string, string> = {
  "Without a Keeper, project metadata and the optional path are hypothetical, not admission proof.": WARNING_CODE["no-keeper"].words,
};
export function warningLines(p: Pick<PlacementPreview, "warnings" | "warningDetails">): { words: string; detail: string | null }[] {
  if (p.warningDetails) return p.warningDetails.map((w) => ({ words: WARNING_CODE[w.code].words, detail: WARNING_CODE[w.code].detail && w.text.trim() ? w.text : null }));
  return (p.warnings ?? []).map((w) => ({ words: LEGACY_WORDS[w] ?? w, detail: null }));
}
export function started(at: number | null, now = Date.now()) {
  if (at === null) return null;
  const d = new Date(at), today = new Date(now).toDateString() === d.toDateString();
  return today ? `started ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : `started ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}
type KnownNames = Parameters<typeof memberName>[1];
/** Quest names for rule rows: the short name, then its Keeper when another quest has the same name, then the Keeper's start time when those Keepers share a name too. */
export function questLabels(room: Room, now = Date.now(), names: KnownNames = { characters: [], classes: [] }): Map<string, string> {
  const characterName = (k: Room["keepers"][number]) => memberName(k.member, names);
  const all = room.keepers.flatMap((k) => k.boardQuests.map((q) => ({ q, k })));
  const name = (q: { short?: string | null; title: string }) => q.short?.trim() || q.title;
  return new Map(all.map(({ q, k }) => {
    const twins = all.filter((o) => o.q !== q && name(o.q) === name(q));
    if (!twins.length) return [q.id, name(q)];
    const sameKeeperName = twins.some((o) => characterName(o.k) === characterName(k));
    const when = sameKeeperName ? started(k.threadCreatedAt ?? null, now) : null;
    return [q.id, `${name(q)} · ${characterName(k)}${when ? `, ${when}` : ""}`];
  }));
}

export function valueWord(n: Names, f: MatchField, v: string) {
  if (f === "projectIds") return projectName(n, v);
  if (f === "classes") return classWord(n, v);
  if (f === "questIds") return n.quests.get(v) ?? v;
  if (f === "keeperEnvironmentProviders") return n.envs.get(v)?.displayName ?? v;
  return v;
}
export function catches(n: Names, r: Rule) {
  return MATCH_FIELDS.filter((f) => r.match[f]).map((f) => ({ field: f, word: fieldWord(f, r.match[f]!.length), values: r.match[f]!.map((v) => valueWord(n, f, v)) }));
}

export type Dest = { place: string; detail: string | null; remote: boolean; unavailable: string | null };
/** Where a rule sends members, in words. `unavailable` names a provider the catalog doesn't list; with no catalog it stays null (unknown, not missing). */
export function sendsTo(n: Names, t: Target): Dest {
  if (t.kind === "current") return { place: "Where it runs today", detail: "the Keeper's machine; a Smith gets its own worktree there", remote: false, unavailable: null };
  const m = t.machine;
  const envKnown = n.envs.has(t.environmentProviderId) || !n.catalog;
  const machineKnown = m.type !== "new" || !n.catalog || n.catalog.machines.some((x) => x.id === m.machineProviderId);
  const host = m.type === "existing" ? n.catalog?.hosts.find((h) => h.id === m.hostId)?.name ?? m.hostId : null;
  const where = m.type === "keeper" ? "on the Keeper's machine" : m.type === "project-checkout" ? "on the project checkout's machine" : m.type === "existing" ? `on ${host}` : `on a new ${machineName(n, m.machineProviderId)}`;
  const ins = m.type === "new" && m.inputs && typeof m.inputs === "object" && !Array.isArray(m.inputs) ? Object.entries(m.inputs).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ") : null;
  return {
    place: `${n.envs.get(t.environmentProviderId)?.displayName ?? t.environmentProviderId} ${where}`,
    detail: [t.workspace === "dedicated-machine" ? "one machine per member" : "a linked worktree", ins || null].filter(Boolean).join(" · "),
    remote: m.type === "new" || m.type === "existing",
    unavailable: !envKnown ? t.environmentProviderId : !machineKnown && m.type === "new" ? m.machineProviderId : null,
  };
}
export const needsConsent = (r: Rule) => r.target.kind === "provider" && r.target.machine.type === "new";
export const consented = (r: Rule) => r.consent.guardInstall && r.consent.remoteDetectionOnly && r.consent.linuxUncontainedChecks;
export const NO_CONSENT = { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false };
export const FULL_CONSENT = { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true };

/** The earlier enabled rule that catches everything this one catches, so this one is never reached; a design-time hint, the server matches. */
export function shadowedBy(rules: readonly Rule[], i: number): number | null {
  const later = rules[i]!;
  for (let j = 0; j < i; j++) {
    const e = rules[j]!;
    if (!e.enabled) continue;
    if (MATCH_FIELDS.every((f) => { const ev = e.match[f]; if (!ev) return true; const lv = later.match[f]; return !!lv && lv.every((v) => ev.includes(v)); })) return j;
  }
  return null;
}

// ---------- Server problems, placed ----------
export type Placed = { rule: number | null; field: string; problem: Problem };
/** `machines.rules.3.target.workspace` lands on rule 3's workspace; caps on their field; anything else in the summary (`rule` null, `field` the raw key). */
export function placeProblems(problems: readonly Problem[]): Placed[] {
  return problems.filter((p) => p.key === "machines" || p.key.startsWith("machines.")).map((p) => {
    const m = p.key.match(/^machines\.rules\.(\d+)\.(.+)$/);
    if (m) return { rule: Number(m[1]), field: m[2]!, problem: p };
    return { rule: null, field: p.key.replace(/^machines\.?/, ""), problem: p };
  });
}
export const otherProblems = (problems: readonly Problem[]) => problems.filter((p) => !(p.key === "machines" || p.key.startsWith("machines.")));
/** The words a problem's field takes on its rule row. */
export function problemField(field: string): string {
  const match = field.match(/^match\.(\w+)/);
  if (match && (MATCH_FIELDS as string[]).includes(match[1]!)) return fieldWord(match[1] as MatchField);
  const input = field.match(/^target\.(machine\.)?inputs(?:\.(.+))?$/);
  if (input) return `${input[1] ? "Machine input" : "Checkout input"}${input[2] ? ` ${input[2]}` : "s"}`;
  const words: Record<string, string> = { id: "Rule ID", label: "Name", target: "Sends to", "target.environmentProviderId": "Checkout", "target.workspace": "Workspace", "target.machine": "Machine", "target.machine.machineProviderId": "Machine", "target.machine.hostId": "Machine", consent: "Consent", maxMakers: "Makers per Keeper", maxCheckers: "Checkers per Keeper", rules: "Rules", "": "Rules" };
  return words[field] ?? field;
}
/** Which editor field a problem belongs to: `match.<field>`, `label`, `target.workspace`, `target.inputs.<key>` and so on; ids land on Name, which they derive from. */
export const editorKey = (field: string) => field === "id" ? "label" : field;

// ---------- Provider inputs from a JSON schema ----------
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; anyOf?: Schema[]; oneOf?: Schema[]; items?: Schema; minimum?: number; maximum?: number; maxItems?: number; pattern?: string; required?: string[] };
export type InputField = { key: string; kind: "integer" | "string" | "strings"; min?: number; max?: number; maxItems?: number; required: boolean };
/** One object shape becomes fields (integers, strings, string arrays, one level of nesting); several shapes or anything else is edited as JSON. */
export function fieldsOf(schema: unknown): { fields: InputField[]; optional: boolean; json: boolean } {
  if (schema === null || typeof schema !== "object") return { fields: [], optional: true, json: false };
  const s = schema as Schema;
  const branches = s.anyOf ?? [s];
  const objects = branches.filter((b) => b.type === "object" || b.properties);
  const optional = branches.some((b) => b.type === "null") || !(objects[0]?.required?.length);
  if (objects.length !== 1) return { fields: [], optional, json: objects.length > 1 };
  const fields: InputField[] = [];
  let json = false;
  const add = (key: string, p: Schema, required: boolean) => {
    if (p.type === "integer" || p.type === "number") fields.push({ key, kind: "integer", min: p.minimum, max: p.maximum, required });
    else if (p.type === "string") fields.push({ key, kind: "string", required });
    else if (p.type === "array" && p.items?.type === "string") fields.push({ key, kind: "strings", maxItems: p.maxItems, required });
    else return false;
    return true;
  };
  for (const [key, p] of Object.entries(objects[0]!.properties ?? {})) {
    const required = !!objects[0]!.required?.includes(key);
    if (add(key, p, required)) continue;
    if (p.type === "object" && p.properties && Object.entries(p.properties).every(([k2, q]) => add(`${key}.${k2}`, q, false))) continue;
    json = true;
  }
  return { fields, optional, json };
}
export function readInput(value: Json | undefined, key: string): Json | undefined {
  let cur: Json | undefined = value;
  for (const part of key.split(".")) cur = cur && typeof cur === "object" && !Array.isArray(cur) ? cur[part] : undefined;
  return cur;
}
/** Sets one input; an empty value is left out, never sent as "". Returns undefined when nothing is left. */
export function writeInput(value: Json | undefined, key: string, next: Json | undefined): Json | undefined {
  const root: Record<string, Json> = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) as Record<string, Json> : {};
  const parts = key.split(".");
  let cur = root;
  for (const part of parts.slice(0, -1)) { const child = cur[part]; cur = cur[part] = child && typeof child === "object" && !Array.isArray(child) ? child as Record<string, Json> : {}; }
  const last = parts[parts.length - 1]!;
  if (next === undefined || next === "" || (Array.isArray(next) && next.length === 0)) delete cur[last]; else cur[last] = next;
  if (parts.length > 1 && Object.keys(cur).length === 0) delete root[parts[0]!];
  return Object.keys(root).length ? root : undefined;
}

// ---------- List edits ----------
/** An id from the label, `^[a-z][a-z0-9-]{0,63}$`, unique among the others. */
export function ruleId(label: string, taken: readonly string[]): string {
  const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "") || "rule").slice(0, 58).replace(/-+$/, "");
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) { const id = `${base}-${n}`; if (!taken.includes(id)) return id; }
}
export function moveRule(rules: readonly Rule[], i: number, d: -1 | 1): Rule[] | null {
  const j = i + d;
  if (j < 0 || j >= rules.length) return null;
  const next = [...rules];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
/** A copy goes right after its source with a new id, off, and with its consent cleared: the contract asks for a fresh confirmation. */
export function copyRule(rules: readonly Rule[], i: number): Rule[] {
  const src = rules[i]!;
  const copy: Rule = { ...structuredClone(src), id: ruleId(`${src.id}-copy`, rules.map((r) => r.id)), label: `${src.label} (copy)`.slice(0, 200), enabled: false, consent: { ...NO_CONSENT } };
  const next = [...rules];
  next.splice(i + 1, 0, copy);
  return next;
}

/** The settings row's line: counts, what needs the user, and the caps. */
export function settingsSummary(s: PlacementSettings, n: Names): string {
  if (!s.rules.length) return `None: every hire runs where it runs today. ${s.maxMakers} makers and ${s.maxCheckers} checkers per Keeper.`;
  const needs = s.rules.filter((r) => (needsConsent(r) && !consented(r)) || sendsTo(n, r.target).unavailable).length;
  return `${s.rules.length} ${s.rules.length === 1 ? "rule" : "rules"}, ${s.rules.filter((r) => r.enabled).length} on.${needs ? ` ${needs} need${needs === 1 ? "s" : ""} you.` : ""} ${s.maxMakers} makers and ${s.maxCheckers} checkers per Keeper.`;
}

// ---------- The preview's hire ----------
export type Hire = { mode: "keeper"; keeperThreadId: string; questId: string | null; classId: string } | { mode: "project"; projectId: string; keeperPath: string; classId: string };
export const isHire = (v: unknown): v is Hire => !!v && typeof v === "object" && ((v as Hire).mode === "keeper" ? typeof (v as { keeperThreadId?: unknown }).keeperThreadId === "string" : (v as Hire).mode === "project" && typeof (v as { projectId?: unknown }).projectId === "string") && typeof (v as Hire).classId === "string";
/** Spec section 14: the most recently active live Keeper, then the last hire previewed on this device, then the first project by name. */
export function defaultHire(room: Room | undefined, remembered: Hire | null, catalog: PlacementCatalog | null, classId = "smith"): Hire | null {
  const live = (room?.keepers ?? []).filter((k) => !k.archived).sort((a, b) => (b.member.lastActiveAt ?? b.member.createdAt) - (a.member.lastActiveAt ?? a.member.createdAt));
  if (live[0]) return { mode: "keeper", keeperThreadId: live[0].member.threadId, questId: null, classId };
  if (remembered) return remembered;
  const first = [...(catalog?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name))[0];
  return first ? { mode: "project", projectId: first.id, keeperPath: "", classId } : null;
}
export function previewInput(h: Hire): PlacementPreviewInput {
  return h.mode === "keeper" ? { projectId: null, keeperThreadId: h.keeperThreadId, keeperPath: null, classId: h.classId, questId: h.questId }
    : { projectId: h.projectId, keeperThreadId: null, keeperPath: h.keeperPath.trim() || null, classId: h.classId, questId: null };
}
