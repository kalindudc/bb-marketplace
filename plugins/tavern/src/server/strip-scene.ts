import { currentMoodReport, waypointMoodVerdict } from "../shared/mood";
import { wasReleased } from "../shared/member-engagement";
import type { StripScene } from "../shared/strip-scene";
import type { BoardQuest, JournalEntry, Member, Plan, Report, Route } from "../shared/schema";
import { askMemberTarget } from "./ask-effects";
import { askNeedsUser } from "./attention";
import type { Keeper } from "./keeper/service";
import type { KeeperStore, Runtime } from "./keeper/store";
import { memberHost } from "./member-engagement";

type Stamp = { revision: string; at: number };
type Commit = Stamp & { from: string | null; to: string; version?: number | null };
type Input = {
  member: Pick<Member, "classId" | "role" | "state" | "engagement">;
  quest?: Pick<BoardQuest, "id" | "phase" | "planVersion" | "greenlitVersion" | "archivedAt" | "deletedAt" | "held"> | null;
  route?: Pick<Route, "kind" | "boardQuestId"> & { boardQuestIds: readonly string[] } | null;
  commit?: Commit | null;
  assignment?: Stamp | null;
  assigned?: boolean;
  report?: Pick<Report, "status" | "createdAt"> | null;
  verdict?: { status: "verified" | "rejected"; at: number } | null;
  held?: boolean;
  gone?: boolean;
};

export function committedStripPhase(store: KeeperStore, threadId: string, questId: string): Commit | null {
  const row = store.db.prepare(`SELECT id, at,
    json_extract(data, '$.phase.from') AS "from", json_extract(data, '$.phase.to') AS "to",
    json_extract(data, '$.stripPlanVersion') AS version
    FROM tavern_events WHERE board_quest_id = ? AND keeper_thread_id = ?
    AND json_type(data, '$.phase') = 'object' ORDER BY id DESC LIMIT 1`).get(questId, threadId) as
    { id: number; at: number; from: string | null; to: string; version: number | null } | undefined;
  return row ? { revision: `phase:${row.id}`, at: row.at, from: row.from, to: row.to, version: row.version } : null;
}

export function committedStripReview(store: KeeperStore, threadId: string, questId: string, planVersion: number, waypointId: string, entries: readonly JournalEntry[]) {
  const linked = entries.filter(entry => entry.link?.boardQuestId === questId && entry.link?.waypointId === waypointId);
  if (!linked.length || linked.some(entry => entry.status !== "verified")) return null;
  const row = store.db.prepare(`SELECT at, json_extract(data, '$.verdict') AS status
    FROM tavern_events WHERE board_quest_id = ? AND type IN ('waypoint.review-round','waypoint.review-rejected')
    AND json_extract(actor, '$.kind') = 'agent' AND json_extract(actor, '$.threadId') = ?
    AND json_extract(data, '$.planVersion') = ? AND json_extract(data, '$.waypointId') = ?
    ORDER BY id DESC LIMIT 1`).get(questId, threadId, planVersion, waypointId) as { at: number; status: string } | undefined;
  return row?.status === "verified" ? { at: row.at, status: "verified" as const } : null;
}

type SceneFacts = {
  thread: Runtime; boardQuest: BoardQuest | null; plan: Plan | null; entries: readonly JournalEntry[];
  lastReport?: Report; verdict: ReturnType<typeof waypointMoodVerdict>; held: boolean; archived: boolean;
};

