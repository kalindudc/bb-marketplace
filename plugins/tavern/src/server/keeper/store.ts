import { createHash, randomUUID } from "node:crypto";
import { pullRequestSchema, type PullRequest } from "../../shared/pull-request";
import type { JournalTarget } from "../../shared/placement";
import type { RequestSources } from "../../shared/request-source";
import { liveMemberSql } from "../liveness";
import { nonAlertEventSql } from "../news";
import { consumesMemberWrite, type MemberEngagementData } from "../member-engagement";
import type { Database } from "../ports";
import { freezeJson } from "../freeze-json";
import { databaseConnection } from "../prepared-database";
import type { ProjectContext, Scope, ScopeOverride, ScopeResolution, Violation } from "../../scope";
import type {
  Actor,
  Ask,
  BoardQuest,
  Brief,
  Decision,
  Member,
  Plan,
  Report,
  Route,
  Rule,
  TavernEvent,
  KeeperNote,
  GateRecord,
  LeadLink,
  LeadPlanRecord,
} from "../../shared/schema";
import { actorSchema, readStoredActor } from "../../shared/schema";


// Opening events remain append-only; their quest is projected from the bound source route.
const eventQuestSql = `coalesce(tavern_events.board_quest_id, CASE tavern_events.type
  WHEN 'route.recorded' THEN (SELECT json_extract(opening.data,'$.boardQuestId') FROM tavern_records opening
    WHERE opening.kind='routes' AND opening.id=json_extract(tavern_events.data,'$.routeId')
    AND json_extract(opening.data,'$.kind')='new-quest')
  WHEN 'user.message' THEN (SELECT json_extract(opening.data,'$.boardQuestId') FROM tavern_records opening
    WHERE opening.kind='routes' AND json_extract(opening.data,'$.sourceMessageId')=json_extract(tavern_events.data,'$.receiptId')
    AND json_extract(opening.data,'$.kind')='new-quest'
    ORDER BY opening.rowid DESC LIMIT 1) END)`;
const visibleEventSql = `${nonAlertEventSql} AND NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=${eventQuestSql} AND q.archived_at IS NOT NULL)`;

