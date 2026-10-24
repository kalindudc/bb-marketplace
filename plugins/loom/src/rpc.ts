// The page's server side: reads over the store and changes through the same engine methods the CLI calls.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { humanAction } from "./cli";
import { rpcContract, type AgentRow, type BoardCard, type ProjectView, type SpecSummary, type ThreadInfo, type TicketDetail, type TicketPr } from "./contract";
import type { EventRow, PostRow, ProjectRow, ReviewRow, Store, ThreadRow, TicketRow } from "./db/store";
import { stripAnsi, ticketActivity } from "./activity";
import { Changes } from "./changes";
import { replyRecipient, type Engine } from "./engine";
import { projectHealth } from "./health";
import { homeView } from "./home";
import { projectInsights } from "./insights";
import { POLL_MS } from "./merge";
import { askOf, forgeRoundsSinceRequeue, PR_TEXT_MINUTES, prTextFor, statusOf } from "./pull-requests";
import { followsFeedback, prSettings, repoSettings } from "./repos";
import { computeMetrics } from "./metrics";
import { nextStepOf } from "./next-step";
import { LoomError, landsOf, namedRepos, repoOverviews, withRepoNames, type Projects } from "./projects";
import { overviewAt, projectTimeline, rewind, rowsOf } from "./replay";
import { projectMetrics } from "./reports";
import { blockedAtReview } from "./review";
import { IN_FLIGHT, kinship, overlaps, readyTickets, startable, toLite, type TicketLite } from "./scheduler";
import { holdOf, stacking, stackOf, upstreamOf } from "./stack";
import { parseSpec, type Spec } from "./spec";
import { specReviewStatus } from "./spec-review";
import { dismissAsk, plannerAsk } from "./asks";
import { plannerView } from "./planner-view";
import { specVersionView } from "./spec-view";
import { HUMAN_ACTOR, type TicketState } from "./states";
import { blockedAtStart, specOf } from "./workers";

export const CHANGED_CHANNEL = "loom:changed";
const THROTTLE_MS = 300;

export interface RpcDeps {
  projects: Projects;
  engine: Engine;
  store: Store;
  now: () => number;
}

/** Publishes `loom:changed` with the project's slug after each committed event or `store.changed` call, at most once per project every 300 ms; a call inside a window goes out when the window ends. A change outside any project publishes `{ slug: null }`, throttled the same way. This is the only thing that publishes to the page. Returns the stop function. */
export function watchChanges(bb: BbPluginApi, store: Store): () => void {
  const timers = new Map<number | null, ReturnType<typeof setTimeout>>();
  store.setOnEvent((projectId) => {
    if (timers.has(projectId)) return;
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const slug = projectId === null ? null : store.project(projectId)?.slug;
        if (slug !== undefined) bb.realtime.publish(CHANGED_CHANNEL, { slug });
      }, THROTTLE_MS),
    );
  });
  return () => {
    store.setOnEvent(null);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}

/** The draft card's view of a stored spec. A stored spec always parses; if one ever does not, its errors come back as warnings. */
export function specSummary(toml: string): SpecSummary {
  const { spec, errors, warnings } = parseSpec(toml);
  if (spec === null) return { tickets: [], repos: [], checks: [], reviewer: null, warnings: [...errors, ...warnings] };
  return {
    tickets: spec.ticket.map((ticket) => ({ ref: ticket.ref, title: ticket.title, dependsOn: ticket.depends_on })),
    repos: (spec.repo ?? []).map((repo) => ({ name: repo.name, bbProjectId: repo.project, bbProjectName: null })),
    checks: spec.checks.commands,
    reviewer: modelLabel(spec.agents.reviewer),
    warnings,
  };
}

/** "provider / model" with only the parts that are set, or null when neither is. */
const modelLabel = ({ provider, model }: { provider?: string; model?: string }) => [provider, model].filter((part) => part !== undefined).join(" / ") || null;

