import type { EnvironmentSpec, ForgeSpec, RepoSpec, Spec, WorktreeSpec } from "./spec";

/** One repository of a project, with every setting the spec leaves to the top level filled in from it. */
export interface RepoSettings {
  /** The [[repo]] name, or null for the project's own repository in a single-repo spec. */
  name: string | null;
  /** Null for the project's own repository: the caller uses the Loom project's bb project. */
  bbProjectId: string | null;
  base: string;
  remote: string;
  /** The integration branch, which has the same name in every repo; null on the pr strategy. */
  branch: string | null;
  checks: string[];
  afterMerge: string[];
  protected: string[];
  /** Where its pull requests open; gh when the spec names none. */
  forge: ForgeSpec;
  /**
   * Loom relies on the pull requests' CI for every test the plugin checks do not run: on the pr strategy unless ci is
   * false, and only on a forge that reports checks, which loom_propose requires of a spec that relies on it.
   */
  ci: boolean;
  /** The environment provider its workers and reviewers start in; null for today's managed worktree. */
  environment: EnvironmentSpec | null;
  /** The command that prepares its integration worktree; null for Loom's own git worktree. */
  worktree: WorktreeSpec | null;
  /** How many commits of its remote base an open pull request's branch may lack before Loom merges the base into it; null is off. */
  refreshBehind: number | null;
  /** How long each git fetch, ls-remote or push for it may take; null when the spec sets none, so the host's default applies. */
  gitNetworkTimeoutMs: number | null;
  /** How long the index and tree steps of one host call on its checkout may take together; null when the spec sets none. */
  gitIndexTimeoutMs: number | null;
}

export function isMultiRepo(spec: Spec): boolean {
  return (spec.repo?.length ?? 0) > 0;
}

function settingsOf(spec: Spec, repo: RepoSpec | null): RepoSettings {
  const forge = repo?.forge ?? spec.merge.forge ?? { kind: "gh" };
  const seconds = repo?.git_network_timeout_seconds ?? spec.merge.git_network_timeout_seconds;
  const index = repo?.git_index_timeout_seconds ?? spec.merge.git_index_timeout_seconds;
  return {
    name: repo?.name ?? null,
    bbProjectId: repo?.project ?? null,
    base: repo?.base ?? spec.project.base,
    remote: repo?.remote ?? spec.merge.remote,
    // parseSpec fills merge.branch in on the integration strategy, as freshBase in workers.ts relies on too.
    branch: spec.merge.strategy === "integration" ? spec.merge.branch! : null,
    checks: [...(repo?.checks ?? spec.checks.commands)],
    afterMerge: [...(repo?.after_merge ?? spec.checks.after_merge)],
    protected: [...spec.scope.protected, ...(repo?.protected ?? [])],
    forge,
    ci: spec.merge.strategy === "pr" && (repo?.ci ?? spec.checks.ci ?? true) && followsFeedback(forge),
    environment: repo?.environment ?? spec.environment ?? null,
    worktree: repo?.worktree ?? spec.merge.worktree ?? null,
    refreshBehind: spec.merge.strategy === "pr" ? (repo?.refresh_behind ?? spec.merge.refresh_behind ?? null) : null,
    gitNetworkTimeoutMs: seconds === undefined ? null : seconds * 1000,
    gitIndexTimeoutMs: index === undefined ? null : index * 1000,
  };
}

/**
 * The networkTimeoutMs to give a host call that fetches, runs ls-remote or pushes in this repo. Empty when the spec sets none,
 * so the call is what it was before the setting existed.
 */
export function gitNetwork(settings: Pick<RepoSettings, "gitNetworkTimeoutMs">): { networkTimeoutMs?: number } {
  return settings.gitNetworkTimeoutMs === null ? {} : { networkTimeoutMs: settings.gitNetworkTimeoutMs };
}

/** The indexTimeoutMs to give a host call that reads or writes a whole index or tree on this repo's checkout; empty when the spec sets none. */
export function gitIndex(settings: Pick<RepoSettings, "gitIndexTimeoutMs">): { indexTimeoutMs?: number } {
  return settings.gitIndexTimeoutMs === null ? {} : { indexTimeoutMs: settings.gitIndexTimeoutMs };
}

