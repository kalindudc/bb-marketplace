// The page's RPC contract and the types it carries. The app imports only types from this file, so zod stays out of its bundle.
import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ProjectHealth } from "./health";
import type { HomeProject, HomeView, NeedItem } from "./home";
import type { ActivityMark, Chip, CurrentItem, EventLine, InsightsFilter, InsightsNumbers, InsightsWindow, LineTone, Part, Phrase, ProjectInsights, StoryGroup, StoryItem } from "./insights";
import type { ProjectMetrics } from "./metrics";
import type { NextStep } from "./next-step";
import type { BbProjectChoice, PlanningSession, ProjectOverview, RepoOverview } from "./projects";
import { MAX_PLANNING_REPOS } from "./prompts";
import type { Finding } from "./review";
import type { Moment, MomentKind, ProjectTimeline, SessionBar, TicketBar } from "./replay";
import { repoSpecSchema } from "./spec";
import type { SpecReviewStatus } from "./spec-review";
import type { SentNote, SpecReviewRound, SpecVersionView } from "./spec-view";
import type { PlannerAction, PlannerStep, PlannerVersion, PlannerView, TurnStep, VersionChange } from "./planner-view";
import type { AskStep, PlannerAsk } from "./asks";
import type { ActivityItem, Attempt, ChecksItem, CheckStep, Mark, MergeItem, PrFeedbackItem, PrTextItem, ReviewItem, TicketActivity } from "./activity";
import type { ChangedFile, ChangeKind, ChangeRepo, ChangeSource, ChangesView, FilePatch } from "./changes";
import type { AuthorKind, PostKind, ProjectState, ReviewVerdict, Role, ThreadState, TicketState } from "./states";
import { MERGE_CHOICES } from "./states";

export type ProjectSummary = ProjectOverview;
export type { ActivityMark, Chip, CurrentItem, EventLine, InsightsFilter, InsightsNumbers, InsightsWindow, LineTone, Part, Phrase, ProjectInsights, StoryGroup, StoryItem };
export type { ChangedFile, ChangeKind, ChangeRepo, ChangeSource, ChangesView, FilePatch };
export type { SpecReviewRound };
export type { AskStep, PlannerAction, PlannerAsk, PlannerStep, PlannerVersion, PlannerView, TurnStep, VersionChange };
export type { ActivityItem, Attempt, BbProjectChoice, ChecksItem, CheckStep, PrFeedbackItem, PrTextItem, HomeProject, HomeView, Mark, MergeItem, Moment, MomentKind, NeedItem, NextStep, PlanningSession, ProjectHealth, ProjectTimeline, RepoOverview, ReviewItem, SentNote, SessionBar, SpecVersionView, TicketActivity, TicketBar };

export interface BoardCard {
  key: string;
  title: string;
  state: TicketState;
  stateAt: number;
  /** The ticket's [[repo]] name; null on a single-repo project. */
  repo: string | null;
  priority: number;
  attempt: number;
  reviewRound: number;
  deps: string[];
  /** Queued, with its dependencies done and no overlapping scope in flight or picked first: the next free worker takes it. */
  ready: boolean;
  /** Why a queued ticket that is not ready waits: unmet dependencies, then in-flight tickets whose scope overlaps it, then earlier picks whose scope overlaps it. */
  waitingOn: string[];
  /** The live worker or reviewer thread, if there is one. */
  threadId: string | null;
  prUrl: string | null;
  blockedReason: string | null;
  /** It has a commit, or a worker's worktree at work, for the Changes tab to show. */
  hasChanges: boolean;
  /** The open pull requests, by ticket key, whose commits this ticket's branch is built on. */
  stackedOn: string[];
  /** Why an approved ticket's pull request waits on its open dependencies, in a short sentence; null when it does not. */
  holding: string | null;
  /** A queued ticket whose worker, or a ticket in review whose reviewer, did not start and waits to try again; null otherwise. */
  startWait: StartWaitView | null;
}

export interface StartWaitView {
  role: "worker" | "reviewer";
  reason: string;
  /** When Loom tries again. */
  until: number;
  /** Failed starts in a row. */
  tries: number;
  /** The environment provider said it cannot start one now, so the wait counts no attempt. */
  unavailable: boolean;
}

/** What the draft card shows before a project has tickets on the board. */
export interface SpecSummary {
  tickets: Array<{ ref: string; title: string; dependsOn: string[] }>;
  /** The spec's [[repo]] tables; empty on a single-repo spec. `bbProjectName` is null when bb cannot tell. */
  repos: Array<{ name: string; bbProjectId: string; bbProjectName: string | null }>;
  checks: string[];
  /** "provider / model", or null when the spec sets neither. */
  reviewer: string | null;
  warnings: string[];
}

export interface SpecPanel {
  toml: string;
  version: number;
  pendingVersion: number | null;
  summary: SpecSummary;
}