/** Every thread row of a project: spawning, active and ending rows first, then the newest. A worker shows when it times out only while its ticket is being worked on, as the engine's timeout rule reads. */
export function agentRows(threads: ThreadRow[], tickets: TicketRow[], spec: Spec | null): AgentRow[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const live = (row: ThreadRow) => Number(row.state !== "ended");
  return [...threads]
    .sort((a, b) => live(b) - live(a) || b.started_at - a.started_at || b.id - a.id)
    .map((row) => {
      const ticket = row.ticket_id === null ? null : (byId.get(row.ticket_id) ?? null);
      const timing = spec !== null && row.role === "worker" && row.state === "active" && row.clock_at !== null && ticket?.state === "working" && ticket.worker_thread_id === row.thread_id;
      return {
        threadId: row.thread_id,
        role: row.role,
        ticketKey: ticket?.key ?? null,
        ticketTitle: ticket?.title ?? null,
        state: row.state,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        endReason: row.end_reason,
        tokens: row.tokens,
        rateLimitRetries: row.rate_limit_retries,
        reviewRound: row.review_round,
        model: spec === null || row.role === "planner" ? null : modelLabel(spec.agents[row.role]),
        timeoutAt: timing ? row.clock_at! + spec.agents.ticket_timeout_minutes * 60_000 : null,
      };
    });
}

/** A review's verdict in words, or why a pending one has none: its reviewer never started, or ended without one. */
function reviewStatus(review: ReviewRow, reviewer: ThreadRow | null): string {
  if (review.verdict !== "pending") return review.verdict.replace("_", " ");
  if (reviewer?.state !== "ended") return "pending";
  return reviewer.thread_id === null ? "reviewer could not start" : "ended without a verdict";
}

/** The state a blocked or cancelled ticket was in when it stopped: the `from` of its last state event; null for any other state. `moves` are the ticket's `ticket.state` events. */
function stoppedFrom(ticket: TicketRow, moves: EventRow[]): TicketState | null {
  if (ticket.state !== "blocked" && ticket.state !== "cancelled") return null;
  const last = moves.at(-1);
  return last === undefined ? null : (JSON.parse(last.data_json) as { from: TicketState }).from;
}

/** Whether a ticket is ready and, when it waits, on what. */
function queueOf(lites: TicketLite[], stack = false): (lite: TicketLite) => { ready: boolean; waitingOn: string[] } {
  const ready = readyTickets(lites, stack);
  const readyIds = new Set(ready.map((lite) => lite.id));
  const done = startable(lites, stack);
  const kin = stack ? kinship(lites) : () => false;
  return (lite) => {
    const waiting = lite.state === "queued" && !readyIds.has(lite.id);
    const waitingOn = waiting
      ? [
          ...lite.deps.filter((key) => !done.has(key)),
          ...lites.filter((other) => IN_FLIGHT.includes(other.state) && other.repo === lite.repo && !kin(other, lite) && overlaps(other.scope, lite.scope)).map((other) => other.key),
          ...ready.filter((other) => (other.priority - lite.priority || other.seq - lite.seq) < 0 && overlaps(other.scope, lite.scope)).map((other) => other.key),
        ]
      : [];
    return { ready: readyIds.has(lite.id), waitingOn: [...new Set(waitingOn)] };
  };
}

/** One card per ticket. A queued ticket that is not ready says why, from a single readyTickets pass; `spec` says whether the project stacks. */
export function boardCards(tickets: TicketRow[], threads: ThreadRow[], spec: Spec | null = null): BoardCard[] {
  const lites = tickets.map(toLite);
  const stack = spec !== null && stacking(spec);
  const queue = queueOf(lites, stack);
  return tickets.map((ticket, index) => {
    const lite = lites[index]!;
    const live = threads.filter((row) => row.ticket_id === ticket.id && row.state === "active" && row.thread_id !== null).sort((a, b) => Number(b.role === "worker") - Number(a.role === "worker"));
    return {
      key: ticket.key,
      title: ticket.title,
      state: ticket.state,
      stateAt: ticket.state_at,
      repo: ticket.repo,
      priority: ticket.priority,
      attempt: ticket.attempt,
      reviewRound: ticket.review_round,
      deps: lite.deps,
      ...queue(lite),
      threadId: live[0]?.thread_id ?? null,
      prUrl: ticket.pr_url,
      blockedReason: ticket.blocked_reason,
      hasChanges: ticket.head_sha !== null || ((ticket.state === "working" || ticket.state === "checking") && ticket.environment_id !== null),
      ...stackFacts(tickets, ticket, stack),
    };
  });
}