export function readStripScene(keeper: Keeper, member: Member, known?: SceneFacts): StripScene {
  const { store } = keeper;
  const { threadId, boardQuestId } = member;
  const thread = known?.thread ?? store.runtime(threadId);
  const boardQuest = known ? known.boardQuest : boardQuestId ? store.get("quests", boardQuestId) : null;
  const plan = known ? known.plan : boardQuest ? store.get("plans", `${boardQuest.id}:${boardQuest.planVersion}`) : null;
  const entries = known?.entries ?? (boardQuest ? keeper.journal.linkedEntries(boardQuest.id) : []);
  const lastReport = known ? known.lastReport : store.query("reports", "memberThreadId", threadId, 1)[0];
  const verdict = known ? known.verdict : waypointMoodVerdict(member, entries);
  const route = member.role === "keeper" && thread.lastRouteId && !thread.pending.length ? store.get("routes", thread.lastRouteId) : null;
  const routedQuest = route?.keeperThreadId === threadId && route.boardQuestId && route.boardQuestIds.length <= 1 && (route.kind === "steer" || route.kind === "new-quest") ? store.get("quests", route.boardQuestId) : null;
  const quest = routedQuest?.keeperThreadId === threadId ? routedQuest : boardQuest;
  const waypoint = member.checkerWaypointId ?? member.waypointId;
  const assigned = !!waypoint && !!plan?.waypoints.some(w => w.id === waypoint);
  const sceneVerdict = member.classId === "warden" && boardQuest && assigned && waypoint && plan
    ? committedStripReview(store, threadId, boardQuest.id, plan.version, waypoint, entries)
    : verdict?.waypointId === waypoint ? verdict : null;
  const host = known ? null : memberHost(store, member);
  const askOwner = member.role === "keeper" ? threadId : member.keeperThreadId;
  const held = known?.held ?? (member.role === "keeper" && keeper.memory.notes(threadId, 200).some(note => note.kind === "waiting-on-user") ||
    !!askOwner && store.openAsks(askOwner, undefined, true).some(ask => {
      if (!askNeedsUser(store, ask)) return false;
      if (member.role === "keeper") return true;
      const target = askMemberTarget(ask);
      return target ? target === threadId : !!waypoint && ask.boardQuestId === boardQuestId && ask.holds.includes(waypoint);
    }));
  const assignmentAt = thread.lastBriefAt ?? thread.initialBriefAt;
  return stripScene({ member, quest, route,
    commit: member.role === "keeper" && quest ? committedStripPhase(store, threadId, quest.id) : null,
    assignment: assignmentAt == null ? null : { at: assignmentAt, revision: thread.lastAcceptedBriefId ?? `brief:${thread.briefVersion ?? 0}` },
    assigned: assigned || member.errand && !boardQuest,
    report: !boardQuest || lastReport?.boardQuestId === boardQuest.id && lastReport.waypointId === waypoint && lastReport.createdAt >= (plan?.createdAt ?? 0)
      ? currentMoodReport(lastReport, thread.lastBriefAt) : null,
    verdict: assigned && sceneVerdict && sceneVerdict.at >= (plan?.createdAt ?? 0) ? sceneVerdict : null,
    held,
    gone: thread.hidden || (known?.archived ?? (host?.archivedAt != null || host?.deletedAt != null)) || wasReleased(member),
  });
}

export function stripScene({ member, quest, route, commit, assignment, assigned, report, verdict, held, gone }: Input): StripScene {
  const id = member.classId;
  const role = member.role === "keeper" ? "keeper" : id === "smith" || id === "ranger" || id === "warden" || id === "wanderer" ? id : "other";
  const result: StripScene = { revision: "neutral", at: null, role, stage: "neutral", activity: "unknown", moment: "none", posture: "clear" };
  if (gone || ["released", "archived", "stopped"].includes(member.engagement ?? "") || quest?.archivedAt != null || quest?.deletedAt != null)
    return { ...result, posture: "gone" };
  if (held || quest?.phase === "held" || member.state === "failed" || member.state === "waiting") result.posture = "held";
  if (quest?.phase === "stopped" || quest?.phase === "stopping") return result;
  const stamp = (stage: StripScene["stage"], moment: StripScene["moment"], fact: Stamp) =>
    ({ ...result, stage, moment, at: fact.at, revision: JSON.stringify([quest?.id, quest?.planVersion, assignment?.revision, fact.revision]) });
  if (role === "keeper") {
    if (!quest || route?.boardQuestId !== quest.id || route.boardQuestIds.length > 1 || (route.kind !== "new-quest" && route.kind !== "steer")) return result;
    const phase = quest.phase === "held" ? quest.held?.from : quest.phase;
    const stage = phase === "scout" || phase === "greenlight" ? "plan"
      : phase === "closing" || phase === "check" ? "review"
      : phase === "done" ? "rest" : "work";
    if (!commit || commit.to !== quest.phase || commit.version !== undefined && commit.version !== quest.planVersion) return { ...result, stage };
    const moment = commit.from === "greenlight" && commit.to === "build" && quest.greenlitVersion === quest.planVersion ? "plan-ready"
      : commit.from === "closing" && commit.to === "done" ? "wrapped" : "none";
    return stamp(stage, moment, commit);
  }
  if (!assigned || !assignment || member.engagement === "briefing" || quest?.phase === "done") return result;
  const stage = role === "warden" ? "review" : "work";
  if (verdict && verdict.at >= assignment.at) {
    if (verdict.status === "verified") return stamp(stage, "verified", { revision: `verified:${verdict.at}`, at: verdict.at });
    result.posture = "held";
  }
  if (report && report.createdAt >= assignment.at) {
    if (report.status !== "done") result.posture = "held";
    return stamp(stage, "report", { revision: `report:${report.createdAt}`, at: report.createdAt });
  }
  if (member.engagement === "resting") return { ...result, stage: "rest" };
  return stamp(stage, "assignment", assignment);
}
