// The Loom page's home across every project: totals, what needs the human, and one row per project. Needs you is one
// list across projects (the queue contract): only what needs a timely decision of the human enters it, and the rail
// badge counts the same list (badge.ts).
import { plannerAsk, type PlannerAsk } from "./asks";
import { acknowledged, badgeAcksOf, rolloutWarnings, warningId, wrongMerges } from "./badge-acks";
import type { BoardCard } from "./contract";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import { cardFailure } from "./failing";
import { finalBadge } from "./final-review";
import { plural, readyToLand } from "./format";
import { mergeOrderOf } from "./merge-order";
import { throughputOf } from "./metrics";
import { phasesOf } from "./phases";
import type { ProjectOverview, Projects } from "./projects";
import { rolloutOf } from "./rollout";
import { IN_FLIGHT, isBudgetPause, toLite } from "./scheduler";
import { specReviewStatus } from "./spec-review";
import { readSpec, type Spec } from "./spec";
import { PAUSE_NOW_REASON } from "./states";
import { queueOrder } from "./home-order";
import { specOf } from "./ctx";

export type NeedKind = "blocked" | "failed" | "approve" | "pending" | "ask" | "land" | "paused" | "merge" | "draft" | "wrongBase" | "rollout";

export interface NeedItem {
  /** Stable while the need lasts: its kind and what it is about, such as "blocked:CSV-7" or "merge:CSV-12:<sha>". */
  id: string;
  kind: NeedKind;
  slug: string;
  project: string;
  projectKey: string;
  /** The ticket the item is about; null for an item about the project. */
  key: string | null;
  /** Every ticket the item is about, for an item about several (failed tickets, wrong-branch merges). */
  keys: string[];
  /** The ticket's title, or what the item is about; null when the project's name says it. */
  title: string | null;
  text: string;
  /** When the need began; null when Loom does not record it, which the page shows as "age unknown". */
  startedAt: number | null;
  /** Where the item comes from, in words; two when one item stands for two sources, such as an ask to approve the version that waits. */
  sources: string[];
  /** For a blocked ticket: the open tickets that wait on it directly, and how many wait on it in all. */
  unblocks: { direct: string[]; all: number } | null;
  /** What Loom does while the item waits; null when it does nothing about it. */
  meanwhile: string | null;
  /** What clears the item, and for an item the human can acknowledge, that acknowledging only hides it. */
  clears: string;
  /** The version an approve, pending or ask item approves. */
  version: number | null;
  /** The planner.asked event of an ask item. */
  ask: number | null;
  /** The pull request and commit a merge confirmation is bound to, or the pull request of a held draft. */
  prUrl: string | null;
  sha: string | null;
  /** What an acknowledgement of a wrongBase or rollout item records. */
  ackItems: string[];
  /** A pause for the token budget or the deadline, which a new spec version can lift. */
  budget: boolean;
}

/** A Loom thread that bb may show waiting on the human; the page joins it with bb's live thread state. */
export interface WaitableThread {
  threadId: string;
  role: "planner" | "worker" | "reviewer" | "planning";
  /** The project's slug; null for a planning conversation that has not proposed. */
  slug: string | null;
  /** The project's name, or the conversation's title. */
  project: string;
  projectKey: string | null;
  key: string | null;
}

export interface HomeProject extends ProjectOverview {
  progress: { done: number; total: number; inFlight: number; blocked: number };
  /** Live worker and reviewer rows; a planner stays active while on call for triage rounds, so it is left out. */
  agents: number;
  /** Tickets done on each of the last 14 days, oldest first. */
  throughput: number[];
  tokens: number;
  /** Threads bb started, and of those the ones that never reported usage: their tokens are unknown, not zero. */
  tokenThreads: number;
  tokensUnreported: number;
  maxTokens: number | null;
  lastEventAt: number | null;
  /** The phase in progress of a phased project, or its last when every phase is done; null for an unphased project. */
  phase: { index: number; count: number; title: string; done: number; total: number } | null;
  /** Open tickets whose failure Loom retries and that Work shows as Failed (failing.ts). */
  failed: number;
}

