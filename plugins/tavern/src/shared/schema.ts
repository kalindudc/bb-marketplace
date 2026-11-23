import { z } from "zod";
import { classScopeSchema, scopeOverrideSchema } from "../scope/schema";
import { CLASS_BODY_LIMIT } from "./class-rules";
import { LOOK_BUILDS, LOOK_HAIRS, LOOK_HAIR_COLOURS, LOOK_HATS, LOOK_LIGHTS, LOOK_SKINS } from "./look";
import { SPEECH_KEYS } from "./says";
import { taleResultsSchema } from "./tale-results";
import { dispositionSchema, engagementSchema } from "./member-engagement";

// The one source of truth for Tavern's domain shapes, shared by the server, the RPC contract and the UI.
// Words: a "board quest" is a goal a Keeper holds; a "journal" is any thread's own checklist.

export const SHAPES = ["shield", "pennant", "tower", "lozenge", "roundel", "square"] as const;
export const HUES = ["teal", "plum", "violet", "blue", "rose", "ink"] as const;
export const CHARGES = ["chevron", "fess", "cross", "bend", "star", "pale", "saltire", "chief", "dots"] as const;

const id = z.string().min(1).max(120);
const threadId = z.string().min(1).max(100);
const epochMs = z.number().int().nonnegative();

export const classDefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  kind: z.enum(["keeper", "member"]).optional(),
  label: z.string().min(1).max(40),
  /** The plain word shown beside the themed one, for example "scout" beside "Ranger". */
  plain: z.string().min(1).max(40),
  description: z.string().max(400),
  shape: z.enum(SHAPES),
  startable: z.boolean(),
  hireable: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  permission: z.enum(["accept-edits", "auto", "full"]).nullable(),
  // added by Scopes builder: class files can select and narrow a preset without changing provider permissions.
  scope: classScopeSchema.optional(),
  environment: z.enum(["shared", "worktree"]).nullable(),
  tools: z.array(z.string()),
  hires: z.array(z.string()),
  greenlight: z.enum(["explicit", "none"]).nullable(),
  budget: z.object({ members: z.number().int(), rangers: z.number().int(), rangerMinutes: z.number().int() }).nullable(),
  characters: z.array(z.string()),
  /** The role prompt (Markdown body of the class file). */
  body: z.string().refine(text => new TextEncoder().encode(text).length <= CLASS_BODY_LIMIT, `Class body must be at most ${CLASS_BODY_LIMIT} UTF-8 bytes.`),
  /** "builtin", or the absolute path of the file that defined or overrode it. */
  source: z.string(),
});
export type ClassDef = z.infer<typeof classDefSchema>;
export const classKind = (role: Pick<ClassDef, "id" | "kind">) => role.kind ?? (role.id === "keeper" ? "keeper" : "member");

export const characterLookSchema = z.object({
  build: z.enum(LOOK_BUILDS).optional(),
  hair: z.enum(LOOK_HAIRS).optional(),
  hairColour: z.enum(LOOK_HAIR_COLOURS).optional(),
  skin: z.enum(LOOK_SKINS).optional(),
  hat: z.enum(LOOK_HATS).optional(),
  light: z.enum(LOOK_LIGHTS).optional(),
});
export type CharacterLookFields = z.infer<typeof characterLookSchema>;

export const characterDefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(40),
  classes: z.array(z.string()),
  hue: z.enum(HUES),
  charge: z.enum(CHARGES),
  /** Overrides for the traits seeded from the avatar or id; anything left out is seeded. */
  look: characterLookSchema.optional(),
  avatar: z.string().min(1).optional(),
  temper: z.string().max(40),
  style: z.string().max(200),
  quirks: z.array(z.string().max(200)).max(5),
  /** Voice lines for presentation slots only. Never fed to reasoning. */
  lines: z.object({ hired: z.string(), row: z.string(), done: z.string(), wrap: z.string(), empty: z.string() }),
  says: z.partialRecord(z.enum(SPEECH_KEYS), z.array(z.string().min(1).max(60, "Use 60 characters or fewer.")).max(5, "Use at most five lines.")).optional(),
  body: z.string(),
  source: z.string(),
});
export type CharacterDef = z.infer<typeof characterDefSchema>;
export const characterVoiceSchema = characterDefSchema.pick({ name: true, hue: true, charge: true, temper: true, style: true, quirks: true, lines: true, says: true });
export type CharacterVoice = z.infer<typeof characterVoiceSchema>;

/** Who did something. "user" is the human; agents are named by thread id. */
export const actorSchema = z.union([
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent"), threadId }),
  z.object({ kind: z.literal("tavern") }),
  z.object({ kind: z.literal("import"), from: z.string() }),
]);
export type Actor = z.infer<typeof actorSchema>;
/** Events are append-only, so an actor stored under an older or mistaken shape is read as Tavern's rather than failing every reader. */
export function readStoredActor(raw: string): Actor {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { kind: "tavern" }; }
  const parsed = actorSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "tavern" };
}

