import type { BoardCard, FeedRow, ProjectSummary, ProjectView, TicketDetail } from "../src/contract";
import type { ProjectMetrics } from "../src/metrics";
import { TICKET_STATES, type TicketState } from "../src/states";

export const NOW = Date.UTC(2026, 0, 10, 12);
export const HOUR = 3_600_000;

export const overview = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  slug: "csv",
  name: "CSV export",
  key: "CSV",
  state: "running",
  goal: "Let people export their orders as a CSV file from the admin page.",
  base: "main",
  strategy: "integration",
  branch: "loom/csv",
  approvedVersion: 1,
  pendingVersion: null,
  plannerThreadId: "thr_plan",
  sectionId: "sec_1",
  hostId: "host_1",
  reason: null,
  ticketCount: 4,
  ticketCounts: { queued: 2, working: 1, done: 1 },
  createdAt: NOW - 3 * 24 * HOUR,
  updatedAt: NOW - HOUR,
  ...over,
});

export const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  key: "CSV-1",
  title: "Order rows",
  state: "queued",
  stateAt: NOW - 2 * HOUR,
  priority: 2,
  attempt: 0,
  reviewRound: 0,
  deps: [],
  ready: true,
  waitingOn: [],
  threadId: null,
  prUrl: null,
  blockedReason: null,
  ...over,
});

export const metrics = (over: Partial<ProjectMetrics> = {}): ProjectMetrics => ({
  counts: { ...(Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>), queued: 2, working: 1, done: 1 },
  wip: 1,
  throughput: Array.from({ length: 14 }, (_, index) => ({ day: `2026-01-${String(index + 1).padStart(2, "0")}`, done: index === 12 ? 2 : index === 13 ? 1 : 0 })),
  cycleTime: { p50: 3 * HOUR + 12 * 60_000, p85: 5 * HOUR, n: 1 },
  leadTime: { p50: 26 * HOUR, p85: 26 * HOUR, n: 1 },
  wipAge: [{ key: "CSV-2", state: "working", ageMs: 5 * HOUR }],
  firstPassApproval: { rate: 0.5, n: 2 },
  reviewRounds: { mean: 1.5, n: 2 },
  checks: { total: 4, failed: 1 },
  blocks: 1,
  humanInterventions: 2,
  tokens: { total: 12_000, perDoneTicket: 12_000, byRole: { planner: 2000, worker: 8000, reviewer: 2000 } },
  cumulativeFlow: Array.from({ length: 14 }, (_, index) => ({
    day: `2026-01-${String(index + 1).padStart(2, "0")}`,
    ...(Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>),
    queued: 4 - Math.min(3, Math.floor(index / 4)),
    working: Math.min(1, Math.floor(index / 6)),
    done: Math.floor(index / 10),
  })),
  activeMs: 7 * HOUR,
  ...over,
});

export const projectView = (over: Partial<ProjectView> = {}): ProjectView => ({
  overview: overview(),
  board: [card(), card({ key: "CSV-2", title: "Export endpoint", state: "working", stateAt: NOW - 5 * HOUR, attempt: 1, ready: false, threadId: "thr_w1" })],
  metrics: metrics(),
  spec: { toml: '[project]\nslug = "csv"\n', version: 1, pendingVersion: null, pendingToml: null },
  prUrl: null,
  now: NOW,
  ...over,
});

export const ticketDetail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  slug: "csv",
  projectState: "running",
  key: "CSV-2",
  title: "Export endpoint",
  state: "working",
  stateAt: NOW - 5 * HOUR,
  priority: 2,
  attempt: 1,
  reviewRound: 0,
  deps: ["CSV-1"],
  blockedReason: null,
  branch: "loom/csv-2",
  prUrl: null,
  body: "Serve the file.",
  acceptance: ["WHEN the endpoint is called THE SYSTEM SHALL stream a CSV"],
  verify: [],
  scope: ["src/export/**"],
  posts: [{ id: 1, parentId: null, depth: 0, authorKind: "planner", authorThreadId: "thr_plan", kind: "brief", body: "Serve the file.", at: NOW - 6 * HOUR }],
  reviews: [],
  threads: [{ threadId: "thr_w1", role: "worker", state: "active", startedAt: NOW - 5 * HOUR, endedAt: null, endReason: null }],
  ...over,
});

export const feedRow = (over: Partial<FeedRow> = {}): FeedRow => ({ id: 1, at: NOW - HOUR, kind: "ticket.created", actor: "human", ticketKey: "CSV-1", text: "CSV-1 was created.", ...over });
