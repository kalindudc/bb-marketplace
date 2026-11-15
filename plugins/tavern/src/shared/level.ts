import type { CharacterServiceRecord } from "./service-record";

export const RESULTS_PER_LEVEL = 8;
export type LevelRole = "maker" | "warden" | "keeper";
/** Rangers, Smiths and Wanderers are makers, as the server's record counts them. */
export const levelRole = (classId: string): LevelRole => classId === "keeper" ? "keeper" : classId === "warden" ? "warden" : "maker";

/**
 * What a role has earned, from the lasting record. A Warden's check counts whatever its verdict, so a level never rewards passing work.
 * A Keeper's quest counts only when it came back with a verified waypoint: a quest whose optional waypoints were all skipped earns nothing.
 */
export function earnedCount(record: Pick<CharacterServiceRecord, "maker" | "warden" | "keeper"> | null, role: LevelRole): number {
  if (!record) return 0;
  if (role === "maker") return record.maker?.verifiedWaypoints ?? 0;
  if (role === "warden") return record.warden?.independentChecks ?? 0;
  return record.keeper?.verifiedReturns ?? 0;
}

export function levelFromCount(count: number): number | null {
  return count > 0 ? 1 + Math.floor(count / RESULTS_PER_LEVEL) : null;
}
