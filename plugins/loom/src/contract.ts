// The page's RPC contract and the types it carries. The app imports only types from this file, so zod stays out of its bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ProjectMetrics } from "./metrics";
import type { ProjectOverview } from "./projects";
import type { Finding } from "./review";
import type { AuthorKind, PostKind, ProjectState, ReviewVerdict, Role, ThreadState, TicketState } from "./states";

export type ProjectSummary = ProjectOverview;

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

export interface SpecPanel {
  toml: string;
  version: number;
  pendingVersion: number | null;
  pendingToml: string | null;
}

export interface ProjectView {
  overview: ProjectOverview;
  board: BoardCard[];
  metrics: ProjectMetrics;
  spec: SpecPanel;
  prUrl: string | null;
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

export const rpcContract = defineRpcContract({
  projects: { input: z.null(), output: typed<ProjectSummary[]>() },
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
});
