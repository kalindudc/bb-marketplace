// The Changes tab: what a project changed, read from git on the machine that has its checkout. Merged work is compared by
// the merge commits Loom recorded, so a finished or archived project still shows what it merged; work whose commits are
// no longer in the repository says so, and the page leaves it out.
import type { ProjectRow, Store, TicketRow } from "./db/store";
import type { HostInput, HostOutput } from "./host-contract";
import type { BbPort, EnvironmentFile, FileStatus, HostPort } from "./ports";
import { LoomError } from "./projects";
import type { Spec } from "./spec";
import type { TicketState } from "./states";
import { freshBase, specOf } from "./workers";

const MAX_FILES = 2000;
const PATCH_BYTES = 400_000;
const READS_AT_ONCE = 6;
const CACHE_LIMIT = 1000;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const LIVE_STATES: readonly TicketState[] = ["working", "checking"];

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type ChangeKind = "branch" | "merge" | "commit" | "live";

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** A new file git does not track yet, in a live worktree. */
  untracked: boolean;
  /** What a Viewed mark holds on to: the file's content after the change, or its counts in a live worktree. */
  fingerprint: string;
  /** On the whole branch, the merged tickets that changed the file. */
  tickets: string[];
}

export interface ChangeSource {
  /** "branch", or the kind and the ticket's key, such as "merge:CSV-1". */
  id: string;
  kind: ChangeKind;
  key: string | null;
  title: string | null;
  state: TicketState | null;
  /** The commits compared, which a file's patch is read between; null for a live worktree or when nothing was read. */
  base: string | null;
  head: string | null;
  /** What it is compared with: a branch, or the branch as it was before the project's first merge. */
  against: string;
  /** When its merge happened, for a merge. */
  at: number | null;
  attempt: number;
  reviewRound: number;
  files: ChangedFile[] | null;
  truncated: boolean;
  /** Why there are no files, such as no changes yet. */
  note: string | null;
  /** Its commits are no longer in the repository. */
  gone: boolean;
}

export interface ChangesView {
  slug: string;
  strategy: "integration" | "pr";
  base: string;
  /** The remote's base branch, which live work is compared with: "origin/main". */
  remoteBase: string;
  branch: string | null;
  /** Done or archived: the whole branch is what the project merged, from before its first merge to its last. */
  finished: boolean;
  sources: ChangeSource[];
  /** Why nothing could be read, such as no checkout on this machine. */
  unavailable: string | null;
}

export type FilePatch = { patch: string; truncated: boolean } | { patch: null; message: string };

type GitRead = Omit<HostInput<"changedFiles">, "repo" | "maxFiles">;
type Read = { kind: "git"; input: GitRead } | { kind: "live"; environmentId: string; base: string; fallback: GitRead | null } | { kind: "none"; note: string };
type Listing = Extract<HostOutput<"changedFiles">, { outcome: "ok" }>;
type Merge = { sha: string; before: string; at: number };

interface Plan {
  source: Pick<ChangeSource, "id" | "kind" | "key" | "title" | "state" | "against" | "at" | "attempt" | "reviewRound">;
  read: Read;
}

/** Each done ticket's merge into the integration branch, from its move to done. */
function mergesOf(store: Store, projectId: number): Map<number, Merge> {
  const merges = new Map<number, Merge>();
  for (const event of store.eventsOfKind(projectId, "ticket.state")) {
    const data = JSON.parse(event.data_json) as { to?: string; outcome?: string; sha?: unknown; before?: unknown };
    if (event.ticket_id === null || data.to !== "done" || data.outcome !== "merged" || typeof data.sha !== "string" || typeof data.before !== "string") continue;
    merges.set(event.ticket_id, { sha: data.sha, before: data.before, at: event.at });
  }
  return merges;
}

const ticketSource = (ticket: TicketRow, kind: ChangeKind, against: string, at: number | null = null): Plan["source"] => ({
  id: `${kind}:${ticket.key}`,
  kind,
  key: ticket.key,
  title: ticket.title,
  state: ticket.state,
  against,
  at,
  attempt: ticket.attempt,
  reviewRound: ticket.review_round,
});