function stackFacts(tickets: TicketRow[], ticket: TicketRow, stack: boolean): Pick<BoardCard, "stackedOn" | "holding"> {
  if (!stack || ticket.state === "done" || ticket.state === "cancelled") return { stackedOn: [], holding: null };
  const open = new Set(upstreamOf(tickets, ticket).open.map((dep) => dep.key));
  const stackedOn = Object.keys(stackOf(ticket)?.deps ?? {}).filter((key) => open.has(key));
  const hold = ticket.state === "approved" ? holdOf(tickets, ticket) : null;
  const holding = hold === null ? null : hold.why === "merge" ? `Its pull request opens once all but one of ${hold.keys.join(", ")} merge` : hold.why === "push" ? `Its pull request opens once ${hold.keys[0]} has one` : `Its pull request opens once ${hold.keys[0]} takes the base branch`;
  return { stackedOn, holding };
}

/** A draft's tickets as queued cards, keyed as approval will key them, so the Board shows what approving creates. */
export function draftCards(spec: Spec, at: number): BoardCard[] {
  const keyOf = new Map(spec.ticket.map((ticket, index) => [ticket.ref, `${spec.project.key}-${index + 1}`]));
  const lites: TicketLite[] = spec.ticket.map((ticket, index) => ({
    id: index + 1,
    key: keyOf.get(ticket.ref)!,
    state: "queued",
    priority: ticket.priority,
    seq: index + 1,
    deps: ticket.depends_on.map((ref) => keyOf.get(ref)!),
    pushed: false,
    scope: ticket.scope,
    repo: ticket.repo ?? null,
  }));
  const queue = queueOf(lites);
  return lites.map((lite, index) => ({
    key: lite.key,
    title: spec.ticket[index]!.title,
    state: "queued",
    stateAt: at,
    repo: lite.repo,
    priority: lite.priority,
    attempt: 0,
    reviewRound: 0,
    deps: lite.deps,
    ...queue(lite),
    threadId: null,
    prUrl: null,
    blockedReason: null,
    hasChanges: false,
    stackedOn: [],
    holding: null,
  }));
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const { projects, engine, store, now } = deps;
  const changes = new Changes({ store, bb: engine.ctx.bb, host: engine.ctx.host });

  /** With `eventId`, the project as it was at that event; it never writes. */
  const projectView = async (slug: string, eventId?: number): Promise<ProjectView> => {
    // Every read after the names comes in one synchronous pass, so the view is of one moment.
    const names = await projects.bbProjectNames();
    const live = projects.require(slug);
    const past = eventId === undefined ? null : rewind(rowsOf(store, live), eventId);
    const spec = projects.spec(slug, past?.specVersion);
    const inForce = JSON.parse(store.specVersion(live.id, spec.version)!.spec_json) as Spec;
    const overview = withRepoNames(
      past === null ? projects.overview(slug) : { ...projects.overview(slug), ...overviewAt(past, inForce), repos: repoOverviews(past.project, inForce, past.tickets, landsOf(past.events)) },
      names,
    );
    const project = past?.project ?? live;
    const tickets = past?.tickets ?? store.tickets(project.id);
    const threads = past?.threads ?? store.threadsForProject(project.id);
    const at = past?.at ?? now();
    const metrics = past === null ? projectMetrics(store, project, at) : computeMetrics({ ...past, now: at });
    const approved = project.approved_version === null ? null : specOf(store, project);
    const current = approved ?? inForce;
    const board = project.state === "draft" ? draftCards(current, at) : boardCards(tickets, threads, current);
    const summary = specSummary(spec.toml);
    const specReview = past === null ? specReviewStatus(store, project) : null;
    return {
      overview,
      board,
      metrics,
      spec: {
        toml: spec.toml,
        version: spec.version,
        summary: { ...summary, repos: namedRepos(summary.repos, names) },
        pendingVersion: project.pending_version,
      },
      prUrl: project.pr_url,
      next: nextStepOf({
        overview,
        board,
        version: spec.version,
        maxWorkers: current.agents.max_workers,
        triage: current.agents.triage,
        startFailed: past === null ? tickets.filter((ticket) => blockedAtStart(store, ticket)).map((ticket) => ticket.key) : [],
        reviewRefused: tickets.filter(blockedAtReview).map((ticket) => ticket.key),
        ...(specReview === null ? {} : { specReview }),
      }),
      health: approved === null ? null : projectHealth({ tickets, threads, metrics, spec: approved, now: at }),
      agents: agentRows(threads, tickets, approved),
      now: at,
      at: past?.eventId ?? null,
      specReview,
      openAsks: past === null && project.state !== "archived" ? (plannerAsk(store, project)?.steps.filter((step) => !step.done).length ?? 0) : 0,
    };
  };

  /** The ticket's pull request on the pr strategy; a rewound view leaves out what Loom read and asked since. */
  const ticketPr = (project: ProjectRow, ticket: TicketRow, posts: readonly PostRow[], live: boolean): TicketPr | null => {
    const spec = specOf(store, project);
    if (spec.merge.strategy !== "pr") return null;
    const settings = prSettings(spec);
    const forge = repoSettings(spec, ticket.repo).forge;
    const merges = posts.filter((post) => post.kind === "merge").map((post) => JSON.parse(post.data_json) as { outcome?: string; sha?: string; overLimit?: boolean });
    const outcomes = merges.map((data) => data.outcome);
    // A requeue after a closed pull request opens a new one, whose commits start again at its own first push.
    const opened = Math.max(outcomes.lastIndexOf("pr_opened"), outcomes.lastIndexOf("branch_pushed"));
    const first = opened >= 0 ? 1 : 0;
    // A rewound view has the live row's pull request columns, so it reads what was pushed by then from the posts it kept.
    const pushedSha = live ? ticket.pushed_sha : (merges.filter((data) => data.sha !== undefined && ["pr_opened", "pr_pushed", "pr_unchanged", "branch_pushed"].includes(data.outcome ?? "")).at(-1)?.sha ?? null);
    const feedback = merges.slice(Math.max(0, opened)).filter((data) => data.outcome === "pr_feedback" && data.overLimit !== true) as Array<{ human?: boolean; counted?: number | null }>;
    const rounds = live ? ticket.pr_rounds : feedback.length;
    const counted = live ? forgeRoundsSinceRequeue(store, ticket.id) : (feedback.filter((data) => data.human !== true).at(-1)?.counted ?? 0);
    const status = live ? statusOf(ticket) : null;
    const ask = live ? askOf(ticket) : null;
    const asked = ask !== null && ticket.state === "approved" && ask.head === ticket.head_sha && prTextFor(spec, ticket) === null;
    return {
      url: ticket.pr_url,
      draft: spec.merge.draft,
      forge: forge.kind,
      branch: pushedSha === null ? null : ticket.pr_branch,
      pushedSha,
      commits: settings.squash && pushedSha !== null ? first + outcomes.slice(Math.max(0, opened)).filter((outcome) => outcome === "pr_pushed").length : null,
      rounds,
      counted,
      maxRounds: settings.maxFixRounds,
      follows: settings.maxFixRounds > 0 && followsFeedback(forge),
      checks: status === null || status.head === null ? null : { passed: status.passed, failed: status.failed, pending: status.pending, at: status.at },
      nextCheckAt: live && ticket.state === "pr_open" && ticket.pr_checked_at !== null ? ticket.pr_checked_at + POLL_MS : null,
      writing: asked ? { since: ask.at, fix: ask.fix, until: ask.at + PR_TEXT_MINUTES * 60_000 } : null,
    };
  };

  /** With `eventId`, the ticket as it was at that event: no reply goes anywhere from there. */
  const ticketDetail = (key: string, eventId?: number): TicketDetail => {
    const view = projects.ticketView(key);
    const live = store.ticketByKey(key)!;
    const liveProject = store.project(live.project_id)!;
    const past = eventId === undefined ? null : rewind(rowsOf(store, liveProject), eventId);
    const ticket = past === null ? live : past.tickets.find((row) => row.id === live.id);
    if (ticket === undefined) throw new LoomError("loom_not_found", `${key} did not exist yet at that moment.`);
    const project = past?.project ?? liveProject;
    const own = <T extends { ticket_id: number | null }>(rows: T[]) => rows.filter((row) => row.ticket_id === ticket.id);
    const threads = past === null ? store.threadsForTicket(ticket.id) : own(past.threads);
    const posts = past === null ? store.posts(ticket.id) : own(past.posts);
    const runs = past === null ? store.runs(ticket.id) : own(past.runs);
    const reviews = past === null ? store.reviews(ticket.id) : own(past.reviews);
    const moves = past === null ? store.ticketEvents(ticket.id, ["ticket.state"]) : own(past.events).filter((event) => event.kind === "ticket.state");
    const kept = new Set(posts.map((post) => post.id));
    const deps = JSON.parse(ticket.deps_json) as string[];
    const stateOf = (dep: string) => (past === null ? store.ticketByKey(dep) : past.tickets.find((row) => row.key === dep))?.state;
    return {
      slug: project.slug,
      projectState: project.state,
      key: ticket.key,
      title: ticket.title,
      state: ticket.state,
      stateAt: ticket.state_at,
      repo: ticket.repo,
      priority: ticket.priority,
      attempt: ticket.attempt,
      reviewRound: ticket.review_round,
      deps,
      depsDone: deps.filter((dep) => stateOf(dep) === "done"),
      blockedReason: ticket.blocked_reason,
      branch: ticket.branch,
      prUrl: ticket.pr_url,
      pr: ticketPr(project, ticket, posts, past === null),
      body: ticket.body,
      acceptance: JSON.parse(ticket.acceptance_json) as string[],
      verify: JSON.parse(ticket.verify_json) as string[],
      scope: JSON.parse(ticket.scope_json) as string[],
      posts: view.posts.filter((post) => kept.has(post.id)).map((post) => ({ id: post.id, parentId: post.parent_id, depth: post.depth, authorKind: post.author_kind, authorThreadId: post.author_thread_id, kind: post.kind, body: post.body, at: post.at })),
      reviews: reviews.map((review) => ({
        id: review.id,
        round: review.round,
        verdict: review.verdict,
        status: reviewStatus(review, threads.find((row) => row.id === review.thread_row_id) ?? null),
        threadId: threads.find((row) => row.id === review.thread_row_id)?.thread_id ?? null,
        summary: review.summary,
        findings: JSON.parse(review.findings_json),
        at: review.at,
      })),
      threads: threads.map((row) => ({ threadId: row.thread_id, role: row.role, attempt: row.attempt, reviewRound: row.review_round, state: row.state, startedAt: row.started_at, endedAt: row.ended_at, endReason: row.end_reason })),
      replyTo: past === null ? (replyRecipient(store, ticket)?.role ?? null) : null,
      stoppedFrom: stoppedFrom(ticket, moves),
      activity: ticketActivity({ state: ticket.state, posts, threads, runs }),
      at: past?.eventId ?? null,
      now: past?.at ?? now(),
    };
  };

  // Every change is the human's: it runs through humanAction, which writes the human.action event (none for a change outside any project), and refuses any other plugin.
  const act = <T>(ctx: { experimental_caller: { kind: string } }, action: string, data: { slug?: string; key?: string; [extra: string]: unknown }, fn: () => Promise<T> | T): Promise<T> => {
    if (ctx.experimental_caller.kind === "plugin") throw new Error("Loom's controls are for the human: another plugin cannot call them.");
    return humanAction({ projects, store }, {}, action, data, fn);
  };

  bb.rpc.register(rpcContract, {
    projects: () => projects.namedList(),
    home: async () => {
      const names = await projects.bbProjectNames();
      const view = homeView({ store, projects, now: now() });
      return { ...view, projects: view.projects.map((row) => withRepoNames(row, names)) };
    },
    project: ({ slug, at }) => projectView(slug, at),
    ticket: ({ key, at }) => ticketDetail(key, at),
    runOutput: ({ id }) => {
      const output = store.runOutput(id);
      return output === null ? null : { output: stripAnsi(output) };
    },
    insights: ({ slug, window, at }) => {
      // One synchronous pass over the store, so the view is of one moment.
      const live = projects.require(slug);
      const rows = rowsOf(store, live);
      const past = at === undefined ? null : rewind(rows, at);
      const project = past?.project ?? live;
      const spec = project.approved_version === null ? (JSON.parse(store.specVersion(live.id, projects.spec(slug, past?.specVersion).version)!.spec_json) as Spec) : specOf(store, project);
      return projectInsights(past ?? rows, { now: past?.at ?? now(), window, strategy: spec.merge.strategy, maxWorkers: spec.agents.max_workers, maxTokens: spec.budget.max_tokens ?? null });
    },
    timeline: ({ slug }) => projectTimeline(rowsOf(store, projects.require(slug)), now()),
    planning: () => projects.planningSessions(),
    planningSession: ({ threadId }) => projects.planningSession(threadId),
    plannerView: ({ threadId }) => plannerView({ store, projects }, threadId, now()),
    messagePlanner: async ({ threadId, text }, ctx) => {
      await act(ctx, "message", {}, () => engine.messagePlanner(threadId, text));
      return plannerView({ store, projects }, threadId, now());
    },
    dismissAsk: async ({ slug, ask }, ctx) => {
      const project = projects.require(slug);
      await act(ctx, "dismissAsk", { slug, ask }, () => dismissAsk(store, project, ask));
      return project.planner_thread_id === null ? null : plannerView({ store, projects }, project.planner_thread_id, now());
    },
    specVersion: ({ slug, version, base }) => specVersionView({ store, projects }, slug, version, base),
    bbProjects: () => projects.bbProjectChoices(),
    changes: ({ slug }) => changes.view(slug),
    changePatch: (input) => changes.patch(input),
    startPlanning: ({ request, merge, reviewer, repos }, ctx) => act(ctx, "plan", {}, () => projects.startPlanning({ request, merge, reviewer, repos: repos ?? [] })),
    sendNotes: async ({ slug, notes, includeOlder }, ctx) => {
      await act(ctx, "notes", { slug, notes }, () => projects.sendNotes(slug, notes, includeOlder === true));
      return specVersionView({ store, projects }, slug);
    },
    threadInfo: ({ threadId }): ThreadInfo | null => {
      const row = store.threadByThreadId(threadId);
      const project = row === null ? null : store.project(row.project_id);
      if (row === null || project === null) return store.planning(threadId)?.ended_at === null ? { role: "planner", slug: null, key: null, state: "planning" } : null;
      if (row.role === "planner") return { role: "planner", slug: project.slug, key: null, state: project.state };
      const ticket = row.ticket_id === null ? null : store.ticket(row.ticket_id);
      return ticket === null ? null : { role: row.role, slug: project.slug, key: ticket.key, state: ticket.state };
    },
    reply: async ({ key, body, parentId }, ctx) => {
      await act(ctx, "post", { key }, () => engine.humanPost(key, body, parentId));
      return ticketDetail(key);
    },
    ticketAction: async ({ key, action, note }, ctx) => {
      await act(ctx, action, { key }, () => {
        if (action === "requeue") return engine.requeue(key, note, HUMAN_ACTOR);
        if (action === "block") return engine.block(key, note, HUMAN_ACTOR);
        return engine.cancel(key, note, HUMAN_ACTOR);
      });
      return ticketDetail(key);
    },
    control: async ({ slug, action, version, repo }, ctx) => {
      if (repo !== undefined && action !== "land" && action !== "landDirect") throw new LoomError("loom_invalid_input", `A repo goes only with land and landDirect, not with ${action}.`);
      const which = repo === undefined ? {} : { repo };
      switch (action) {
        case "approve": {
          const project = projects.require(slug);
          const pending = project.state !== "draft" && project.pending_version !== null;
          await act(ctx, "approve", { slug, pending }, () => engine.approve(slug, HUMAN_ACTOR, version));
          break;
        }
        case "start":
          await act(ctx, "start", { slug }, () => engine.start(slug, HUMAN_ACTOR));
          break;
        case "pause":
          await act(ctx, "pause", { slug }, () => engine.pause(slug, HUMAN_ACTOR, false));
          break;
        case "pauseNow":
          await act(ctx, "pause", { slug, now: true }, () => engine.pause(slug, HUMAN_ACTOR, true));
          break;
        case "resume":
          await act(ctx, "resume", { slug }, () => engine.resume(slug, HUMAN_ACTOR));
          break;
        case "land":
          await act(ctx, "land", { slug, ...which }, () => engine.land(slug, HUMAN_ACTOR, { ready: false, ...which }));
          break;
        case "landDirect":
          await act(ctx, "land", { slug, ...which, direct: true }, () => engine.land(slug, HUMAN_ACTOR, { ready: false, direct: true, ...which }));
          break;
        case "archive":
          await act(ctx, "archive", { slug }, () => engine.archive(slug, HUMAN_ACTOR));
          break;
      }
      return projectView(slug);
    },
  });
}
