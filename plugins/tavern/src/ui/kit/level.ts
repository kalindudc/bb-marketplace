import { RESULTS_PER_LEVEL, levelFromCount, levelRole, earnedCount, type LevelRole } from "../../shared/level";
import type { CharacterServiceRecord } from "../../shared/service-record";
import type { BoardQuestDetail } from "../../shared/contract";
import type { Member } from "../../shared/schema";

/** One rule for every class (README "Levels"): a level per eight earned results, each class counting the work it is trusted for. The rule itself lives in src/shared, so the server's tale snapshots use the same one. */
export { RESULTS_PER_LEVEL, levelRole, earnedCount };
export type { LevelRole };
/** Notches a crest can carry; past that, the words carry the level. */
export const MAX_NOTCHES = 5;

const UNIT: Record<LevelRole, [one: string, many: string]> = {
  maker: ["verified waypoint", "verified waypoints"],
  warden: ["independent check", "independent checks"],
  keeper: ["quest with verified work", "quests with verified work"],
};
const NONE: Record<LevelRole, string> = {
  maker: "No verified waypoints yet",
  warden: "No independent checks yet",
  keeper: "No quests with verified work yet",
};
/**
 * Where a level comes from, said once beside the level line, so a Ranger at level 1 reads as "not checked yet", not "not good". A Keeper
 * has none: its unit, "quests with verified work", already says it.
 */
export const LEVEL_BASIS: Partial<Record<LevelRole, string>> = {
  maker: "Levels come from waypoints a Warden verified.",
  warden: "Levels come from independent checks, whatever the verdict.",
};

export type Level = {
  role: LevelRole; count: number; level: number;
  /** Results still to earn for the next level. */
  toNext: number;
  /** Notches the crest cuts: none at level 1, so every notch was earned. */
  notches: number;
  /** "Level 2 · 7 more independent checks for level 3." Each number is said once: the record carries the count. */
  words: string;
};

/** The level for a count, or null with nothing earned: then there is no level line and the crest stays plain (`noLevelWords`). */
export function levelOf(role: LevelRole, count: number): Level | null {
  const level = levelFromCount(count);
  if (level === null) return null;
  const toNext = RESULTS_PER_LEVEL - (count % RESULTS_PER_LEVEL);
  const [one, many] = UNIT[role];
  return {
    role, count, level, toNext, notches: Math.min(level - 1, MAX_NOTCHES),
    words: `Level ${level} · ${toNext} more ${toNext === 1 ? one : many} for level ${level + 1}.`,
  };
}

export const noLevelWords = (role: LevelRole) => NONE[role];

/** The "Character levels" setting, from the registry; an older server that doesn't send it means on. */
export const levelsShown = (registry: { levels?: boolean }) => registry.levels !== false;

/** A character's level in one class, from the registry's records; null when levels are off, the server sends no records, or nothing is earned. */
export function levelFor(registry: { levels?: boolean; serviceRecords?: readonly CharacterServiceRecord[] }, characterId: string | null, classId: string): Level | null {
  if (!characterId || !registry.serviceRecords || !levelsShown(registry)) return null;
  const role = levelRole(classId);
  return levelOf(role, earnedCount(registry.serviceRecords.find(r => r.characterId === characterId) ?? null, role));
}

/** A level a character reached on a quest, from the server's snapshot when the quest returned; never worked out in the browser. */
export type ReachedLevel = { level: number; earned: boolean };

/**
 * Said from level 2 up, and only when it rose: a first result that earns level 1 stays silent, and a legacy tale with no snapshot says
 * nothing. `earned` only when the server's history was complete at the snapshot (exactly true); otherwise the words give the level
 * without claiming this quest earned it. The tale page and the tale chat card both say it this way.
 */
export function reachedLevel(detail: Pick<BoardQuestDetail, "tale">, member: Pick<Member, "characterId" | "classId">): ReachedLevel | null {
  if (!member.characterId) return null;
  const role = levelRole(member.classId);
  const entry = detail.tale?.levels?.find(l => l.characterId === member.characterId && l.role === role);
  if (!entry || entry.after === null || !(entry.after >= 2 && entry.after > (entry.before ?? 1))) return null;
  return { level: entry.after, earned: entry.historyComplete === true };
}

export const reachedWords = (name: string, r: ReachedLevel) => r.earned ? `${name} reached level ${r.level} on this quest.` : `${name} was level ${r.level} after this quest.`;

/**
 * Each character's crossing once, in party order. A party can hold the same character twice ("Lark II"), and a level belongs to the
 * character and its role, so the crossing is said once and named with the character's own name, never a member's display name.
 */
export function reachedInParty<M extends Pick<Member, "characterId" | "classId">>(detail: Pick<BoardQuestDetail, "tale">, members: readonly M[], characters: readonly { id: string; name: string }[]): { member: M; name: string; reached: ReachedLevel }[] {
  const seen = new Set<string>();
  const said: { member: M; name: string; reached: ReachedLevel }[] = [];
  for (const member of members) {
    const reached = reachedLevel(detail, member);
    const character = reached && characters.find(c => c.id === member.characterId);
    const key = `${member.characterId}|${levelRole(member.classId)}`;
    if (!reached || !character || seen.has(key)) continue;
    seen.add(key);
    said.push({ member, name: character.name, reached });
  }
  return said;
}
