// The page's RPC contract and the types it carries. The app imports only types from this file, so zod stays out of its bundle.
import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ProjectHealth } from "./health";
import type { HomeProject, HomeView, NeedItem } from "./home";
import type { ProjectMetrics } from "./metrics";
import type { NextStep } from "./next-step";
import type { PlanningSession, ProjectOverview } from "./projects";
import type { Finding } from "./review";
import type { ProjectTimeline, SessionBar, TicketBar } from "./replay";
import type { SentNote, SpecVersionView } from "./spec-view";
import type { ActivityItem, Attempt, ChecksItem, CheckStep, Mark, MergeItem, ReviewItem, TicketActivity } from "./activity";
import type { ChangedFile, ChangeKind, ChangeSource, ChangesView, FilePatch } from "./changes";
import type { AuthorKind, PostKind, ProjectState, ReviewVerdict, Role, ThreadState, TicketState } from "./states";
import { MERGE_CHOICES } from "./states";

export type ProjectSummary = ProjectOverview;
export type { ChangedFile, ChangeKind, ChangeSource, ChangesView, FilePatch };
export type { ActivityItem, Attempt, ChecksItem, CheckStep, HomeProject, HomeView, Mark, MergeItem, NeedItem, NextStep, PlanningSession, ProjectHealth, ProjectTimeline, ReviewItem, SentNote, SessionBar, SpecVersionView, TicketActivity, TicketBar };

export interface BoardCard {
  key: string;
  title: string;
  state: TicketState;
  stateAt: number;
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
}

/** What the draft card shows before a project has tickets on the board. */
export interface SpecSummary {
  tickets: Array<{ ref: string; title: string; dependsOn: string[] }>;
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

export interface TicketDetail {
  slug: string;
  projectState: ProjectState;
  key: string;
  title: string;
  state: TicketState;
  stateAt: number;
  priority: number;
  attempt: number;
  reviewRound: number;
  deps: string[];
  /** The dependencies whose ticket is done. */
  depsDone: string[];
  blockedReason: string | null;
  branch: string | null;
  prUrl: string | null;
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
  metrics: { input: z.object({ slug, days: z.union([z.literal(7), z.literal(14), z.literal(30)]), at: eventId.optional() }).strict(), output: typed<ProjectMetrics>() },
  project: { input: z.object({ slug, at: eventId.optional() }).strict(), output: typed<ProjectView>() },
  ticket: { input: z.object({ key, at: eventId.optional() }).strict(), output: typed<TicketDetail>() },
  runOutput: { input: z.object({ id: z.number().int().min(1) }).strict(), output: typed<{ output: string } | null>() },
  feed: { input: z.object({ slug, afterId: z.number().int().min(0).optional(), at: eventId.optional() }).strict(), output: typed<{ rows: FeedRow[]; lastId: number }>() },
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
    input: z.object({ slug, action: z.enum(CONTROL_ACTIONS), version: z.number().int().min(1).optional(), confirm }).strict(),
    output: typed<ProjectView>(),
  },
  sendNotes: {
    input: z
      .object({
        slug,
        notes: z
          .array(z.object({ version: z.number().int().min(1), paths: z.array(z.string().min(1).max(200)).min(1).max(10), body: z.string().trim().min(1).max(4000) }).strict())
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
  startPlanning: {
    input: z.object({ request: z.custom<NewThreadRequest>(isComposerRequest), merge: z.enum(MERGE_CHOICES), reviewer: z.string().max(200), confirm }).strict(),
    output: typed<{ threadId: string }>(),
  },
  specVersion: { input: z.object({ slug, version: z.number().int().min(1).optional() }).strict(), output: typed<SpecVersionView>() },
  changes: { input: z.object({ slug }).strict(), output: typed<ChangesView>() },
  changePatch: {
    input: z.object({ slug, path: z.string().min(1).max(4096), base: commitHash.optional(), head: commitHash.optional(), key: key.optional() }).strict(),
    output: typed<FilePatch>(),
  },
});
