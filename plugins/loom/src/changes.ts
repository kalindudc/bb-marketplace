// The Changes tab: what a project changed, read from git on the machine that has its checkout. Merged work is compared by
// the merge commits Loom recorded, so a finished or archived project still shows what it merged; work whose commits are
// no longer in the repository says so, and the page leaves it out. On a multi-repo project each repo is read in its own
// checkout, and a repo without one leaves only its own sources unread.
import { repoCheckout, type RepoCheckout } from "./checkouts";
import type { ProjectRow, Store, TicketRow } from "./db/store";
import type { HostInput, HostOutput } from "./host-contract";
import type { BbPort, EnvironmentFile, FileStatus, HostPort } from "./ports";
import { LoomError } from "./projects";
import { isMultiRepo, repoSettings, type RepoSettings } from "./repos";
import type { Spec } from "./spec";
import { stackOf } from "./stack";
import type { TicketState } from "./states";
import { baseOf, specOf } from "./workers";

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
  /** "branch" ("branch:<repo>" on a multi-repo project), or the kind and the ticket's key, such as "merge:CSV-1". */
  id: string;
  kind: ChangeKind;
  /** The [[repo]] the ticket or the branch is in; null on a single-repo project. */
  repo: string | null;
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

/** One repository of the project as the Changes tab reads it. */
export interface ChangeRepo {
  /** The [[repo]] name; null for a single-repo project's own repository. */
  name: string | null;
  base: string;
  /** The repo's remote base branch, which its whole branch is compared with: "origin/main". */
  remoteBase: string;
  /** The integration branch; null on the pull request strategy. */
  branch: string | null;
  /** Why this repo cannot be read, such as no checkout on the project's machine. */
  unavailable: string | null;
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
  /** One entry per repo, in the spec's [[repo]] order; a single-repo project has one, named null. Empty without an approved spec. */
  repos: ChangeRepo[];
  sources: ChangeSource[];
  /** Why nothing could be read, such as no checkout on this machine: set only when no repo can be read. */
  unavailable: string | null;
}

export type FilePatch = { patch: string; truncated: boolean } | { patch: null; message: string };

type GitRead = Omit<HostInput<"changedFiles">, "repo" | "maxFiles">;
type Read = { kind: "git"; input: GitRead } | { kind: "live"; environmentId: string; base: string; fallback: GitRead | null } | { kind: "none"; note: string };
type Listing = Extract<HostOutput<"changedFiles">, { outcome: "ok" }>;
type Merge = { sha: string; before: string; at: number };

interface Plan {
  source: Pick<ChangeSource, "id" | "kind" | "repo" | "key" | "title" | "state" | "against" | "at" | "attempt" | "reviewRound">;
  read: Read;
}

const remoteBaseOf = (settings: RepoSettings) => `${settings.remote}/${settings.base}`;

/** Every repo of the spec in its [[repo]] order; a single-repo spec has its own repository, named null. */
const reposOf = (spec: Spec): RepoSettings[] => (isMultiRepo(spec) ? spec.repo!.map((repo) => repoSettings(spec, repo.name)) : [repoSettings(spec, null)]);

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
  repo: ticket.repo,
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
    const fresh = baseOf(spec, ticket);
    return { source: ticketSource(ticket, "live", fresh), read: { kind: "live", environmentId: ticket.environment_id, base: fresh, fallback: commit } };
  }
  if (commit !== null) return { source: ticketSource(ticket, "commit", opts.against), read: { kind: "git", input: commit } };
  return { source: ticketSource(ticket, "commit", opts.against), read: { kind: "none", note: ticket.state === "queued" ? "No changes yet." : "No commit was recorded." } };
}

