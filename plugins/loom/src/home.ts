// The Loom page's home across every project: totals, what needs the human, and one row per project.
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { readyToLand } from "./format";
import { throughputOf } from "./metrics";
import type { ProjectOverview, Projects } from "./projects";
import { IN_FLIGHT } from "./scheduler";
import type { Spec } from "./spec";
import { PAUSE_NOW_REASON } from "./states";
import { specOf } from "./workers";

export interface NeedItem {
  kind: "blocked" | "approve" | "pending" | "land" | "paused";
  slug: string;
  project: string;
  /** The ticket a blocked item is about; null for an item about the project. */
  key: string | null;
  text: string;
  at: number;
}

export interface HomeProject extends ProjectOverview {
  progress: { done: number; total: number; inFlight: number; blocked: number };
  /** Live worker and reviewer rows; a planner stays active while on call for triage rounds, so it is left out. */
  agents: number;
  /** Tickets done on each of the last 14 days, oldest first. */
  throughput: number[];
  tokens: number;
  maxTokens: number | null;
  lastEventAt: number | null;
}

export interface HomeView {
  totals: { projects: number; running: number; paused: number; workers: number; reviewers: number; planners: number; slots: number; doneLast7: number; doneByDay: number[]; tokens: number; perDoneTicket: number | null };
  needsYou: NeedItem[];
  projects: HomeProject[];
  now: number;
}

const TREND_DAYS = 14;
const ticketsLabel = (count: number) => `${count} ticket${count === 1 ? "" : "s"}`;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

interface Loaded {
  project: ProjectRow;
  row: HomeProject;
  tickets: TicketRow[];
  threads: ThreadRow[];
}

/** Totals and needs leave archived projects out; the project rows keep them, as the list always has. */
export function homeView(a: { store: Store; projects: Projects; now: number }): HomeView {
  const { store, now } = a;
  const loaded = store.projects().map((project) => load(store, a.projects.overview(project.slug), project, now));
  const live = loaded.filter((entry) => entry.project.state !== "archived");
  const active = live.flatMap((entry) => entry.threads).filter((thread) => thread.state === "active");
  const running = live.filter((entry) => entry.project.state === "running");
  const doneByDay = Array.from({ length: TREND_DAYS }, (_, index) => sum(live.map((entry) => entry.row.throughput[index]!)));
  const tokens = sum(live.map((entry) => entry.row.tokens));
  const done = sum(live.map((entry) => entry.row.progress.done));
  return {
    totals: {
      projects: live.length,
      running: running.length,
      paused: live.filter((entry) => entry.project.state === "paused").length,
      workers: active.filter((thread) => thread.role === "worker").length,
      reviewers: active.filter((thread) => thread.role === "reviewer").length,
      planners: active.filter((thread) => thread.role === "planner").length,
      slots: sum(running.map((entry) => specOf(store, entry.project).agents).map((agents) => agents.max_workers + agents.max_reviewers)),
      doneLast7: sum(doneByDay.slice(-7)),
      doneByDay,
      tokens,
      perDoneTicket: done === 0 ? null : tokens / done,
    },
    needsYou: live.flatMap((entry) => needsOf(store, entry)).sort((x, y) => y.at - x.at),
    projects: loaded.map((entry) => entry.row),
    now,
  };
}

function load(store: Store, overview: ProjectOverview, project: ProjectRow, now: number): Loaded {
  const tickets = store.tickets(project.id);
  const threads = store.threadsForProject(project.id);
  const count = (match: (ticket: TicketRow) => boolean) => tickets.filter(match).length;
  const row: HomeProject = {
    ...overview,
    progress: {
      done: count((ticket) => ticket.state === "done"),
      total: count((ticket) => ticket.state !== "cancelled"),
      inFlight: count((ticket) => IN_FLIGHT.includes(ticket.state)),
      blocked: count((ticket) => ticket.state === "blocked"),
    },
    agents: threads.filter((thread) => thread.role !== "planner" && thread.state !== "ended").length,
    throughput: throughputOf(store.projectEvents(project.id), now, TREND_DAYS).map((day) => day.done),
    tokens: sum(threads.map((thread) => thread.tokens ?? 0)),
    maxTokens: project.approved_version === null ? null : (specOf(store, project).budget.max_tokens ?? null),
    lastEventAt: store.eventsNewest(project.id, 1)[0]?.at ?? null,
  };
  return { project, row, tickets, threads };
}

function needsOf(store: Store, { project, row, tickets }: Loaded): NeedItem[] {
  const item = (kind: NeedItem["kind"], text: string, at: number, key: string | null = null): NeedItem => ({ kind, slug: project.slug, project: project.name, key, text, at });
  const items = tickets.filter((ticket) => ticket.state === "blocked").map((ticket) => item("blocked", ticket.blocked_reason ?? "blocked", ticket.state_at, ticket.key));
  if (project.state === "draft") {
    const latest = store.latestSpecVersion(project.id)!;
    items.push(item("approve", `has a draft spec v${latest.version} with ${ticketsLabel((JSON.parse(latest.spec_json) as Spec).ticket.length)}`, latest.created_at));
  } else if (project.pending_version !== null) {
    items.push(item("pending", `spec v${project.pending_version} waits for your approval`, store.specVersion(project.id, project.pending_version)!.created_at));
  }
  if (readyToLand(row)) {
    items.push(item("land", `finished all ${ticketsLabel(row.progress.done)}; land the integration branch`, Math.max(...tickets.map((ticket) => ticket.state_at))));
  }
  if (project.state === "paused" && project.system_reason !== null && project.system_reason !== PAUSE_NOW_REASON) items.push(item("paused", project.system_reason, project.updated_at));
  return items;
}