/** One planner, worker or reviewer thread row of a project. */
export interface AgentRow {
  threadId: string | null;
  role: Role;
  ticketKey: string | null;
  ticketTitle: string | null;
  state: ThreadState;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  tokens: number | null;
  rateLimitRetries: number;
  reviewRound: number;
  /** The spec's "provider / model" for the role; null for a planner or when the spec sets neither. */
  model: string | null;
  /** When the engine ends a worker whose ticket is still being worked on; null otherwise. */
  timeoutAt: number | null;
}

export interface ProjectView {
  overview: ProjectOverview;
  /** Before approval, the draft's tickets with the keys approval will give them. */
  board: BoardCard[];
  /** The one thing to do next, for the bar over the tabs; null for an archived project. */
  next: NextStep | null;
  metrics: ProjectMetrics;
  spec: SpecPanel;
  prUrl: string | null;
  /** Null until the project has an approved spec. */
  health: ProjectHealth | null;
  /** Live rows first, then the newest. */
  agents: AgentRow[];
  now: number;
  /** The event the view was rewound to; null for the live view. */
  at: number | null;
  /** The automatic spec review of the draft or the pending version; null in a rewound view. */
  specReview: SpecReviewStatus | null;
  /** The steps the planner asked the human to take (loom_ask_human) that are not done yet; 0 in a rewound view. */
  openAsks: number;
}

export interface PostDto {
  id: number;
  parentId: number | null;
  depth: number;
  authorKind: AuthorKind;
  authorThreadId: string | null;
  kind: PostKind;
  body: string;
  at: number;
}

export interface ReviewDto {
  id: number;
  round: number;
  verdict: ReviewVerdict;
  /** The verdict in words, or why a pending review has none: "reviewer could not start", "ended without a verdict" or "pending". */
  status: string;
  summary: string | null;
  findings: Finding[];
  /** The reviewer's thread; null when it never started. */
  threadId: string | null;
  at: number;
}

export interface ThreadDto {
  threadId: string | null;
  role: Role;
  /** The worker's attempt; null for a reviewer and for rows from before Loom recorded it. */
  attempt: number | null;
  reviewRound: number;
  state: ThreadState;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
}

/** A ticket's pull request on the pr strategy, for the ticket page. */
export interface TicketPr {
  url: string | null;
  draft: boolean;
  forge: "gh" | "command" | "none";
  /** The remote branch Loom pushes to, and the commit it last pushed there; null before the first push. */
  branch: string | null;
  pushedSha: string | null;
  /** The commits Loom pushed: one, and one more per fix round with a change; null when the spec pushes the branch as it is. */
  commits: number | null;
  /** Every fix round so far, the human's included; `counted` is the rounds the pull request's feedback started since the last requeue, which `maxRounds` limits. */
  rounds: number;
  counted: number;
  maxRounds: number;
  /** Whether Loom reads the pull request's checks and reviews on this forge. */
  follows: boolean;
  /** The checks on the pull request's head when Loom last read them; null before the first read after a push. */
  checks: { passed: number; failed: number; pending: number; at: number } | null;
  /** When Loom reads the pull request next; null when it is not open. */
  nextCheckAt: number | null;
  /** Loom asked the worker for the pull request's text, or a fix round's commit message, at `since` and waits for it. */
  writing: { since: number; fix: boolean; until: number } | null;
}

export interface TicketDetail {
  slug: string;
  projectState: ProjectState;
  key: string;
  title: string;
  state: TicketState;
  stateAt: number;
  /** The ticket's [[repo]] name; null on a single-repo project. */
  repo: string | null;
  priority: number;
  attempt: number;
  reviewRound: number;
  deps: string[];
  /** The dependencies whose ticket is done. */
  depsDone: string[];
  blockedReason: string | null;
  startWait: StartWaitView | null;
  branch: string | null;
  prUrl: string | null;
  /** Null on the integration strategy. */
  pr: TicketPr | null;
  body: string;
  acceptance: string[];
  verify: string[];
  scope: string[];
  posts: PostDto[];
  reviews: ReviewDto[];
  threads: ThreadDto[];
  /** Who hears a reply now, by the rule Engine.humanPost delivers with. */
  replyTo: "worker" | "planner" | null;
  /** The state a blocked or cancelled ticket left; null otherwise. */
  stoppedFrom: TicketState | null;
  activity: TicketActivity;
  /** The event the ticket was rewound to, and the time it shows; `at` is null for the live ticket. */
  at: number | null;
  now: number;
}

export interface FeedRow {
  id: number;
  at: number;
  kind: string;
  actor: string;
  ticketKey: string | null;
  text: string;
}

