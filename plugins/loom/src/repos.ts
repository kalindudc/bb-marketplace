import type { RepoSpec, Spec } from "./spec";

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
}

export function isMultiRepo(spec: Spec): boolean {
  return (spec.repo?.length ?? 0) > 0;
}

function settingsOf(spec: Spec, repo: RepoSpec | null): RepoSettings {
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

/** Where a worker's branch starts in a repo when no earlier worker left one. */
export function freshBaseOf(spec: Spec, name: string | null): string {
  const settings = repoSettings(spec, name);
  return settings.branch ?? `${settings.remote}/${settings.base}`;
}
