// The page's server side: reads over the store and changes through the same engine methods the CLI calls.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { humanAction } from "./cli";
import { rpcContract, type BoardCard, type ProjectView, type ThreadInfo, type TicketDetail } from "./contract";
import type { Store, ThreadRow, TicketRow } from "./db/store";
import type { Engine } from "./engine";
import type { Projects } from "./projects";
import { projectFeed, projectMetrics } from "./reports";
import { IN_FLIGHT, overlaps, readyTickets, toLite } from "./scheduler";
import { HUMAN_ACTOR } from "./states";

export const CHANGED_CHANNEL = "loom:changed";
const THROTTLE_MS = 300;

export interface RpcDeps {
  projects: Projects;
  engine: Engine;
  store: Store;
  now: () => number;
}

/** Publishes `loom:changed` with the project's slug after each committed event or `store.changed` call, at most once per project every 300 ms; a call inside a window goes out when the window ends. This is the only thing that publishes to the page. Returns the stop function. */
export function watchChanges(bb: BbPluginApi, store: Store): () => void {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  store.setOnEvent((projectId) => {
    if (timers.has(projectId)) return;
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const slug = store.project(projectId)?.slug;
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

/** One card per ticket. A queued ticket that is not ready says why, from a single readyTickets pass. */
export function boardCards(tickets: TicketRow[], threads: ThreadRow[]): BoardCard[] {
  const lites = tickets.map(toLite);
  const ready = readyTickets(lites);
  const readyIds = new Set(ready.map((lite) => lite.id));
  const done = new Set(lites.filter((lite) => lite.state === "done").map((lite) => lite.key));
  return tickets.map((ticket, index) => {
    const lite = lites[index]!;
    const waiting = ticket.state === "queued" && !readyIds.has(ticket.id);
    const waitingOn = waiting
      ? [
          ...lite.deps.filter((key) => !done.has(key)),
          ...lites.filter((other) => IN_FLIGHT.includes(other.state) && overlaps(other.scope, lite.scope)).map((other) => other.key),
          ...ready.filter((other) => (other.priority - lite.priority || other.seq - lite.seq) < 0 && overlaps(other.scope, lite.scope)).map((other) => other.key),
        ]
      : [];
    const live = threads.filter((row) => row.ticket_id === ticket.id && row.state === "active" && row.thread_id !== null).sort((a, b) => Number(b.role === "worker") - Number(a.role === "worker"));
    return {
      key: ticket.key,
      title: ticket.title,
      state: ticket.state,
      stateAt: ticket.state_at,
      priority: ticket.priority,
      attempt: ticket.attempt,
      reviewRound: ticket.review_round,
      deps: lite.deps,
      ready: readyIds.has(ticket.id),
      waitingOn: [...new Set(waitingOn)],
      threadId: live[0]?.thread_id ?? null,
      prUrl: ticket.pr_url,
      blockedReason: ticket.blocked_reason,
    };
  });
}

export function registerRpc(bb: BbPluginApi, deps: RpcDeps): void {
  const { projects, engine, store, now } = deps;

  const projectView = (slug: string): ProjectView => {
    const overview = projects.overview(slug);
    const project = projects.require(slug);
    const tickets = store.tickets(project.id);
    const threads = store.threadsForProject(project.id);
    const at = now();
    const spec = projects.spec(slug);
    return {
      overview,
      board: boardCards(tickets, threads),
      metrics: projectMetrics(store, project, at),
      spec: {
        toml: spec.toml,
        version: spec.version,
        pendingVersion: project.pending_version,
        pendingToml: project.pending_version === null ? null : projects.spec(slug, project.pending_version).toml,
      },
      prUrl: project.pr_url,
      now: at,
    };
  };

  const ticketDetail = (key: string): TicketDetail => {
    const view = projects.ticketView(key);
    const ticket = store.ticketByKey(key)!;
    const project = store.project(ticket.project_id)!;
    return {
      slug: project.slug,
      projectState: project.state,
      key: ticket.key,
      title: ticket.title,
      state: ticket.state,
      stateAt: ticket.state_at,
      priority: ticket.priority,
      attempt: ticket.attempt,
      reviewRound: ticket.review_round,
      deps: view.deps,
      blockedReason: ticket.blocked_reason,
      branch: ticket.branch,
      prUrl: ticket.pr_url,
      body: ticket.body,
      acceptance: view.acceptance,
      verify: view.verify,
      scope: view.scope,
      posts: view.posts.map((post) => ({ id: post.id, parentId: post.parent_id, depth: post.depth, authorKind: post.author_kind, authorThreadId: post.author_thread_id, kind: post.kind, body: post.body, at: post.at })),
      reviews: store.reviews(ticket.id).map((review) => ({ id: review.id, round: review.round, verdict: review.verdict, summary: review.summary, findings: JSON.parse(review.findings_json), at: review.at })),
      threads: store.threadsForTicket(ticket.id).map((row) => ({ threadId: row.thread_id, role: row.role, state: row.state, startedAt: row.started_at, endedAt: row.ended_at, endReason: row.end_reason })),
    };
  };

  // Every change is the human's: it runs through humanAction, which writes the human.action event, and refuses any other plugin.
  const act = <T>(ctx: { experimental_caller: { kind: string } }, action: string, data: { slug?: string; key?: string; [extra: string]: unknown }, fn: () => Promise<T> | T): Promise<T> => {
    if (ctx.experimental_caller.kind === "plugin") throw new Error("Loom's controls are for the human: another plugin cannot call them.");
    return humanAction({ projects, store }, {}, action, data, fn);
  };

  bb.rpc.register(rpcContract, {
    projects: () => projects.list(),
    project: ({ slug }) => projectView(slug),
    ticket: ({ key }) => ticketDetail(key),
    feed: ({ slug, afterId }) => projectFeed(store, projects.require(slug), afterId),
    threadInfo: ({ threadId }): ThreadInfo | null => {
      const row = store.threadByThreadId(threadId);
      const project = row === null ? null : store.project(row.project_id);
      if (row === null || project === null) return null;
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
    control: async ({ slug, action, version }, ctx) => {
      switch (action) {
        case "approve": {
          const project = projects.require(slug);
          const pending = project.state !== "draft" && project.pending_version !== null;
          await act(ctx, "approve", { slug, pending }, () => projects.approve(slug, HUMAN_ACTOR, version));
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
          await act(ctx, "land", { slug }, () => engine.land(slug, HUMAN_ACTOR, { ready: false }));
          break;
        case "archive":
          await act(ctx, "archive", { slug }, () => engine.archive(slug, HUMAN_ACTOR));
          break;
      }
      return projectView(slug);
    },
  });
}
