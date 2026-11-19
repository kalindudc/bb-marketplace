import { taleResultsSchema } from "./tale-results";
import { characterServiceRecordSchema, taleLevelSchema } from "./service-record";
import { executionFactsSchema } from "./class-execution";
import { classExecutionInputSchema, classModeFactsSchema, classNoticeSchema } from "./class-execution-contract";
import { z } from "zod";
import { defineContract } from "./define-contract";
import { voiceModeSchema } from "./settings";
import { placementContract } from "./placement-rpc";
import { voiceCheckContract } from "./voice-check";
import { awayContract } from "./away-rpc";
import { awayStatusSchema } from "./away";
import { scopeSchema } from "../scope/schema";
import { characterAuthorshipSchema, characterReportVoicesSchema } from "./character-presentation";
import {
  askSchema,
  briefSchema,
  keeperNoteSchema,
  gateRecordSchema,
  boardQuestSchema,
  checkerHandoffHoldSchema,
  characterDefSchema,
  classDefSchema,
  decisionSchema,
  ENTRY_STATUSES,
  eventSchema,
  evidenceSchema,
  memberSchema,
  planSchema,
  journalSchema,
  journalProgressSchema,
  reportSchema,
  ROUTE_KINDS,
  routeSchema,
  ruleSchema,
  WAYPOINT_STATES,
  waypointSchema,
} from "./schema";

// The RPC contract between Tavern's server and its UI. Server handlers invalidate the tags below whenever the data
// behind them changes, so every query stays live without polling.

const threadId = z.string().min(1).max(100);
const id = z.string().min(1).max(120);
/** At most this many brief context lines reach the widget: every hire-time line, then the newest follow-ups. */
export const DECOR_BRIEF_CONTEXT_MAX = 200;

export const tags = {
  registry: () => "tavern:registry",
  settings: () => "tavern:settings",
  thread: (threadId: string) => `tavern:thread:${threadId}`,
  journal: (threadId: string) => `tavern:journal:${threadId}`,
  boardQuest: (id: string) => `tavern:quest:${id}`,
  room: () => "tavern:room",
  mapHistory: () => "tavern:map-history",
  rows: () => "tavern:rows",
};

export const registrySchema = z.object({
  ambientMotion: z.enum(["calm", "lively", "off"]).optional(),
  voice: voiceModeSchema.optional(),
  levels: z.boolean().optional(),
  serviceRecords: z.array(characterServiceRecordSchema).optional(),
  characterAuthorship: z.array(characterAuthorshipSchema).optional(),
  characterReportVoices: z.array(characterReportVoicesSchema).optional(),
  classes: z.array(classDefSchema),
  characters: z.array(characterDefSchema),
  /** Files that failed to parse, with the reason, so the UI can say so instead of hiding them. */
  problems: z.array(z.object({ path: z.string(), message: z.string() })),
});

/** A waypoint with its live state, derived from the linked journal entries of its owner. */
export const waypointViewSchema = waypointSchema.extend({
  // added by Builder B: contact is a server-recorded fact, not a plan-author assertion.
  gate: gateRecordSchema.nullable().optional(),
  state: z.enum(WAYPOINT_STATES),
  ownerMember: memberSchema.nullable(),
  /** The linked entry's evidence, and the Warden's verdict when there is one. */
  evidenceCount: z.number().int(),
  verifiedBy: threadId.nullable(),
  rejectedReason: z.string().nullable(),
});

export const boardQuestSummarySchema = boardQuestSchema.extend({
  stopUnconfirmed: z.number().int().nonnegative().optional(),
  stopPendingHires: z.array(z.object({ token: id, classId: z.string(), title: z.string() })).optional(),
  plan: planSchema.nullable(),
  waypoints: z.array(waypointViewSchema),
  members: z.array(memberSchema),
  openAsks: z.number().int(),
  /** "you", "keeper", "party", "outside": whose move it is now, with one line. */
  move: z.object({ who: z.enum(["you", "keeper", "party", "outside", "nobody"]), text: z.string() }),
});
export type BoardQuestSummary = z.infer<typeof boardQuestSummarySchema>;
export const mapHistorySchema = z.object({ keepers: z.array(z.object({ threadId: z.string(), total: z.number().int().nonnegative(), quests: z.array(boardQuestSchema.extend({ members: z.array(memberSchema) })).max(5) })) });
export type MapHistory = z.infer<typeof mapHistorySchema>;

