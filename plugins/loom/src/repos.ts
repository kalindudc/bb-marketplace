import type { EnvironmentSpec, ForgeSpec, RepoSpec, Spec } from "./spec";

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
   * false, and only on a forge that reports checks, which loom_propose requires of a spec that sets ci = true.
   */
  ci: boolean;
  /** The environment provider its workers and reviewers start in; null for today's managed worktree. */
  environment: EnvironmentSpec | null;
  /** How many commits of its remote base an open pull request's branch may lack before Loom merges the base into it; null is off. */
  refreshBehind: number | null;
  /** How long each git fetch, ls-remote or push for it may take; null when the spec sets none, so the host's default applies. */
  gitNetworkTimeoutMs: number | null;
}

/** The integration branch, loom/<slug> in every repo; null on the pr strategy. */
export function integrationBranchOf(spec: Spec): string | null {
  return spec.merge.strategy === "integration" ? `loom/${spec.project.slug}` : null;
}

export function isMultiRepo(spec: Spec): boolean {
  return (spec.repo?.length ?? 0) > 0;
}

function settingsOf(spec: Spec, repo: RepoSpec | null): RepoSettings {
  const forge = repo?.forge ?? spec.merge.forge ?? { kind: "gh" };
  const seconds = repo?.git_network_timeout_seconds ?? spec.merge.git_network_timeout_seconds;
  return {
    name: repo?.name ?? null,
    bbProjectId: repo?.project ?? null,
    base: repo?.base ?? spec.project.base,
    remote: repo?.remote ?? spec.merge.remote,
    branch: integrationBranchOf(spec),
    checks: [...(repo?.checks ?? spec.checks.commands)],
    afterMerge: [...(repo?.after_merge ?? spec.checks.after_merge)],
    protected: [...spec.scope.protected, ...(repo?.protected ?? [])],
    forge,
    ci: spec.merge.strategy === "pr" && (repo?.ci ?? spec.checks.ci ?? true) && followsFeedback(forge),
    environment: repo?.environment ?? spec.environment ?? null,
    refreshBehind: spec.merge.strategy === "pr" ? (repo?.refresh_behind ?? spec.merge.refresh_behind ?? null) : null,
    gitNetworkTimeoutMs: seconds === undefined ? null : seconds * 1000,
  };
}

/**
 * The networkTimeoutMs to give a host call that fetches, runs ls-remote or pushes in this repo. Empty when the spec sets none,
 * so the call is what it was before the setting existed.
 */
export function gitNetwork(settings: Pick<RepoSettings, "gitNetworkTimeoutMs">): { networkTimeoutMs?: number } {
  return settings.gitNetworkTimeoutMs === null ? {} : { networkTimeoutMs: settings.gitNetworkTimeoutMs };
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
  /** Fix rounds the pull request's CI and review feedback may start before the ticket blocks; 0 follows only merged and closed. */
  maxFixRounds: number;
  /** A ticket starts once its dependencies' pull requests are open, on top of them in its own repo, instead of once they merged. */
  stack: boolean;
}

/** What prSettings reads for each [merge] key the spec leaves out; the parser leaves them out so old specs hash as they did. */
export const PR_DEFAULTS = { describe: "worker", max_fix_rounds: 5, stack: true } as const;

export function prSettings(spec: Spec): PrSettings {
  return { describe: spec.merge.describe ?? PR_DEFAULTS.describe, maxFixRounds: spec.merge.max_fix_rounds ?? PR_DEFAULTS.max_fix_rounds, stack: spec.merge.stack ?? PR_DEFAULTS.stack };
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
  requireLive: boolean;
  maxAttempts: number;
  /** Whether a final review runs before each merge. */
  finalReview: boolean;
}

export const AUTO_MERGE_ATTEMPTS = 3;
/** What autoMergeOf reads for each auto_merge key the spec leaves out. */
export const AUTO_MERGE_DEFAULTS = { mode: "manual", require_live: false, max_attempts: AUTO_MERGE_ATTEMPTS } as const;

export function autoMergeOf(forge: ForgeSpec): AutoMergeSettings | null {
  const auto = forge.auto_merge;
  if (auto === undefined || forge.kind === "none") return null;
  return { method: auto.method, mode: auto.mode ?? AUTO_MERGE_DEFAULTS.mode, comment: auto.comment ?? null, rejected: [...(auto.rejected ?? [])], requireLive: auto.require_live ?? AUTO_MERGE_DEFAULTS.require_live, maxAttempts: auto.max_attempts ?? AUTO_MERGE_DEFAULTS.max_attempts, finalReview: auto.final_review !== undefined };
}

/** The methods that may run again after a failure Loom cannot read: gh merges or queues a pull request at most once, while a comment or a command could be posted twice. */
export const repeatableMerge = (method: AutoMergeSettings["method"]) => method !== "comment" && method !== "command";