/** Each repo's whole branch, in the spec's [[repo]] order, then each merge oldest first, then the tickets that have not merged. */
function plansOf(store: Store, project: ProjectRow, spec: Spec, repos: readonly RepoSettings[]): Plan[] {
  const tickets = store.tickets(project.id);
  if (spec.merge.strategy === "pr") {
    // A stacked ticket that has not merged is read against the commit it is stacked on, so its dependencies' changes are not counted as its own.
    const against = (ticket: TicketRow) => (ticket.state === "done" ? null : stackOf(ticket)?.base) ?? remoteBaseOf(repoSettings(spec, ticket.repo));
    return tickets.map((ticket) => unmergedPlan(ticket, spec, { against: against(ticket), landed: ticket.state === "done" }));
  }

  const branch = spec.merge.branch!;
  const finished = project.state === "done" || project.state === "archived";
  const merges = mergesOf(store, project.id);
  const merged = tickets.filter((ticket) => merges.has(ticket.id)).sort((a, b) => merges.get(a.id)!.at - merges.get(b.id)!.at || a.seq - b.seq);
  const wholes = repos.map((repo): Plan => {
    const own = merged.filter((ticket) => ticket.repo === repo.name);
    const first = own.length === 0 ? null : merges.get(own[0]!.id)!;
    const last = own.length === 0 ? null : merges.get(own.at(-1)!.id)!;
    const remoteBase = remoteBaseOf(repo);
    return {
      source: {
        id: repo.name === null ? "branch" : `branch:${repo.name}`,
        kind: "branch",
        repo: repo.name,
        key: null,
        title: null,
        state: null,
        against: finished ? `${branch} before its first merge` : remoteBase,
        at: last?.at ?? null,
        attempt: 0,
        reviewRound: 0,
      },
      read:
        first === null || last === null
          ? { kind: "none", note: "Nothing merged yet." }
          : finished
            ? { kind: "git", input: { base: first.before, head: last.sha, mergeBase: false } }
            : { kind: "git", input: { base: remoteBase, head: `refs/heads/${branch}`, mergeBase: true } },
    };
  });
  return [
    ...wholes,
    ...merged.map((ticket) => {
      const merge = merges.get(ticket.id)!;
      return { source: ticketSource(ticket, "merge", branch, merge.at), read: { kind: "git", input: { base: merge.before, head: merge.sha, mergeBase: false } } } satisfies Plan;
    }),
    ...tickets.filter((ticket) => !merges.has(ticket.id)).map((ticket) => unmergedPlan(ticket, spec, { against: branch, landed: false })),
  ];
}

const gitFile = (file: Listing["files"][number]): ChangedFile => ({ ...file, previousPath: null, untracked: false, fingerprint: file.blob ?? "deleted", tickets: [] });
const liveFile = (file: EnvironmentFile): ChangedFile => ({ ...file, fingerprint: `live:${file.status}:${file.additions}:${file.deletions}`, tickets: [] });

// A source in a repo that has no checkout to read it in.
const unread = (plan: Plan, note: string): ChangeSource => ({ ...plan.source, base: null, head: null, files: null, truncated: false, note, gone: false });