// added by Builder B: scope state and evidence are additive so older UI fixtures remain valid.
export const memberScopeSchema = z.object({
  threadId, scope: scopeSchema.nullable(), error: z.string().nullable(), armed: z.boolean(), pendingAskId: id.nullable(),
  guardPosture: memberSchema.shape.guardPosture,
  // added by Builder B: expose the configured mode and rejected class/project policy changes.
  mode: z.enum(["enforce", "watch", "off"]).optional(), problems: z.array(z.string()).optional(),
  guard: z.object({ installed: z.boolean(), stale: z.boolean(), sandbox: z.enum(["available", "missing", "not-applicable"]), claude: z.literal("phase-2-not-installed") }).optional(),
});
export const scopeViolationSchema = z.object({
  threadId, providerId: z.string(), at: z.number(), eventId: z.string(), seq: z.number(), ruleId: z.string(), reason: z.string(),
  stopped: z.boolean(), stopError: z.string().optional(), latencyMs: z.number(), call: z.unknown().optional(),
  // added by Builder B: watch observations are not enforced violations or blocker asks.
  mode: z.enum(["enforce", "watch"]).optional(),
});

// added by Builder B: counts and snapshot watermarks keep clipped decision lists honest and bulk acknowledgement race-safe.
const decisionAttentionFields = {
  decidedCount: z.number().int().nonnegative().optional(),
  decidedThroughId: id.nullable().optional(),
};

/** Everything a thread's decorations need in one read: the widget row, the crest, member headers. */
export const threadDecorSchema = z.object({
  threadId,
  widgetRow: z.boolean().optional(),
  ambientMotion: z.enum(["calm", "lively", "off"]).optional(), repeatSeconds: z.number().optional(), characters: z.boolean().optional(),
  voice: voiceModeSchema.optional(),
  moodSignals: z.object({
    released: z.boolean(),
    archived: z.boolean(),
    handBack: z.boolean(),
    report: reportSchema.pick({ status: true, createdAt: true }).nullable(),
    waypointTitle: z.string().nullable().optional(),
    verdict: z.object({ status: z.enum(["verified", "rejected"]), at: z.number(), checkerName: z.string().nullable().optional(), waypointTitle: z.string().nullable().optional() }).nullable(),
  }).optional(),
  /** News events the Keeper has not received yet: the widget's available-events signal. */
  pendingEvents: z.number().int().nonnegative().optional(),
  /** Whether wake-delivered ticks may batch (an opt-in setting; sweep ticks never batch). */
  wakeBatching: z.boolean().optional(),
  classNotice: classNoticeSchema.nullable().optional(),
  // added by Builder B: show the live guardrail and any pending widening alongside member details.
  scope: memberScopeSchema.nullable().optional(),
  violations: z.array(scopeViolationSchema).optional(),
  member: memberSchema.nullable(),
  /** The Keeper of a member thread, so its header can say who it reports to. */
  keeper: memberSchema.nullable(),
  boardQuest: boardQuestSchema.nullable(),
  /** Member threads: the brief they were hired with. */
  brief: z.string().nullable(),
  /** The brief as hired, plus every follow-up the Keeper sent since; follow-ups outgrow the hire-time limits. */
  briefFields: briefSchema.extend({ context: z.array(z.string().max(8200)).max(DECOR_BRIEF_CONTEXT_MAX) }).nullable().optional(),
  progress: journalProgressSchema,
  /** Keeper threads only. */
  keeperView: z
    .object({
      boardQuests: z.array(boardQuestSummarySchema),
      errands: z.array(memberSchema),
      openAsks: z.array(askSchema),
      decidedForYou: z.array(decisionSchema),
      ...decisionAttentionFields,
      // added by Builder B: expose durable manual-Stop quiet state and an explicit Resume action.
      quietSince: z.number().nullable().optional(),
      // added by Builder B: archival is observed host state, not inferred from Stop.
      archived: z.boolean().optional(),
      /** listening: idle and ready; busy: in a turn; holding: a tick is held while you type. */
      status: z.enum(["listening", "busy", "holding"]),
    })
    .nullable(),
  /** The widget row is hidden for this thread. */
  hidden: z.boolean(),
});
export type ThreadDecor = z.infer<typeof threadDecorSchema>;