/** A ticket that has not merged: its worker's worktree while it works, else the commit that passed its checks. */
function unmergedPlan(ticket: TicketRow, spec: Spec, opts: { against: string; landed: boolean }): Plan {
  const commit: GitRead | null = ticket.head_sha === null ? null : { base: opts.against, head: ticket.head_sha, mergeBase: true, ...(opts.landed ? { landed: true } : {}) };
  if (LIVE_STATES.includes(ticket.state) && ticket.environment_id !== null) {
    return { source: ticketSource(ticket, "live", freshBase(spec)), read: { kind: "live", environmentId: ticket.environment_id, base: freshBase(spec), fallback: commit } };
  }
  if (commit !== null) return { source: ticketSource(ticket, "commit", opts.against), read: { kind: "git", input: commit } };
  return { source: ticketSource(ticket, "commit", opts.against), read: { kind: "none", note: ticket.state === "queued" ? "No changes yet." : "No commit was recorded." } };
}

function plansOf(store: Store, project: ProjectRow, spec: Spec): Plan[] {
  const tickets = store.tickets(project.id);
  const remoteBase = `${spec.merge.remote}/${spec.project.base}`;
  if (spec.merge.strategy === "pr") return tickets.map((ticket) => unmergedPlan(ticket, spec, { against: remoteBase, landed: ticket.state === "done" }));

  const branch = spec.merge.branch!;
  const finished = project.state === "done" || project.state === "archived";
  const merges = mergesOf(store, project.id);
  const merged = tickets.filter((ticket) => merges.has(ticket.id)).sort((a, b) => merges.get(a.id)!.at - merges.get(b.id)!.at || a.seq - b.seq);
  const first = merged.length === 0 ? null : merges.get(merged[0]!.id)!;
  const last = merged.length === 0 ? null : merges.get(merged.at(-1)!.id)!;
  const whole: Plan = {
    source: { id: "branch", kind: "branch", key: null, title: null, state: null, against: finished ? `${branch} before its first merge` : remoteBase, at: last?.at ?? null, attempt: 0, reviewRound: 0 },
    read:
      first === null || last === null
        ? { kind: "none", note: "Nothing merged yet." }
        : finished
          ? { kind: "git", input: { base: first.before, head: last.sha, mergeBase: false } }
          : { kind: "git", input: { base: remoteBase, head: `refs/heads/${branch}`, mergeBase: true } },
  };
  return [
    whole,
    ...merged.map((ticket) => {
      const merge = merges.get(ticket.id)!;
      return { source: ticketSource(ticket, "merge", branch, merge.at), read: { kind: "git", input: { base: merge.before, head: merge.sha, mergeBase: false } } } satisfies Plan;
    }),
    ...tickets.filter((ticket) => !merges.has(ticket.id)).map((ticket) => unmergedPlan(ticket, spec, { against: branch, landed: false })),
  ];
}

const gitFile = (file: Listing["files"][number]): ChangedFile => ({ ...file, previousPath: null, untracked: false, fingerprint: file.blob ?? "deleted", tickets: [] });
const liveFile = (file: EnvironmentFile): ChangedFile => ({ ...file, fingerprint: `live:${file.status}:${file.additions}:${file.deletions}`, tickets: [] });

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(fn))));
  return results;
}

export class Changes {
  // A listing between two full commit hashes never changes, so it is read once.
  private readonly cache = new Map<string, HostOutput<"changedFiles">>();

  constructor(private readonly deps: { store: Store; bb: BbPort; host: HostPort }) {}

  private project(slug: string): ProjectRow {
    const project = this.deps.store.projectBySlug(slug);
    if (project === null) throw new LoomError("loom_not_found", `No Loom project named "${slug}".`, "Run `bb loom list` to see the projects.");
    return project;
  }

  /** The checkout to read git in, or why there is none: a deleted bb project, like a missing checkout, leaves nothing to read. */
  private async checkout(project: ProjectRow): Promise<{ hostId: string; repo: string } | string> {
    let repo: string | null;
    try {
      repo = project.host_id === null ? null : await this.deps.bb.projectCheckout(project.bb_project_id, project.host_id);
    } catch (error) {
      return `The project's checkout cannot be found, so its changes cannot be read: ${errText(error)}`;
    }
    return project.host_id === null || repo === null ? `The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}, so its changes cannot be read.` : { hostId: project.host_id, repo };
  }