export interface HomeView {
  totals: { projects: number; running: number; paused: number; workers: number; reviewers: number; planners: number; slots: number; busy: number; doneLast7: number; doneByDay: number[]; tokens: number; tokenThreads: number; tokensUnreported: number; perDoneTicket: number | null };
  needsYou: NeedItem[];
  threads: WaitableThread[];
  projects: HomeProject[];
  now: number;
}

/** The board cards of a project's tickets, as the project view draws them (rpc.ts boardCards). */
export type CardsOf = (project: ProjectRow, tickets: TicketRow[], threads: ThreadRow[], spec: Spec) => BoardCard[];

const TREND_DAYS = 14;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const OPEN = (state: string) => state !== "done" && state !== "cancelled";

interface Loaded {
  project: ProjectRow;
  row: HomeProject;
  tickets: TicketRow[];
  threads: ThreadRow[];
  spec: Spec | null;
  cards: BoardCard[];
}

/** Totals and needs leave archived projects out; the project rows keep them, as the list always has. */
export function homeView(a: { store: Store; projects: Projects; now: number; cards: CardsOf }): HomeView {
  const { store, now } = a;
  const loaded = store.projects().map((project) => load(a, a.projects.overview(project.slug), project));
  const live = loaded.filter((entry) => entry.project.state !== "archived");
  const running = live.filter((entry) => entry.project.state === "running");
  // A paused project's workers and reviewers keep running until they finish, so its slots count against them. Agents
  // count where slots do, so the two compare.
  const staffed = live.filter((entry) => entry.project.state === "running" || entry.project.state === "paused");
  const active = staffed.flatMap((entry) => entry.threads).filter((thread) => thread.state === "active");
  const doneByDay = Array.from({ length: TREND_DAYS }, (_, index) => sum(live.map((entry) => entry.row.throughput[index]!)));
  const tokens = sum(live.map((entry) => entry.row.tokens));
  const done = sum(live.map((entry) => entry.row.progress.done));
  const created = new Map(live.map((entry) => [entry.project.slug, entry.project.created_at]));
  return {
    totals: {
      projects: live.length,
      running: running.length,
      paused: live.filter((entry) => entry.project.state === "paused").length,
      workers: active.filter((thread) => thread.role === "worker").length,
      reviewers: active.filter((thread) => thread.role === "reviewer").length,
      planners: live.flatMap((entry) => entry.threads).filter((thread) => thread.state === "active" && thread.role === "planner").length,
      slots: sum(staffed.map((entry) => specOf(store, entry.project).agents).map((agents) => agents.max_workers + agents.max_reviewers)),
      // As the scheduler counts them: a worker waiting in review or on its pull request keeps its thread but no slot.
      busy: sum(staffed.map((entry) => entry.tickets.filter((ticket) => toLite(ticket).holds).length + entry.threads.filter((thread) => thread.role === "reviewer" && (thread.state === "spawning" || thread.state === "active")).length)),
      doneLast7: sum(doneByDay.slice(-7)),
      doneByDay,
      tokens,
      tokenThreads: sum(live.map((entry) => entry.row.tokenThreads)),
      tokensUnreported: sum(live.map((entry) => entry.row.tokensUnreported)),
      perDoneTicket: done === 0 ? null : tokens / done,
    },
    needsYou: queueOrder(
      live.flatMap((entry) => needsOf(store, entry, now)),
      (slug) => created.get(slug) ?? 0,
    ),
    threads: waitable(store, live),
    projects: loaded.map((entry) => entry.row),
    now,
  };
}