export interface Records {
  keeperCharges: import("./succession-store").KeeperCharge;
  keeperSpendIntervals: { chargeId: string; threadId: string; from: number | null; until: number | null; activityAt?: number };
  keeperSuccessions: import("./succession-store").KeeperSuccession;
  successionThreads: import("./succession-store").SuccessionThread;
  stopAll: import("../../shared/stop-all").StopAllState;
  pullRequests: PullRequest;
  taleDeliveries: import("zod").infer<typeof import("../tale").taleDeliverySchema>;
  taleDeliveryAttempts: import("zod").infer<typeof import("../tale").taleDeliveryAttemptSchema>;
  serviceRecords: import("../../shared/service-record").ServiceQuestRecord;
  serviceVerdicts: import("../../shared/service-record").ServiceVerdict;
  serviceRecordState: import("../../shared/service-record").ServiceRecordState;
  taleKeeps: import("../../shared/service-record").TaleKeep;
  members: Member;
  leadLinks: LeadLink;
  leadPlans: LeadPlanRecord;
  quests: BoardQuest;
  plans: Plan;
  asks: Ask;
  actVerdicts: { wardenThreadId: string; entryId: string; target: import("../../shared/quest-authority").ActTarget; at: number };
  decisions: Decision;
  decisionSeen: { token: string; seenAt: number };
  attentionSeen: { token: string; seenAt: number };
  rules: Rule;
  reports: Report;
  summaries: import("../../shared/schema").Summary;
  routes: Route;
  askMeta: {
    planVersion?: number;
    reversible?: boolean;
    scopeThreadId?: string;
    briefDelivery?: { threadId: string; briefId: string };
    stopMemberThreadId?: string;
    stopHireTokens?: string[];
    guardHire?: { fingerprint: string; providerId: string; model: string; characterId: string | null; displayName: string; token?: string };
    /** The summary the Keeper reported; the tale is told only from it, after the user's conclude answer. */
    wrapDraft?: { outcome: string; left: string; skipped?: { waypointId: string; reason: string }[]; next?: string[]; results?: import("../../shared/tale-results").TaleResults };
  };
  scopeRequests: ScopeRequest;
  scopeViolations: Violation;
  scopeCallObservations: import("../../scope/watch").CallObservation & { memberThreadId: string; boardQuestId: string | null };
  scopeActObservations: import("../../scope/watch").ActObservation & { keeperThreadId: string; boardQuestId: string | null };
  shellGrants: import("../../shared/shell-grant").ShellGrant;
  scopeInputs: { initial?: ScopeOverride; fingerprint?: string; changes: { override: ScopeOverride; approved?: string[] }[] };
  skips: { boardQuestId: string; version: number; waypointId: string };
  hires: HireIntent;
  placementPicks: { remote: string; projectId: string; ruleId: string; at: number };
  placementModelFailures: { id: string; target: string; providerId?: string; model: string; detail: string; at: number };
  staffing: Staffing;
  notes: KeeperNote;
  gates: GateRecord;
  gateReminders: { keeperThreadId: string; at: number; value?: string };
  autoGreenlights: { keeperThreadId: string; boardQuestId: string; planVersion: number; undonePlanVersion?: number };
}
export interface ScopeRequest {
  keeperThreadId: string;
  boardQuestId: string | null;
  memberThreadId: string;
  classId: string;
  context: ProjectContext;
  override: ScopeOverride;
  widenings: string[];
  reason: string;
  initialBrief: string | null;
  spawnInput?: boolean;
  rememberRemotes?: Record<string, string>;
  state: "pending" | "applied" | "declined";
}
export interface Staffing {
  boardQuestId: string;
  version: number;
  classId: string;
  slots: { memberThreadId: string | null; uses: number }[];
}
export interface StaffingReservation {
  id: string;
  slot: number;
  replacement: number;
  previous: Staffing["slots"][number];
}
export interface ReviewTarget {
  boardQuestId: string;
  waypointId: string;
  makerThreadId: string;
  entryIds: string[];
  checks?: Scope["checks"];
  snapshotId?: string;
  expectedTree?: string;
  makerSubmissionId?: string;
  reviewKey?: string;
  journalTargets?: JournalTarget[];
  waypointFingerprint?: string;
}
export interface HireIntent {
  permanent?: Member["permanent"];
  placementExecution?: { target: import("../../shared/placement-settings").PlacementRule["target"]; providerId: string; model?: string };
  classDefinition?: import("../../shared/schema").ClassDef;
  leadLinkId?: string;
  cancelledAt?: number;
  initialInput?: string;
  scopeResolution?: ScopeResolution | null;
  scopeOverride?: ScopeOverride;
  scopePrepared?: boolean;
  limitDecisionIds?: string[];
  guardApprovalAskId?: string;
  staffing?: StaffingReservation;
  replacesThreadId?: string;
  classId: string;
  characterId: string | null;
  projectId: string;
  createdAt: number;
  memberThreadId?: string;
  owner: {
    keeperThreadId: string;
    boardQuestId: string | null;
    waypointId: string | null;
    errand: boolean;
    title: string;
    displayName?: string;
    checkIndependence?: Member["checkIndependence"];
    guardPosture?: Member["guardPosture"];
    reviewTarget?: ReviewTarget;
    requestSources?: RequestSources;
    assignmentText?: string;
    brief: Brief;
  };
}
export interface TickBatch {
  id: string;
  threadId: string;
  text: string;
  cursor: number;
  heldNewsProgress?: Record<string, number>;
  continuation?: { eventId: number; offset: number } | null;
  reportIds: string[];
  ledger?: { hash: string; version: number; asOf: number };
  fullLedger?: boolean;
  gateReminderKeys?: string[];
  gateWarnings?: { key: string; value: string }[];
  briefWarnings?: { memberThreadId: string; signature: string }[];
  momentKeys?: string[];
  reanchorVersion?: number;
  reanchor: string | null;
  createdAt: number;
  hostAfterSeq?: number;
  attempted: boolean;
  sendPending?: boolean;
  resendCount?: number;
  admittedResendCount?: number;
  lastSendAt?: number;
  measurements?: { facts: { chars: number; clipped: boolean }; restatement?: { bytes: number; clipped: boolean } };
  rowId: string | null;
  state: "prepared" | "queued" | "delivered" | "cancelled";
}
export type RangerContinuation = { reportId: string; minutes: number; questions: string[] };
export interface PendingBrief {
  rangerContinuation?: RangerContinuation;
  waypointIds?: string[];
  id: string;
  text: string;
  assignmentText?: string;
  requestSources?: RequestSources;
  attempts: number;
  nextAttemptAt: number;
  attemptedAt: number | null;
  hostAfterSeq: number | null;
  error: string | null;
  blockerAskId?: string | null;
  createdAt?: number;
  state?: "queued" | "delivering" | "unconfirmed";
  receiptChecks?: number;
  queuedOnHost?: boolean;
  retryRequested?: boolean;
  cancelledQueueId?: string | null;
  hostQueueId?: string | null;
}
export interface Runtime {
  memberEngagement?: MemberEngagementData;
  placementExecution?: HireIntent["placementExecution"];
  keeperTitleSet?: string;
  keeperTitleReplaced?: string;
  keeperTitleRetired?: boolean;
  classDefinition?: import("../../shared/schema").ClassDef;
  classNotice?: import("../../shared/class-execution-contract").ClassNotice | null;
  classRootProblem?: string | null;
  registryWaitSince?: number | null;
  dispatchFailureSince?: number | null;
  registryFailureAskId?: string | null;
  builtinKeeperFallback?: boolean;
  scopeKeeperFallback?: boolean;
  scopeRefusalCounts?: Record<string, number>;
  scopeAssignedBranch?: { environmentId: string; branch: string };
  projectClassRevision?: string;
  classExecutionChoice?: { providerId?: string; recordedAt?: number; model: string | null; reasoningLevel: string | null; modelSource: string | null; reasoningSource: string | null };
  reviewTarget?: ReviewTarget | null;
  submissionTarget?: ReviewTarget | null;
  openingGoal?: { text: string; at: number };
  requestSources?: RequestSources | null;
  assignmentText?: string | null;
  clusterSessionPending?: boolean;
  lastFailure?: string;
  placementFirstTurnSettled?: boolean;
  turnStartedAt?: number | null;
  ledger?: { hash: string; version: number; asOf: number };
  lastLedger?: { hash: string; version: number; at: number };
  briefWarningsSeen?: Record<string, string>;
  manualStopAt?: number | null;
  queuedTickResetId?: string | null;
  lastReply?: { text: string; at: number };
  lastSpendActivityAt?: number;
  reanchorVersion?: number;
  momentCards?: { reanchorVersion: number; keys: string[] };
  pendingMomentEvents?: number[];
  failureCount?: number;
  tickRefusalCount?: number;
  tickRetryAt?: number | null;
  tickDeliveryAskId?: string | null;
  failedRequests?: string[];
  briefVersion?: number;
  reportedBriefVersion?: number;
  failureAskId?: string | null;
  lastBriefAt?: number;
  lastAcceptedBriefId?: string;
  acceptedBriefWaypoints?: { boardQuestId: string; waypointIds: string[] };
  initialBriefAt?: number;
  rangerBox?: { startedAt: number; priorBudgetMinutes: number; priorElapsedMinutes: number; priorOverrun: boolean };
  rangerAcceptedReportId?: string;
  lastUnreportedTurn?: string;
  scopePending?: string | null;
  scopeProblems?: string[];
  executionNotes?: string[];
  routes?: {
    id: string;
    receiptId?: string;
    pending: boolean;
    acceptedAt?: number;
  }[];
  turnEventsObserved?: boolean;
  turnBoundaryUnknown?: boolean;
  mainTurnId?: string;
  endedMainTurns?: string[];
  interruptedMainTurns?: { id: string; at: number }[];
  archivePending?: boolean;
  cellarArchiveRequested?: boolean;
  cellarArchived?: boolean;
  partyArchiveRepairAt?: number;
  archiveError?: string | null;
  liveSince?: number;
  archivedAt?: number | null;
  deletedAt?: number | null;
  threadTitle?: string | null;
  threadCreatedAt?: number;
  projectId: string | null;
  brief: Brief | null;
  hidden: boolean;
  typingAt: number | null;
  userAt: number | null;
  pending: {
    id?: string;
    accepted?: boolean;
    acceptedAt?: number;
    text: string;
    at: number;
    key: string;
    hint: string | null;
    classSelectionOnly?: boolean;
  }[];
  lastRouteId: string | null;
  tickAt: number | null;
  cursor: number;
  heldNewsCursors?: Record<string, { cursor: number; through?: number }>;
  briefFactCursor?: number;
  factContinuation?: { eventId: number; offset: number } | null;
  heldAt: number | null;
  holdExpiredAt?: number;
  reanchor: string | null;
  lastReanchorAt: number | null;
  eventSequence: number;
  lastStrikeAt: number | null;
  quietHintAt?: number;
  waitNoteId?: string | null;
}
const initialRuntime = (): Runtime => ({
  projectId: null,
  brief: null,
  hidden: false,
  typingAt: null,
  userAt: null,
  pending: [],
  lastRouteId: null,
  tickAt: null,
  cursor: 0,
  heldAt: null,
  reanchor: null,
  lastReanchorAt: null,
  eventSequence: 0,
  lastStrikeAt: null,
});

import { hasUserAskOutcome, legacyAskEffect } from "../ask-effects";
import { consumesQuestWrite } from "./quest-lifecycle";
import { undoAskProjection } from "../undo-record";
import { currentAskNames } from "../quest-names";

type StoreView = {
  records: Map<string, Map<string, unknown>>;
  members?: Map<string, Member>;
  runtime: Map<string, { value: Runtime; json: string }>;
};
const views = new WeakMap<Database, StoreView>();

const recordPageSize = 200;

