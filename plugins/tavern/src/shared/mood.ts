import type { Room, ThreadDecor } from "./contract";
import { KNOB_FIELDS } from "./settings";
import type { BoardQuest, JournalEntry, KeeperNote, Member, Report } from "./schema";

/** What a member is doing, as the party shows it. `released` is not drawn on the strip at all. */
export const MOODS = ["idle", "working", "waiting", "reported", "verified", "blocked", "resting", "error"] as const;
export type Mood = (typeof MOODS)[number];
export type MoodOrGone = Mood | "released";
type MoodReport = Pick<Report, "status" | "createdAt">;
type Verdict = { status: "verified" | "rejected"; at: number | null };

export const REPORTED_MS = KNOB_FIELDS.tavern.reportedPoseSeconds.default * 1000;
export const VERIFIED_MS = KNOB_FIELDS.tavern.verifiedPoseMinutes.default * 60_000;

export type MoodFacts = {
  now: number;
  activity: Member["state"];
  released?: boolean;
  archived?: boolean;
  openAsk?: boolean;
  handBack?: boolean;
  report?: MoodReport | null;
  verdict?: Verdict | null;
  settled?: boolean;
  reportedMs?: number;
  verifiedMs?: number;
};

const recent = (now: number, at: number, window: number) => now >= at && now - at < window;

export function characterMood({ now, activity, released, archived, openAsk, handBack, report, verdict, settled, reportedMs = REPORTED_MS, verifiedMs = VERIFIED_MS }: MoodFacts): MoodOrGone {
  if (released || archived || activity === "stopped") return "released";
  if (activity === "failed") return "error";
  if (openAsk || handBack || report?.status === "needs-decision") return "waiting";
  if (verdict?.status === "rejected") return "blocked";
  if (report?.status === "blocked" && !(verdict?.status === "verified" && verdict.at !== null && verdict.at >= report.createdAt && verdict.at <= now)) return "blocked";
  if (verdict?.status === "verified" && verdict.at !== null && recent(now, verdict.at, verifiedMs)) return "verified";
  if (report?.status === "done" && recent(now, report.createdAt, reportedMs)) return "reported";
  if (activity === "working") return "working";
  if (activity === "done" || (activity === "idle" && settled)) return "resting";
  return "idle";
}

export function waypointMoodVerdict(member: Member, entries: readonly JournalEntry[]): { status: Verdict["status"]; at: number; waypointId: string; checkerThreadId: string | null } | null {
  if (member.classId === "warden" || !member.boardQuestId) return null;
  const linked = entries.filter(e => e.threadId === member.threadId && e.link?.boardQuestId === member.boardQuestId);
  const verdictAt = (e: JournalEntry) => e.review?.at ?? e.updatedAt;
  const rejected = linked.filter(e => e.status === "rejected");
  const pending = new Set(linked.filter(e => e.status !== "verified").map(e => e.link?.waypointId));
  const candidates = rejected.length ? rejected : linked.filter(e => e.status === "verified" && !pending.has(e.link?.waypointId));
  const latest = candidates.reduce<JournalEntry | null>((best, entry) => !best || verdictAt(entry) > verdictAt(best) ? entry : best, null);
  if (!latest?.link) return null;
  const actor = latest.review?.actor ?? latest.updatedBy;
  return { status: rejected.length ? "rejected" : "verified", at: verdictAt(latest), waypointId: latest.link.waypointId,
    checkerThreadId: actor.kind === "agent" ? actor.threadId : null };
}

export function currentMoodReport(report: MoodReport | undefined, briefAt?: number | null): MoodReport | null {
  return report && (briefAt == null || report.createdAt >= briefAt) ? { status: report.status, createdAt: report.createdAt } : null;
}

const holds = (q: BoardQuest) => q.archivedAt == null && q.phase !== "stopping" && q.phase !== "stopped" && q.phase !== "done" && q.checkerHandoffHold?.release === null;
const goneQuest = (q: BoardQuest | null | undefined) => q != null && (q.archivedAt != null || q.deletedAt != null || q.phase === "stopped");

export function widgetMoodFacts(data: ThreadDecor, now: number): MoodFacts {
  const { member, keeperView, scope, boardQuest, moodSignals, progress } = data;
  return {
    now,
    activity: member?.state ?? "idle",
    released: moodSignals?.released === true,
    archived: moodSignals?.archived === true || keeperView?.archived === true || goneQuest(boardQuest),
    openAsk: !!scope?.pendingAskId || !!keeperView?.openAsks.some(a => a.state === "open"),
    handBack: moodSignals?.handBack === true || !!keeperView?.boardQuests.some(holds),
    report: moodSignals?.report ?? null,
    verdict: moodSignals?.verdict ?? null,
    reportedMs: (data.reportedPoseSeconds ?? KNOB_FIELDS.tavern.reportedPoseSeconds.default) * 1000,
    verifiedMs: (data.verifiedPoseMinutes ?? KNOB_FIELDS.tavern.verifiedPoseMinutes.default) * 60_000,
    settled: progress.total > 0 && progress.done === progress.total,
  };
}

type RoomMoodDetails = {
  reports?: readonly Report[];
  entries?: readonly JournalEntry[];
  notes?: readonly KeeperNote[];
  briefAt?: number | null;
};

export function roomMoodFacts(room: Pick<Room, "keepers" | "asks">, member: Member, now: number, details: RoomMoodDetails = {}): MoodFacts {
  const id = member.threadId;
  const keeper = room.keepers.find(k => k.member.threadId === (member.role === "keeper" ? id : member.keeperThreadId));
  const quest = keeper?.boardQuests.find(q => q.id === member.boardQuestId);
  const entries = details.entries?.filter(e => e.threadId === id) ?? [];
  const report = details.reports?.reduce<Report | undefined>((latest, r) =>
    r.memberThreadId === id && (!latest || r.createdAt > latest.createdAt) ? r : latest, undefined);
  const rejected = quest?.waypoints.some(w => w.ownerMember?.threadId === id && w.state === "rejected");
  return {
    now,
    activity: member.state,
    archived: (member.role === "keeper" && keeper?.archived === true) || goneQuest(quest),
    openAsk: room.asks.some(a => a.state === "open" && (a.scopeChange?.memberThreadId === id || a.keeperThreadId === id)),
    handBack: (member.role === "keeper" && !!keeper?.boardQuests.some(holds)) || !!details.notes?.some(n =>
      n.keeperThreadId === id && n.kind === "waiting-on-user" && n.state === "open" && (n.validUntil == null || n.validUntil > now)),
    report: currentMoodReport(report, details.briefAt),
    verdict: waypointMoodVerdict(member, entries) ?? (rejected ? { status: "rejected", at: null } : null),
    settled: entries.length > 0 && entries.every(e => e.status === "done" || e.status === "verified"),
  };
}