export const evidenceSchema = z.object({
  kind: z.enum(["command", "file", "url", "pr", "query", "note"]),
  /** The command, path:line, URL, PR link or query. */
  ref: z.string().min(1).max(2000),
  /** What it showed, in a line or two. */
  detail: z.string().max(2000).default(""),
  exitCode: z.number().int().nullable().default(null),
});
export type Evidence = z.infer<typeof evidenceSchema>;

const summaryLine = z.string().trim().min(1).regex(/^[^\r\n\u2028\u2029]+$/, "Use one line");
export const summaryDraftSchema = z.object({
  boardQuestId: id,
  title: summaryLine.max(180),
  body: z.string().min(1).max(4000),
  results: taleResultsSchema.optional(),
  links: z.array(evidenceSchema).max(30).default([]),
  next: z.array(summaryLine.max(400)).max(3).optional(),
  request: z.object({ kind: z.enum(["ask", "hand-back"]), id }).strict().optional(),
  supersedes: id.optional(),
}).strict();
export const summarySchema = summaryDraftSchema.extend({ id, keeperThreadId: threadId, createdAt: epochMs });
export const summaryViewSchema = summarySchema.extend({ seen: z.boolean(), correctedBy: id.nullable(), previousTitle: z.string().optional() });
export const summaryEntrySchema = summaryViewSchema.partial({ body: true, links: true }).extend({ order: z.number().int().optional() });
export type Summary = z.infer<typeof summarySchema>;
export type SummaryDraft = z.infer<typeof summaryDraftSchema>;
export type SummaryView = z.infer<typeof summaryViewSchema>;
export type SummaryEntry = z.infer<typeof summaryEntrySchema>;

// ---------- Journal (every thread) ----------