  private async listing(checkout: { hostId: string; repo: string }, input: GitRead): Promise<HostOutput<"changedFiles">> {
    const request = { repo: checkout.repo, maxFiles: MAX_FILES, ...input };
    const key = JSON.stringify([checkout.hostId, request]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const result = await this.deps.host.call(checkout.hostId, "changedFiles", request);
    if (FULL_SHA.test(input.base) && FULL_SHA.test(input.head)) {
      if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
      this.cache.set(key, result);
    }
    return result;
  }

  private async read(checkout: { hostId: string; repo: string }, plan: Plan): Promise<ChangeSource> {
    const empty = { base: null, head: null, files: null, truncated: false, note: null, gone: false };
    const { read } = plan;
    if (read.kind === "none") return { ...plan.source, ...empty, files: [], note: read.note };
    try {
      if (read.kind === "live") {
        const live = await this.deps.bb.environmentFiles(read.environmentId, read.base);
        if (live.outcome === "ok") return { ...plan.source, ...empty, files: live.files.map(liveFile), truncated: live.truncated };
        if (read.fallback === null) return { ...plan.source, ...empty, note: `The worker's worktree cannot be read: ${live.message}` };
        return this.read(checkout, { source: { ...plan.source, id: `commit:${plan.source.key}`, kind: "commit" }, read: { kind: "git", input: read.fallback } });
      }
      const listed = await this.listing(checkout, read.input);
      if (listed.outcome === "missing") return { ...plan.source, ...empty, note: `Its commits are no longer in the repository: ${listed.message}`, gone: true };
      return { ...plan.source, ...empty, base: listed.base, head: listed.head, files: listed.files.map(gitFile), truncated: listed.truncated };
    } catch (error) {
      return { ...plan.source, ...empty, note: `Could not read the changes: ${errText(error)}` };
    }
  }

  async view(slug: string): Promise<ChangesView> {
    const project = this.project(slug);
    const approved = project.approved_version !== null;
    const spec = approved ? specOf(this.deps.store, project) : null;
    const view: ChangesView = {
      slug,
      strategy: spec?.merge.strategy ?? "integration",
      base: spec?.project.base ?? "",
      remoteBase: spec === null ? "" : `${spec.merge.remote}/${spec.project.base}`,
      branch: spec?.merge.branch ?? null,
      finished: project.state === "done" || project.state === "archived",
      sources: [],
      unavailable: null,
    };
    if (spec === null) return { ...view, unavailable: "The project has no approved spec yet." };
    const checkout = await this.checkout(project);
    if (typeof checkout === "string") return { ...view, unavailable: checkout };
    const sources = await inBatches(plansOf(this.deps.store, project, spec), READS_AT_ONCE, (plan) => this.read(checkout, plan));
    const whole = sources.find((source) => source.kind === "branch");
    for (const file of whole?.files ?? []) {
      file.tickets = sources.filter((source) => source.kind === "merge" && source.files?.some((other) => other.path === file.path)).map((source) => source.key!);
    }
    return { ...view, sources };
  }

  /** One file's patch: between two commits of a listing, or in a working ticket's worktree when `key` names it. */
  async patch(input: { slug: string; path: string; base?: string; head?: string; key?: string }): Promise<FilePatch> {
    const project = this.project(input.slug);
    if (input.key !== undefined) {
      const ticket = this.deps.store.ticketByKey(input.key);
      if (ticket === null || ticket.project_id !== project.id) throw new LoomError("loom_not_found", `No ticket ${input.key} in ${input.slug}.`);
      if (ticket.environment_id === null) return { patch: null, message: `${ticket.key} has no worktree now.` };
      const live = await this.deps.bb.environmentPatch(ticket.environment_id, freshBase(specOf(this.deps.store, project)), input.path);
      return live.outcome === "ok" ? { patch: live.patch, truncated: live.truncated } : { patch: null, message: live.message };
    }
    if (input.base === undefined || input.head === undefined) throw new LoomError("loom_invalid_input", "A file's patch needs the two commits it is read between, or the key of a working ticket.");
    const checkout = await this.checkout(project);
    if (typeof checkout === "string") return { patch: null, message: checkout };
    const result = await this.deps.host.call(checkout.hostId, "filePatch", { repo: checkout.repo, base: input.base, head: input.head, path: input.path, maxBytes: PATCH_BYTES });
    return result.outcome === "ok" ? { patch: result.patch, truncated: result.truncated } : { patch: null, message: `Its commits are no longer in the repository: ${result.message}` };
  }
}
