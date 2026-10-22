import type { AgentRow, Attempt, BoardCard, FeedRow, HomeProject, HomeView, ProjectHealth, ProjectSummary, ProjectTimeline, ProjectView, RepoOverview, SpecVersionView, TicketDetail } from "../src/contract";
import type { ProjectMetrics } from "../src/metrics";
import { parseSpec } from "../src/spec";
import { TICKET_STATES, type TicketState } from "../src/states";
import { specToml, type Doc } from "./helpers";

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
  repos: [{ name: null, bbProjectId: "proj_1", bbProjectName: "shop", base: "main", branch: "loom/csv", prUrl: null, landedAt: null, toLand: true }],
  createdAt: NOW - 3 * 24 * HOUR,
  updatedAt: NOW - HOUR,
  ...over,
});

/** One repo of a multi-repo project's overview: web by default, with merged work to land. */
export const repoOverview = (over: Partial<RepoOverview> = {}): RepoOverview => ({ name: "web", bbProjectId: "proj_web", bbProjectName: "shop-web", base: "main", branch: "loom/csv", prUrl: null, landedAt: null, toLand: true, ...over });

/** The helpers' base spec over two repos: web (its own checks, after-merge checks and a protected path) holds csv-model, and api (another base and remote, bb's name for it unknown) holds csv-export. */
export function withRepos(doc: Doc): void {
  doc.scope = { protected: ["db/**"] };
  doc.repo = [
    { name: "web", project: "proj_web", checks: ["npm run web-test"], after_merge: ["npm run web-e2e"], protected: ["web.lock"] },
    { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
  ];
  doc.ticket[0].repo = "web";
  doc.ticket[1].repo = "api";
}

export const homeProject = (over: Partial<HomeProject> = {}): HomeProject => ({
  ...overview(),
  progress: { done: 1, total: 4, inFlight: 1, blocked: 0 },
  agents: 3,
  throughput: [0, 0, 1, 2, 1, 0, 1, 2, 0, 1, 1, 0, 2, 1],
  tokens: 12_000,
  maxTokens: 50_000,
  lastEventAt: NOW - 2 * 60_000,
  ...over,
});

export const homeView = (over: Partial<HomeView> = {}): HomeView => ({
  totals: { projects: 4, running: 2, paused: 1, workers: 3, reviewers: 2, planners: 1, slots: 8, doneLast7: 14, doneByDay: [0, 1, 2, 1, 3, 0, 2, 4, 1, 2, 3, 2, 4, 3], tokens: 3_100_000, perDoneTicket: 220_000 },
  needsYou: [
    { kind: "blocked", slug: "csv", project: "CSV export", key: "CSV-7", text: "needs the staging DB credentials", at: NOW - 5 * 60_000 },
    { kind: "approve", slug: "audit", project: "Audit log", key: null, text: "has a draft spec v1 with 9 tickets", at: NOW - 12 * 60_000 },
    { kind: "land", slug: "srch", project: "Search revamp", key: null, text: "finished all 12 tickets; land the integration branch", at: NOW - HOUR },
    { kind: "paused", slug: "bill", project: "Billing API", key: null, text: "The token budget is used up: 900 of 900 tokens.", at: NOW - 3 * HOUR },
  ],
  projects: [homeProject()],
  now: NOW,
  ...over,
});

export const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  key: "CSV-1",
  title: "Order rows",
  state: "queued",
  stateAt: NOW - 2 * HOUR,
  repo: null,
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
  tokens: { total: 12_000, perDoneTicket: 12_000, byRole: { planner: 2000, worker: 8000, reviewer: 2000 }, unreported: 0 },
  cumulativeFlow: Array.from({ length: 14 }, (_, index) => ({
    day: `2026-01-${String(index + 1).padStart(2, "0")}`,
    ...(Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>),
    queued: 4 - Math.min(3, Math.floor(index / 4)),
    working: Math.min(1, Math.floor(index / 6)),
    done: Math.floor(index / 10),
  })),
  activeMs: 7 * HOUR,
  timeInState: { ms: { ...(Object.fromEntries(TICKET_STATES.map((state) => [state, 0])) as Record<TicketState, number>), queued: 2 * HOUR, working: 4 * HOUR, checking: HOUR, review: 3 * HOUR }, flowEfficiency: 0.4, n: 1 },
  checksByCommand: [
    { command: "npm test", runs: 3, failed: 1, p50Ms: 100_000 },
    { command: "npm run lint", runs: 1, failed: 0, p50Ms: 12_000 },
  ],
  scopeFlags: { outside: 1, protectedHits: 0 },
  findings: { total: 3, blocking: 1, shouldFix: 2, rounds: 3, changesRequested: 1 },
  tokensByTicket: [
    { key: "CSV-2", tokens: 6000 },
    { key: "CSV-1", tokens: 2000 },
  ],
  reliability: { failedAttempts: 1, rateLimitRetries: 2, timeouts: 1, mergesSentBack: 1 },
  ...over,
});

export const health = (over: Partial<ProjectHealth> = {}): ProjectHealth => ({
  progress: { done: 8, total: 14, inFlight: 3, blocked: 1, queued: 2 },
  pace: { perDay: 0.5, remaining: 6, etaDays: 12 },
  budget: { used: 12_000, max: 50_000 },
  deadline: { date: "2026-01-15", daysLeft: 6 },
  capacity: { workers: 1, maxWorkers: 2, reviewers: 1, maxReviewers: 2, readyWaiting: 1 },
  ...over,
});