export const ENTRY_STATUSES = ["todo", "doing", "blocked", "done", "verified", "rejected"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const waypointLinkSchema = z.object({ boardQuestId: id, waypointId: id });
export type WaypointLink = z.infer<typeof waypointLinkSchema>;

export const journalEntrySchema = z.object({
  threadId,
  /** Never reused: new ids are zero-padded hex; previously issued base36 ids remain valid. */
  id: z.string().regex(/^[0-9a-z]{2,8}$/),
  parentId: z.string().nullable(),
  description: z.string().min(1).max(500),
  status: z.enum(ENTRY_STATUSES),
  owner: z.string().nullable(),
  // added by Builder A: dependency readiness, artifact links and completion attribution survive reload and undo.
  after: z.array(z.string()).max(200).default([]),
  links: z.array(evidenceSchema).max(30).default([]),
  doneAt: epochMs.nullable().default(null),
  doneBy: actorSchema.nullable().default(null),
  note: z.string().max(2000).nullable(),
  evidence: z.array(evidenceSchema),
  // added by Builder A: separate review evidence and attribution; memberEvidenceAt marks proof submitted after the latest rejection.
  review: z.object({ actor: actorSchema, at: epochMs, evidence: z.array(evidenceSchema).max(30), reason: z.string().max(2000).nullable(), previousNote: z.string().max(2000).nullable().default(null), memberEvidenceAt: epochMs.nullable().default(null) }).nullable().default(null),
  link: waypointLinkSchema.nullable(),
  // added by Builder A: board summaries are phase-owned mirrors, not agent-ticked waypoint work.
  boardQuestId: id.nullable().default(null),
  /**
   * What the owner of a delegated entry last did, for the agent to check: its thread went idle (with the first line of its output),
   * it reported settled, or its thread was archived or deleted. A fact, not a status: done, reopen, start, block and wait clear it.
   */
  report: z.object({ kind: z.enum(["idle", "settled", "archived", "deleted"]), at: epochMs, threadId: z.string().nullable(), summary: z.string().max(300).nullable(), by: actorSchema }).nullable().optional(),
  /** Evidence from earlier briefs, moved off the entry when a follow-up brief reopened it: a done needs at least one item not in here. */
  rebrief: z.object({ version: z.number().int().positive(), evidence: z.array(evidenceSchema).max(30) }).nullable().optional(),
  /** Description rewrites since the last status change: rewording doesn't keep an entry current. */
  rewrites: z.number().int().min(0).optional(),
  order: z.number(),
  createdAt: epochMs,
  updatedAt: epochMs,
  createdBy: actorSchema,
  updatedBy: actorSchema,
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

export const journalProgressSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
  /** The entry being worked on: the first "doing", else the next open one. */
  current: z.object({ id: z.string(), description: z.string(), status: z.enum(ENTRY_STATUSES) }).nullable(),
  blocked: z.number().int(),
  // added by Builder A: server-derived quietness is available to the Keeper without browser timers.
  quietSince: epochMs.nullable().optional(),
});
export type JournalProgress = z.infer<typeof journalProgressSchema>;

export const journalChangeSchema = z.object({
  id: z.number().int(),
  threadId,
  at: epochMs,
  actor: actorSchema,
  /** add, split, start, done, block, reopen, verify, reject, update, note, link, delete, clear, reorder, reparent, undo, redo, import. */
  action: z.string(),
  entryIds: z.array(z.string()),
  /** One plain sentence, for example: You ticked [a3] "Add the retry" done. */
  text: z.string(),
  /** Whether the agent has seen this change (user edits reach the agent once). */
  seen: z.boolean(),
});
export type JournalChange = z.infer<typeof journalChangeSchema>;

export const journalSchema = z.object({
  threadId,
  entries: z.array(journalEntrySchema),
  changes: z.array(journalChangeSchema),
  progress: journalProgressSchema,
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  /** Set while another plugin owns the `quest` tool (pi-quests installed and loaded first). */
  toolOwnedElsewhere: z.boolean(),
  reportGraceMinutes: z.number().int().positive().optional(),
  // added by Builder A: failed imports remain visible without failing every Tavern capability.
  problem: z.string().max(500).optional(),
});
export type Journal = z.infer<typeof journalSchema>;

// ---------- Members (every typed thread) ----------

export const MEMBER_STATES = ["working", "idle", "waiting", "failed"] as const;

// added by Builder B: provider capability and a specific user-approved detection-only exception remain visible.
export const guardPostureSchema = z.object({
  providerId: z.string(), mode: z.enum(["pre-exec", "detection-only"]), label: z.string(), approvalAskId: id.nullable(),
});
export const memberSchema = z.object({
  repo: z.string().min(1).optional(),
  draftPush: z.object({ branch: z.string(), remote: z.string(), memberHead: z.string(), homeHead: z.string(), profile: z.string() }).optional(),
  engagement: engagementSchema.optional(),
  disposition: dispositionSchema.optional(),
  stopError: z.string().nullable().optional(),
  lastStopAttemptAt: epochMs.nullable().optional(),
  threadId,
  classId: z.string(),
  characterId: z.string().min(1).nullable(),
  // added by Builder B: live-party names remain unique without inventing new character registry ids.
  displayName: z.string().max(80).optional(),
  /** keeper: leads board quests. member: hired by a Keeper. solo: started by the user with a non-Keeper class. */
  role: z.enum(["keeper", "member", "solo"]),
  leadLinkId: id.optional(),
  keeperThreadId: threadId.nullable(),
  boardQuestId: id.nullable(),
  waypointId: id.nullable(),
  // added by Builder B: a Warden checks this waypoint without owning a linked journal entry.
  checkerWaypointId: z.string().nullable().optional(),
  checkerMakerThreadId: z.string().nullable().optional(),
  // added by Builder B: a fallback review must never be presented as an independent check.
  checkIndependence: z.enum(["independent", "same-family", "not-established"]).optional(),
  guardPosture: guardPostureSchema.optional(),
  /** A side quest: a one-off helper hired for an aside, outside any board quest. */
  errand: z.boolean(),
  title: z.string().nullable(),
  state: z.enum(MEMBER_STATES),
  /** One short line about what it is doing now. */
  doing: z.string().nullable(),
  createdAt: epochMs,
  lastActiveAt: epochMs.nullable(),
  lastReportAt: epochMs.nullable(),
  rangerCheckpointReportId: id.optional(),
  strikes: z.number().int(),
  verifiedWins: z.number().int(),
});
export type Member = z.infer<typeof memberSchema> & { pullRequests?: import("./pull-request").PullRequest[]; placement?: import("./placement-view").PlacementView | null };

export const briefSchema = z.object({
  outcome: z.string().min(1).max(2000),
  mode: z.enum(["make-it-work", "make-it-better"]),
  outOfScope: z.string().max(2000).default(""),
  doneWhen: z.string().min(1).max(2000),
  context: z.array(z.string().max(500)).max(30).default([]),
  /** Rangers: numbered questions and a time box. */
  questions: z.array(z.string().max(1000)).max(12).default([]),
  timeboxMinutes: z.number().int().min(1).max(240).nullable().default(null),
});
export type Brief = z.infer<typeof briefSchema>;

// ---------- Board quests and the Keeper's ledger ----------

export const PHASES = ["scout", "greenlight", "build", "check", "wrap", "held", "closing", "done", "stopping", "stopped"] as const;
export type Phase = (typeof PHASES)[number];

export const WAYPOINT_STATES = ["planned", "todo", "doing", "blocked", "rejected", "reported", "verified", "accepted", "done", "skipped", "waived"] as const;
export type WaypointState = (typeof WAYPOINT_STATES)[number];

// added by Builder B: durable facts, promises, hand-backs and outside-gate contact survive session loss.
const noteCondition = z.string().trim().min(1).max(500);
const noteFields = z.object({
  text: z.string().trim().min(1).max(1000),
  action: z.string().trim().min(1).max(300).refine(text => !/[\r\n]/.test(text), "An action must be one line").optional(),
  why: z.string().trim().min(1).max(1000).optional(),
  boardQuestId: id.nullish(), dueAt: epochMs.nullish(),
  condition: noteCondition.nullish(), validUntil: epochMs.nullish(),
}).strict();
export const noteDraftSchema = z.discriminatedUnion("kind", [
  noteFields.extend({ kind: z.literal("fact") }),
  noteFields.extend({ kind: z.literal("commitment") }).refine(note => note.dueAt != null, { path: ["dueAt"], message: "A commitment needs a deadline (dueAt)." }),
  noteFields.extend({
    kind: z.literal("waiting-on-user"),
    need: z.string({ error: "Add need: one sentence saying what you need from the user, at most 120 characters." }).trim().min(1).max(120)
      .refine(text => !/[\r\n]/.test(text), "The need must be one line"),
  }).refine(note => !!note.action, { message: "A hand-back needs an action only the user can do. Record information as a fact or use summaries when available." }),
]);
export type NoteDraft = z.input<typeof noteDraftSchema>;
export const keeperNoteSchema = z.object({
  id, keeperThreadId: threadId, boardQuestId: id.nullable(),
  kind: z.enum(["fact", "commitment", "waiting-on-user"]), text: z.string(),
  memberThreadId: threadId.optional(),
  action: z.string().optional(), why: z.string().optional(), need: z.string().optional(),
  resolution: z.object({ by: z.literal("user"), how: z.enum(["done", "replied"]), at: epochMs, reply: z.string().optional() }).optional(),
  dueAt: epochMs.nullable(), condition: z.string().nullable(), validUntil: epochMs.nullable(),
  sourceMessageId: id.nullable(), routeId: id.nullable(),
  state: z.enum(["open", "done"]), createdAt: epochMs, updatedAt: epochMs,
  doneAt: epochMs.nullable(), dueNotifiedAt: epochMs.nullable(),
});
export type KeeperNote = z.infer<typeof keeperNoteSchema>;
export const gateInputSchema = z.object({
  boardQuestId: id, waypointId: z.string().regex(/^w[0-9]{1,3}$/),
  askedWho: z.string().trim().min(1).max(200), via: z.string().trim().min(1).max(300),
  askedAt: epochMs.optional(), answer: z.string().trim().min(1).max(1000).optional(), answeredAt: epochMs.optional(),
}).strict();
export const gateRecordSchema = gateInputSchema.extend({
  // added by Builder B: gate contact follows who/what identity rather than a plan version.
  identity: z.string().optional(),
  keeperThreadId: threadId, planVersion: z.number().int(), askedAt: epochMs,
  answer: z.string().nullable(), answeredAt: epochMs.nullable(),
});
export type GateRecord = z.infer<typeof gateRecordSchema>;

export const waypointCheckSchema = z.enum(["warden", "keeper", "none", "you"], { error: "Each waypoint needs a check: warden, keeper, or none for an agent; you for the user; keeper for an outside owner." });
export const waypointSchema = z.object({
  id: z.string().regex(/^w[0-9]{1,3}$/),
  title: z.string().min(1).max(200),
  acts: z.array(z.object({ kind: z.string().min(1).max(120), path: z.string().max(4096).optional(), command: z.string().max(8000).optional() }).strict()).max(30).optional(),
  /** agent: a party member; user: the human; outside: a named person or team (a gate). */
  actor: z.enum(["agent", "user", "outside"]),
  check: waypointCheckSchema.optional(),
  /** Member thread id once staffed; a class id while planned; a person or team name for outside gates. */
  owner: z.string().nullable(),
  leadTime: z.string().max(80).nullable(),
  dependsOn: z.array(z.string()),
  doneWhen: z.string().max(1000).nullable(),
  optional: z.boolean(),
});
export type Waypoint = z.infer<typeof waypointSchema>;

export const planQuestionSchema = z.object({
  id: z.string().regex(/^q[0-9]{1,2}$/),
  text: z.string().min(1).max(500),
  options: z.array(z.string().max(200)).max(5),
  recommended: z.number().int().nullable(),
  reversible: z.boolean(),
});

export const leadEnvelopeSchema = z.object({
  members: z.number().int().min(1).max(1000),
  rangers: z.number().int().min(0).max(1000),
  depth: z.number().int().min(1).max(3),
}).strict().refine(envelope => envelope.rangers <= envelope.members, "Rangers count toward the lead's member limit.");
export type LeadEnvelope = z.infer<typeof leadEnvelopeSchema>;
export const leadLinkSchema = z.object({
  id,
  hireToken: id,
  parentKeeperThreadId: threadId,
  parentQuestId: id,
  parentWaypointId: id,
  childKeeperThreadId: threadId.nullable(),
  childQuestId: id.nullable(),
  generation: z.number().int().min(1),
  parentPlan: z.object({
    version: z.number().int().positive(),
    receipt: z.object({ kind: z.enum(["ask-answer", "decision"]), id }),
    check: waypointCheckSchema,
    acts: waypointSchema.shape.acts,
  }),
  envelope: leadEnvelopeSchema,
  amendedBy: id.optional(),
  retirement: z.object({ reason: z.string().min(1).max(500), requestedBy: threadId, confirmedBy: threadId.optional() }).optional(),
  forcedStop: z.object({ receipt: z.string().min(1), reason: z.string().min(1).max(500), hostStopped: z.boolean().optional() }).optional(),
  cleanupError: z.string().optional(),
  result: z.object({ eventId: z.number().int().positive(), makerThreadId: threadId, entryId: z.string() }).optional(),
  amendedRequirements: z.object({ check: waypointCheckSchema, acts: z.array(waypointSchema.shape.acts.unwrap().element).max(120) }).optional(),
  state: z.enum(["reserved", "linked", "retirement-requested", "retiring", "retired", "cancelled", "stopped"]),
});
export type LeadLink = z.infer<typeof leadLinkSchema>;

export const partySlotSchema = z.object({
  classId: z.string(),
  characterId: z.string().nullable(),
  model: z.string().nullable(),
  purpose: z.string().max(300),
  waypointIds: z.array(z.string()),
  leadEnvelope: leadEnvelopeSchema.optional(),
});

import { budgetCentsSchema, spendBudgetSchema, spendProposalSchema } from "./spend";

/** One version of a quest map: the plan the user greenlights. */
export const planSchema = z.object({
  boardQuestId: id,
  reversible: z.boolean().default(false),
  version: z.number().int().positive(),
  createdAt: epochMs,
  /** Set when this version came from a user steer; shown as "from your steer, 14:05". */
  fromSteer: z.object({ routeId: id, at: epochMs, text: z.string().max(300) }).nullable(),
  goal: z.string().max(1000),
  doneWhen: z.string().max(1000),
  findings: z.array(z.string().max(500)).max(12),
  assumptions: z.array(z.string().max(300)).max(10),
  questions: z.array(planQuestionSchema).max(3),
  waypoints: z.array(waypointSchema).min(1).max(24),
  party: z.array(partySlotSchema).max(8),
  alwaysAskKinds: z.array(z.enum(CONSEQUENTIAL_ASK_KINDS)).default([]),
  reviewLoad: z.string().max(300),
  spendBudgetCents: budgetCentsSchema.optional().describe("Proposed spend budget in USD cents. Only the user approving this exact plan can set it."),
  eta: z.string().max(120).nullable(),
  changeNote: z.string().max(500).nullable(),
});
export type Plan = z.infer<typeof planSchema>;

export const planInputSchema = planSchema.omit({ version: true, createdAt: true, fromSteer: true }).extend({
  fromSteer: id.nullish(),
  waypoints: z.array(waypointSchema.extend({ check: waypointCheckSchema }).refine(w =>
    w.actor === "user" ? w.check === "you" : w.actor === "outside" ? w.check === "keeper" : w.check !== "you",
  { path: ["check"], message: "Use warden, keeper, or none for an agent; you for the user; keeper for an outside owner." })).min(1).max(24),
});

export const settleWaypointSchema = z.object({
  boardQuestId: id,
  waypointId: z.string().regex(/^w[0-9]{1,3}$/),
  as: z.enum(["accepted", "skipped", "open"]),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const checkerHandoffHoldDraftSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const checkerHandoffHoldSchema = z.object({
  id, routeId: id, sourceMessageId: id, sourceText: z.string().max(2000),
  reason: z.string().min(1).max(1000), createdAt: epochMs,
  release: z.object({ at: epochMs, via: z.enum(["banner", "page", "phone", "chat", "cli"]), askId: id.nullable() }).nullable(),
});
export type CheckerHandoffHold = z.infer<typeof checkerHandoffHoldSchema>;

import { communicationHoldSchema } from "./communication";
import { delegationSchema, preapprovalSchema, delegationKindSchema, actTargetSchema, CONSEQUENTIAL_ASK_KINDS } from "./quest-authority";
import { closeEarlyDraftSchema, concludeDraftSchema, questOutcomeSchema, waypointWaiverSchema } from "./closing";
import { pullRequestDraftOperationSchema } from "./pull-request";

export const questNamesSchema = z.object({
  title: z.string().min(1).max(200).refine(value => value.trim().length > 0).transform(value => value.trim()),
  short: z.string().min(1).max(40).refine(value => value.trim().length > 0).transform(value => value.trim()),
});

export const boardQuestSchema = z.object({
  delegations: z.array(delegationSchema).max(100).optional(),
  preapprovals: z.array(preapprovalSchema).max(100).optional(),
  checkerHandoffHold: checkerHandoffHoldSchema.optional(),
  id,
  keeperThreadId: threadId,
  title: z.string().min(1).max(200),
  short: z.string().min(1).max(40),
  phase: z.enum(PHASES),
  outcome: questOutcomeSchema.optional(),
  waivers: z.array(waypointWaiverSchema).max(24).optional(),
  held: z.object({ from: z.enum(["scout", "greenlight", "build"]), since: epochMs }).optional(),
  planVersion: z.number().int().nonnegative(),
  greenlitVersion: z.number().int().nullable(),
  checkPlanVersion: z.number().int().positive().optional(),
  createdAt: epochMs,
  updatedAt: epochMs,
  endedAt: epochMs.nullable(),
  stopReason: z.string().trim().max(500).nullable().optional(),
  cellarOnStop: id.optional(),
  stoppingSince: epochMs.nullable().optional(),
  stopHireAskId: id.nullable().optional(),
  reviewAllowance: z.array(z.object({ id, surface: z.string(), at: epochMs, usedBy: z.string().nullable() })).optional(),
  spendBudget: spendBudgetSchema.optional(),
  spendProposal: spendProposalSchema.nullable().optional(),
  deletedAt: epochMs.nullable().optional(),
  /** Set when the user archived a returned or stopped quest: hidden from the common room, kept in the archive. */
  archivedAt: epochMs.nullable().default(null),
});
export type BoardQuest = z.infer<typeof boardQuestSchema>;

// Only "decision" may carry a timed default; every other kind waits for the user.
export const ASK_KINDS = ["greenlight", "decision", "conclude", ...CONSEQUENTIAL_ASK_KINDS, "blocker", "scope"] as const;

export const askOptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,20}$/),
  label: z.string().min(1).max(160),
  detail: z.string().max(300).default(""),
  recommended: z.boolean().default(false),
});

