import type { ReactNode } from "react";
import type { CharacterServiceRecord } from "../../shared/service-record";
import { LEVEL_BASIS, RESULTS_PER_LEVEL, earnedCount, levelRole, noLevelWords, useToday, type Level as KitLevel, type LevelRole } from "../kit";
import type { Registry } from "./common";

/** "12 Nov", with the year when it isn't this year. */
export function recordDate(at: number, today: number) {
  const d = new Date(at);
  const day = `${d.getDate()} ${d.toLocaleDateString("en", { month: "short" })}`;
  return d.getFullYear() === new Date(today).getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The character's lasting record, or undefined when the server sends none (an older build), which is not the same as an empty record. */
export function serviceRecordOf(registry: Registry, characterId: string): CharacterServiceRecord | null | undefined {
  if (!registry.serviceRecords) return undefined;
  return registry.serviceRecords.find((r) => r.characterId === characterId) ?? null;
}

export type Role = LevelRole;
/** The role a character levels in: its first class's, by the kit's rule. */
export const roleOf = (classIds: readonly string[]): Role => levelRole(classIds[0] ?? "");
const word = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** A card footer's unit for the count its level uses. */
const STILL: Record<Role, [one: string, many: string]> = {
  maker: ["verified waypoint", "verified waypoints"],
  // A check earns whatever its verdict, so these words never say "verified".
  warden: ["independent check", "independent checks"],
  keeper: ["quest with verified work", "quests with verified work"],
};
/** The kit's words after "Level N · ", which the sheet draws as the level mark itself. */
export const levelLine = (lv: KitLevel) => { const lead = `Level ${lv.level} · `; return lv.words.startsWith(lead) ? lv.words.slice(lead.length) : lv.words; };

/**
 * The level and its bar, by the kit's rule (8 earned results a level, each class counting what it's trusted for); nothing when
 * nothing is earned. `detail` adds the sentence and the basis the sheet reads, or its "No … yet".
 */
export function Level({ lv, role, detail = false }: { lv: KitLevel | null; role: Role; detail?: boolean }) {
  if (!lv) return detail ? <p className="tv-lvl-none" data-level="none">{noLevelWords(role)}</p> : null;
  const into = RESULTS_PER_LEVEL - lv.toNext;
  const mark = <span className="tv-lvl" role={detail ? undefined : "img"} aria-label={detail ? undefined : lv.words}><b>Level {lv.level}</b><span className="tv-lvl-bar" aria-hidden="true"><i style={{ width: `${(into / RESULTS_PER_LEVEL) * 100}%` }} /></span></span>;
  if (!detail) return mark;
  return <div className="tv-lvl-d" data-level={lv.level}>
    {/* Inline, so a narrow sheet wraps inside the sentence; the no-break space keeps "·" with the level, never leading a line. */}
    <p className="tv-lvl-line">{mark}{"\u00a0· "}{levelLine(lv)}</p>
    {LEVEL_BASIS[lv.role] && <p className="tv-lvl-why">{LEVEL_BASIS[lv.role]}</p>}
  </div>;
}

/** A line as parts: numbers are drawn bold, and the same parts give the plain text for a title. */
type Part = string | number;
type Line = { role: Role; parts: Part[]; title?: string };
const text = (parts: Part[]) => parts.join("");
const draw = (parts: Part[]) => parts.map((p, i) => typeof p === "number" ? <b className="num" key={i}>{p}</b> : p);
/** A list of counted things with every zero left out: "11 checks, 9 independent, 2 same-family". */
const joined = (items: (Part[] | null)[]) => items.filter((x): x is Part[] => x !== null).flatMap((x, i) => (i ? [", ", ...x] : x));

/**
 * When one role began on record. The server sends it per role over the whole history (null when a record of that role is undated);
 * an older server doesn't, and then it is the earliest quest's end among the rows sent, unknown when a row is undated or the record
 * holds more quests than it sends.
 */
function roleSince(record: CharacterServiceRecord, role: Role): number | null {
  const exact = record[role]?.firstEarnedAt;
  if (exact !== undefined) return exact;
  if (record.records.length < record.recordsTotal) return null;
  const rows = record.records.filter((r) => r.role === role);
  if (!rows.length || rows.some((r) => r.endedAt === null)) return null;
  return Math.min(...rows.map((r) => r.endedAt!));
}
/** A Keeper's one-role line says "and 5 verified waypoints"; with its role named it reads ", with 5 verified waypoints". */
const KEEPER_AND = " and ";
const AS: Record<Role, string> = { keeper: "As a Keeper: ", maker: "As a maker: ", warden: "As a Warden: " };

/**
 * One line per role the character has earned in, Keeper first, with every zero left out. With records in two roles each line names
 * its role and carries its own date, since a Keeper's waypoints (in the quests it led) and a maker's (its own work) differ. Catches count only a Warden's rejection that
 * a later Warden-verified fix proved right; same-family checks are never independent. "On record since" holds for every class: a
 * Keeper's date can come from a quest it stopped.
 */
export function recordLines(record: CharacterServiceRecord | null, today: number, since = true): Line[] {
  if (!record) return [];
  const lines: Line[] = [];
  const k = record.keeper, m = record.maker, w = record.warden;
  if (k && k.returnedQuests > 0) {
    const parts: Part[] = ["Brought back ", k.returnedQuests, ` ${word(k.returnedQuests, "quest")}`];
    if (k.verifiedReturns > 0 && k.verifiedReturns < k.returnedQuests) parts.push(" (", k.verifiedReturns, " with verified work)");
    if (k.verifiedWaypoints > 0) parts.push(KEEPER_AND, k.verifiedWaypoints, ` ${word(k.verifiedWaypoints, "verified waypoint")}`);
    lines.push({ role: "keeper", parts });
  }
  if (m && m.verifiedWaypoints > 0) lines.push({ role: "maker", parts: [m.verifiedWaypoints, ` ${word(m.verifiedWaypoints, "verified waypoint")} across `, m.quests, ` ${word(m.quests, "quest")}`] });
  if (w && w.checks > 0) {
    const caught = w.caughtDefects > 0 ? [w.caughtDefects, " caught a defect before return"] : null;
    // Every check same-family: say it as one count rather than "N checks, 0 independent, N same-family".
    const head: Part[][] = w.sameFamilyChecks === w.checks ? [[w.checks, ` same-family ${word(w.checks, "check")}`]]
      : [[w.checks, ` ${word(w.checks, "check")}`], w.independentChecks > 0 ? [w.independentChecks, " independent"] : null, w.sameFamilyChecks > 0 ? [w.sameFamilyChecks, " same-family"] : null].filter((x): x is Part[] => x !== null);
    lines.push({ role: "warden", parts: joined([...head, caught]), title: w.caughtSince !== null ? `Catches are complete since ${recordDate(w.caughtSince, today)}; before that, a catch counts only where its proof survived.` : undefined });
  }
  if (lines.length > 1) {
    for (const l of lines) {
      const first = l.parts[0];
      l.parts = [AS[l.role], ...(typeof first === "string" ? [first.charAt(0).toLowerCase() + first.slice(1), ...l.parts.slice(1)] : l.parts)].map((p) => p === KEEPER_AND ? ", with " : p);
      const at = roleSince(record, l.role);
      if (since && at !== null) l.parts.push(", on record since ", recordDate(at, today));
    }
    return lines;
  }
  if (since && lines.length && record.firstEarnedAt !== null) lines[0]!.parts.push(", on record since ", recordDate(record.firstEarnedAt, today));
  return lines;
}
/** The record as one plain sentence each, for a title. */
export const recordText = (record: CharacterServiceRecord | null, today: number) => recordLines(record, today).map((l) => `${text(l.parts)}.`).join(" ");

/** The sheet's record: what the character earned, which archiving its threads no longer erases, and where older history is partial. */
export function ServiceRecord({ record, name }: { record: CharacterServiceRecord | null; name: string }) {
  const today = useToday();
  const lines = recordLines(record, today);
  // With nothing earned, the level's "No … yet" says it; the block is only for what there is.
  if (!lines.length && record?.completeSince == null) return null;
  return <div className="tv-svc" role="group" aria-label={`${name}'s service record`} data-service-record>
    {lines.map((l) => <p key={l.role} data-role={l.role} title={l.title}>{draw(l.parts)}.</p>)}
    {record?.completeSince != null && <p className="tv-svc-part" data-partial>History before {recordDate(record.completeSince, today)} is partial: it counts only the proof that survived.</p>}
  </div>;
}

/**
 * A character card's footer: only the count its level uses, so it fits on one line; a Warden's adds its independent checks. With
 * that count at 0 it shows the record's first line instead, and the whole record is in the title.
 */
export function RecordBrief({ record, role }: { record: CharacterServiceRecord | null; role: Role }) {
  const today = useToday();
  const all = recordLines(record, today);
  if (!all.length) return <span className="tv-cc-line">no record yet</span>;
  const n = earnedCount(record, role), w = record?.warden;
  const parts: Part[] = n <= 0 ? recordLines(record, today, false)[0]!.parts
    : role === "warden" && w ? [w.checks, ` ${word(w.checks, "check")} · `, w.independentChecks, " independent"]
    : [n, ` ${word(n, ...STILL[role])}`];
  return <span className="tv-cc-line" title={recordText(record, today)}>{draw(parts)}</span>;
}
