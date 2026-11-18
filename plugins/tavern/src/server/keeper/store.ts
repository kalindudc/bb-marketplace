import { randomUUID } from "node:crypto";
import type { JournalTarget } from "../../shared/placement";
import type { RequestSources } from "../../shared/request-source";
import { liveMemberSql } from "../liveness";
import type { Database } from "../ports";
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
} from "../../shared/schema";
import { actorSchema, readStoredActor } from "../../shared/schema";

import type { VoiceCheck } from "../../shared/voice-check";

// Opening events remain append-only; their quest is projected from the bound source route.
const eventQuestSql = `coalesce(tavern_events.board_quest_id, CASE tavern_events.type
  WHEN 'route.recorded' THEN (SELECT json_extract(opening.data,'$.boardQuestId') FROM tavern_records opening
    WHERE opening.kind='routes' AND opening.id=json_extract(tavern_events.data,'$.routeId')
    AND json_extract(opening.data,'$.keeperThreadId')=tavern_events.keeper_thread_id AND json_extract(opening.data,'$.kind')='new-quest')
  WHEN 'user.message' THEN (SELECT json_extract(opening.data,'$.boardQuestId') FROM tavern_records opening
    WHERE opening.kind='routes' AND json_extract(opening.data,'$.sourceMessageId')=json_extract(tavern_events.data,'$.receiptId')
    AND json_extract(opening.data,'$.keeperThreadId')=tavern_events.keeper_thread_id AND json_extract(opening.data,'$.kind')='new-quest'
    ORDER BY opening.rowid DESC LIMIT 1) END)`;
const visibleEventSql = `NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=${eventQuestSql} AND q.archived_at IS NOT NULL)`;