export const boardQuestDetailSchema = z.object({
  // added by Builder B: the Keeper's wrap and journal-backed credits remain sparse-safe for old fixtures.
  tale: z.object({
    outcome: z.string(), left: z.string().nullable(),
    results: taleResultsSchema.optional(),
    fileHostId: z.string().optional(),
    delivery: z.object({ text: z.string().max(24000), capturedAt: z.number(), threadId: z.string(), truncated: z.boolean(), companionThreadId: z.string().optional(), companionReady: z.boolean().optional(), companionFailed: z.boolean().optional() }).optional(),
    next: z.array(z.string().max(200)).max(5).optional(),
    document: z.object({ threadId: z.string(), rootPath: z.string(), target: z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }) }).optional(),
    skipped: z.array(z.object({ waypointId: id, reason: z.string() })),
    wrappedAt: z.number().int().nonnegative(),
    levels: z.array(taleLevelSchema).nullable().optional(),
    keptCharacterIds: z.array(id).optional(),
  }).nullable().optional(),
  memberCredits: z.array(z.object({
    memberThreadId: threadId, madeWaypointIds: z.array(id), verifiedWaypointIds: z.array(id),
  })).optional(),
  notes: z.array(keeperNoteSchema).optional(), gates: z.array(gateRecordSchema).optional(),
  // added by Builder B: show scope state and violations for the quest's members.
  scopes: z.array(memberScopeSchema).optional(),
  violations: z.array(scopeViolationSchema).optional(),
  quest: boardQuestSummarySchema,
  plans: z.array(planSchema),
  asks: z.array(askSchema.extend({ planVersion: z.number().int().nonnegative().optional() })),
  decisions: z.array(decisionSchema),
  // added by Builder B: history includes seen and cellared decisions, with bounded older pages.
  decisionsNextCursor: z.string().nullable().optional(),
  decisionsTotal: z.number().int().nonnegative().optional(),
  rules: z.array(ruleSchema),
  reports: z.array(reportSchema),
  routes: z.array(routeSchema),
  events: z.array(eventSchema),
});
export type BoardQuestDetail = z.infer<typeof boardQuestDetailSchema>;

export const ledgerSchema = z.object({
  // added by Builder B: durable facts/promises and gate contact are visible in the Ledger.
  notes: z.array(keeperNoteSchema).optional(), gates: z.array(gateRecordSchema).optional(), notesTotal: z.number().int().optional(),
  // added by Builder B: keep live guardrails and violation evidence in the Keeper ledger.
  scopes: z.array(memberScopeSchema).optional(),
  violations: z.array(scopeViolationSchema).optional(),
  keeperThreadId: threadId,
  quietSince: z.number().nullable().optional(),
  // added by Builder B: aged, unscoped promises remain readable through status history.
  olderPromises: z.number().int().nonnegative().optional(),
  boardQuests: z.array(boardQuestSummarySchema),
  // added by Builder B: attention is independent of the complete, paged decision history.
  decidedForYou: z.array(decisionSchema).optional(),
  ...decisionAttentionFields,
  decisions: z.array(decisionSchema),
  decisionsNextCursor: z.string().nullable().optional(),
  decisionsTotal: z.number().int().nonnegative().optional(),
  rules: z.array(ruleSchema),
  asks: z.array(askSchema),
  routes: z.array(routeSchema),
  /** The text the Keeper is re-anchored with each session start and tick, shown so the user sees what it "knows". */
  restatement: z.string(),
  lastReanchorAt: z.number().nullable(),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export const roomSchema = z.object({
  hearthFlicker: z.boolean().optional(),
  ambientMotion: z.enum(["calm", "lively", "off"]).optional(), repeatSeconds: z.number().optional(),
  away: awayStatusSchema.optional(),
  keepers: z.array(
    z.object({
      member: memberSchema,
      // added by Builder B: archived Keepers remain available for folding and uncellared quests.
      archived: z.boolean().optional(),
      // added by Builder B: bb metadata distinguishes same-name Keepers without inventing dates.
      threadTitle: z.string().nullable().optional(),
      threadCreatedAt: z.number().nullable().optional(),
      quietSince: z.number().nullable().optional(),
      boardQuests: z.array(boardQuestSummarySchema),
      errands: z.array(memberSchema),
      status: z.enum(["listening", "busy", "holding"]),
    }),
  ),
  /** Open asks across every Keeper, oldest first. */
  asks: z.array(askSchema),
  decidedForYou: z.array(decisionSchema),
  ...decisionAttentionFields,
  /** Drafts and PRs waiting on the user's review, against the review budget. */
  review: z.object({ waiting: z.number().int(), budget: z.number().int(), items: z.array(z.object({
    title: z.string(), url: z.string().nullable(), boardQuestId: z.string().nullable(),
    questTitle: z.string().optional(),
    waypoint: z.object({ id: z.string(), title: z.string(), doneWhen: z.string().nullable() }).optional(),
    member: z.object({ threadId: z.string(), displayName: z.string(), classId: z.string() }).nullable().optional(),
    reportId: z.string().nullable().optional(),
    headline: z.string().max(500).optional(),
    headlineTruncated: z.boolean().optional(),
    evidenceCount: z.number().int().nonnegative().optional(),
    reportedAt: z.number().nullable().optional(),
    waitingFor: z.object({ who: z.enum(["checker", "keeper", "you"]), name: z.string().optional(), working: z.boolean().optional() }).optional(),
  })) }),
  /** Solo typed threads (Wanderers and others the user started directly). */
  solos: z.array(memberSchema),
  recent: z.array(eventSchema),
  /** How many archived quests exist; the room shows them only behind a collapsed Archive section. */
  archivedCount: z.number().int().default(0),
});
export type Room = z.infer<typeof roomSchema>;

export const crestSchema = z.object({ threadId, classId: z.string(), characterId: z.string().nullable(), label: z.string() });

const journalEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), descriptions: z.array(z.string().min(1).max(500)).min(1).max(20), parentId: z.string().nullable().default(null) }),
  z.object({ op: z.literal("update"), entryId: z.string(), description: z.string().min(1).max(500) }),
  // added by Builder A: UI status edits can supply a blocker reason or completion evidence without bypassing gates.
  z.object({ op: z.literal("status"), entryIds: z.array(z.string()).min(1), status: z.enum(ENTRY_STATUSES), reason: z.string().max(2000).optional(), evidence: z.array(evidenceSchema).max(30).optional() }),
  z.object({ op: z.literal("note"), entryId: z.string(), note: z.string().max(2000).nullable() }),
  z.object({ op: z.literal("delete"), entryIds: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("reorder"), entryId: z.string(), beforeId: z.string().nullable() }),
  z.object({ op: z.literal("reparent"), entryId: z.string(), parentId: z.string().nullable() }),
  z.object({ op: z.literal("clear"), all: z.boolean() }),
  /** Clears a delegate's report mark without closing the entry: "still waiting". */
  z.object({ op: z.literal("wait"), entryIds: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("undo") }),
  z.object({ op: z.literal("redo") }),
]);
export type JournalEdit = z.infer<typeof journalEditSchema>;