import { shellGrantTargetSchema } from "./shell-grant";
const leadPlanLimitsSchema = z.object({
  members: z.number().int().nonnegative(),
  rangers: z.number().int().nonnegative(),
  depth: z.number().int().min(1).max(3),
  check: waypointCheckSchema,
  acts: z.array(waypointSchema.shape.acts.unwrap().element).max(120),
});
export const leadPlanDecisionSchema = z.object({
  childQuestId: id,
  version: z.number().int().positive(),
  action: z.enum(["approve", "refuse"]),
}).strict();
export const leadPlanReviewSchema = z.object({
  childQuestId: id,
  version: z.number().int().positive(),
  parentQuestId: id,
  parentWaypointId: id,
  parentTitle: z.string().min(1).max(200),
  approved: leadPlanLimitsSchema,
  requested: leadPlanLimitsSchema,
  changes: z.array(z.object({ linkId: id, questTitle: z.string().min(1).max(200), approved: leadPlanLimitsSchema, requested: leadPlanLimitsSchema })).max(3),
  planChanges: z.object({ fromVersion: z.number().int().positive(), fields: z.array(z.string()),
    addedWaypoints: z.array(z.string()), removedWaypoints: z.array(z.string()), changedWaypoints: z.array(z.string()), orderChanged: z.boolean() }).optional(),
  why: z.string().max(400),
});
export const leadPlanRecordSchema = z.object({
  request: leadPlanReviewSchema,
  linkId: id,
  generation: z.number().int().positive(),
  parentVersion: z.number().int().positive(),
  parentApproval: z.object({ id, kind: z.string() }),
  basis: z.array(z.object({ linkId: id, generation: z.number().int().positive(), amendedBy: id.nullable() })).max(3),
  lane: z.enum(["keeper", "user"]),
  state: z.enum(["pending", "approved", "refused", "superseded"]),
  receipt: z.object({ id, kind: z.enum(["decision", "ask-answer"]) }).nullable(),
});
export type LeadPlanReview = z.infer<typeof leadPlanReviewSchema>;
export type LeadPlanRecord = z.infer<typeof leadPlanRecordSchema>;