export class KeeperStore {
  private readonly view: StoreView;
  log?: (level: "info" | "warn", message: string) => void;
  /** Set by the runtime: fires after an event is appended, so news can wake the Keeper it belongs to. */
  onEvent?: (event: { keeperThreadId: string | null; boardQuestId: string | null; type: string; data: Record<string, unknown>; actor: Actor }) => void;
  constructor(readonly db: Database) {
    const connection = databaseConnection(db);
    let view = views.get(connection);
    if (!view) {
      view = { records: new Map(), runtime: new Map() };
      views.set(connection, view);
    }
    this.view = view;
  }
  private rememberRecord(kind: string, id: string, value: unknown) {
    let rows = this.view.records.get(kind);
    if (!rows) { rows = new Map(); this.view.records.set(kind, rows); }
    rows.set(id, value);
  }
  private forgetRecords(kind: string) {
    this.view.records.delete(kind);
    if (kind === "members") this.view.members = undefined;
  }
  writeRecords(sql: string, ...args: unknown[]) {
    const rows = this.db.prepare(`${sql} RETURNING kind`).all(...args) as { kind: string }[];
    for (const kind of new Set(rows.map(row => row.kind))) this.forgetRecords(kind);
    return { changes: rows.length };
  }
  renameQuestCreditLabels(id: string, { title, short }: Pick<BoardQuest, "title" | "short">) {
    return this.writeRecords("UPDATE tavern_records SET data=json_set(data,'$.title',?,'$.short',?) WHERE kind='serviceRecords' AND id=?", title, short, id).changes > 0;
  }
  cancelQuestHires(questId: string, at: number) {
    this.writeRecords("UPDATE tavern_records SET data=json_set(data,'$.cancelledAt',?) WHERE kind='hires' AND json_extract(data,'$.owner.boardQuestId')=?", at, questId);
  }
  importRows<T>(write: () => T): T {
    this.view.records.clear();
    this.view.runtime.clear();
    this.view.members = undefined;
    return write();
  }
  removeLegacyRuntimeFields(threadId: string, fields: readonly string[]) {
    this.db.prepare(`UPDATE tavern_runtime SET data=json_remove(data,${fields.map(() => "?").join(",")}) WHERE thread_id=?`)
      .run(...fields.map(field => `$.${field}`), threadId);
    this.view.runtime.delete(threadId);
  }
  id(prefix: string) {
    return `${prefix}_${randomUUID()}`;
  }
  private decode<K extends keyof Records>(kind: K, data: string): Records[K] {
    const record = JSON.parse(data);
    if (kind === "asks" && (!record.effect || record.reversible === undefined)) {
      const meta = this.get("askMeta", record.id);
      record.effect ??= legacyAskEffect(record, meta, this.runtime(record.keeperThreadId));
      record.reversible ??= meta?.reversible === true;
    }
    return record;
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | null {
    if (kind === "members" && this.view.members) return (this.view.members.get(id) ?? null) as Records[K] | null;
    const cached = this.view.records.get(kind)?.get(id);
    if (cached !== undefined && !(kind === "successionThreads" && this.db.inTransaction)) return cached as Records[K] | null;
    const row = this.db.prepare("SELECT data FROM tavern_records WHERE kind=? AND id=?").get(kind, id) as { data: string } | undefined;
    if (row === undefined) {
      if (kind === "successionThreads" && !this.db.inTransaction) this.rememberRecord(kind, id, null);
      return null;
    }
    const value = JSON.parse(row.data) as Records[K];
    // Legacy asks derive an effect from other rows that can change independently.
    if (kind === "asks" && (!(value as Ask).effect || (value as Ask).reversible === undefined)) return freezeJson(this.decode(kind, row.data));
    const immutable = freezeJson(value);
    if (!this.db.inTransaction) this.rememberRecord(kind, id, immutable);
    return immutable;
  }
  query<K extends keyof Records>(
    kind: K,
    field: "keeperThreadId" | "boardQuestId" | "memberThreadId" | "parentKeeperThreadId" | "owner",
    value: string,
    limit = recordPageSize,
  ): Records[K][] {
    const rows = this.db
      .prepare(
        `SELECT data FROM tavern_records WHERE kind=? AND json_extract(data, '$.${field}')=? ORDER BY rowid DESC LIMIT ?`,
      )
      .all(kind, value, limit) as { data: string }[];
    return rows.map((row) => this.decode(kind, row.data)).reverse();
  }
  latestPermanentOccupant(boardQuestId: string, decisionId: string): Member | null {
    const row = this.db.prepare(`SELECT data FROM tavern_records WHERE kind='members'
      AND json_extract(data, '$.boardQuestId')=? AND json_extract(data, '$.permanent.decisionId')=?
      ORDER BY rowid DESC LIMIT 1`).get(boardQuestId, decisionId) as { data: string } | undefined;
    return row ? this.decode("members", row.data) : null;
  }
  pendingMemberBriefs(keeperThreadId: string, boardQuestId?: string, memberThreadId?: string) {
    const rows = this.db.prepare(`SELECT m.data AS member, json_extract(r.data,'$.memberEngagement.delivery') AS brief
      FROM tavern_records m JOIN tavern_runtime r ON r.thread_id=m.id
      WHERE m.kind='members' AND json_extract(m.data, '$.keeperThreadId')=?
        AND json_extract(m.data,'$.role')='member' AND json_type(r.data,'$.memberEngagement.delivery')='object'
        AND (? IS NULL OR json_extract(m.data,'$.boardQuestId')=?) AND (? IS NULL OR m.id=?)
      ORDER BY m.rowid`).all(keeperThreadId, boardQuestId ?? null, boardQuestId ?? null, memberThreadId ?? null, memberThreadId ?? null) as { member: string; brief: string }[];
    return rows.map(row => ({ member: this.decode("members", row.member), pending: JSON.parse(row.brief) as PendingBrief }));
  }
  issuedShellGrants(field: "memberThreadId" | "boardQuestId", value: string) {
    const rows = this.db.prepare(`SELECT data FROM tavern_records WHERE kind='shellGrants' AND json_extract(data,'$.state')='issued' AND json_extract(data,'$.${field}')=? ORDER BY rowid`).all(value) as { data: string }[];
    return rows.map(row => this.decode("shellGrants", row.data));
  }
  retiringLeadLinks(): LeadLink[] {
    const rows = this.db.prepare("SELECT data FROM tavern_records WHERE kind='leadLinks' AND json_extract(data,'$.state')='retiring' ORDER BY rowid DESC").all() as { data: string }[];
    return rows.map(row => this.decode("leadLinks", row.data));
  }
  leadLinksBy(field: "parentQuestId" | "childQuestId", questId: string): LeadLink[] {
    const rows = this.db.prepare(`SELECT data FROM tavern_records WHERE kind='leadLinks' AND json_extract(data,'$.${field}')=?`).all(questId) as { data: string }[];
    return rows.map(row => this.decode("leadLinks", row.data));
  }
  chainSeats(questId: string): { members: number; rangers: number } {
    return this.db.prepare(`SELECT count(*) AS members, count(CASE WHEN classId='ranger' THEN 1 END) AS rangers FROM (
      SELECT json_extract(data,'$.classId') AS classId FROM tavern_records
      WHERE kind='members' AND json_extract(data,'$.boardQuestId')=?
        AND json_extract(data,'$.engagement') IN ('briefing','active','resting','releasing','stopping','archiving')
      UNION ALL
      SELECT json_extract(data,'$.classId') FROM tavern_records
      WHERE kind='hires' AND json_extract(data,'$.owner.boardQuestId')=?
        AND json_extract(data,'$.memberThreadId') IS NULL
    )`).get(questId, questId) as { members: number; rangers: number };
  }
  hireForMember(memberThreadId: string): (HireIntent & { id: string }) | null {
    const row = this.db.prepare(
      "SELECT id,data FROM tavern_records WHERE kind='hires' AND json_extract(data,'$.memberThreadId')=? ORDER BY rowid DESC LIMIT 1",
    ).get(memberThreadId) as { id: string; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as HireIntent, id: row.id } : null;
  }
  membersWithBriefs(keeperThreadId: string): Member[] {
    const rows = this.db.prepare(`SELECT m.data FROM tavern_records m
      WHERE m.kind='members' AND json_extract(m.data,'$.keeperThreadId')=?
      AND json_extract(m.data,'$.boardQuestId') IS NOT NULL AND ${liveMemberSql("brief")}
      ORDER BY m.rowid`).all(keeperThreadId) as { data: string }[];
    return rows.map(row => this.decode("members", row.data));
  }
  activeStaffing(keeperThreadId: string): Member[] {
    const rows = this.db.prepare(`SELECT m.data FROM tavern_records m
      LEFT JOIN tavern_runtime t ON t.thread_id=json_extract(m.data,'$.threadId')
      WHERE m.kind='members' AND json_extract(m.data,'$.keeperThreadId')=?
      AND ${liveMemberSql("occupy")}
      ORDER BY m.rowid`).all(keeperThreadId) as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as Member);
  }
  errandsPage(keeperThreadId: string, limit: number, offset: number, boardQuestId?: string) {
    const where = `m.kind='members' AND json_extract(m.data,'$.role')='member'
      AND json_extract(m.data,'$.keeperThreadId')=? AND json_extract(m.data,'$.errand')=1
      ${boardQuestId ? "AND json_extract(m.data,'$.boardQuestId')=?" : ""}`;
    const occupies = liveMemberSql("occupy");
    const inFlight = `(${occupies}) AND json_extract(m.data,'$.state')<>'failed'`;
    const from = `FROM tavern_records m WHERE ${where}`;
    const params = [keeperThreadId, ...(boardQuestId ? [boardQuestId] : [])];
    const counts = this.db.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN ${inFlight} THEN 1 ELSE 0 END),0) AS inFlightCount ${from}`)
      .get(...params) as { total: number; inFlightCount: number };
    const rows = this.db.prepare(`SELECT m.data, CASE WHEN ${occupies} THEN 1 ELSE 0 END AS occupies ${from}
      ORDER BY CASE WHEN ${inFlight} THEN 0 ELSE 1 END,
      max(json_extract(m.data,'$.createdAt'),coalesce(json_extract(m.data,'$.lastReportAt'),0),coalesce(json_extract(m.data,'$.lastActiveAt'),0)) DESC,
      m.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as { data: string; occupies: number }[];
    return { ...counts, members: rows.map(row => ({ member: JSON.parse(row.data) as Member, occupies: row.occupies === 1 })) };
  }
  mapHistory() {
    const rows = this.db.prepare(`WITH archived AS (
      SELECT m.id AS thread_id FROM tavern_records m JOIN tavern_runtime t ON t.thread_id=m.id
      WHERE m.kind='members' AND json_extract(m.data,'$.role')='keeper'
      AND json_extract(t.data,'$.archivedAt') IS NOT NULL
      ORDER BY json_extract(t.data,'$.archivedAt') DESC,m.id LIMIT 50
    ), ranked AS (
      SELECT q.id,q.data,json_extract(q.data,'$.keeperThreadId') AS keeper_id,
      row_number() OVER (PARTITION BY json_extract(q.data,'$.keeperThreadId') ORDER BY
        coalesce(json_extract(q.data,'$.endedAt'),json_extract(q.data,'$.updatedAt')) DESC,q.rowid DESC) AS position,
      count(*) OVER (PARTITION BY json_extract(q.data,'$.keeperThreadId')) AS total
      FROM tavern_records q JOIN archived a ON a.thread_id=json_extract(q.data,'$.keeperThreadId') WHERE q.kind='quests' AND json_extract(q.data,'$.deletedAt') IS NULL
    ) SELECT a.thread_id,r.data,coalesce(r.total,0) AS total,
      (SELECT json_group_array(json(m.data)) FROM tavern_records m WHERE m.kind='members'
       AND json_extract(m.data,'$.boardQuestId')=r.id) AS members
      FROM archived a LEFT JOIN ranked r ON r.keeper_id=a.thread_id AND r.position<=5
      ORDER BY a.thread_id,r.position`).all() as { thread_id: string; data: string | null; total: number; members: string }[];
    const keepers = new Map<string, { threadId: string; total: number; quests: (BoardQuest & { members: Member[] })[] }>();
    for (const row of rows) {
      let keeper = keepers.get(row.thread_id);
      if (!keeper) { keeper = { threadId: row.thread_id, total: row.total, quests: [] }; keepers.set(row.thread_id, keeper); }
      if (row.data !== null) keeper.quests.push({ ...JSON.parse(row.data) as BoardQuest, members: JSON.parse(row.members) as Member[] });
    }
    return { keepers: [...keepers.values()] };
  }
  scopeViolations(threadIds: string[]) {
    if (!threadIds.length) return [];
    const ids = [...new Set(threadIds)].slice(0, 500);
    const rows = this.db
      .prepare(
        `SELECT data FROM tavern_records WHERE kind='scopeViolations' AND json_extract(data,'$.threadId') IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 100`,
      )
      .all(JSON.stringify(ids)) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Violation).reverse();
  }
  scopeCallPage(memberThreadId: string, before?: number, limit = recordPageSize) {
    const rows = this.db.prepare(`SELECT rowid AS cursor, data FROM tavern_records
      WHERE kind='scopeCallObservations' AND json_extract(data, '$.memberThreadId')=? AND (? IS NULL OR rowid<?)
      ORDER BY rowid DESC LIMIT ?`).all(memberThreadId, before ?? null, before ?? null, limit + 1) as { cursor: number; data: string }[];
    return {
      recent: rows.slice(0, limit).map(row => this.decode("scopeCallObservations", row.data)),
      next: rows.length > limit ? rows[limit - 1].cursor : null,
    };
  }
  scopeCallActivity(memberThreadId: string) {
    const aggregate = this.db.prepare(`SELECT count(*) AS count, count(CASE WHEN json_extract(data,'$.outcome')='inspection-unavailable' THEN 1 END) AS unavailable
      FROM tavern_records WHERE kind='scopeCallObservations' AND json_extract(data, '$.memberThreadId')=?`).get(memberThreadId) as { count: number; unavailable: number };
    return { ...aggregate, ...this.scopeCallPage(memberThreadId) };
  }
  pendingScopeRequests(keeperThreadId: string) {
    const rows = this.db
      .prepare(
        "SELECT id, data FROM tavern_records WHERE kind='scopeRequests' AND json_extract(data,'$.keeperThreadId')=? AND json_extract(data,'$.state')='pending' ORDER BY rowid LIMIT 100",
      )
      .all(keeperThreadId) as { id: string; data: string }[];
    return rows.map((row) => ({
      id: row.id,
      ...(JSON.parse(row.data) as ScopeRequest),
    }));
  }
  visibleRecords<
    K extends "quests" | "reports" | "asks" | "decisions" | "routes",
  >(
    kind: K,
    keeperThreadId: string,
    limit = 100,
    offset = 0,
    boardQuestId?: string,
  ): Records[K][] {
    let visibility =
      kind === "quests"
        ? "r.archived_at IS NULL"
        : "NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND q.archived_at IS NOT NULL)";
    if (kind === "routes")
      visibility = `(${visibility} OR EXISTS (
      SELECT 1 FROM json_each(r.data,'$.boardQuestIds') target
      JOIN tavern_records q ON q.kind='quests' AND q.id=target.value
      WHERE q.archived_at IS NULL))`;
    const rows = this.db
      .prepare(
        `SELECT r.data FROM tavern_records r WHERE r.kind=?
      AND json_extract(r.data,'$.keeperThreadId')=? AND ${visibility}
      ${boardQuestId ? "AND json_extract(r.data,'$.boardQuestId')=?" : ""}
      ORDER BY r.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(
        kind,
        keeperThreadId,
        ...(boardQuestId ? [boardQuestId] : []),
        limit,
        offset,
      ) as {
      data: string;
    }[];
    return rows.map((row) => this.decode(kind, row.data));
  }
  archivedQuestCount(keeperThreadId?: string) {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM tavern_records WHERE kind='quests' AND archived_at IS NOT NULL AND json_extract(data,'$.deletedAt') IS NULL
      ${keeperThreadId ? "AND json_extract(data,'$.keeperThreadId')=?" : ""}`,
      )
      .get(...(keeperThreadId ? [keeperThreadId] : [])) as { n: number };
    return row.n;
  }
  archivedQuestPage(cursor: string | null, limit: number) {
    let after: [number, string] | null = null;
    if (cursor !== null) {
      try {
        if (cursor.length > 1024) throw new Error("Cursor too long");
        const value: unknown = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        );
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !Number.isSafeInteger(value[0]) ||
          value[0] < 0 ||
          typeof value[1] !== "string" ||
          value[1].length < 1 ||
          value[1].length > 120
        )
          throw new Error("Invalid cursor shape");
        after = value as [number, string];
      } catch {
        throw new Error("Invalid archive cursor");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT data FROM tavern_records WHERE kind='quests' AND archived_at IS NOT NULL AND json_extract(data,'$.deletedAt') IS NULL
      ${after ? "AND archived_at<=? AND (archived_at<? OR id<?)" : ""}
      ORDER BY archived_at DESC, id DESC LIMIT ?`,
      )
      .all(...(after ? [after[0], after[0], after[1]] : []), limit + 1) as {
      data: string;
    }[];
    const quests = rows
      .slice(0, limit)
      .map((row) => JSON.parse(row.data) as BoardQuest);
    const last = quests.at(-1);
    return {
      quests,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.archivedAt, last.id])).toString(
              "base64url",
            )
          : null,
      total: this.archivedQuestCount(),
    };
  }
  deletedQuestPage(cursor: string | null, limit: number) {
    let after: [number, string] | null = null;
    if (cursor !== null) {
      try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || !Number.isFinite(value[0]) || typeof value[1] !== "string") throw new Error("Invalid cursor");
        after = value as [number, string];
      } catch { throw new Error("Invalid deleted quest cursor"); }
    }
    const from = "FROM tavern_records WHERE kind='quests' AND json_extract(data,'$.deletedAt') IS NOT NULL";
    const rows = this.db.prepare(`SELECT data ${from} ${after ? "AND (json_extract(data,'$.deletedAt')<? OR (json_extract(data,'$.deletedAt')=? AND id<?))" : ""}
      ORDER BY json_extract(data,'$.deletedAt') DESC,id DESC LIMIT ?`)
      .all(...(after ? [after[0], after[0], after[1]] : []), limit + 1) as { data: string }[];
    const quests = rows.slice(0, limit).map(row => JSON.parse(row.data) as BoardQuest);
    const last = quests.at(-1);
    const total = (this.db.prepare(`SELECT count(*) AS n ${from}`).get() as { n: number }).n;
    return { quests, total, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.deletedAt, last.id])).toString("base64url") : null };
  }
  answeredUserWaypoints(boardQuestId: string): Ask[] {
    const rows = this.db.prepare(`SELECT data FROM tavern_records WHERE kind='asks'
      AND json_extract(data,'$.boardQuestId')=? AND json_extract(data,'$.effect.type')='user-waypoint'
      AND json_extract(data,'$.state')='answered' AND json_extract(data,'$.answer.by')='user'
      ORDER BY rowid`).all(boardQuestId) as { data: string }[];
    return rows.map(row => this.decode("asks", row.data));
  }
  openAsks(
    keeperThreadId?: string,
    boardQuestId?: string,
    visibleOnly = false,
  ): Ask[] {
    const args = [keeperThreadId, boardQuestId].filter(
      (id): id is string => id !== undefined,
    );
    const clause = `${keeperThreadId ? " AND json_extract(data,'$.keeperThreadId')=?" : ""}${boardQuestId ? " AND json_extract(data,'$.boardQuestId')=?" : ""}`;
    const asks = (
      this.db
        .prepare(
          `SELECT r.data FROM tavern_records r WHERE kind='asks' AND json_extract(data,'$.state')='open'${clause}
           ${visibleOnly ? "AND NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND q.archived_at IS NOT NULL)" : ""}
           ORDER BY r.rowid`,
        )
        .all(...args) as { data: string }[]
    ).map((row) => this.decode("asks", row.data));
    return visibleOnly ? asks.map(undoAskProjection(this)).filter(ask => ask.lane !== "keeper" && ask.lane !== "tavern" && hasUserAskOutcome(ask, ask.effect!)).map(ask => currentAskNames(this, ask)) : asks;
  }
  activeRules(
    keeperId: string,
    projectId: string | null,
    questId: string | null,
    includeQuests: boolean,
    includeInactive = false,
  ): Rule[] {
    const rows = this.db
      .prepare(
        `SELECT data FROM tavern_records WHERE kind='rules' AND (?=1 OR json_extract(data,'$.active')=1) AND (
      json_extract(data,'$.scope')='global'
      OR (json_extract(data,'$.scope')='project' AND json_extract(data,'$.scopeId')=?)
      OR (json_extract(data,'$.scope')='keeper' AND json_extract(data,'$.scopeId')=?)
      OR (json_extract(data,'$.scope')='quest' AND (json_extract(data,'$.scopeId')=? OR
        (?=1 AND json_extract(data,'$.scopeId') IN (SELECT id FROM tavern_records WHERE kind='quests' AND archived_at IS NULL AND json_extract(data,'$.keeperThreadId')=?))))
    ) ORDER BY rowid DESC LIMIT 100`,
      )
      .all(
        Number(includeInactive),
        projectId,
        keeperId,
        questId,
        Number(includeQuests && questId === null),
        keeperId,
      ) as {
      data: string;
    }[];
    return rows.reverse().map((row) => JSON.parse(row.data) as Rule);
  }
  checkerHeldQuests(keeperThreadId: string): BoardQuest[] {
    const rows = this.db.prepare(`SELECT data FROM tavern_records WHERE kind='quests'
      AND json_extract(data,'$.keeperThreadId')=?
      AND json_extract(data,'$.phase') NOT IN ('done','stopping','stopped')
      AND json_extract(data,'$.checkerHandoffHold.id') IS NOT NULL
      AND json_extract(data,'$.checkerHandoffHold.release') IS NULL ORDER BY rowid DESC`).all(keeperThreadId) as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as BoardQuest);
  }
  questsAwaitingSpendCheck(): { id: string; keeperThreadId: string }[] {
    return this.db.prepare(`SELECT id, json_extract(data,'$.keeperThreadId') AS keeperThreadId
      FROM tavern_records WHERE kind='quests' AND archived_at IS NULL
      AND json_extract(data,'$.archivedAt') IS NULL AND json_extract(data,'$.endedAt') IS NULL
      AND json_extract(data,'$.phase') NOT IN ('done','stopped','stopping')
      AND json_extract(data,'$.spendBudget.cents') IS NOT NULL
      AND json_extract(data,'$.spendBudget.reached') IS NULL ORDER BY rowid DESC`).all() as { id: string; keeperThreadId: string }[];
  }
  activeQuests(limit = 200): BoardQuest[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM tavern_records WHERE kind='quests' AND json_extract(data,'$.phase') NOT IN ('done','stopped') ORDER BY rowid DESC LIMIT ?",
        )
        .all(limit) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as BoardQuest);
  }
  allocated(questId: string, classId: string): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM tavern_records m LEFT JOIN tavern_runtime t ON t.thread_id=json_extract(m.data,'$.threadId')
      WHERE m.kind='members' AND json_extract(m.data,'$.boardQuestId')=? AND json_extract(m.data,'$.classId')=?
      AND ${liveMemberSql("occupy")}`,
      )
      .get(questId, classId) as { n: number };
    return row.n;
  }
  latest<K extends keyof Records>(kind: K, limit = 200): Records[K][] {
    return (
      this.db
        .prepare(
          "SELECT data FROM tavern_records WHERE kind=? ORDER BY rowid DESC LIMIT ?",
        )
        .all(kind, limit) as { data: string }[]
    )
      .reverse()
      .map((row) => this.decode(kind, row.data));
  }
  keeperEventOwners(threadId: string): string[] {
    const chargeId = this.get("successionThreads", threadId)?.chargeId;
    if (!chargeId || this.get("keeperCharges", chargeId)?.current !== threadId) return [threadId];
    const prior = this.db.prepare(`SELECT json_extract(data,'$.predecessor') AS id FROM tavern_records
      WHERE kind='keeperSuccessions' AND json_extract(data,'$.chargeId')=? AND json_extract(data,'$.state')='done'`).all(chargeId) as { id: string }[];
    return [threadId, ...prior.map(row => row.id)];
  }
  spendIntervals(threadId: string): Records["keeperSpendIntervals"][] {
    const current = this.get("keeperSpendIntervals", threadId);
    if (!current) return [{ chargeId: threadId, threadId, from: null, until: null }];
    const rows = this.db.prepare("SELECT data FROM tavern_records WHERE kind='keeperSpendIntervals' AND json_extract(data,'$.chargeId')=? ORDER BY json_extract(data,'$.from')").all(current.chargeId) as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as Records["keeperSpendIntervals"]);
  }
  messageReceipt(keeperId: string, id: string, settled = false) {
    const row = this.db.prepare("SELECT thread_id, text, at, accepted FROM tavern_messages WHERE id=?").get(id) as { thread_id: string; text: string; at: number; accepted: number } | undefined;
    return row && (!settled || row.accepted === 2 && row.text.trim()) && this.keeperEventOwners(keeperId).includes(row.thread_id) ? row : undefined;
  }
  partyMessageReceipt(keeperId: string, receiptId: string) {
    return this.db.prepare(`SELECT m.thread_id, m.text, m.at, m.accepted, e.board_quest_id
      FROM tavern_messages m JOIN tavern_events e ON json_extract(e.data,'$.receiptId')=m.id
      WHERE m.id=? AND e.type='user.told-member' AND json_extract(e.actor,'$.kind')='user'
        AND e.keeper_thread_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(receiptId, JSON.stringify(this.keeperEventOwners(keeperId))) as
      { thread_id: string; text: string; at: number; accepted: number; board_quest_id: string | null } | undefined;
  }
  messageText(receiptId: string) {
    return (
      this.db
        .prepare("SELECT text FROM tavern_messages WHERE id=?")
        .get(receiptId) as { text: string } | undefined
    )?.text;
  }
  receipt(
    threadId: string,
    text: string,
    at: number,
    rowId?: string,
    accepted = true,
  ): { id: string; fresh: boolean } {
    if (rowId) {
      const existing = this.db
        .prepare("SELECT id FROM tavern_messages WHERE row_id=?")
        .get(rowId) as { id: string } | undefined;
      if (existing) {
        if (accepted) this.db.prepare("UPDATE tavern_messages SET accepted=1 WHERE id=? AND thread_id=? AND accepted=0").run(existing.id, threadId);
        return { id: existing.id, fresh: false };
      }
      const inline = this.db
        .prepare(
          "SELECT id FROM tavern_messages WHERE thread_id=? AND text=? AND row_id IS NULL AND accepted<2 AND (accepted=0 OR at BETWEEN ? AND ?) ORDER BY accepted, at, rowid LIMIT 1",
        )
        .get(threadId, text, at - 5000, at + 5000) as
        { id: string } | undefined;
      if (inline) {
        this.db
          .prepare("UPDATE tavern_messages SET row_id=?, accepted=? WHERE id=?")
          .run(rowId, Number(accepted), inline.id);
        return { id: inline.id, fresh: false };
      }
    }
    const id = this.id("message");
    this.db
      .prepare(
        "INSERT INTO tavern_messages(id,thread_id,text,at,row_id,accepted) VALUES(?,?,?,?,?,?)",
      )
      .run(id, threadId, text, at, rowId ?? null, Number(accepted));
    return { id, fresh: true };
  }
  finishReceipt(id: string | undefined) {
    if (id)
      this.db
        .prepare("UPDATE tavern_messages SET accepted=2 WHERE id=?")
        .run(id);
  }
  messageId(rowId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM tavern_messages WHERE row_id=?")
      .get(rowId) as { id: string } | undefined;
    return row?.id ?? null;
  }
  pruneTicks() {
    this.db
      .prepare(
        "UPDATE tavern_outbox SET data=json_set(data, '$.text', '') WHERE state IN ('delivered','cancelled') AND json_extract(data,'$.text') != ''",
      )
      .run();
  }
  putTick(batch: TickBatch) {
    const stored = ["delivered", "cancelled"].includes(batch.state)
      ? { ...batch, text: "" }
      : batch;
    this.db
      .prepare(
        "INSERT INTO tavern_outbox(id,thread_id,state,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
      )
      .run(batch.id, batch.threadId, batch.state, JSON.stringify(stored));
  }
  tick(id: string): TickBatch | null {
    const row = this.db
      .prepare("SELECT data FROM tavern_outbox WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TickBatch) : null;
  }
  pendingTick(threadId: string): TickBatch | null {
    const row = this.db
      .prepare(
        "SELECT data FROM tavern_outbox WHERE thread_id=? AND state IN ('prepared','queued') ORDER BY rowid LIMIT 1",
      )
      .get(threadId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as TickBatch) : null;
  }
  remove(kind: keyof Records, id: string) {
    this.db.prepare("DELETE FROM tavern_records WHERE kind=? AND id=?").run(kind, id);
    this.view.records.get(kind)?.delete(id);
    // Only publish committed rows: a savepoint can undo this removal.
    if (kind === "members") this.view.members = undefined;
  }
  all<K extends keyof Records>(kind: K): Records[K][] {
    if (kind === "members") {
      let members = this.view.members;
      if (!members) {
        const rows = this.db.prepare("SELECT id,data FROM tavern_records WHERE kind=? ORDER BY rowid").all(kind) as { id: string; data: string }[];
        members = new Map(rows.map(row => [row.id, freezeJson(this.decode("members", row.data))]));
        if (!this.db.inTransaction) {
          this.view.members = members;
          this.view.records.delete("members");
        }
      }
      return [...members.values()] as Records[K][];
    }
    const rows = this.db.prepare("SELECT data FROM tavern_records WHERE kind=? ORDER BY rowid").all(kind) as { data: string }[];
    return rows.map(row => this.decode(kind, row.data));
  }
  put<K extends keyof Records>(kind: K, id: string, data: Records[K]) {
    if (kind === "members") {
      const member = data as Member, previous = this.get("members", id);
      const authorised = consumesMemberWrite(data);
      if ((member.engagement !== previous?.engagement || member.disposition !== previous?.disposition || member.role !== "keeper" && !member.engagement) && !authorised)
        throw new Error("Member engagement writes require the engagement transition");
    }
    if (kind === "quests") {
      const previous = this.get("quests", id);
      const authorised = consumesQuestWrite(data);
      // Normalized reads must not migrate legacy phases during unrelated record updates.
      if (!authorised && previous && ["check", "wrap"].includes(previous.phase) && (data as BoardQuest).phase === "build") {
        data = { ...data, phase: previous.phase };
      }
      if ((!previous || previous.phase !== (data as BoardQuest).phase || JSON.stringify(previous.held) !== JSON.stringify((data as BoardQuest).held)) && !authorised) throw new Error("Quest phase writes require the quest lifecycle");
    }
    const json = JSON.stringify(data);
    this.db.prepare(
      "INSERT INTO tavern_records(kind,id,data,archived_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,archived_at=excluded.archived_at",
    ).run(kind, id, json, kind === "quests" ? ((data as BoardQuest).archivedAt ?? null) : null);
    this.view.records.get(kind)?.delete(id);
    if (this.db.inTransaction) {
      if (kind === "members") this.view.members = undefined;
    } else {
      const value = freezeJson(JSON.parse(json) as Records[K]);
      if (kind === "members" && this.view.members) this.view.members.set(id, value as Member);
      else if (kind !== "asks" || (value as Ask).effect && (value as Ask).reversible !== undefined) this.rememberRecord(kind, id, value);
    }
    return data;
  }
  private runtimeRow(threadId: string) {
    const cached = this.view.runtime.get(threadId);
    if (cached) return cached;
    const row = this.db.prepare("SELECT data FROM tavern_runtime WHERE thread_id=?").get(threadId) as { data: string } | undefined;
    if (!row) return null;
    const result = { value: freezeJson({ ...initialRuntime(), ...(JSON.parse(row.data) as Runtime) }), json: row.data };
    if (!this.db.inTransaction) this.view.runtime.set(threadId, result);
    return result;
  }
  runtime(threadId: string): Runtime {
    return this.runtimeRow(threadId)?.value ?? freezeJson(initialRuntime());
  }
  pullRequestsForMember(threadId: string): PullRequest[] {
    return this.all("pullRequests").filter(pr => pr.memberThreadId === threadId || pr.owner === threadId);
  }
  recordPullRequest(input: Omit<PullRequest, "id" | "memberThreadId"> & { memberThreadId?: string }, at: number): PullRequest {
    return this.atomic(() => {
      const id = "pr-" + createHash("sha256").update(JSON.stringify([input.projectId, input.head])).digest("hex");
      const previous = this.get("pullRequests", id);
      if (previous && (previous.owner !== input.owner || previous.boardQuestId !== input.boardQuestId || previous.keeperThreadId !== input.keeperThreadId)) throw new Error("This branch already has a pull request and an owner; reuse that record.");
      if (previous && previous.base !== input.base) throw new Error(`This branch's draft targets ${previous.base}; moving it comes later`);
      const state = previous && previous.url !== input.url ? "draft" : previous?.state ?? input.state;
      const prior = previous?.url === input.url ? previous : null;
      const next = pullRequestSchema.parse({ ...input, state, memberThreadId: previous?.memberThreadId ?? input.memberThreadId ?? input.owner, id,
        ...(prior ? { verdict: prior.verdict, readyDecisionId: prior.readyDecisionId,
          verifiedCommit: (prior.pushedHead ?? prior.memberHead) === (input.pushedHead ?? input.memberHead) ? prior.verifiedCommit : input.verifiedCommit } : {}) });
      if (JSON.stringify(previous) !== JSON.stringify(next)) this.changePullRequest(next, at);
      return next;
    });
  }
  pullRequestsForQuest(questId: string): PullRequest[] {
    const rows = this.db.prepare("SELECT data FROM tavern_records WHERE kind='pullRequests' AND json_extract(data,'$.boardQuestId')=? ORDER BY rowid").all(questId) as { data: string }[];
    return rows.map(row => pullRequestSchema.parse(JSON.parse(row.data)));
  }
  openPullRequests(questId: string) { return this.pullRequestsForQuest(questId).filter(pr => pr.state === "draft" || pr.state === "ready"); }
  changePullRequest(pr: PullRequest, at: number, askId?: string, change?: { actor: Actor; action: string; reason: string; receipt: string }) {
    return this.atomic(() => {
      this.put("pullRequests", pr.id, pr);
      const { actor, ...details } = change ?? {};
      this.event(at, pr.keeperThreadId, pr.boardQuestId, "pull-request.changed", `Pull request ${pr.state}: ${pr.url}; owner ${pr.owner}`, { ...pr, ...details, ...(askId ? { askId } : {}) }, actor ?? (askId ? { kind: "user" } : { kind: "tavern" }));
      return pr;
    });
  }
  transferPullRequests(threadId: string, at: number) {
    const member = this.get("members", threadId);
    if (member?.classId !== "smith" || !member.keeperThreadId) return;
    for (const pr of this.all("pullRequests")) if (pr.owner === threadId && ["draft", "ready"].includes(pr.state))
      this.changePullRequest({ ...pr, owner: member.keeperThreadId }, at);
  }
  patch(threadId: string, patch: Partial<Runtime>) {
    const current = this.runtimeRow(threadId);
    const data = { ...(current?.value ?? initialRuntime()), ...patch };
    const json = JSON.stringify(data);
    if (current?.json === json) return data;
    this.db.prepare(
      "INSERT INTO tavern_runtime(thread_id,data) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data",
    ).run(threadId, json);
    if (this.db.inTransaction) this.view.runtime.delete(threadId);
    else this.view.runtime.set(threadId, { value: freezeJson({ ...initialRuntime(), ...JSON.parse(json) as Runtime }), json });
    return data;
  }
  atomic<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  event(
    at: number,
    keeperThreadId: string | null,
    boardQuestId: string | null,
    type: string,
    text: string,
    data: Record<string, unknown> = {},
    actor: Actor = { kind: "tavern" },
  ) {
    actor = actorSchema.parse(actor);
    const result = this.db
      .prepare(
        "INSERT INTO tavern_events(at,keeper_thread_id,board_quest_id,actor,type,text,data) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        at,
        keeperThreadId,
        boardQuestId,
        JSON.stringify(actor),
        type,
        text.slice(0, 500),
        JSON.stringify(data),
      );
    if (/^(ask\.|scope\.|thread\.|member\.hired$)/.test(type))
      this.log?.(
        type === "scope.violation" ? "warn" : "info",
        `Tavern ${type} keeper=${keeperThreadId ?? "-"} quest=${boardQuestId ?? "-"}: ${text.slice(0, 200)}`,
      );
    this.onEvent?.({ keeperThreadId, boardQuestId, type, data, actor });
    return Number(result.lastInsertRowid);
  }
  questRoadEvent(boardQuestId: string, through: number): TavernEvent | null {
    return this.readEvents("WHERE board_quest_id=? AND at<=? AND json_type(data,\'$.phase\')=\'object\' AND json_extract(data,\'$.phase.to\') NOT IN (\'done\',\'stopped\') ORDER BY at DESC,id DESC LIMIT 1", [boardQuestId, through])[0] ?? null;
  }
  questHeldEvent(questId: string, before: number): TavernEvent | null {
    return this.readEvents("WHERE board_quest_id=? AND id<? AND json_type(data,'$.phase')='object' AND json_extract(data,'$.phase.to')='held' ORDER BY id DESC LIMIT 1", [questId, before])[0] ?? null;
  }
  latestQuestEvent(questId: string, type: string): TavernEvent | null {
    return this.readEvents("WHERE board_quest_id=? AND type=? ORDER BY id DESC LIMIT 1", [questId, type])[0] ?? null;
  }
  eventSequence(keeperId: string): number {
    const owners = this.keeperEventOwners(keeperId);
    return (this.db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM tavern_events WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")})`).get(...owners) as { id: number }).id;
  }
  heldNews(questId: string, cursor: number, through: number, limit = 100): TavernEvent[] {
    return this.readEvents(`WHERE board_quest_id=? AND id>? AND id<=? AND ${visibleEventSql} AND type NOT IN ('user.message','route.recorded','route.corrected','journal.changed','questlog.changed') ORDER BY id ASC LIMIT ?`, [questId, cursor, through, limit]);
  }
  heldJournalChurn(questId: string, cursor: number, through: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM tavern_events WHERE board_quest_id=? AND id>? AND id<=? AND type IN ('journal.changed','questlog.changed') AND ${visibleEventSql}`).get(questId, cursor, through) as { n: number }).n;
  }
  acknowledgeHeldNews(threadId: string, progress: Record<string, number>) {
    const cursors = { ...this.runtime(threadId).heldNewsCursors };
    for (const [questId, cursor] of Object.entries(progress)) {
      const window = cursors[questId];
      if (!window) continue;
      if (window.through !== undefined && cursor >= window.through) delete cursors[questId];
      else cursors[questId] = { ...window, cursor: Math.max(window.cursor, cursor) };
    }
    this.patch(threadId, { heldNewsCursors: cursors });
  }
  roomEvents(limit = 60) {
    return this.readEvents(
      `WHERE ${visibleEventSql} ORDER BY id DESC LIMIT ?`,
      [limit],
    ).reverse();
  }
  unreadEvents(
    keeperThreadId: string,
    after: number,
    limit = 100,
    visibleOnly = false,
  ): TavernEvent[] {
    const owners = this.keeperEventOwners(keeperThreadId);
    return this.readEvents(
      `WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")}) AND id>? ${visibleOnly ? `AND ${visibleEventSql}` : ""} ORDER BY id ASC LIMIT ?`,
      [...owners, after, limit],
    );
  }
  briefFacts(keeperThreadId: string, after: number, through: number) {
    const owners = this.keeperEventOwners(keeperThreadId);
    return this.readEvents(
      `WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")}) AND type='member.briefed' AND id>? AND id<=? ORDER BY id DESC LIMIT 8`,
      [...owners, after, through],
    );
  }
  recentScopeBlocks(keeperThreadId: string, limit: number, questId?: string) {
    const owners = this.keeperEventOwners(keeperThreadId);
    return this.readEvents(`WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")})
      AND type IN ('scope.violation','blocker.moved') AND coalesce(json_extract(data,'$.mode'),'enforce') <> 'watch'
      AND (type='scope.violation' OR json_extract(data,'$.effectType')='scope-blocker')
      ${questId ? "AND board_quest_id=?" : ""} AND ${visibleEventSql} ORDER BY id DESC LIMIT ?`, [...owners, ...(questId ? [questId] : []), limit]);
  }
  recentScheduledRounds(keeperThreadId: string) {
    const owners = this.keeperEventOwners(keeperThreadId);
    return this.readEvents(`WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")}) AND type='member.schedule-round' AND ${visibleEventSql} ORDER BY id DESC LIMIT 20`, owners);
  }
  momentEvents(keeperThreadId: string, ids: number[]) {
    if (!ids.length) return [];
    return this.readEvents(`WHERE keeper_thread_id=? AND id IN (SELECT value FROM json_each(?)) AND ${visibleEventSql} ORDER BY id ASC`, [keeperThreadId, JSON.stringify(ids)]);
  }
  eventCount(keeperThreadId: string, after: number, visibleOnly = false) {
    const owners = this.keeperEventOwners(keeperThreadId);
    return (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM tavern_events WHERE keeper_thread_id IN (${owners.map(() => "?").join(",")}) AND id>? ${visibleOnly ? `AND ${visibleEventSql}` : ""}`,
        )
        .get(...owners, after) as { n: number }
    ).n;
  }
  private readEvents(clause: string, args: (string | number)[]): TavernEvent[] {
    const rows = this.db
      .prepare(`SELECT tavern_events.*, ${eventQuestSql} AS resolved_quest_id FROM tavern_events ${clause}`)
      .all(...args) as {
      resolved_quest_id: string | null;
      id: number;
      at: number;
      keeper_thread_id: string | null;
      board_quest_id: string | null;
      actor: string;
      type: string;
      text: string;
      data: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      keeperThreadId: row.keeper_thread_id,
      boardQuestId: row.resolved_quest_id,
      actor: readStoredActor(row.actor),
      type: row.type === "quest.held" && JSON.parse(row.data).phase?.to !== "held" ? "quest.kept-open" : row.type,
      text: row.text,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }
  events(keeperThreadId?: string, after = 0, limit = 200): TavernEvent[] {
    const owners = keeperThreadId === undefined ? [] : this.keeperEventOwners(keeperThreadId);
    const rows = this.db
      .prepare(
        `SELECT * FROM tavern_events WHERE id > ? ${owners.length ? `AND keeper_thread_id IN (${owners.map(() => "?").join(",")})` : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(after, ...owners, limit) as {
      id: number;
      at: number;
      keeper_thread_id: string | null;
      board_quest_id: string | null;
      actor: string;
      type: string;
      text: string;
      data: string;
    }[];
    return rows.reverse().map((row) => ({
      id: row.id,
      at: row.at,
      keeperThreadId: row.keeper_thread_id,
      boardQuestId: row.board_quest_id,
      actor: readStoredActor(row.actor),
      type: row.type === "quest.held" && JSON.parse(row.data).phase?.to !== "held" ? "quest.kept-open" : row.type,
      text: row.text,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }
}