function load(a: { store: Store; now: number; cards: CardsOf }, overview: ProjectOverview, project: ProjectRow): Loaded {
  const { store, now } = a;
  const tickets = store.tickets(project.id);
  const threads = store.threadsForProject(project.id);
  const count = (match: (ticket: TicketRow) => boolean) => tickets.filter(match).length;
  const spec = project.approved_version === null ? null : specOf(store, project);
  const cards = spec === null ? [] : a.cards(project, tickets, threads, spec);
  const finals = spec === null ? new Map() : new Map(tickets.map((ticket) => [ticket.key, finalBadge(store, spec, ticket)] as const));
  const phases = spec === null ? null : phasesOf(spec, tickets);
  const activeAt = phases?.findIndex((each) => each.state === "active") ?? -1;
  const current = phases === null ? -1 : activeAt !== -1 ? activeAt : phases.map((each) => each.state).lastIndexOf("done");
  const phase = phases === null || current === -1 ? null : { index: current, count: phases.length, title: phases[current]!.title, done: phases[current]!.tickets.done + phases[current]!.tickets.cancelled, total: phases[current]!.tickets.total };
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
    // As Insights counts them: a row whose spawn never went through has no usage to report.
    tokenThreads: threads.filter((thread) => thread.thread_id !== null).length,
    tokensUnreported: threads.filter((thread) => thread.thread_id !== null && thread.tokens === null).length,
    maxTokens: spec === null ? null : (spec.budget.max_tokens ?? null),
    lastEventAt: store.eventsNewest(project.id, 1)[0]?.at ?? null,
    phase,
    failed: cards.filter((card) => OPEN(card.state) && card.state !== "blocked" && cardFailure(card, finals.get(card.key)) !== null).length,
  };
  return { project, row, tickets, threads, spec, cards };
}

/** The open tickets that wait on `key` through depends_on, directly and in all. */
function unblocksOf(cards: readonly BoardCard[], key: string): { direct: string[]; all: number } {
  const open = cards.filter((card) => OPEN(card.state));
  const direct = open.filter((card) => card.deps.includes(key)).map((card) => card.key);
  const all = new Set<string>();
  const walk = (from: string) => {
    for (const card of open) if (card.deps.includes(from) && !all.has(card.key)) (all.add(card.key), walk(card.key));
  };
  walk(key);
  return { direct, all: all.size };
}

const BLANK = { key: null, keys: [], title: null, unblocks: null, meanwhile: null, version: null, ask: null, prUrl: null, sha: null, ackItems: [], budget: false } as const;