export const askEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("lead-plan"), request: leadPlanReviewSchema }),
  z.object({ type: z.literal("greenlight"), planVersion: z.number().int().nonnegative(), requiresExplicit: z.literal(true).optional() }),
  z.object({ type: z.literal("conclude"), draft: concludeDraftSchema }),
  z.object({ type: z.literal("close-early"), draft: closeEarlyDraftSchema }),
  z.object({ type: z.literal("release-hold"), holdId: id }),
  settleWaypointSchema.omit({ boardQuestId: true }).extend({ type: z.literal("settle-waypoint"), planVersion: z.number().int().positive() }),
  z.object({ type: z.literal("soft-limit"), limit: z.enum(["party", "rangers"]), text: z.string().min(1).max(400), reason: z.string().max(600) }),
  z.object({ type: z.literal("pull-request-draft"), operation: pullRequestDraftOperationSchema }),
  z.object({ type: z.literal("communication-hold"), hold: communicationHoldSchema, keeperReview: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("retry-stop"), memberThreadId: threadId.optional(), hireTokens: z.array(z.string()).optional() }),
  z.object({ type: z.literal("retry-brief"), threadId, briefId: id }),
  z.object({ type: z.literal("grant-scope"), memberThreadId: threadId }),
  z.object({ type: z.literal("grant-shell-act"), memberThreadId: threadId, target: shellGrantTargetSchema, heldEventId: z.string().min(1).max(420).optional() }).strict(),
  z.object({ type: z.literal("scope-blocker"), memberThreadId: threadId }),
  z.object({ type: z.literal("repair-guard"), memberThreadId: threadId }),
  z.object({ type: z.literal("detection-hire"), binding: z.object({ fingerprint: z.string(), providerId: z.string(), model: z.string(), characterId: z.string().nullable(), displayName: z.string(), token: z.string().optional() }) }),
  z.object({ type: z.literal("decision"), outcomes: z.array(z.object({ optionId: z.string(), outcome: z.enum(["approve", "decline"]) })).optional() }),
  ...(["retry-provider", "retry-tick", "placement-blocker", "answer-blocker", "registry-blocker"] as const).map(type => z.object({ type: z.literal(type) })),
]);
export type AskEffect = z.infer<typeof askEffectSchema>;
export const askSchema = z.object({
  unsure: z.boolean().optional(),
  target: actTargetSchema.optional(),
  mergeApproval: z.object({ expiresAt: epochMs, delegationId: id.optional() }).optional(),
  mergeUse: z.object({ at: epochMs, eventId: z.string(), succeeded: z.boolean() }).optional(),
  sendTarget: z.string().optional(),
  clusterTargets: z.array(z.object({ context: z.string().optional(), namespace: z.string().optional() })).optional(),
  runThreadId: threadId.optional(),
  runThreadName: z.string().optional(),
  clusterGrantExpiresAt: epochMs.optional(),
  clusterApproval: z.object({ at: epochMs, via: z.enum(["banner", "page", "phone", "chat"]), surface: z.string(), note: z.string().max(2000).nullable() }).optional(),
  change: z.string().trim().min(1).max(600).optional(),
  undo: z.string().trim().min(1).max(600).optional(),
  lane: z.enum(["user", "keeper", "tavern"]).optional(),
  effect: askEffectSchema.optional(),
  reversible: z.boolean().optional(),
  releaseHoldId: id.optional(),
  // added by Builder B: scope consent must show the exact grants, override, member and trusted repository, not a truncated summary.
  scopeChange: z.object({ memberThreadId: threadId, override: scopeOverrideSchema, widenings: z.array(z.string()), reason: z.string(), projectRoot: z.string().optional(), remotes: z.array(z.string()).optional(), pushRemote: z.string().optional() }).optional(),
  id,
  keeperThreadId: threadId,
  boardQuestId: id.nullable(),
  question: z.string().min(1).max(400),
  forwardedQuestion: z.object({ parentQuestId: id, byline: z.string().min(1).max(400), body: z.string().min(1).max(400) }).optional(),
  /** Why it is the user's call, in a few words. */
  why: z.string().max(200),
  kind: z.enum(ASK_KINDS),
  options: z.array(askOptionSchema).min(1).max(5),
  /** What keeps going while it waits. */
  meanwhile: z.string().max(300),
  /** Waypoint ids that wait on the answer. */
  holds: z.array(z.string()),
  /** Reversible asks only: when the recommended option applies by itself. */
  proceedAt: epochMs.nullable(),
  /** For sends-as-you: exactly what would be sent, and where. Shown in full wherever the ask is answered. */
  draft: z.object({ to: z.string().max(300), body: z.string().max(8000) }).nullable(),
  state: z.enum(["open", "answered", "defaulted", "withdrawn"]),
  draftApprovalInvalidated: z.literal(true).optional(),
  withdrawnAt: epochMs.nullable().optional(),
  withdrawnCause: z.enum(["quest-stopped", "quest-returned", "plan-superseded", "keeper-archived", "turn-recovered", "scope-cleared", "backup-restored", "conclude-stale-at-upgrade", "closing-stale", "merge-moot"]).nullable().optional(),
  answer: z
    .object({
      surface: z.string().optional(),
      optionId: z.string(),
      note: z.string().max(2000).nullable(),
      by: z.enum(["user", "default", "keeper", "preapproval", "tavern"]),
      preapproval: z.object({ id: z.string(), at: epochMs, surface: z.string() }).optional(),
      keeperAuthority: z.literal("keepers.alwaysAsk").optional(),
    draftDelegationId: id.optional(),
      via: z.enum(["banner", "page", "phone", "chat", "cli", "timer", "tavern"]),
      at: epochMs,
    })
    .nullable(),
  createdAt: epochMs,
});
export type Ask = z.infer<typeof askSchema>;

const decisionReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route"), id }).strict(),
  z.object({ kind: z.literal("rule"), id }).strict(),
  z.object({ kind: z.literal("answer"), id }).strict(),
  z.object({ kind: z.literal("plan"), version: z.number().int().positive(), waypointId: id }).strict(),
]);
const consequenceLine = z.string().trim().min(1).max(400);

/** A call recorded in the ledger. Reversible calls the Keeper made alone show under "Decided for you" with an Undo. */
export const decisionSchema = z.object({
  coveredBy: decisionReceiptSchema.optional(),
  options: z.array(consequenceLine).min(1).max(5).optional(),
  consequence: z.object({ change: consequenceLine, audience: consequenceLine, undo: consequenceLine }).strict().optional(),
  unsure: z.boolean().optional(),
  undoUnavailable: z.literal(true).optional(),
  answerReceipt: id.optional(),
  pullRequestReady: id.optional(),
  leadPlan: leadPlanDecisionSchema.optional(),
  pullRequestGrant: z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  askId: id.optional(), optionId: z.string().optional(), kind: delegationKindSchema.optional(),
  exceeds: z.enum(["party", "rangers"]).optional(),
  waypointCall: settleWaypointSchema.pick({ waypointId: true, as: true }).extend({ planVersion: z.number().int().positive() }).optional(),
  checkChange: z.object({ planVersion: z.number().int().positive(), previousVersion: z.number().int().positive(), steer: z.object({ at: epochMs, text: z.string() }) }).optional(),
  usedBy: z.string().nullable().optional(),
  // added by Builder B: acknowledgement is cross-device display state; missing means unseen.
  seenAt: epochMs.nullable().optional(),
  id,
  keeperThreadId: threadId,
  boardQuestId: id.nullable(),
  text: z.string().min(1).max(400),
  why: z.string().max(600),
  source: z.enum(["keeper", "steer", "ask", "user"]),
  sourceRef: z.string().nullable(),
  reversible: z.boolean(),
  undone: z.boolean(),
  createdAt: epochMs,
});
export type Decision = z.infer<typeof decisionSchema>;

