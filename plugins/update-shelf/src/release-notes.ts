import type { Changelog } from "./contract";
import { sliceChangelog } from "./changelog";
import { COMMIT_PAGE, parseGitHubRepo, repoUrl, type GitHub, type GitHubCommit, type GitHubRepo } from "./github";
import { isCommit, isSemver } from "./versions";

export interface ReleaseNotesInput {
  /** bb's source text for the plugin: its resolved source, or the requested one. */
  source: string;
  subdirectory: string | null;
  installedCommit: string | null;
  candidateCommit: string;
  /** The installed package version. */
  installedVersion: string | null;
  /** The candidate's release version when its tag names one. */
  candidateVersion: string | null;
}

const SHOWN_COMMITS = 30;

const empty = (unavailable: string | null): Changelog => ({
  toVersion: null,
  notes: [],
  commits: [],
  moreCommits: 0,
  commitsCapped: false,
  changelogError: null,
  commitsError: null,
  compareUrl: null,
  unavailable,
});

/**
 * What changed between the installed and the candidate commit, read from the plugin's source repository:
 * the candidate's CHANGELOG.md sections newer than the installed version, and the commits that touched the plugin.
 * A part that cannot be read is left out; only when every part fails does the result say why.
 */
export async function releaseNotes(input: ReleaseNotesInput, github: GitHub): Promise<Changelog> {
  const repo = parseGitHubRepo(input.source);
  if (repo === null) return empty(`Changelogs are read from GitHub, and this plugin installs from ${input.source}.`);
  if (!isCommit(input.candidateCommit)) return empty("This update is not a git commit, so there is no source to read.");

  const subdirectory = input.subdirectory?.replace(/^\.?\/+|\/+$/gu, "") || null;
  const prefix = subdirectory === null ? "" : `${subdirectory}/`;
  const installed = input.installedCommit !== null && isCommit(input.installedCommit) ? input.installedCommit : null;

  const [changelogFile, packageFile, touched] = await Promise.allSettled([
    github.file(repo, `${prefix}CHANGELOG.md`, input.candidateCommit),
    input.candidateVersion !== null ? Promise.resolve(null) : github.file(repo, `${prefix}package.json`, input.candidateCommit),
    installed === null ? Promise.resolve(null) : commitsSince(github, repo, installed, input.candidateCommit, subdirectory),
  ]);

  const toVersion = input.candidateVersion ?? packageVersion(packageFile);
  const notes =
    changelogFile.status === "fulfilled" && changelogFile.value !== null
      ? sliceChangelog(changelogFile.value, { from: input.installedVersion, to: toVersion })
      : [];
  const relevant = touched.status === "fulfilled" && touched.value !== null ? touched.value : null;
  const commits = (relevant?.commits ?? []).slice(0, SHOWN_COMMITS);

  const changelogError = reason(changelogFile) ?? reason(packageFile);
  const commitsError = reason(touched);
  const firstError = changelogError ?? commitsError;
  // With nothing to show, a part that failed means the answer is unknown, not that nothing changed.
  const nothingRead = notes.length === 0 && commits.length === 0;

  return {
    toVersion,
    notes,
    commits,
    moreCommits: (relevant?.commits.length ?? 0) - commits.length,
    commitsCapped: relevant?.capped ?? false,
    changelogError,
    commitsError,
    compareUrl:
      installed === null
        ? `${repoUrl(repo)}/commits/${input.candidateCommit}`
        : `${repoUrl(repo)}/compare/${installed}...${input.candidateCommit}`,
    unavailable: nothingRead && firstError !== null ? `Couldn't read ${repo.owner}/${repo.name}: ${firstError}` : null,
  };
}

/** Whether every part of a changelog was read, so it can be kept until the update changes. */
export function isComplete(changelog: Changelog): boolean {
  return changelog.unavailable === null && changelog.changelogError === null && changelog.commitsError === null;
}

function reason(result: PromiseSettledResult<unknown>): string | null {
  if (result.status === "fulfilled") return null;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

/** The commits that touched the plugin since the installed commit, newest first. */
async function commitsSince(
  github: GitHub,
  repo: GitHubRepo,
  installed: string,
  candidate: string,
  path: string | null,
): Promise<{ commits: GitHubCommit[]; capped: boolean }> {
  const since = await github.commitDate(repo, installed);
  const page = await github.commits(repo, { head: candidate, since, path });
  return { commits: page.filter((commit) => commit.sha !== installed), capped: page.length >= COMMIT_PAGE };
}

function packageVersion(result: PromiseSettledResult<string | null>): string | null {
  if (result.status !== "fulfilled" || result.value === null) return null;
  try {
    const version = (JSON.parse(result.value) as { version?: unknown }).version;
    return typeof version === "string" && isSemver(version) ? version : null;
  } catch {
    return null;
  }
}