function needsOf(store: Store, entry: Loaded, now: number): NeedItem[] {
  const { project, row, tickets, spec, cards } = entry;
  const item = (fields: Partial<NeedItem> & Pick<NeedItem, "id" | "kind" | "text" | "startedAt" | "sources" | "clears">): NeedItem => ({ ...BLANK, keys: [], ackItems: [], slug: project.slug, project: project.name, projectKey: project.key, ...fields });
  const items: NeedItem[] = [];
  const triage = spec?.agents.triage === true && project.state === "running";

  for (const ticket of tickets.filter((each) => each.state === "blocked")) {
    const unblocks = unblocksOf(cards, ticket.key);
    items.push(
      item({
        id: `blocked:${ticket.key}`,
        kind: "blocked",
        key: ticket.key,
        keys: [ticket.key],
        title: ticket.title,
        text: ticket.blocked_reason ?? "blocked",
        startedAt: ticket.state_at,
        sources: ["blocked ticket"],
        unblocks,
        meanwhile: triage ? "The planner sees it in its next triage round and may requeue it." : null,
        clears: "Clears when the ticket is requeued or cancelled.",
      }),
    );
  }

  // The same rule as Work's Failed group: one read that failed and is retried is a fact, not a need (failing.ts).
  const finals = spec === null ? new Map() : new Map(tickets.map((ticket) => [ticket.key, finalBadge(store, spec, ticket)] as const));
  const failed = cards.flatMap((card) => {
    if (!OPEN(card.state) || card.state === "blocked") return [];
    const failure = cardFailure(card, finals.get(card.key));
    return failure === null ? [] : [{ card, failure }];
  });
  if (failed.length > 0) {
    const [first] = failed;
    const starts = failed.flatMap(({ failure }) => (failure.since === null ? [] : [failure.since]));
    items.push(
      item({
        id: `failed:${project.slug}`,
        kind: "failed",
        key: failed.length === 1 ? first!.card.key : null,
        keys: failed.map(({ card }) => card.key),
        title: failed.length === 1 ? first!.card.title : `${plural(failed.length, "ticket")} failed`,
        text: failed.length === 1 ? `${first!.failure.what}: ${first!.card.retry?.message ?? first!.card.startWait?.reason ?? first!.card.reviewerLookup?.reason ?? "see the ticket"}` : [...new Set(failed.map(({ failure }) => failure.what))].join(" · "),
        startedAt: starts.length === failed.length ? Math.min(...starts) : null,
        sources: ["failed step Loom retries"],
        meanwhile: "Loom keeps retrying by itself.",
        clears: "Clears when the step succeeds, or when the ticket is blocked, requeued or cancelled.",
      }),
    );
  }

  const ask = project.state === "archived" ? null : plannerAsk(store, project);
  const openAsk: PlannerAsk | null = ask !== null && ask.open ? ask : null;
  const review = specReviewStatus(store, project);
  // A draft needs the human once its review passed or stopped, or when it did not finish.
  let version: NeedItem | null = null;
  if (project.state === "draft" && review.kind !== "reviewing" && review.kind !== "changes") {
    const latest = store.latestSpecVersion(project.id)!;
    const text = review.kind === "failed" ? `draft v${latest.version}'s spec review did not finish: ${review.reason}` : `has a draft spec v${latest.version} with ${plural(readSpec(latest.spec_json, store).ticket.length, "ticket")}`;
    version = item({ id: `approve:${project.slug}:${latest.version}`, kind: "approve", version: latest.version, text, startedAt: latest.created_at, sources: ["draft spec"], clears: "Clears when you approve it, or when the planner proposes a newer draft." });
  } else if (project.state !== "draft" && project.pending_version !== null && review.kind !== "reviewing" && review.kind !== "changes") {
    const text = review.kind === "failed" ? `spec v${project.pending_version}'s spec review did not finish: ${review.reason}` : `spec v${project.pending_version} waits for your approval`;
    version = item({ id: `pending:${project.slug}:${project.pending_version}`, kind: "pending", version: project.pending_version, text, startedAt: store.specVersion(project.id, project.pending_version)!.created_at, sources: ["spec version"], clears: "Clears when you approve it, or when the planner proposes a newer version." });
  }
  const askApproves = version !== null && openAsk !== null && openAsk.steps.some((step) => !step.done && step.action === "approve" && step.version === version!.version);
  if (openAsk !== null) {
    const open = openAsk.steps.filter((step) => !step.done);
    items.push(
      item({
        id: `ask:${project.slug}:${openAsk.id}`,
        kind: "ask",
        ask: openAsk.id,
        version: askApproves ? version!.version : null,
        title: open.map((step) => step.text).join(" · "),
        text: openAsk.why === "" ? `${plural(open.length, "step")} to take` : openAsk.why,
        // One root cause, one item: an ask to approve the version that waits is that version's item too.
        startedAt: askApproves ? Math.min(openAsk.at, version!.startedAt!) : openAsk.at,
        sources: askApproves ? [`planner ask, ${plural(open.length, "step")}`, `spec v${version!.version} waits for approval`] : [`planner ask, ${plural(open.length, "step")}`],
        clears: "Each step clears once you take it or mark it done. Set aside hides the whole ask until the planner asks again.",
      }),
    );
  }
  if (version !== null && !askApproves) items.push(version);

  if (readyToLand(row)) {
    items.push(item({ id: `land:${project.slug}`, kind: "land", text: `finished all ${plural(row.progress.done, "ticket")}; land the integration branch`, startedAt: Math.max(...tickets.map((ticket) => ticket.state_at)), sources: ["finished project"], clears: "Clears when you land the integration branch." }));
  }
  if (project.state === "paused" && project.system_reason !== null && project.system_reason !== PAUSE_NOW_REASON) {
    items.push(item({ id: `paused:${project.slug}`, kind: "paused", text: project.system_reason, startedAt: project.updated_at, sources: ["project Loom paused"], meanwhile: "Running agents finish their turn; nothing new starts.", clears: "Clears when you resume the project.", budget: isBudgetPause(project.system_reason) }));
  }

  for (const card of cards) {
    if (card.mergeConfirm?.ready === true && !card.mergeConfirm.confirmed) {
      const requested = card.mergeConfirm.requested;
      items.push(
        item({
          id: `merge:${card.key}:${card.mergeConfirm.sha}`,
          kind: "merge",
          key: card.key,
          keys: [card.key],
          title: card.title,
          text: requested === null || requested.note === "" ? "merge to confirm" : requested.note,
          prUrl: card.mergeConfirm.prUrl,
          sha: card.mergeConfirm.sha,
          startedAt: requested?.at ?? null,
          sources: requested === null ? ["merge to confirm"] : ["merge to confirm", "planner asked"],
          clears: "Clears when it merges; a new push replaces it with one for the new commit.",
        }),
      );
    }
    if (card.draft === "held" && card.prUrl !== null) {
      const requested = card.releaseRequested;
      items.push(
        item({
          id: `draft:${card.key}`,
          kind: "draft",
          key: card.key,
          keys: [card.key],
          title: card.title,
          text: requested === null || requested.note === "" ? "held as a draft until you release it" : requested.note,
          prUrl: card.prUrl,
          startedAt: requested?.at ?? null,
          sources: requested === null ? ["held draft"] : ["held draft", "planner asked"],
          clears: "Clears when you release the draft.",
        }),
      );
    }
  }

  if (spec !== null) {
    const acks = badgeAcksOf(store, project);
    const wrong = wrongMerges(mergeOrderOf(spec, tickets, finals));
    const wrongIds = wrong.map((entry) => entry.key);
    if (wrong.length > 0 && !acknowledged(acks.merge, wrongIds)) {
      const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
      items.push(
        item({
          id: `wrongBase:${project.slug}`,
          kind: "wrongBase",
          key: wrong.length === 1 ? wrong[0]!.key : null,
          keys: wrongIds,
          title: `${plural(wrong.length, "pull request")} merged into another ticket's branch`,
          text: wrong.map((entry) => `${entry.key} into ${entry.mergedInto ?? "another ticket"}`).join(" · "),
          // When Loom saw the merge: the ticket's move to done or blocked.
          startedAt: Math.min(...wrong.map((entry) => byKey.get(entry.key)?.state_at ?? now)),
          sources: ["merge order"],
          ackItems: wrongIds,
          clears: "Clears when the ticket whose branch it went into merges too. Acknowledge only hides it, until another pull request merges the wrong way.",
        }),
      );
    }
    const warnings = rolloutWarnings(rolloutOf(spec, tickets, store.rolloutMarks(project.id), now));
    const warningIds = [...new Set(warnings.map(warningId))];
    if (warnings.length > 0 && !acknowledged(acks.rollout, warningIds)) {
      items.push(
        item({
          id: `rollout:${project.slug}`,
          kind: "rollout",
          keys: [...new Set(warnings.flatMap((warning) => warning.keys))],
          title: `${plural(warnings.length, "rollout warning")} before you merge or deploy`,
          text: warnings.map((warning) => warning.text).join(" · "),
          startedAt: null,
          sources: ["rollout"],
          ackItems: warningIds,
          clears: "Clears once what each warning waits for is live. Acknowledge only hides them, until a new warning appears.",
        }),
      );
    }
  }
  return items;
}

/** Every thread bb may show waiting on the human: each live project's planner, its active workers and reviewers, and the planning conversations. */
function waitable(store: Store, live: readonly Loaded[]): WaitableThread[] {
  const rows: WaitableThread[] = [];
  for (const { project, threads, tickets } of live) {
    const keyOf = new Map(tickets.map((ticket) => [ticket.id, ticket.key]));
    if (project.planner_thread_id !== null) rows.push({ threadId: project.planner_thread_id, role: "planner", slug: project.slug, project: project.name, projectKey: project.key, key: null });
    for (const thread of threads) {
      if (thread.state !== "active" || thread.thread_id === null || thread.role === "planner" || thread.thread_id === project.planner_thread_id) continue;
      rows.push({ threadId: thread.thread_id, role: thread.role, slug: project.slug, project: project.name, projectKey: project.key, key: thread.ticket_id === null ? null : (keyOf.get(thread.ticket_id) ?? null) });
    }
  }
  const known = new Set(rows.map((row) => row.threadId));
  for (const planning of store.openPlanning()) {
    if (known.has(planning.thread_id)) continue;
    rows.push({ threadId: planning.thread_id, role: "planning", slug: null, project: planning.title ?? "Planning", projectKey: null, key: null });
  }
  return rows;
}