const ok = z.object({ ok: z.literal(true) });

/** The class fields the Classes page edits (server registry.ts CLASS_EDITABLE). */
export const classEditSchema = classDefSchema.pick({ label: true, plain: true, description: true, body: true, characters: true, startable: true, hireable: true, scope: true }).partial().strict();
export type ClassEditInput = z.infer<typeof classEditSchema>;

export const rpcContract = defineContract({
  ...placementContract,
  ...awayContract,
  ...voiceCheckContract,
  classExecution: {
    input: classExecutionInputSchema,
    output: classModeFactsSchema,
    tags: () => [tags.registry()],
  },
  classExecutions: {
    input: z.object({ projectId: z.string().optional() }).strict(),
    output: z.object({ classes: z.array(z.object({ classId: z.string(), start: classModeFactsSchema, hire: classModeFactsSchema })) }),
    tags: () => [tags.registry()],
  },
  applyClassExecution: {
    input: z.object({ threadId }).strict(),
    output: z.object({ model: z.string().optional(), reasoningLevel: z.string().optional() }),
  },
  dismissClassNotice: {
    input: z.object({ threadId }).strict(), output: ok,
  },
  registry: {
    // added by Builder B: new-thread class selection needs the project's registry overrides before a thread exists.
    input: z.object({ projectId: z.string().min(1).max(100).optional() }).strict(),
    output: registrySchema,
    tags: () => [tags.registry(), tags.settings()],
  },
  decor: {
    input: z.object({ threadId }).strict(),
    output: threadDecorSchema,
    tags: ({ threadId }: { threadId: string }) => [tags.thread(threadId), tags.journal(threadId), tags.settings()],
  },
  crests: {
    input: z.object({ threadIds: z.array(threadId).max(500) }).strict(),
    output: z.object({ crests: z.array(crestSchema) }),
    tags: () => [tags.rows()],
  },
  journal: {
    input: z.object({ threadId }).strict(),
    output: journalSchema,
    tags: ({ threadId }: { threadId: string }) => [tags.journal(threadId)],
  },
  journalEdit: {
    input: z.object({ threadId, edit: journalEditSchema }).strict(),
    output: z.object({ ok: z.literal(true), message: z.string() }),
  },
  resumeKeeper: {
    input: z.object({ threadId }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  ledger: {
    input: z.object({ threadId }).strict(),
    output: ledgerSchema,
    tags: ({ threadId }: { threadId: string }) => [tags.thread(threadId)],
  },
  routes: {
    input: z.object({ threadId }).strict(),
    // added by Builder B: receipts show the linked standing rule without a second query.
    output: z.object({ routes: z.array(routeSchema), boardQuests: z.array(boardQuestSchema), rules: z.array(ruleSchema).optional() }),
    tags: ({ threadId }: { threadId: string }) => [tags.thread(threadId)],
  },
  boardQuest: {
    input: z.object({ id }).strict(),
    output: boardQuestDetailSchema,
    tags: ({ id }: { id: string }) => [tags.boardQuest(id)],
  },
  setTaleKept: {
    input: z.object({ questId: id, characterId: id, kept: z.boolean() }).strict(),
    output: z.object({ kept: z.boolean() }),
  },
  room: {
    input: z.object({}).strict(),
    output: roomSchema,
    tags: () => [tags.room(), tags.settings()],
  },
  // added by Builder C: directive digests and side quests need reports without a board quest.
  reports: {
    input: z.object({ ids: z.array(id).max(30).default([]), memberThreadId: threadId.nullable().default(null) }).strict(),
    output: z.object({ reports: z.array(reportSchema) }),
    tags: () => [tags.room(), tags.rows()],
  },
  releaseCheckerHandoff: {
    input: z.object({ boardQuestId: id, holdId: id, via: z.enum(["page", "banner"]) }).strict(),
    output: z.object({ checkerHandoffHold: checkerHandoffHoldSchema }),
  },
  answerAsk: {
    input: z.object({ askId: id, optionId: z.string(), note: z.string().max(2000).nullable().default(null), via: z.enum(["banner", "page", "phone", "chat"]) }).strict(),
    output: ok,
  },
  // added by Builder B: display-only acknowledgement never undoes a decision or wakes its Keeper.
  markDecisionsSeen: {
    input: z.union([
      z.object({ ids: z.array(id).min(1).max(200) }).strict(),
      z.object({ all: z.literal(true), keeperThreadId: threadId.optional(), throughId: id.nullable().optional() }).strict(),
    ]),
    output: z.object({ ok: z.literal(true), ids: z.array(id), undoToken: id.nullable() }),
  },
  markDecisionsUnseen: {
    input: z.object({ undoToken: id }).strict(),
    output: z.object({ ok: z.literal(true), ids: z.array(id) }),
  },
  decisionHistory: {
    input: z.object({ keeperThreadId: threadId, boardQuestId: id.optional(), cursor: z.string().max(1024).nullable().default(null), limit: z.number().int().min(1).max(100).default(100) }).strict(),
    output: z.object({ decisions: z.array(decisionSchema), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() }),
    tags: ({ keeperThreadId, boardQuestId }: { keeperThreadId: string; boardQuestId?: string }) => [tags.thread(keeperThreadId), ...(boardQuestId ? [tags.boardQuest(boardQuestId)] : [])],
  },
  undoDecision: {
    input: z.object({ decisionId: id }).strict(),
    output: ok,
  },
  correctRoute: {
    // added by Builder B: a user correction can retain or choose several quest targets for one steer.
    input: z.object({ routeId: id, kind: z.enum(ROUTE_KINDS), boardQuestId: id.nullable(), boardQuestIds: z.array(id).max(8).default([]) }).strict(),
    output: ok,
  },
  addRule: {
    input: z
      .object({ scope: z.enum(["global", "project", "keeper", "quest"]), scopeId: z.string().nullable(), text: z.string().min(1).max(500), source: z.enum(["user", "message"]) })
      .strict(),
    output: ok,
  },
  confirmRule: {
    input: z.object({ ruleId: id, active: z.boolean() }).strict(),
    output: ok,
  },
  // added by Builder B: a user can explicitly widen a rule without replacing or activating it.
  widenRule: {
    input: z.object({ ruleId: id, scope: z.enum(["global", "project", "keeper"]) }).strict(),
    output: ok,
  },
  stopBoardQuest: {
    input: z.object({ id, reason: boardQuestSchema.shape.stopReason }).strict(),
    output: z.object({ phase: z.enum(["stopping", "stopped"]), unconfirmed: z.number().int().nonnegative() }),
  },
  /** Archive or restore returned and stopped board quests; active quests are refused. */
  archiveBoardQuests: {
    input: z.object({ ids: z.array(id).min(1).max(200), archived: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true), changed: z.number().int(), notes: z.array(z.string()).default([]), pendingArchives: z.array(threadId).default([]) }),
  },
  /** The archive, newest first, paged; the common room leaves archived quests out. */
  mapHistory: {
    input: z.object({}).strict(), output: mapHistorySchema, tags: () => [tags.mapHistory()],
  },
  archivedBoardQuests: {
    input: z.object({ cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(100).default(30) }).strict(),
    output: z.object({ boardQuests: z.array(boardQuestSummarySchema), nextCursor: z.string().nullable(), total: z.number().int() }),
    tags: () => [tags.room()],
  },
  deleteBoardQuest: {
    input: z.object({ id }).strict(),
    output: z.object({ ok: z.literal(true), changed: z.number().int(), notes: z.array(z.string()), pendingArchives: z.array(threadId) }),
  },
  restoreDeletedQuest: {
    input: z.object({ id }).strict(),
    output: z.object({ ok: z.literal(true), changed: z.number().int() }),
  },
  deletedBoardQuests: {
    input: z.object({ cursor: z.string().nullable().default(null), limit: z.number().int().min(1).max(100).default(30) }).strict(),
    output: z.object({ boardQuests: z.array(boardQuestSummarySchema), nextCursor: z.string().nullable(), total: z.number().int() }),
    tags: () => [tags.room()],
  },
  setHidden: {
    input: z.object({ threadId, hidden: z.boolean() }).strict(),
    output: ok,
  },
  // added by Builder D: persist the character sheet's presentation fields to the user's character override.
  saveCharacterVoice: {
    input: z.object({ characterId: id, voice: characterDefSchema.pick({ name: true, hue: true, charge: true, temper: true, style: true, quirks: true, lines: true }) }).strict(),
    output: characterDefSchema,
  },
  saveCharacterAvatar: {
    input: z.object({ characterId: id, avatar: characterDefSchema.shape.avatar.unwrap() }).strict(),
    output: characterDefSchema,
  },
  // The Classes page editor (registry-rpc.ts). Reading and previewing are open; saving and removing an override are client-only.
  classEditor: {
    input: z.object({ classId: id, projectId: z.string().min(1).max(100).nullable() }).strict(),
    output: z.object({
      current: classDefSchema, revision: z.string(), projectPath: z.string().nullable(),
      layers: z.array(z.object({ source: z.enum(["shipped", "global", "project"]), path: z.string(), exists: z.boolean() })),
      models: executionFactsSchema,
      running: z.number().int().min(0),
    }),
  },
  classPreview: {
    input: z.object({ classId: id, projectId: z.string().min(1).max(100).nullable(), target: z.enum(["global", "project"]), edit: classEditSchema }).strict(),
    output: z.discriminatedUnion("code", [
      z.object({ code: z.literal("ok"), path: z.string(), shadowedBy: z.enum(["project"]).nullable(),
        changes: z.array(z.object({ field: z.string(), from: z.unknown(), to: z.unknown() })),
        widening: z.array(z.object({ field: z.literal("scope"), from: z.string().nullable(), to: z.string().nullable() })) }),
      z.object({ code: z.literal("invalid"), problems: z.array(z.string()) }),
    ]),
  },
  saveClass: {
    input: z.object({ classId: id, projectId: z.string().min(1).max(100).nullable(), target: z.enum(["global", "project"]), edit: classEditSchema, revision: z.string().min(1).max(100) }).strict(),
    output: z.discriminatedUnion("code", [
      z.object({ code: z.literal("ok"), class: classDefSchema, path: z.string() }),
      z.object({ code: z.literal("stale") }),
      z.object({ code: z.literal("invalid"), problems: z.array(z.string()) }),
    ]),
  },
  removeClassOverride: {
    input: z.object({ classId: id, projectId: z.string().min(1).max(100).nullable(), target: z.enum(["global", "project"]), revision: z.string().min(1).max(100) }).strict(),
    output: z.discriminatedUnion("code", [
      z.object({ code: z.literal("ok"), path: z.string() }),
      z.object({ code: z.literal("stale") }),
      z.object({ code: z.literal("invalid"), problems: z.array(z.string()) }),
    ]),
  },
  /** The composer in a Keeper's thread pings this while the user types, so ticks hold until they send. */
  typing: {
    input: z.object({ threadId }).strict(),
    output: ok,
  },
});