/** The repo a patch between two commits is read in: a name of the spec's [[repo]] tables on a multi-repo project, else none. */
function patchRepo(slug: string, spec: Spec, repo: string | undefined): string | null {
  if (!isMultiRepo(spec)) {
    if (repo !== undefined) throw new LoomError("loom_invalid_input", `${slug} has no [[repo]] tables, so a file's patch is read in its one repository and takes no repo.`);
    return null;
  }
  const names = spec.repo!.map((entry) => entry.name);
  if (repo === undefined) throw new LoomError("loom_invalid_input", `A file's patch in ${slug} needs the repo it is read in: one of ${names.join(", ")}.`);
  if (!names.includes(repo)) throw new LoomError("loom_invalid_input", `Project ${slug} has no repo "${repo}"; its repos are ${names.join(", ")}.`);
  return repo;
}

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

  /**
   * The checkout of repo `name` to read git in, or why there is none: a deleted bb project, like a missing checkout, leaves nothing to read.
   * A named repo without a checkout says so with repoCheckout's message, which names the repo and the clone command.
   */
  private async checkout(project: ProjectRow, spec: Spec, name: string | null): Promise<RepoCheckout | string> {
    try {
      return await repoCheckout(this.deps, project, spec, name);
    } catch (error) {
      const missing = error instanceof LoomError && error.code === "loom_no_checkout";
      if (name !== null) return missing ? error.message : `The checkout of the repo "${name}" cannot be found, so its changes cannot be read: ${errText(error)}`;
      return missing ? `The bb project has no checkout on the machine ${project.host_id ?? "(unknown)"}, so its changes cannot be read.` : `The project's checkout cannot be found, so its changes cannot be read: ${errText(error)}`;
    }
  }

  private async listing(checkout: RepoCheckout, input: GitRead): Promise<HostOutput<"changedFiles">> {
    const request = { repo: checkout.path, maxFiles: MAX_FILES, ...input };
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

  private async read(checkout: RepoCheckout, plan: Plan): Promise<ChangeSource> {
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
      repos: [],
      sources: [],
      unavailable: null,
    };
    if (spec === null) return { ...view, unavailable: "The project has no approved spec yet." };
    const settings = reposOf(spec);
    const checkouts = new Map(await Promise.all(settings.map(async (repo) => [repo.name, await this.checkout(project, spec, repo.name)] as const)));
    const repos = settings.map((repo): ChangeRepo => {
      const checkout = checkouts.get(repo.name)!;
      return { name: repo.name, base: repo.base, remoteBase: remoteBaseOf(repo), branch: repo.branch, unavailable: typeof checkout === "string" ? checkout : null };
    });
    if (repos.every((repo) => repo.unavailable !== null)) {
      return { ...view, repos, unavailable: repos.length === 1 ? repos[0]!.unavailable : `None of the project's repos can be read. ${repos.map((repo) => repo.unavailable).join(" ")}` };
    }
    const sources = await inBatches(plansOf(this.deps.store, project, spec, settings), READS_AT_ONCE, (plan) => {
      const checkout = checkouts.get(plan.source.repo)!;
      return typeof checkout === "string" ? Promise.resolve(unread(plan, checkout)) : this.read(checkout, plan);
    });
    for (const whole of sources.filter((source) => source.kind === "branch")) {
      const merged = sources.filter((source) => source.kind === "merge" && source.repo === whole.repo);
      for (const file of whole.files ?? []) file.tickets = merged.filter((source) => source.files?.some((other) => other.path === file.path)).map((source) => source.key!);
    }
    return { ...view, repos, sources };
  }

  /**
   * One file's patch: between two commits of a listing, read in the checkout of `repo` (required on a multi-repo project), or in a
   * working ticket's worktree when `key` names it.
   */
  async patch(input: { slug: string; path: string; base?: string; head?: string; key?: string; repo?: string }): Promise<FilePatch> {
    const project = this.project(input.slug);
    if (input.key !== undefined) {
      const ticket = this.deps.store.ticketByKey(input.key);
      if (ticket === null || ticket.project_id !== project.id) throw new LoomError("loom_not_found", `No ticket ${input.key} in ${input.slug}.`);
      if (ticket.environment_id === null) return { patch: null, message: `${ticket.key} has no worktree now.` };
      const live = await this.deps.bb.environmentPatch(ticket.environment_id, baseOf(specOf(this.deps.store, project), ticket), input.path);
      return live.outcome === "ok" ? { patch: live.patch, truncated: live.truncated } : { patch: null, message: live.message };
    }
    if (input.base === undefined || input.head === undefined) throw new LoomError("loom_invalid_input", "A file's patch needs the two commits it is read between, or the key of a working ticket.");
    if (project.approved_version === null) return { patch: null, message: "The project has no approved spec yet." };
    const spec = specOf(this.deps.store, project);
    const checkout = await this.checkout(project, spec, patchRepo(input.slug, spec, input.repo));
    if (typeof checkout === "string") return { patch: null, message: checkout };
    const result = await this.deps.host.call(checkout.hostId, "filePatch", { repo: checkout.path, base: input.base, head: input.head, path: input.path, maxBytes: PATCH_BYTES });
    return result.outcome === "ok" ? { patch: result.patch, truncated: result.truncated } : { patch: null, message: `Its commits are no longer in the repository: ${result.message}` };
  }
}
