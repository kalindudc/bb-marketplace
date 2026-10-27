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
}

export function isMultiRepo(spec: Spec): boolean {
  return (spec.repo?.length ?? 0) > 0;
}

function settingsOf(spec: Spec, repo: RepoSpec | null): RepoSettings {
  const forge = repo?.forge ?? spec.merge.forge ?? { kind: "gh" };
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
  };
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

/** Where a worker's branch starts in a repo when no earlier worker left one. */
export function freshBaseOf(spec: Spec, name: string | null): string {
  const settings = repoSettings(spec, name);
  return settings.branch ?? `${settings.remote}/${settings.base}`;
}