export const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  threadId: "thr_w1",
  role: "worker",
  ticketKey: "CSV-2",
  ticketTitle: "Export endpoint",
  state: "active",
  startedAt: NOW - 5 * HOUR,
  endedAt: null,
  endReason: null,
  tokens: 6000,
  rateLimitRetries: 1,
  reviewRound: 0,
  model: "claude / sonnet",
  timeoutAt: NOW + HOUR,
  ...over,
});

export const projectView = (over: Partial<ProjectView> = {}): ProjectView => ({
  overview: overview(),
  board: [card(), card({ key: "CSV-2", title: "Export endpoint", state: "working", stateAt: NOW - 5 * HOUR, attempt: 1, ready: false, threadId: "thr_w1" })],
  metrics: metrics(),
  spec: {
    toml: '[project]\nslug = "csv"\n',
    version: 1,
    pendingVersion: null,
    summary: {
      tickets: [
        { ref: "csv-model", title: "Order rows", dependsOn: [] },
        { ref: "csv-export", title: "Export endpoint", dependsOn: ["csv-model"] },
      ],
      repos: [],
      checks: ["npm test"],
      reviewer: "codex / gpt-5",
      warnings: ["ticket[0] and ticket[1] have overlapping scope and no dependency between them, so they will run one at a time."],
    },
  },
  prUrl: null,
  next: { stage: 4, tone: "normal", title: "Running.", text: "1 worker is on CSV-2.", action: null },
  health: health(),
  agents: [agent()],
  now: NOW,
  at: null,
  ...over,
});

export const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  n: 1,
  claimPostId: 2,
  threadId: "thr_w1",
  startedAt: NOW - 5 * HOUR,
  endedAt: null,
  outcome: "in_progress",
  line: null,
  pipeline: { work: "running", checks: [], review: [], merge: [] },
  items: [],
  ...over,
});

export const ticketDetail = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  slug: "csv",
  projectState: "running",
  key: "CSV-2",
  title: "Export endpoint",
  state: "working",
  stateAt: NOW - 5 * HOUR,
  repo: null,
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
  threads: [{ threadId: "thr_w1", role: "worker", attempt: 1, reviewRound: 0, state: "active", startedAt: NOW - 5 * HOUR, endedAt: null, endReason: null }],
  depsDone: [],
  replyTo: "worker",
  stoppedFrom: null,
  activity: { brief: { postId: 1, at: NOW - 6 * HOUR, edits: 0, fields: [] }, before: [], attempts: [attempt()] },
  at: null,
  now: NOW,
  ...over,
});

/** v2, a draft, of the helpers' base spec, changed from v1 in one criterion and one check. */
export const specVersionView = (over: Partial<SpecVersionView> = {}, edit?: (doc: Doc) => void): SpecVersionView => ({
  slug: "csv",
  version: 2,
  status: "draft",
  toml: specToml(edit),
  spec: parseSpec(specToml(edit)).spec!,
  overlaps: [],
  warnings: [],
  changes: { changed: ["ticket[csv-export].acceptance[1]", "checks.commands[0]"], removed: [] },
  versions: [
    { version: 1, status: "superseded" },
    { version: 2, status: "draft" },
  ],
  notes: [],
  ...over,
});

export const feedRow = (over: Partial<FeedRow> = {}): FeedRow => ({ id: 1, at: NOW - HOUR, kind: "ticket.created", actor: "human", ticketKey: "CSV-1", text: "CSV-1 was created.", ...over });

const MINUTE = 60_000;

/** Three events five minutes apart, two overlapping ticket bars (CSV-2 in trouble), one worker session and the human's start. */
export const timeline = (over: Partial<ProjectTimeline> = {}): ProjectTimeline => ({
  start: NOW - 20 * MINUTE,
  end: NOW,
  events: [
    [11, NOW - 20 * MINUTE],
    [12, NOW - 15 * MINUTE],
    [13, NOW - 10 * MINUTE],
  ],
  project: [
    { from: NOW - 20 * MINUTE, to: NOW - 15 * MINUTE, state: "ready" },
    { from: NOW - 15 * MINUTE, to: NOW, state: "running" },
  ],
  flow: [
    { at: NOW - 20 * MINUTE, counts: { queued: 2 } },
    { at: NOW - 15 * MINUTE, counts: { queued: 1, working: 1 } },
    { at: NOW - 10 * MINUTE, counts: { working: 1, review: 1 } },
  ],
  tickets: [
    { key: "CSV-1", title: "Order rows", from: NOW - 15 * MINUTE, to: NOW, parts: [{ from: NOW - 15 * MINUTE, to: NOW - 10 * MINUTE, state: "working" }, { from: NOW - 10 * MINUTE, to: NOW, state: "review" }] },
    { key: "CSV-2", title: "Export endpoint", from: NOW - 10 * MINUTE, to: NOW, parts: [{ from: NOW - 10 * MINUTE, to: NOW, state: "working" }] },
  ],
  sessions: [{ key: "CSV-1", role: "worker", label: "attempt 1", from: NOW - 15 * MINUTE, to: NOW, endReason: null }],
  marks: [{ id: 12, at: NOW - 15 * MINUTE, action: "start", key: null }],
  trouble: ["CSV-2"],
  ...over,
});
