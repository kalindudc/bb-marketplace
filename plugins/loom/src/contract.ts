// The page's RPC contract and the types it carries. The app imports only types from this file, so zod stays out of its bundle.
import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ProjectHealth } from "./health";
import type { HomeProject, HomeView, NeedItem } from "./home";
import type { ProjectMetrics } from "./metrics";
import type { PlanningSession, ProjectOverview } from "./projects";
import type { Finding } from "./review";
import type { AuthorKind, PostKind, ProjectState, ReviewVerdict, Role, ThreadState, TicketState } from "./states";
import { MERGE_CHOICES } from "./states";

export type ProjectSummary = ProjectOverview;
export type { HomeProject, HomeView, NeedItem, PlanningSession, ProjectHealth };

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
  pendingToml: string | null;
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
  board: BoardCard[];
  metrics: ProjectMetrics;
  spec: SpecPanel;
  prUrl: string | null;
  /** Null until the project has an approved spec. */
  health: ProjectHealth | null;
  /** Live rows first, then the newest. */
  agents: AgentRow[];
  now: number;
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
  summary: string | null;
  findings: Finding[];
  at: number;
}

export interface ThreadDto {
  threadId: string | null;
  role: Role;
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
  slug: string;
  /** The ticket's key for a worker or reviewer; null for a planner. */
  key: string | null;
  /** The ticket's state for a worker or reviewer, the project's for a planner. */
  state: string;
}

export const TICKET_ACTIONS = ["requeue", "block", "cancel"] as const;
export const CONTROL_ACTIONS = ["approve", "start", "pause", "pauseNow", "resume", "land", "archive"] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

const slug = z.string().min(1).max(100);
const key = z.string().min(1).max(100);
// bb's RPC cannot tell the page from an agent that calls `bb plugin rpc`, so every change needs an explicit confirmation.
const confirm = z.literal(true);
const typed = <T>() => z.custom<T>();
// bb's spawn validates the rest of the composer's request.
const isComposerRequest = (value: unknown) => typeof value === "object" && value !== null && typeof (value as { projectId?: unknown }).projectId === "string" && Array.isArray((value as { input?: unknown }).input);

export const rpcContract = defineRpcContract({
  projects: { input: z.null(), output: typed<ProjectSummary[]>() },
  home: { input: z.null(), output: typed<HomeView>() },
  metrics: { input: z.object({ slug, days: z.union([z.literal(7), z.literal(14), z.literal(30)]) }).strict(), output: typed<ProjectMetrics>() },
  project: { input: z.object({ slug }).strict(), output: typed<ProjectView>() },
  ticket: { input: z.object({ key }).strict(), output: typed<TicketDetail>() },
  feed: { input: z.object({ slug, afterId: z.number().int().min(0).optional() }).strict(), output: typed<{ rows: FeedRow[]; lastId: number }>() },
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
  planning: { input: z.null(), output: typed<PlanningSession[]>() },
  planningSession: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: typed<PlanningSession | null>() },
  startPlanning: {
    input: z.object({ request: z.custom<NewThreadRequest>(isComposerRequest), merge: z.enum(MERGE_CHOICES), reviewer: z.string().max(200), confirm }).strict(),
    output: typed<{ threadId: string }>(),
  },
});