export const ruleSchema = z.object({
  keeperThreadId: threadId.nullable().optional(),
  confirmedAt: epochMs.optional(),
  id,
  scope: z.enum(["global", "project", "keeper", "quest"]),
  /** Project id, Keeper thread id or board quest id; null for global. */
  scopeId: z.string().nullable(),
  text: z.string().min(1).max(500),
  source: z.enum(["user", "keeper-proposed", "message"]),
  supersedesRuleId: id.optional(),
  supersededByRuleId: id.optional(),
  /** Keeper-proposed rules stay inactive until the user confirms them. */
  active: z.boolean(),
  // added by Builder B: explicit user widening keeps the original rule and its audit trail.
  widenedAt: epochMs.nullable().optional(),
  widenedBy: actorSchema.nullable().optional(),
  createdAt: epochMs,
});
export type Rule = z.infer<typeof ruleSchema>;

export const reportSchema = z.object({
  id,
  memberThreadId: threadId,
  keeperThreadId: threadId.nullable(),
  boardQuestId: id.nullable(),
  waypointId: z.string().nullable(),
  status: z.enum(["done", "needs-decision", "blocked", "checkpoint"]),
  checkpoint: z.object({ left: z.string().trim().min(1).max(1000), moreMinutes: z.number().int().min(0).max(240) }).strict().optional(),
  outcome: z.string().min(1).max(4000),
  // added by Builder B: the answer belongs in credits; the full report stays one click away.
  headline: z.string().trim().min(1).max(160).optional(),
  evidence: z.array(evidenceSchema).max(30),
  artifacts: z.array(z.string().max(1000)).max(30),
  confidence: z.object({ intent: z.number().int().min(0).max(100), safe: z.number().int().min(0).max(100) }).nullable(),
  /** One line in the character's voice; dropped by the server for blocked and needs-decision reports. */
  voice: z.string().max(140).nullable(),
  wait: z.object({ condition: noteCondition, dueAt: epochMs }).strict().optional(),
  createdAt: epochMs,
  deliveredAt: epochMs.nullable(),
});
export type Report = z.infer<typeof reportSchema>;