export interface Records {
  stopAll: import("../../shared/stop-all").StopAllState;
  taleDeliveries: import("zod").infer<typeof import("../tale").taleDeliverySchema>;
  taleDeliveryAttempts: import("zod").infer<typeof import("../tale").taleDeliveryAttemptSchema>;
  serviceRecords: import("../../shared/service-record").ServiceQuestRecord;
  serviceVerdicts: import("../../shared/service-record").ServiceVerdict;
  serviceRecordState: import("../../shared/service-record").ServiceRecordState;
  taleKeeps: import("../../shared/service-record").TaleKeep;
  members: Member;
  quests: BoardQuest;
  plans: Plan;
  asks: Ask;
  decisions: Decision;
  decisionSeen: { token: string; seenAt: number };
  rules: Rule;
  reports: Report;
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
  skips: { boardQuestId: string; version: number; waypointId: string };
  hires: HireIntent;
  staffing: Staffing;
  notes: KeeperNote;
  gates: GateRecord;
  gateReminders: { keeperThreadId: string; at: number };
  autoGreenlights: { keeperThreadId: string; boardQuestId: string; planVersion: number; undonePlanVersion?: number };
  // The voice check (voice-check/run.ts): each run with the thread ids Tavern spawned for it, and the one hidden parent.
  voiceChecks: VoiceCheck & { threadIds: string[] };
  voiceCheckParent: { threadId: string; ready: boolean; createdAt: number; muted?: boolean };
  voiceCheckUnreachable: { providerId: string; model: string; at: number; detail: string };
  reviewPermits: {
    keeperThreadId: string;
    token: string;
    decisionId: string;
    usedAt: number;
  };
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
  classDefinition?: import("../../shared/schema").ClassDef;
  cancelledAt?: number;
  initialInput?: string;
  scopeResolution?: ScopeResolution | null;
  scopeOverride?: ScopeOverride;
  scopePrepared?: boolean;
  reviewDecisionId?: string;
  guardApprovalAskId?: string;
  staffing?: StaffingReservation;
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
export interface PendingBrief {
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
}
export interface Runtime {
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
  projectClassRevision?: string;
  classExecutionChoice?: { providerId?: string; recordedAt?: number; model: string | null; reasoningLevel: string | null; modelSource: string | null; reasoningSource: string | null };
  stopAttempts?: number;
  stopNextAttemptAt?: number;
  stopAskId?: string | null;
  reviewTarget?: ReviewTarget | null;
  submissionTarget?: ReviewTarget | null;
  openingGoal?: { text: string; at: number };
  requestSources?: RequestSources | null;
  assignmentText?: string | null;
  pendingBrief?: PendingBrief | null;
  lastFailure?: string;
  turnStartedAt?: number | null;
  ledger?: { hash: string; version: number; asOf: number };
  lastLedger?: { hash: string; version: number; at: number };
  manualStopAt?: number | null;
  queuedTickResetId?: string | null;
  lastReply?: { text: string; at: number };
  reanchorVersion?: number;
  failureCount?: number;
  tickRefusalCount?: number;
  tickRetryAt?: number | null;
  tickDeliveryAskId?: string | null;
  failedRequests?: string[];
  briefVersion?: number;
  reportedBriefVersion?: number;
  failureAskId?: string | null;
  lastBriefAt?: number;
  initialBriefAt?: number;
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
  releasePending?: string | null;
  released?: { reason: string; decisionId: string };
  archivePending?: boolean;
  cellarArchiveRequested?: boolean;
  cellarArchived?: boolean;
  partyArchiveRepairAt?: number;
  archiveError?: string | null;
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
  factContinuation?: { eventId: number; offset: number } | null;
  heldAt: number | null;
  holdExpiredAt?: number;
  reanchor: string | null;
  lastReanchorAt: number | null;
  eventSequence: number;
  lastStrikeAt: number | null;
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

import { consumesQuestWrite } from "./quest-lifecycle";

export class KeeperStore {
  log?: (level: "info" | "warn", message: string) => void;
  /** Set by the runtime: fires after an event is appended, so news can wake the Keeper it belongs to. */
  onEvent?: (event: { keeperThreadId: string | null; boardQuestId: string | null; type: string; data: Record<string, unknown>; actor: Actor }) => void;
  constructor(readonly db: Database) {}
  id(prefix: string) {
    return `${prefix}_${randomUUID()}`;
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | null {
    const row = this.db
      .prepare("SELECT data FROM tavern_records WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.data) as Records[K]);
  }
  query<K extends keyof Records>(
    kind: K,
    field: "keeperThreadId" | "boardQuestId" | "memberThreadId",
    value: string,
    limit = 200,
  ): Records[K][] {
    const rows = this.db
      .prepare(
        `SELECT data FROM tavern_records WHERE kind=? AND json_extract(data, '$.${field}')=? ORDER BY rowid DESC LIMIT ?`,
      )
      .all(kind, value, limit) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Records[K]).reverse();
  }
  hireForMember(memberThreadId: string): (HireIntent & { id: string }) | null {
    const row = this.db.prepare(
      "SELECT id,data FROM tavern_records WHERE kind='hires' AND json_extract(data,'$.memberThreadId')=? ORDER BY rowid DESC LIMIT 1",
    ).get(memberThreadId) as { id: string; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as HireIntent, id: row.id } : null;
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
    const inactive = `NOT (${liveMemberSql("occupy")})`;
    const from = `FROM tavern_records m LEFT JOIN tavern_runtime t
      ON t.thread_id=json_extract(m.data,'$.threadId') WHERE ${where}`;
    const params = [keeperThreadId, ...(boardQuestId ? [boardQuestId] : [])];
    const counts = this.db.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN ${inactive} THEN 0 ELSE 1 END),0) AS inFlightCount ${from}`)
      .get(...params) as { total: number; inFlightCount: number };
    const rows = this.db.prepare(`SELECT m.data ${from}
      ORDER BY CASE WHEN ${inactive} THEN 1 ELSE 0 END,
      max(json_extract(m.data,'$.createdAt'),coalesce(json_extract(m.data,'$.lastReportAt'),0),coalesce(json_extract(m.data,'$.lastActiveAt'),0)) DESC,
      m.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as { data: string }[];
    return { ...counts, members: rows.map(row => JSON.parse(row.data) as Member) };
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
        `SELECT data FROM tavern_records WHERE kind='scopeViolations' AND json_extract(data,'$.threadId') IN (${ids.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 100`,
      )
      .all(...ids) as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as Violation).reverse();
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
    return rows.map((row) => JSON.parse(row.data) as Records[K]);
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
  openAsks(
    keeperThreadId?: string,
    boardQuestId?: string,
    visibleOnly = false,
  ): Ask[] {
    const args = [keeperThreadId, boardQuestId].filter(
      (id): id is string => id !== undefined,
    );
    const clause = `${keeperThreadId ? " AND json_extract(data,'$.keeperThreadId')=?" : ""}${boardQuestId ? " AND json_extract(data,'$.boardQuestId')=?" : ""}`;
    return (
      this.db
        .prepare(
          `SELECT r.data FROM tavern_records r WHERE kind='asks' AND json_extract(data,'$.state')='open'${clause}
           ${visibleOnly ? "AND NOT EXISTS (SELECT 1 FROM tavern_records q WHERE q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId') AND q.archived_at IS NOT NULL)" : ""}
           ORDER BY r.rowid LIMIT 500`,
        )
        .all(...args) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as Ask);
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
      .map((row) => JSON.parse(row.data) as Records[K]);
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
      if (existing) return { id: existing.id, fresh: false };
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
    this.db
      .prepare("DELETE FROM tavern_records WHERE kind=? AND id=?")
      .run(kind, id);
  }
  all<K extends keyof Records>(kind: K): Records[K][] {
    return (
      this.db
        .prepare("SELECT data FROM tavern_records WHERE kind=? ORDER BY rowid")
        .all(kind) as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data) as Records[K]);
  }
  put<K extends keyof Records>(kind: K, id: string, data: Records[K]) {
    if (kind === "quests") {
      const previous = this.get("quests", id);
      const authorised = consumesQuestWrite(data);
      // Normalized reads must not migrate legacy phases during unrelated record updates.
      if (!authorised && previous && ["check", "wrap"].includes(previous.phase) && (data as BoardQuest).phase === "build") {
        data = { ...data, phase: previous.phase };
      }
      if ((!previous || previous.phase !== (data as BoardQuest).phase || JSON.stringify(previous.held) !== JSON.stringify((data as BoardQuest).held)) && !authorised) throw new Error("Quest phase writes require the quest lifecycle");
    }
    this.db
      .prepare(
        "INSERT INTO tavern_records(kind,id,data,archived_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,archived_at=excluded.archived_at",
      )
      .run(
        kind,
        id,
        JSON.stringify(data),
        kind === "quests" ? ((data as BoardQuest).archivedAt ?? null) : null,
      );
    return data;
  }
  runtime(threadId: string): Runtime {
    const row = this.db
      .prepare("SELECT data FROM tavern_runtime WHERE thread_id=?")
      .get(threadId) as { data: string } | undefined;
    return row === undefined
      ? initialRuntime()
      : { ...initialRuntime(), ...(JSON.parse(row.data) as Runtime) };
  }
  patch(threadId: string, patch: Partial<Runtime>) {
    const data = { ...this.runtime(threadId), ...patch };
    this.db
      .prepare(
        "INSERT INTO tavern_runtime(thread_id,data) VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data",
      )
      .run(threadId, JSON.stringify(data));
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
    return (this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM tavern_events WHERE keeper_thread_id=?").get(keeperId) as { id: number }).id;
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
    return this.readEvents(
      `WHERE keeper_thread_id=? AND id>? ${visibleOnly ? `AND ${visibleEventSql}` : ""} ORDER BY id ASC LIMIT ?`,
      [keeperThreadId, after, limit],
    );
  }
  eventCount(keeperThreadId: string, after: number, visibleOnly = false) {
    return (
      this.db
        .prepare(
          `SELECT count(*) AS n FROM tavern_events WHERE keeper_thread_id=? AND id>? ${visibleOnly ? `AND ${visibleEventSql}` : ""}`,
        )
        .get(keeperThreadId, after) as { n: number }
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
    const rows = this.db
      .prepare(
        `SELECT * FROM tavern_events WHERE id > ? ${keeperThreadId === undefined ? "" : "AND keeper_thread_id = ?"} ORDER BY id DESC LIMIT ?`,
      )
      .all(
        ...(keeperThreadId === undefined
          ? [after, limit]
          : [after, keeperThreadId, limit]),
      ) as {
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