/** Throws for a name the spec does not list, and for null in a multi-repo spec, where every ticket names its repo. */
export function repoSettings(spec: Spec, name: string | null): RepoSettings {
  const repos = spec.repo ?? [];
  if (name === null) {
    if (repos.length > 0) throw new Error(`This spec lists [[repo]] tables, so a repo name is required: one of ${repos.map((repo) => repo.name).join(", ")}.`);
    return settingsOf(spec, null);
  }
  const repo = repos.find((entry) => entry.name === name);
  if (repo === undefined) {
    throw new Error(repos.length === 0 ? `This spec has no [[repo]] table, so it has no repo "${name}".` : `This spec has no repo "${name}"; its repos are ${repos.map((entry) => entry.name).join(", ")}.`);
  }
  return settingsOf(spec, repo);
}

/** How Loom writes, pushes and follows each ticket's pull request on the pr strategy. */
export interface PrSettings {
  /** Who writes the pull request's title, description and commit message: the ticket's worker, or Loom's template. */
  describe: "worker" | "loom";
  /** One commit per pull request, and one more per fix round, instead of the worker's branch as it is. */
  squash: boolean;
  /** Fix rounds the pull request's CI and review feedback may start before the ticket blocks; 0 follows only merged and closed. */
  maxFixRounds: number;
  /** A ticket starts once its dependencies' pull requests are open, on top of them in its own repo, instead of once they merged. */
  stack: boolean;
  /** An idle worker of an open pull request has its thread archived, freeing its environment, and comes back with a new one when the pull request needs it. */
  releaseWorkers: boolean;
}

export function prSettings(spec: Spec): PrSettings {
  return { describe: spec.merge.describe ?? "worker", squash: spec.merge.squash ?? true, maxFixRounds: spec.merge.max_fix_rounds ?? 5, stack: spec.merge.stack ?? true, releaseWorkers: spec.merge.release_workers ?? true };
}

/** Whether Loom can read a pull request's checks and reviews on this forge: gh, or a command forge with a feedback command. */
export function followsFeedback(forge: ForgeSpec): boolean {
  return forge.kind === "gh" || (forge.kind === "command" && forge.feedback !== undefined);
}

/** Whether Loom can set a pull request's title and description on this forge: gh, or a command forge with an edit command. */
/** Whether Loom can mark a draft pull request ready for review through this forge. */
export function canReady(forge: ForgeSpec): boolean {
  return forge.kind === "gh" || (forge.kind === "command" && forge.ready !== undefined);
}

export function canEdit(forge: ForgeSpec): boolean {
  return forge.kind === "gh" || (forge.kind === "command" && forge.edit !== undefined);
}

/** Whether Loom can answer a pull request's feedback on this forge: gh, or a command forge with a reply command. */
export function canReply(forge: ForgeSpec): boolean {
  return forge.kind === "gh" || (forge.kind === "command" && forge.reply !== undefined);
}

/** Where a worker's branch starts in a repo when no earlier worker left one. */
export function freshBaseOf(spec: Spec, name: string | null): string {
  const settings = repoSettings(spec, name);
  return settings.branch ?? `${settings.remote}/${settings.base}`;
}

/** How Loom merges a repo's ready pull requests itself, with the spec's unset keys filled in; null when the repo's forge does not opt in. */
export interface AutoMergeSettings {
  method: NonNullable<ForgeSpec["auto_merge"]>["method"];
  /** "manual" (the default): each pushed commit's merge waits for the human's confirmation; "auto": Loom asks once it is ready. */
  mode: "auto" | "manual";
  comment: string | null;
  rejected: string[];
  /** "forge": the forge's review decision must be approved; "loom": Loom's own reviewers' approval is enough, unless the forge asks for changes. */
  approval: "forge" | "loom";
  requireLive: boolean;
  maxAttempts: number;
  /** The final review before each merge, as the spec writes it; null when the spec has none. */
  finalReview: NonNullable<NonNullable<ForgeSpec["auto_merge"]>["final_review"]> | null;
}

export const AUTO_MERGE_ATTEMPTS = 3;

export function autoMergeOf(forge: ForgeSpec): AutoMergeSettings | null {
  const auto = forge.auto_merge;
  if (auto === undefined || forge.kind === "none") return null;
  return { method: auto.method, mode: auto.mode ?? "manual", comment: auto.comment ?? null, rejected: [...(auto.rejected ?? [])], approval: auto.approval ?? "forge", requireLive: auto.require_live ?? false, maxAttempts: auto.max_attempts ?? AUTO_MERGE_ATTEMPTS, finalReview: auto.final_review ?? null };
}

/** The methods that may run again after a failure Loom cannot read: gh merges or queues a pull request at most once, while a comment or a command could be posted twice. */
export const repeatableMerge = (method: AutoMergeSettings["method"]) => method !== "comment" && method !== "command";