export interface ThreadInfo {
  role: Role;
  /** null for a planning conversation that has not proposed a spec yet. */
  slug: string | null;
  /** The ticket's key for a worker or reviewer; null for a planner. */
  key: string | null;
  /** The ticket's state for a worker or reviewer, the project's for a planner, "planning" before a spec exists. */
  state: string;
}

export const TICKET_ACTIONS = ["requeue", "block", "cancel"] as const;
export const CONTROL_ACTIONS = ["approve", "start", "pause", "pauseNow", "resume", "land", "landDirect", "archive"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

const slug = z.string().min(1).max(100);
const key = z.string().min(1).max(100);
const eventId = z.number().int().min(1);
const commitHash = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "must be a full commit hash");
// bb's RPC cannot tell the page from an agent that calls `bb plugin rpc`, so every change needs an explicit confirmation.
const confirm = z.literal(true);
const typed = <T>() => z.custom<T>();
// bb's spawn validates the rest of the composer's request.
const isComposerRequest = (value: unknown) => typeof value === "object" && value !== null && typeof (value as { projectId?: unknown }).projectId === "string" && Array.isArray((value as { input?: unknown }).input);

export const rpcContract = defineRpcContract({
  projects: { input: z.null(), output: typed<ProjectSummary[]>() },
  home: { input: z.null(), output: typed<HomeView>() },
  project: { input: z.object({ slug, at: eventId.optional() }).strict(), output: typed<ProjectView>() },
  ticket: { input: z.object({ key, at: eventId.optional() }).strict(), output: typed<TicketDetail>() },
  runOutput: { input: z.object({ id: z.number().int().min(1) }).strict(), output: typed<{ output: string } | null>() },
  insights: {
    input: z.object({ slug, window: z.union([z.enum(["all", "run", "day"]), z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).strict()]).optional(), at: eventId.optional() }).strict(),
    output: typed<ProjectInsights>(),
  },
  timeline: { input: z.object({ slug }).strict(), output: typed<ProjectTimeline>() },
  threadInfo: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: typed<ThreadInfo | null>() },
  reply: {
    input: z.object({ key, body: z.string().min(1).max(20_000), parentId: z.number().int().min(1).optional(), confirm }).strict(),
    output: typed<TicketDetail>(),
  },
  ticketAction: {
    input: z.object({ key, action: z.enum(TICKET_ACTIONS), note: z.string().min(1).max(4000), confirm }).strict(),
    output: typed<TicketDetail>(),
  },
  control: {
    input: z.object({ slug, action: z.enum(CONTROL_ACTIONS), version: z.number().int().min(1).optional(), repo: z.string().min(1).max(100).optional(), confirm }).strict(),
    output: typed<ProjectView>(),
  },
  sendNotes: {
    input: z
      .object({
        slug,
        notes: z
          .array(
            z
              .object({
                version: z.number().int().min(1),
                paths: z.array(z.string().min(1).max(200)).min(1).max(10),
                body: z.string().trim().max(4000),
                suggest: z.object({ from: z.string().max(500), to: z.string().trim().min(1).max(500) }).strict().optional(),
              })
              .strict()
              .refine((note) => note.body !== "" || note.suggest !== undefined, "A note needs text or a suggested value."),
          )
          .min(1)
          .max(30),
        includeOlder: z.literal(true).optional(),
        confirm,
      })
      .strict(),
    output: typed<SpecVersionView>(),
  },
  planning: { input: z.null(), output: typed<PlanningSession[]>() },
  planningSession: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: typed<PlanningSession | null>() },
  plannerView: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: typed<PlannerView | null>() },
  messagePlanner: { input: z.object({ threadId: z.string().min(1).max(200), text: z.string().trim().min(1).max(20_000), confirm }).strict(), output: typed<PlannerView | null>() },
  dismissAsk: { input: z.object({ slug, ask: z.number().int().positive(), confirm }).strict(), output: typed<PlannerView | null>() },
  bbProjects: { input: z.null(), output: typed<BbProjectChoice[]>() },
  startPlanning: {
    input: z
      .object({
        request: z.custom<NewThreadRequest>(isComposerRequest),
        merge: z.enum(MERGE_CHOICES),
        reviewer: z.string().max(200),
        repos: z.array(z.string().min(1).max(100)).max(MAX_PLANNING_REPOS).optional(),
        confirm,
      })
      .strict(),
    output: typed<{ threadId: string }>(),
  },
  specVersion: { input: z.object({ slug, version: z.number().int().min(1).optional(), base: z.number().int().min(1).optional() }).strict(), output: typed<SpecVersionView>() },
  changes: { input: z.object({ slug }).strict(), output: typed<ChangesView>() },
  changePatch: {
    input: z.object({ slug, path: z.string().min(1).max(4096), base: commitHash.optional(), head: commitHash.optional(), key: key.optional(), repo: repoSpecSchema.shape.name.optional() }).strict(),
    output: typed<FilePatch>(),
  },
});
