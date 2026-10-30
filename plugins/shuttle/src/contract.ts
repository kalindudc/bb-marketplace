// The RPC contract between Shuttle's server and its UI, and the shapes both sides share.
import { defineContract } from "./define-contract";
import { z } from "zod";
import { configSchema, WATCH_MODES } from "./config";

/** The page's lists. The Inbox has its own read; Insights too. */
export const AREAS = ["mine", "done", "reviews"] as const;
export type Area = (typeof AREAS)[number];
export const REASONS = ["authored", "requested", "team", "mentioned", "reviewed"] as const;
export type Reason = (typeof REASONS)[number];
export const PR_STATES = ["open", "draft", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];
export const CHECK_STATES = ["passed", "failed", "pending", "none"] as const;
export type CheckState = (typeof CHECK_STATES)[number];
export const REVIEW_STATES = ["approved", "changes", "required", "none"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const LINK_ROLES = ["owner", "review", "reference"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];
export const REVIEW_RUN_STATES = ["running", "done", "failed"] as const;
export const REVIEWER_STATES = ["requested", "approved", "changes", "commented", "dismissed"] as const;
export type ReviewerState = (typeof REVIEWER_STATES)[number];
/** What the user can change on a PR of theirs right now, given its state and its server's commands. */
export const PR_ACTIONS = ["ready", "draft", "close", "reopen", "labels", "reviewers"] as const;
export type PrAction = (typeof PR_ACTIONS)[number];
/** What an agent does with new feedback: fix it (watch mode act), just hear about it (forward), or nothing. */
export const AGENT_MODES = ["fix", "notify", "off"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
export const AGENT_STATUSES = ["working", "waiting", "idle", "archived", "unknown"] as const;
export const VERDICTS = ["comment", "approve", "changes"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const SEVERITIES = ["high", "medium", "low", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const OUTCOMES = ["fixed", "replied", "declined", "question"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const TONES = ["ok", "bad", "warn", "info", "neutral"] as const;
export type NextTone = (typeof TONES)[number];
/** clean: it can merge now; blocked: required reviews or checks are missing; behind: base moved on; conflicts; unknown. */
export const MERGE_STATES = ["clean", "blocked", "behind", "conflicts", "pending", "unknown"] as const;
export type MergeState = (typeof MERGE_STATES)[number];
/** How one check on the head stands. */
export const RUN_STATES = ["failed", "running", "passed", "skipped"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const FILE_CHANGES = ["added", "modified", "removed", "renamed", "copied", "changed"] as const;
export type FileChange = (typeof FILE_CHANGES)[number];
/** What else happened on a PR besides its reviews, comments and commits. */
export const TIMELINE_KINDS = [
  "review_requested", "review_request_removed", "labeled", "unlabeled", "ready_for_review", "converted_to_draft", "force_pushed",
  "merged", "closed", "reopened", "renamed", "auto_merge_enabled", "auto_merge_disabled", "review_dismissed", "branch_deleted", "base_changed",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * The one rule every surface shows: what happens next with this PR. The Inbox card, the row's
 * group and the PR view's banner all use these words, so they never disagree.
 */
export const NEXT_KINDS = [
  // the user's own PRs
  "merged", "closed", "agent_waiting", "nobody", "yours", "agent_on_it", "draft", "auto_merge", "ready_to_merge", "approved_pending", "waiting_review",
  // everyone else's
  "post", "review_done", "review_failed", "running", "rereview", "reviewed", "new_request", "not_reviewed", "looked_up",
] as const;
export type NextKind = (typeof NEXT_KINDS)[number];
/** What a next step's buttons do; the UI owns how each one is carried out. */
export const NEXT_ACTIONS = [
  "merge", "assign_suggested", "pick_agent", "handle", "open_agent", "ready", "nudge", "cancel_auto_merge",
  "choose", "open_review", "review", "approve", "not_now", "track", "reopen",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];
/** What an Inbox rule keeps out: every PR by an author, every PR from a repo, or mentions in a repo where you are not asked by name. */
export const INBOX_RULE_KINDS = ["author", "repo", "mention"] as const;
export type InboxRuleKind = (typeof INBOX_RULE_KINDS)[number];

const key = z.string().min(3).max(400);
const threadId = z.string().min(1).max(100);

export const linkViewSchema = z.object({ threadId: z.string(), title: z.string(), role: z.enum(LINK_ROLES), archived: z.boolean() });
export type LinkView = z.infer<typeof linkViewSchema>;

export const reviewRunSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  state: z.enum(REVIEW_RUN_STATES),
  preset: z.string(),
  trigger: z.enum(["auto", "manual"]),
  head: z.string().nullable(),
  at: z.number(),
});
export type ReviewRunView = z.infer<typeof reviewRunSchema>;

export const labelSchema = z.object({ name: z.string(), color: z.string().nullable() });
export type Label = z.infer<typeof labelSchema>;
/** A team's login is its slug as its server writes it, such as org/team on GitHub. */
export const reviewerSchema = z.object({
  login: z.string(),
  team: z.boolean(),
  state: z.enum(REVIEWER_STATES),
  /** When this reviewer's latest review was submitted, and on which head, when the server says. */
  at: z.number().nullish(),
  head: z.string().nullish(),
  /** The server says the account is a bot or an app. */
  bot: z.boolean().nullish(),
});
export type Reviewer = z.infer<typeof reviewerSchema>;
const reviewerRef = z.object({ login: z.string().trim().min(1).max(200), team: z.boolean() });
export type ReviewerRef = z.infer<typeof reviewerRef>;
const names = z.array(z.string().trim().min(1).max(200)).max(50);
export const prChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("draft") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("reopen") }),
  z.object({ kind: z.literal("labels"), add: names.default([]), remove: names.default([]) }),
  z.object({ kind: z.literal("reviewers"), add: z.array(reviewerRef).max(50).default([]), remove: z.array(reviewerRef).max(50).default([]) }),
]);
export type PrChange = z.output<typeof prChangeSchema>;

export const checkCountsSchema = z.object({ passed: z.number(), failed: z.number(), pending: z.number(), total: z.number() });
export type CheckCounts = z.infer<typeof checkCountsSchema>;

export const agentViewSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  mode: z.enum(AGENT_MODES),
  /** working: its thread is running; waiting: it asked you something; archived: its thread is archived. */
  status: z.enum(AGENT_STATUSES),
  /** Auto agent picked it, from the thread that opened the PR. */
  auto: z.boolean(),
  /** The last batch Shuttle sent it for this PR. */
  lastSent: z.object({ at: z.number(), text: z.string() }).nullable(),
});
export type AgentView = z.infer<typeof agentViewSchema>;