// "rule": the user stated a standing rule in their own words; it is recorded active at once.
export const ROUTE_KINDS = ["steer", "question", "aside", "new-quest", "rule"] as const;

/** How the Keeper read one user message. Drives the "read as" tag above the message. */
export const routeSchema = z.object({
  classSelectionOnly: z.boolean().optional(),
  checkerHandoffHold: checkerHandoffHoldDraftSchema.optional(),
  // added by Builder B: retain user wording and the durable receipt behind route-associated notes.
  userText: z.string().max(200).optional(), sourceMessageId: id.nullable().optional(),
  // added by Builder B: the read-as receipt displays and widens the rule it created.
  ruleId: id.nullable().optional(),
  id,
  keeperThreadId: threadId,
  /** See messageKey() in ./text.ts; matches a user message in the timeline. */
  messageKey: z.string(),
  messageAt: epochMs,
  kind: z.enum(ROUTE_KINDS),
  boardQuestId: id.nullable(),
  /** A steer that names several board quests ("close both quests"); boardQuestId is the first of them. */
  boardQuestIds: z.array(id).max(8).default([]),
  /** What the Keeper did about it, one line. */
  summary: z.string().max(300),
  corrected: z.boolean(),
  createdAt: epochMs,
});
export type Route = z.infer<typeof routeSchema>;

export const eventSchema = z.object({
  id: z.number().int(),
  at: epochMs,
  keeperThreadId: threadId.nullable(),
  boardQuestId: id.nullable(),
  actor: actorSchema,
  /** For example quest.opened, plan.proposed, party.formed, member.hired, report.filed, ask.opened, ask.answered,
   * decision.made, decision.undone, rule.added, route.recorded, tick.sent, tick.held, reanchored, user.told-member,
   * member.stale, quest.wrapped, quest.stopped. */
  type: z.string(),
  text: z.string().max(500),
  data: z.record(z.string(), z.unknown()),
});
export type TavernEvent = z.infer<typeof eventSchema>;
