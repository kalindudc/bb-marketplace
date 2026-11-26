import { currentMoodReport, waypointMoodVerdict } from "../shared/mood";
import { wasReleased } from "../shared/member-engagement";
import type { RoadPlace, StripRoad, StripScene } from "../shared/strip-scene";
import type { BoardQuest, JournalEntry, Member, Plan, Report, Route } from "../shared/schema";
import { askMemberTarget } from "./ask-effects";
import { askNeedsUser } from "./attention";
import type { Keeper } from "./keeper/service";
import type { KeeperStore, Runtime } from "./keeper/store";
import type { SpeechFacts } from "./pi-speech-prompt";
import { memberHost } from "./member-engagement";

type Stamp = { revision: string; at: number };
type Commit = Stamp & { from: string | null; to: string; version?: number | null };
type Input = {
  member: Pick<Member, "classId" | "role" | "state" | "engagement">;
  quest?: (Pick<BoardQuest, "id" | "phase" | "planVersion" | "greenlitVersion" | "archivedAt" | "deletedAt" | "held"> & Partial<Pick<BoardQuest, "short" | "title">>) | null;
  waypointId?: string | null;
  waypoints?: readonly RoadWaypoint[];
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

export function committedStripReview(threadId: string, questId: string, waypointId: string, entries: readonly JournalEntry[]) {
  const linked = entries.filter(entry => entry.link?.boardQuestId === questId && entry.link?.waypointId === waypointId);
  if (!linked.length || linked.some(entry => entry.status !== "verified")) return null;
  const at = linked.reduce<number | null>((latest, { review }) =>
    review?.actor.kind === "agent" && review.actor.threadId === threadId && (latest === null || review.at > latest) ? review.at : latest, null);
  return at === null ? null : { at, status: "verified" as const };
}

type RoadWaypoint = {
  id: string;
  title: string;
  kind: "read" | "make";
  state: "planned" | "doing" | "blocked" | "rejected" | "reported" | "verified" | "done";
  review?: boolean;
};

function roadWaypoints(plan: Plan, entries: readonly JournalEntry[]): RoadWaypoint[] {
  const linked = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    if (entry.link?.boardQuestId !== plan.boardQuestId || entry.owner === "You") continue;
    const id = entry.link.waypointId;
    const rows = linked.get(id);
    if (rows) rows.push(entry);
    else linked.set(id, [entry]);
  }
  const roles = new Map<string, Set<string>>();
  for (const slot of plan.party) for (const id of slot.waypointIds) {
    const assigned = roles.get(id);
    if (assigned) assigned.add(slot.classId);
    else roles.set(id, new Set([slot.classId]));
  }
  return plan.waypoints.filter(w => w.actor === "agent").map(w => {
    const checks = linked.get(w.id) ?? [];
    const classIds = roles.get(w.id);
    const kind = w.owner === "ranger" || classIds?.size === 1 && classIds.has("ranger") ? "read" : "make";
    const reported = checks.length > 0 && checks.every(entry => entry.status === "done" || entry.status === "verified");
    const state = checks.length > 0 && checks.every(entry => entry.status === "verified") ? "verified"
      : reported && w.check === "none" ? "done"
      : reported ? "reported"
      : checks.some(entry => entry.status === "rejected") ? "rejected"
      : checks.some(entry => entry.status === "blocked") ? "blocked"
      : checks.some(entry => entry.status === "doing") ? "doing" : "planned";
    return { id: w.id, title: w.title, kind, state, review: w.check === "warden" || w.check === "keeper" };
  });
}

function currentRoadWaypoint(waypoints: readonly RoadWaypoint[]) {
  return waypoints.find(w => ["doing", "reported", "rejected", "blocked"].includes(w.state));
}

function stripRoad(scene: StripScene, input: Input): StripRoad | undefined {
  const { quest, waypointId, waypoints = [], assignment } = input;
  const { role, stage, moment, posture } = scene;
  if (posture === "gone" || stage === "neutral" || role === "keeper" && stage === "rest" && moment !== "wrapped") return;

  const assigned = waypoints.find(w => w.id === waypointId);
  const current = role === "keeper" && stage === "work"
    ? currentRoadWaypoint(waypoints)
    : assigned;
  const key = quest?.id ?? assignment?.revision ?? role;
  const places: RoadPlace[] = [];
  const add = (id: string, kind: RoadPlace["kind"], state: RoadPlace["state"], waypoint?: string) => {
    places.push({ id, kind, state, ...(waypoint ? { waypoint } : {}) });
    return id;
  };
  const status = posture === "held" || current?.state === "blocked" || current?.state === "rejected" ? "held" : "active";
  const questName = quest?.short || quest?.title;
  const road = (id: string): StripRoad => ({ key, ...(questName === undefined ? {} : { title: questName }), current: id, places });
  if (stage === "plan") return road(add("plan", "plan", status));

  if (quest?.greenlitVersion != null) add("plan", "plan", "done");
  const history = current ? waypoints.slice(0, waypoints.indexOf(current)) : waypoints;
  for (const w of history) {
    if (w.state !== "done" && w.state !== "verified") continue;
    add(w.id, w.kind, "done", w.title);
    if (w.state === "verified") add(`${w.id}:review`, "review", "done", w.title);
  }
  if (role === "keeper" && stage === "work" && !current && waypoints.length) {
    const last = places.at(-1);
    return last ? road(last.id) : undefined;
  }
  const kind = role === "ranger" ? "read" : role === "smith" ? "make" : current?.kind ?? "make";
  const id = current?.id ?? "work";
  const title = current?.title;
  const checking = stage === "review" || current?.state === "reported" && current.review && role !== "ranger";
  const sealed = moment === "verified" || moment === "wrapped";
  const reported = moment === "report" && input.report?.status === "done";
  const made = current?.state === "reported" || current?.state === "done" || current?.state === "verified";
  if (current && (sealed || reported || checking && made)) add(id, kind, "done", title);
  if (checking || moment === "verified") {
    const gate = add(current ? `${id}:review` : "review", "review", sealed ? "done" : status, title);
    if (!sealed) return road(gate);
  }
  if (sealed) return road(add("seal", "seal", status, title));
  if (reported) return road(add(`${id}:report`, "report", status, title));
  if (role === "other" || role === "wanderer") return;
  return road(add(id, kind, status, title));
}