export const nextStepSchema = z.object({
  kind: z.enum(NEXT_KINDS),
  tone: z.enum(TONES),
  /** Short: "Ready to merge", "Changes requested, and nobody is on it". */
  label: z.string(),
  /** One or two sentences with the facts behind the label. */
  why: z.string(),
  /** When an Inbox card leaves, such as "Leaves when it merges, or when you snooze it."; null outside the Inbox. */
  clears: z.string().nullable(),
  /** In the Inbox now (snoozed PRs are not). */
  inbox: z.boolean(),
  primary: z.object({ id: z.enum(NEXT_ACTIONS), label: z.string() }).nullable(),
  more: z.array(z.object({ id: z.enum(NEXT_ACTIONS), label: z.string() })),
});
export type NextStep = z.infer<typeof nextStepSchema>;

export const myReviewSchema = z.object({
  verdict: z.enum(["approve", "changes", "comment", "dismissed"]),
  at: z.number().nullable(),
  head: z.string().nullable(),
});
export type MyReview = z.infer<typeof myReviewSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(SEVERITIES),
  path: z.string(),
  /** A line in the new version of the file; null for a file-level finding. */
  line: z.number().int().positive().nullable(),
  body: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const reviewDraftSchema = z.object({
  id: z.number(),
  threadId: z.string(),
  threadTitle: z.string(),
  preset: z.string().nullable(),
  trigger: z.enum(["auto", "manual"]).nullable(),
  /** The head the review read. */
  head: z.string().nullable(),
  at: z.number(),
  summary: z.string(),
  verdict: z.enum(VERDICTS),
  findings: z.array(findingSchema),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

export const prViewSchema = z.object({
  /** `server:repo#number`, the PR's id everywhere in Shuttle. */
  key: z.string(),
  server: z.string(),
  serverName: z.string(),
  repo: z.string(),
  number: z.number(),
  sep: z.enum(["#", "!"]),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  mine: z.boolean(),
  state: z.enum(PR_STATES),
  checks: z.enum(CHECK_STATES),
  /** How many checks passed, failed and are still running, when the server says; null otherwise. */
  checkCounts: checkCountsSchema.nullable(),
  review: z.enum(REVIEW_STATES),
  head: z.string().nullable(),
  headRef: z.string().nullable(),
  base: z.string().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  files: z.number().nullable(),
  updatedAt: z.number().nullable(),
  createdAt: z.number().nullable(),
  /** When it merged or closed. */
  closedAt: z.number().nullable(),
  reasons: z.array(z.object({ reason: z.enum(REASONS), teams: z.array(z.string()) })),
  /** The teams it asks a review of, without @ or org, so one team reads the same on every server. */
  teams: z.array(z.string()),
  /** When you or your team were asked; null when it does not ask. */
  requestedAt: z.number().nullable(),
  /** The author is a bot, by the server or by the "Bot authors" setting. */
  bot: z.boolean(),
  /** Nothing changed in 30 days. */
  quiet: z.boolean(),
  /** Kept in Reviews › Tracked; it comes to the Inbox when it changes after your review. */
  tracked: z.boolean(),
  links: z.array(linkViewSchema),
  /** The thread that handles new reviews and failed checks on this PR; at most one. */
  agent: agentViewSchema.nullable(),
  /** A thread that could be the agent: the one that opened the PR, found by its branch. */
  suggestedAgent: z.object({ threadId: z.string(), title: z.string(), why: z.string() }).nullable(),
  /** Kept for the CLI and the thread panel: the watch mode behind the agent's mode. */
  watch: z.enum(WATCH_MODES).nullable(),
  lastReview: reviewRunSchema.nullable(),
  /** The thread Shuttle started for this PR's reviews, where the next review goes; null when there is none to reuse. */
  reviewThread: z.object({ threadId: z.string(), title: z.string(), archived: z.boolean() }).nullable(),
  /** Your own latest review on the server, or the one you posted from Shuttle. */
  myReview: myReviewSchema.nullable(),
  /** An AI review draft waiting for you to choose what to post. */
  draft: z.object({ id: z.number(), findings: z.number(), at: z.number() }).nullable(),
  next: nextStepSchema,
  /** Out of the Inbox by a snooze right now, whether until a time or until it changes. */
  snoozed: z.boolean(),
  /** When a snooze ends; null when not snoozed or snoozed until it changes. */
  snoozedUntil: z.number().nullable(),
  /** Dismissed from the Inbox for good; activity: it changed after it was dismissed. */
  dismissed: z.object({ at: z.number(), activity: z.boolean() }).nullable(),
  /** The oldest Inbox rule that matches the PR, whether or not its step would put it in the Inbox. */
  keptOutBy: z.number().nullable(),
  /** It changed since you last opened it in Shuttle, or you never have. */
  unseen: z.boolean(),
  /** You said "I'll do it" about its current feedback. */
  handled: z.boolean(),
  /** GitHub's auto-merge is on: it merges when its checks pass. */
  autoMerge: z.boolean(),
  /** The server's last sync failed every list that brings this PR, so it may be out of date. */
  stale: z.boolean(),
  /** When one of those lists last passed: the age of what this row shows. */
  staleSince: z.number().nullable(),
  /** Review items found on a PR with an agent and not yet sent. */
  pendingItems: z.number(),
  /** null until Shuttle has read them from the server. */
  labels: z.array(labelSchema).nullable(),
  /** Requested reviewers and the latest review of everyone who reviewed; null until a read carried them. */
  reviewers: z.array(reviewerSchema).nullable(),
  /** Empty unless the PR is the user's own. */
  actions: z.array(z.enum(PR_ACTIONS)),
  /** What its server lets you do from Shuttle right now. */
  can: z.object({ merge: z.boolean(), comment: z.boolean(), review: z.boolean(), reply: z.boolean(), resolve: z.boolean() }),
});
export type PrView = z.infer<typeof prViewSchema>;

export const BOARD_ARCHIVED = ["exclude", "include", "only"] as const;
export type BoardArchived = (typeof BOARD_ARCHIVED)[number];
const boardIdSchema = z.string().trim().min(1).max(100);
const boardNameSchema = z.string().trim().min(1).max(80);
const boardDescriptionSchema = z.string().trim().max(300);
const boardPrsSchema = z.array(z.string().trim().min(1).max(500)).max(200);

export const boardSummarySchema = z.object({
  id: boardIdSchema,
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
  createdBy: z.string().nullable(),
  prCount: z.number(),
  attention: z.number(),
  ready: z.number(),
  merged: z.number(),
  preview: z.array(z.object({ key: z.string(), title: z.string(), state: z.enum(PR_STATES) })).max(3),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const boardActivitySchema = z.object({ id: z.number(), at: z.number(), text: z.string(), threadId: z.string().nullable() });
export type BoardActivity = z.infer<typeof boardActivitySchema>;

export const boardDetailSchema = z.object({ board: boardSummarySchema, prs: z.array(prViewSchema), activity: z.array(boardActivitySchema) });
export type BoardDetail = z.infer<typeof boardDetailSchema>;

export const boardsInputSchema = z.object({ query: z.string().max(200).optional(), archived: z.enum(BOARD_ARCHIVED).optional(), key: key.optional() });
export const boardInputSchema = z.object({ id: boardIdSchema });
export const boardCreateInputSchema = z.object({ name: boardNameSchema, description: boardDescriptionSchema.optional(), prs: boardPrsSchema.optional() });
export const boardUpdateInputSchema = z.object({ id: boardIdSchema, name: boardNameSchema.optional(), description: boardDescriptionSchema.optional(), archived: z.boolean().optional() });
export const boardAddInputSchema = z.object({ id: boardIdSchema, prs: boardPrsSchema.min(1) });
export const boardRemoveInputSchema = z.object({ id: boardIdSchema, prs: boardPrsSchema.min(1) });

/** Why a step of a sync failed, in plain words and as the command left it. */
export const SYNC_FAILURE_KINDS = ["unavailable", "timeout", "network", "rate_limit", "auth", "cut_short", "failed"] as const;
export type SyncFailureKind = (typeof SYNC_FAILURE_KINDS)[number];
export const syncFailureSchema = z.object({
  kind: z.enum(SYNC_FAILURE_KINDS),
  /** "Delta was restarting (HTTP 503)". */
  summary: z.string(),
  /** Shuttle's own message, as before. */
  message: z.string(),
  /** The end of what the command printed. */
  output: z.string().nullable(),
  exit: z.number().nullable(),
  command: z.string().nullable(),
  /** A command the user can run to fix it, such as `dt auth login`. */
  fix: z.string().nullable(),
});
export type SyncFailure = z.infer<typeof syncFailureSchema>;

/** A sync's steps, in order: who the user is, each list, then the linked and tracked PRs no list covered. */
export const SYNC_STEPS = ["whoami", "authored", "review_requested", "team_requested", "mentioned", "reviewed", "refresh"] as const;
export type SyncStepName = (typeof SYNC_STEPS)[number];
export const syncStepSchema = z.object({
  operation: z.enum(SYNC_STEPS),
  status: z.enum(["ok", "failed", "skipped"]),
  ms: z.number(),
  attempts: z.number(),
  /** What it brought ("63 PRs"), or why it did not run. */
  detail: z.string().nullable(),
  failure: syncFailureSchema.nullable(),
});
export type SyncStep = z.infer<typeof syncStepSchema>;

/** partial: some lists failed and the rest are current. */
export const SYNC_STATES = ["ok", "partial", "failed"] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const syncRunSchema = z.object({ id: z.number(), at: z.number(), durationMs: z.number(), state: z.enum(SYNC_STATES), steps: z.array(syncStepSchema) });
export type SyncRun = z.infer<typeof syncRunSchema>;

export const serverStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["github", "command"]),
  enabled: z.boolean(),
  /** The last sync passed in full; null until the first sync. */
  ok: z.boolean().nullable(),
  state: z.enum(SYNC_STATES).nullable(),
  login: z.string().nullable(),
  error: z.string().nullable(),
  lastOkAt: z.number().nullable(),
  lastSyncAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  operations: z.array(z.string()),
  /** Syncs in a row that did not pass in full, and when the first of them ran. */
  failures: z.number(),
  failingSince: z.number().nullable(),
  /** The first step that failed in the last sync. */
  failure: syncFailureSchema.extend({ operation: z.enum(SYNC_STEPS) }).nullable(),
  /** Steps of the last sync that failed or did not run; their PRs show older data. */
  failedSteps: z.array(z.enum(SYNC_STEPS)),
  /** When each step last passed. */
  stepOkAt: z.partialRecord(z.enum(SYNC_STEPS), z.number()),
  /** Two syncs in a row failed, or the server needs the user to sign in: the page says so. */
  alert: z.boolean(),
  /** About when Shuttle syncs this server next. */
  nextSyncAt: z.number().nullable(),
  /** The last sync that did not pass in full, within a day. */
  lastFailedAt: z.number().nullable(),
});
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const syncHistorySchema = z.object({
  /** How far back `runs` go. */
  windowMs: z.number(),
  servers: z.array(
    z.object({
      id: z.string(),
      /** Oldest first. */
      runs: z.array(z.object({ at: z.number(), state: z.enum(SYNC_STATES), durationMs: z.number() })),
      /** The newest sync that did not pass in full, with every step. */
      lastFailure: syncRunSchema.nullable(),
      /** Newest first, a week at most. */
      failures: z.array(z.object({ at: z.number(), state: z.enum(SYNC_STATES), operation: z.enum(SYNC_STEPS), summary: z.string(), output: z.string().nullable() })),
      /** Over the passing syncs of `runs`. */
      averageMs: z.number().nullable(),
    }),
  ),
});
export type SyncHistory = z.infer<typeof syncHistorySchema>;

export const eventViewSchema = z.object({
  id: z.number(),
  at: z.number(),
  kind: z.string(),
  text: z.string(),
  key: z.string().nullable(),
  threadId: z.string().nullable(),
});
export type EventView = z.infer<typeof eventViewSchema>;

export const overviewSchema = z.object({
  servers: z.array(serverStatusSchema),
  counts: z.object({ inbox: z.number(), mine: z.number(), done: z.number(), reviews: z.number() }),
  syncedAt: z.number().nullable(),
  syncing: z.boolean(),
  paused: z.boolean(),
  autoAgent: z.boolean(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const inboxRuleSchema = z.object({
  id: z.number(),
  kind: z.enum(INBOX_RULE_KINDS),
  server: z.string(),
  serverName: z.string(),
  /** A login for author rules, a repo for repo and mention rules. */
  value: z.string(),
  createdAt: z.number(),
  /** The keys of the PRs it keeps out of the Inbox now: ones that would be in it, not snoozed or dismissed. */
  keeps: z.array(z.string()),
});
export type InboxRule = z.infer<typeof inboxRuleSchema>;

export const inboxSchema = z.object({
  /** Highest priority first. */
  prs: z.array(prViewSchema),
  /** Live snoozed PRs that are not dismissed, soonest back first; "until it changes" last. */
  snoozed: z.array(prViewSchema),
  /** Live dismissed PRs, most recently dismissed first. */
  dismissed: z.array(prViewSchema),
  /** Newest first. */
  rules: z.array(inboxRuleSchema),
  /** Requests by name or mention that left the Inbox by age and are still not reviewed; they wait in Reviews. */
  olderRequests: z.number(),
  /** How many things automation did in the last 24 hours (Insights › Automation log lists them). */
  handled: z.number(),
});
export type InboxView = z.infer<typeof inboxSchema>;

/** One line of the diff a review thread comments on; `line` is its number in the new file, null for a removed line. */
export const hunkLineSchema = z.object({ kind: z.enum(["add", "del", "context"]), text: z.string(), line: z.number().nullable() });
export type HunkLine = z.infer<typeof hunkLineSchema>;

export const conversationItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["review", "thread", "comment", "check"]),
  author: z.string().nullable(),
  bot: z.boolean(),
  /** The author is you. */
  mine: z.boolean(),
  /** A review's verdict ("approved", "changes requested"), or "failed" for a check. */
  state: z.string().nullable(),
  body: z.string(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  url: z.string().nullable(),
  at: z.number().nullable(),
  /** The review thread this comment is in: what Reply and Resolve act on. */
  thread: z.string().nullable(),
  resolved: z.boolean(),
  /** For your PRs: sent to the agent, or waiting to be sent; null when it was never queued. */
  delivery: z.enum(["sent", "pending"]).nullable(),
  /** What the agent said it did with it. */
  outcome: z.object({ outcome: z.enum(OUTCOMES), note: z.string().nullable(), commit: z.string().nullable(), at: z.number() }).nullable(),
  /** A review thread's comments: the last lines of the diff it is on, ending at its line; null when the server sent none. */
  hunk: z.array(hunkLineSchema).nullable(),
  /** The review an item belongs to: a review's own id, or the review a line comment was posted in. */
  review: z.string().nullable(),
});
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const checkRunSchema = z.object({
  name: z.string(),
  /** The workflow or app it belongs to, when the server says. */
  group: z.string().nullable(),
  state: z.enum(RUN_STATES),
  /** The server's word for how it ended or stands, such as "timed out" or "queued", or a status's description. */
  detail: z.string().nullable(),
  /** A branch rule needs it to pass; null when the server does not say. */
  required: z.boolean().nullable(),
  url: z.string().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  /** A failed check's conversation item, which says what the agent got and did. */
  itemId: z.string().nullable(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;
export const commitViewSchema = z.object({ sha: z.string(), message: z.string(), author: z.string().nullable(), at: z.number().nullable() });
export type CommitView = z.infer<typeof commitViewSchema>;
export const changedFileSchema = z.object({ path: z.string(), additions: z.number().nullable(), deletions: z.number().nullable(), change: z.enum(FILE_CHANGES) });
export type ChangedFile = z.infer<typeof changedFileSchema>;
/**
 * `subject` is who or what the event is about: the reviewer, the label, the new title, the new head or base,
 * or the merge commit. `detail` is what it was before: the old title, head or base, or the branch merged into.
 */
export const timelineEventSchema = z.object({ kind: z.enum(TIMELINE_KINDS), at: z.number(), actor: z.string().nullable(), subject: z.string().nullable(), detail: z.string().nullable() });
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
/** A capped list: up to its first or last 100, and how many there are in all. */
const capped = <T extends z.ZodType>(item: T) => z.object({ total: z.number(), items: z.array(item) });

/** What the PR view shows beyond the conversation. Each part is null when the PR's server does not send it. */
export const prDetailsSchema = z.object({
  checks: capped(checkRunSchema).nullable(),
  /** Oldest first. */
  commits: capped(commitViewSchema).nullable(),
  /** Paths and line counts only, never their contents. */
  files: capped(changedFileSchema).nullable(),
  timeline: z.array(timelineEventSchema).nullable(),
  merge: z.object({ state: z.enum(MERGE_STATES), detail: z.string().nullable() }).nullable(),
});
export type PrDetails = z.infer<typeof prDetailsSchema>;

export const LINK_CARD_KINDS = ["pr", "comment", "review", "commit", "check", "issue"] as const;
export const ISSUE_STATES = ["open", "completed", "not_planned"] as const;
/** A link's colour: its PR's state, or its issue's. */
export const LINK_STATES = [...PR_STATES, "completed", "not_planned"] as const;

/** What the card on a git link in a thread shows; every part is null when the link is not about it or Shuttle could not read it. */
export const linkCardSchema = z.object({
  kind: z.enum(LINK_CARD_KINDS),
  /** "acme/api#12", "acme/api@1a2b3c4" or a check's name, as the card's first line. */
  label: z.string(),
  server: z.string(),
  serverName: z.string(),
  /** The PR the link is on or names, as Shuttle has it; null when Shuttle has not seen it. */
  pr: prViewSchema.nullable(),
  /** The key of that PR, even when Shuttle has not seen it, so the card can offer to look it up. */
  prKey: z.string().nullable(),
  /** Which tab of the PR view the link is closest to. */
  tab: z.enum(["overview", "conversation", "checks", "changes"]),
  comment: z.object({
    item: conversationItemSchema,
    /** Comments in its review thread besides it. */
    replies: z.number(),
    resolved: z.boolean(),
  }).nullable(),
  review: z.object({ item: conversationItemSchema, comments: z.number(), open: z.number() }).nullable(),
  commit: z.object({
    sha: z.string(),
    message: z.string(),
    author: z.string().nullable(),
    at: z.number().nullable(),
    additions: z.number().nullable(),
    deletions: z.number().nullable(),
    checks: z.enum(CHECK_STATES).nullable(),
    /** It is the PR's head now. */
    head: z.boolean(),
    /** What its agent said this commit fixed. */
    fixes: z.array(z.object({ author: z.string().nullable(), path: z.string().nullable(), line: z.number().nullable(), body: z.string() })),
  }).nullable(),
  check: checkRunSchema.extend({ delivery: z.enum(["sent", "pending"]).nullable() }).nullable(),
  issue: z.object({
    number: z.number(),
    title: z.string(),
    state: z.enum(ISSUE_STATES),
    author: z.string().nullable(),
    createdAt: z.number().nullable(),
    closedAt: z.number().nullable(),
    body: z.string(),
    labels: z.array(z.object({ name: z.string(), color: z.string().nullable() })),
    assignees: z.array(z.string()),
    comments: z.number(),
    /** The PRs that close it; `key` is set when Shuttle has the PR, and `state` is Shuttle's then. */
    closedBy: z.array(z.object({ repo: z.string(), number: z.number(), title: z.string(), state: z.enum(PR_STATES), url: z.string(), key: z.string().nullable() })),
  }).nullable(),
  /** Why a part is missing, in plain words: not seen yet, or the server's error. */
  note: z.string().nullable(),
});
export type LinkCard = z.infer<typeof linkCardSchema>;

export const mergeOptionsSchema = z.object({
  /** Methods the repository allows, the default first. */
  methods: z.array(z.enum(MERGE_METHODS)),
  default: z.enum(MERGE_METHODS),
  /** The repository deletes branches after a merge by default. */
  deleteBranch: z.boolean(),
  /** The server can merge it by itself once checks pass. */
  canAuto: z.boolean(),
  state: z.enum(MERGE_STATES),
  /** The server's reason when it is not clean. */
  detail: z.string().nullable(),
});
export type MergeOptions = z.infer<typeof mergeOptionsSchema>;

const weekly = z.array(z.object({ week: z.string(), asked: z.number(), team: z.number(), reviewed: z.number() }));
export const insightsSchema = z.object({
  range: z.enum(["7d", "30d", "90d"]),
  /** Shuttle keeps some of these numbers only from this time on; null when it has everything. */
  collectingSince: z.number().nullable(),
  kpis: z.object({
    merged: z.number(),
    opened: z.number(),
    /** Median milliseconds, or null without data. */
    timeToMerge: z.number().nullable(),
    firstReviewWait: z.number().nullable(),
    reviewResponse: z.number().nullable(),
  }),
  /** Share of your PRs' open time in each phase, 0 to 1; null before Shuttle has seen a PR through. */
  phases: z.object({ draft: z.number(), waiting: z.number(), fixing: z.number(), approved: z.number() }).nullable(),
  feedback: z.object({
    total: z.number(),
    fixed: z.number(),
    replied: z.number(),
    declined: z.number(),
    /** Items on PRs you said you would handle. */
    you: z.number(),
    open: z.number(),
    agentMedianMs: z.number().nullable(),
  }),
  requests: weekly,
  /** Open requests at the end of each day Shuttle synced. */
  openRequests: z.array(z.object({ day: z.string(), total: z.number(), bots: z.number(), quiet: z.number() })),
  ai: z.array(z.object({ preset: z.string(), drafts: z.number(), posted: z.number(), kept: z.number().nullable() })),
  reviewers: z.array(z.object({ login: z.string(), bot: z.boolean(), reviews: z.number(), medianMs: z.number().nullable() })),
  ideas: z.array(z.object({
    id: z.string(),
    tone: z.enum(TONES),
    title: z.string(),
    detail: z.string(),
    action: z.object({ id: z.enum(["nudge", "auto_agent", "hide_bots", "show_quiet", "edit_preset"]), label: z.string(), key: z.string().nullable() }).nullable(),
  })),
});
export type InsightsView = z.infer<typeof insightsSchema>;

export const threadOptionSchema = z.object({ id: z.string(), title: z.string(), projectId: z.string().nullable(), status: z.string(), updatedAt: z.number().nullable() });
export type ThreadOption = z.infer<typeof threadOptionSchema>;
export const projectOptionSchema = z.object({ id: z.string(), name: z.string() });
export type ProjectOption = z.infer<typeof projectOptionSchema>;
export const testResultSchema = z.object({ operation: z.string(), ok: z.boolean(), detail: z.string(), ms: z.number() });
export type TestResult = z.infer<typeof testResultSchema>;

const ok = z.object({ ok: z.literal(true) });
const prOut = z.object({ pr: prViewSchema });
const prsOut = z.object({ prs: z.array(prViewSchema) });

export const reviewInputSchema = z.object({
  key,
  presetId: z.string().max(32).optional(),
  /** Per-run overrides of the preset. */
  skill: z.string().max(100).optional(),
  providerId: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  reasoningLevel: z.string().max(40).optional(),
  note: z.string().max(4000).optional(),
  /** Send the review prompt to this existing thread instead of starting one. */
  threadId: z.string().max(100).optional(),
  /** Start a thread even when the PR has a review thread of Shuttle's to bring back. */
  newThread: z.boolean().optional(),
  projectId: z.string().max(100).optional(),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const agentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), threadId }),
  z.object({ kind: z.literal("new"), projectId: z.string().max(100).optional() }),
  /** No agent: the thread stays linked for reference. */
  z.object({ kind: z.literal("none") }),
]);
export type AgentTarget = z.infer<typeof agentTargetSchema>;

const body = z.string().trim().min(1).max(60_000);
export const postFindingSchema = z.object({ path: z.string().min(1).max(1000), line: z.number().int().positive().nullable(), body: z.string().trim().min(1).max(20_000) });
export type PostFinding = z.infer<typeof postFindingSchema>;

// Reads carry tags and writes declare what they invalidate; background syncs invalidate "prs" and "servers" from the server.
const PRS = () => ["prs"];
const BOARDS = () => ["boards", "prs"];
const CONVERSATION = () => ["prs", "conversation"];
const CONFIG = () => ["config"];

export const rpcContract = defineContract({
  overview: { input: z.object({}), output: overviewSchema, tags: () => ["prs", "servers", "config"] },
  inbox: { input: z.object({}), output: inboxSchema, tags: PRS },
  list: { input: z.object({ area: z.enum(AREAS) }), output: z.object({ prs: z.array(prViewSchema) }), tags: PRS },
  /** body is the description, or null until Shuttle has fetched the PR itself (lists carry none). */
  detail: { input: z.object({ key }), output: z.object({ pr: prViewSchema, events: z.array(eventViewSchema), body: z.string().nullable(), draft: reviewDraftSchema.nullable() }), tags: PRS },
  /** The PR's reviews, comments and failed checks, and the details its view shows, read from its server (kept for 30 seconds). */
  conversation: { input: z.object({ key }), output: z.object({ items: z.array(conversationItemSchema), details: prDetailsSchema.nullable(), error: z.string().nullable(), fetchedAt: z.number() }), tags: () => ["conversation"] },
  /** PRs Shuttle already has whose title, repository, number, author, branches or labels hold every word; no server is asked. */
  search: { input: z.object({ query: z.string().max(200) }), output: z.object({ prs: z.array(prViewSchema), total: z.number() }), tags: PRS },
  boards: { input: boardsInputSchema, output: z.object({ boards: z.array(boardSummarySchema) }), tags: BOARDS },
  board: { input: boardInputSchema, output: boardDetailSchema, tags: BOARDS },
  /** A link or a key such as delta:shop/world#2261179; fetched from its server and kept. */
  lookup: { input: z.object({ query: z.string().min(1).max(500) }), output: prOut, invalidates: PRS },
  activity: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }), output: z.object({ events: z.array(eventViewSchema) }), tags: PRS },
  insights: { input: z.object({ range: z.enum(["7d", "30d", "90d"]) }), output: insightsSchema, tags: PRS },
  /** Every enabled server, or only `server`. */
  sync: { input: z.object({ server: z.string().min(1).max(100).optional() }), output: ok, invalidates: () => ["prs", "servers", "conversation"] },
  /** Each server's syncs of the last three hours, its last failed sync in full and its failures of the last week. */
  syncHistory: { input: z.object({}), output: syncHistorySchema, tags: () => ["servers"] },
  link: { input: z.object({ key, threadId, role: z.enum(LINK_ROLES).optional() }), output: prOut, invalidates: PRS },
  unlink: { input: z.object({ key, threadId }), output: prOut, invalidates: PRS },
  watch: { input: z.object({ key, mode: z.enum(WATCH_MODES).nullable() }), output: prOut, invalidates: PRS },
  /** Make a thread the PR's agent (the one before stays linked for reference), start a new one, or have none. */
  setAgent: { input: z.object({ key, target: agentTargetSchema, mode: z.enum(AGENT_MODES).optional() }), output: z.object({ pr: prViewSchema, threadId: z.string().nullable() }), invalidates: PRS },
  setAgentMode: { input: z.object({ key, mode: z.enum(AGENT_MODES) }), output: prOut, invalidates: PRS },
  /** Send your text to the PR's agent thread, with the PR named; nothing is posted on the PR. */
  askAgent: { input: z.object({ key, text: body }), output: ok, invalidates: PRS },
  /** The page's own switches for Shuttle's bb settings. */
  setSettings: { input: z.object({ autoAgent: z.boolean().optional(), inboxRequests: z.boolean().optional() }), output: ok, invalidates: () => ["prs", "servers", "config"] },
  track: { input: z.object({ key, on: z.boolean() }), output: prOut, invalidates: PRS },
  /**
   * Out of the Inbox until an epoch-ms time (in the future, at most 60 days ahead) or "update", until it changes;
   * anything new brings it back sooner either way. null: back now.
   */
  snooze: { input: z.object({ keys: z.array(key).min(1).max(200), until: z.union([z.number().int(), z.literal("update")]).nullable() }), output: prsOut, invalidates: PRS },
  /** Out of the Inbox for good, even when it changes, and its snooze ends; off restores it. */
  dismiss: { input: z.object({ keys: z.array(key).min(1).max(200), on: z.boolean() }), output: prsOut, invalidates: PRS },
  /** You opened these PRs: they are no longer new. */
  markSeen: { input: z.object({ keys: z.array(key).min(1).max(500) }), output: ok, invalidates: PRS },
  /** The same rule twice returns the existing one, with created false. */
  inboxRuleAdd: { input: z.object({ kind: z.enum(INBOX_RULE_KINDS), server: z.string().min(1).max(100), value: z.string().trim().min(1).max(200) }), output: z.object({ rule: inboxRuleSchema, created: z.boolean() }), invalidates: PRS },
  inboxRuleRemove: { input: z.object({ id: z.number().int() }), output: ok, invalidates: PRS },
  /** "I'll do it": its current feedback leaves the Inbox until new feedback arrives. */
  handle: { input: z.object({ key, on: z.boolean() }), output: prOut, invalidates: PRS },
  /** Runs in the PR's review thread, brought back from the archive when Shuttle archived it, or in a new one. */
  review: { input: reviewInputSchema, output: z.object({ threadId: z.string(), revived: z.boolean() }), invalidates: PRS },
  /** Start a thread that owns the PR ("own") or reviews it ("review"), and link it. */
  newThread: { input: z.object({ key, start: z.enum(["own", "review"]), projectId: z.string().max(100).optional() }), output: z.object({ threadId: z.string() }), invalidates: PRS },
  threadPrs: { input: z.object({ threadId }), output: z.object({ prs: z.array(prViewSchema), sent: z.array(eventViewSchema) }), tags: PRS },
  /** Send every pending review item of the thread's PRs now, without waiting for the batch window. */
  sendUnread: { input: z.object({ threadId }), output: z.object({ sent: z.number() }), invalidates: PRS },
  threads: { input: z.object({ query: z.string().max(200).optional() }), output: z.object({ threads: z.array(threadOptionSchema) }) },
  projects: { input: z.object({ key: key.optional() }), output: z.object({ projects: z.array(projectOptionSchema), suggested: z.string().nullable() }) },
  getConfig: { input: z.object({}), output: z.object({ config: configSchema }), tags: CONFIG },
  saveConfig: { input: z.object({ config: z.unknown() }), output: z.object({ config: configSchema }), invalidates: () => ["config", "prs", "servers"] },
  boardCreate: { input: boardCreateInputSchema, output: boardDetailSchema, invalidates: () => ["boards"] },
  boardUpdate: { input: boardUpdateInputSchema, output: z.object({ board: boardSummarySchema }), invalidates: () => ["boards"] },
  boardAdd: { input: boardAddInputSchema, output: z.object({ board: boardSummarySchema, added: z.array(z.string()), alreadyPresent: z.array(z.string()) }), invalidates: () => ["boards"] },
  boardRemove: { input: boardRemoveInputSchema, output: z.object({ board: boardSummarySchema, removed: z.array(z.string()) }), invalidates: () => ["boards"] },
  /** Run a server's commands once (a saved server by id, or an unsaved one) and report each. */
  testServer: { input: z.object({ id: z.string().max(32).optional(), server: z.unknown().optional() }), output: z.object({ results: z.array(testResultSchema) }) },
  exportToml: { input: z.object({}), output: z.object({ toml: z.string() }), tags: CONFIG },
  importToml: { input: z.object({ toml: z.string().max(200_000), apply: z.boolean() }), output: z.object({ changes: z.array(z.string()), config: configSchema.nullable() }), invalidates: (input) => (input.apply ? ["config", "prs", "servers"] : []) },
  /** Change one of the user's own PRs on its server, then read it back. */
  editPr: { input: z.object({ key, change: prChangeSchema }), output: prOut, invalidates: PRS },
  /** What the label and reviewer pickers offer: the repo's labels, people the server suggests, and known teams. */
  editOptions: {
    input: z.object({ key }),
    output: z.object({ labels: z.array(labelSchema.extend({ description: z.string().nullable() })), people: z.array(z.string()), teams: z.array(z.string()) }),
  },
  /** How this PR can merge: the repository's methods and whether it can merge now. Untagged; read when the dialog opens. */
  mergeOptions: { input: z.object({ key }), output: mergeOptionsSchema },
  /** Merge one of your PRs, only while its head is still `head`; with `auto`, once its checks pass. */
  merge: {
    input: z.object({ key, method: z.enum(MERGE_METHODS), head: z.string().min(7).max(100), auto: z.boolean(), deleteBranch: z.boolean(), subject: z.string().trim().max(500).optional() }),
    output: z.object({ pr: prViewSchema, merged: z.boolean() }),
    invalidates: CONVERSATION,
  },
  cancelAutoMerge: { input: z.object({ key }), output: prOut, invalidates: PRS },
  /** A comment on the PR's conversation, as you. */
  comment: { input: z.object({ key, body }), output: prOut, invalidates: CONVERSATION },
  /**
   * A review as you: a verdict, a body and inline comments. With draftId, the AI draft it came from
   * is marked posted. Findings the server cannot place on a line go into the body.
   */
  submitReview: {
    input: z.object({
      key,
      verdict: z.enum(VERDICTS),
      body: z.string().trim().max(60_000),
      findings: z.array(postFindingSchema).max(100).default([]),
      draftId: z.number().int().optional(),
      /** Post a draft whose review read an older head: its comments stay on the lines that review read. Never for an approval. */
      staleOk: z.boolean().optional(),
    }),
    output: z.object({ pr: prViewSchema, placed: z.number(), inBody: z.number() }),
    invalidates: CONVERSATION,
  },
  discardDraft: { input: z.object({ key, draftId: z.number().int() }), output: prOut, invalidates: PRS },
  /** Undo a discard. */
  restoreDraft: { input: z.object({ key, draftId: z.number().int() }), output: prOut, invalidates: PRS },
  reply: { input: z.object({ key, thread: z.string().min(1).max(300), body }), output: ok, invalidates: CONVERSATION },
  resolve: { input: z.object({ key, thread: z.string().min(1).max(300), resolved: z.boolean() }), output: ok, invalidates: CONVERSATION },
  /** The card for a git link in a thread. A PR comes from Shuttle's copy; its comments and details from the same 30-second read as its view. Nothing is written. */
  linkCard: { input: z.object({ url: z.string().min(8).max(2000) }), output: linkCardSchema, tags: () => ["prs", "conversation"] },
  /** Each link's kind and its PR's or issue's state, from what Shuttle already has, to mark links in threads; no server is asked. */
  linkStates: {
    input: z.object({ urls: z.array(z.string().min(8).max(2000)).max(100) }),
    output: z.object({ links: z.array(z.object({ url: z.string(), kind: z.enum(LINK_CARD_KINDS).nullable(), state: z.enum(LINK_STATES).nullable() })) }),
    tags: PRS,
  },
  skills: { input: z.object({ projectId: z.string().max(100).optional() }), output: z.object({ skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })) }) },
});