type SceneFacts = {
  thread: Runtime; boardQuest: BoardQuest | null; plan: Plan | null; entries: readonly JournalEntry[];
  lastReport?: Report; verdict: ReturnType<typeof waypointMoodVerdict>; held: boolean; archived: boolean;
};

function stripQuest(store: KeeperStore, member: Member, thread: Runtime, boardQuest: BoardQuest | null) {
  const { threadId } = member;
  const route = member.role === "keeper" && thread.lastRouteId ? store.get("routes", thread.lastRouteId) : null;
  const routedQuest = route?.keeperThreadId === threadId && route.boardQuestId && route.boardQuestIds.length <= 1 && (route.kind === "steer" || route.kind === "new-quest") ? store.get("quests", route.boardQuestId) : null;
  return { quest: routedQuest?.keeperThreadId === threadId ? routedQuest : boardQuest, route };
}

export function readSpeechFacts(keeper: Keeper, member: Member, stage: StripScene["stage"]): SpeechFacts {
  const { store } = keeper;
  const boardQuest = member.boardQuestId ? store.get("quests", member.boardQuestId) : null;
  const { quest } = stripQuest(store, member, store.runtime(member.threadId), boardQuest);
  const plan = quest ? store.get("plans", `${quest.id}:${quest.planVersion}`) : null;
  const waypointId = member.checkerWaypointId ?? member.waypointId;
  const waypoint = plan && (member.role !== "keeper" ? plan.waypoints.find(w => w.id === waypointId)
    : stage === "work" || stage === "review" ? currentRoadWaypoint(roadWaypoints(plan, keeper.journal.linkedEntries(plan.boardQuestId))) : undefined);
  return { questTitle: quest?.title, waypointTitle: waypoint?.title, working: member.state === "working", waiting: member.state === "waiting" };
}

export function readStripScene(keeper: Keeper, member: Member, known?: SceneFacts): StripScene {
  const { store } = keeper;
  const { threadId, boardQuestId } = member;
  const thread = known?.thread ?? store.runtime(threadId);
  const boardQuest = known ? known.boardQuest : boardQuestId ? store.get("quests", boardQuestId) : null;
  const plan = known ? known.plan : boardQuest ? store.get("plans", `${boardQuest.id}:${boardQuest.planVersion}`) : null;
  const entries = known?.entries ?? (boardQuest ? keeper.journal.linkedEntries(boardQuest.id) : []);
  const lastReport = known ? known.lastReport : store.query("reports", "memberThreadId", threadId, 1)[0];
  const verdict = known ? known.verdict : waypointMoodVerdict(member, entries);
  const { quest, route } = stripQuest(store, member, thread, boardQuest);
  const waypoint = member.checkerWaypointId ?? member.waypointId;
  const assigned = !!waypoint && !!plan?.waypoints.some(w => w.id === waypoint);
  const sceneVerdict = member.classId === "warden" && boardQuest && assigned && waypoint && plan
    ? committedStripReview(threadId, boardQuest.id, waypoint, entries)
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
  const input: Input = { member, quest, route, waypointId: waypoint,
    commit: member.role === "keeper" && quest ? committedStripPhase(store, threadId, quest.id) : null,
    assignment: assignmentAt == null ? null : { at: assignmentAt, revision: thread.lastAcceptedBriefId ?? `brief:${thread.briefVersion ?? 0}` },
    assigned: assigned || member.errand && !boardQuest,
    report: !boardQuest || lastReport?.boardQuestId === boardQuest.id && lastReport.waypointId === waypoint && lastReport.createdAt >= (plan?.createdAt ?? 0)
      ? currentMoodReport(lastReport, thread.lastBriefAt) : null,
    verdict: assigned && sceneVerdict && sceneVerdict.at >= (plan?.createdAt ?? 0) ? sceneVerdict : null,
    held,
    gone: thread.hidden || (known?.archived ?? (host?.archivedAt != null || host?.deletedAt != null)) || wasReleased(member),
  };
  const scene = stripFacts(input);
  if (!known || scene.stage === "neutral" || scene.posture === "gone") return scene;
  const roadPlan = quest?.id === boardQuest?.id ? plan : quest ? store.get("plans", `${quest.id}:${quest.planVersion}`) : null;
  const roadEntries = roadPlan && quest!.id !== boardQuest?.id ? keeper.journal.linkedEntries(quest!.id) : entries;
  const road = stripRoad(scene, { ...input, waypoints: roadPlan ? roadWaypoints(roadPlan, roadEntries) : undefined });
  return road ? { ...scene, road } : scene;
}

export function stripScene(input: Input): StripScene {
  const scene = stripFacts(input);
  const road = stripRoad(scene, input);
  return road ? { ...scene, road } : scene;
}

function stripFacts({ member, quest, route, commit, assignment, assigned, report, verdict, held, gone }: Input): StripScene {
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
