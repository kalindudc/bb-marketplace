import { describe, expect, it } from "vitest";
import { COMMIT_PAGE, type GitHub, type GitHubCommit } from "../src/github";
import { releaseNotes, type ReleaseNotesInput } from "../src/release-notes";

const INSTALLED = "d86c13657608fc30aca5771aa94d531c11d053cc";
const CANDIDATE = "f1fb0e872fb287da2ffb49363bbf81513825cc29";

const commit = (sha: string, title: string): GitHubCommit => ({ sha, title, url: `https://github.com/o/r/commit/${sha}` });

const INPUT: ReleaseNotesInput = {
  source: "https://github.com/o/r.git@genui/v0.2.6 (d86c13657608)",
  subdirectory: "plugins/genui",
  installedCommit: INSTALLED,
  candidateCommit: CANDIDATE,
  installedVersion: "0.2.6",
  candidateVersion: "0.2.7",
};

type Query = Parameters<GitHub["commits"]>[1];

function fakeGitHub(
  files: Record<string, string>,
  overrides: Partial<GitHub> = {},
): GitHub & { reads: string[]; queries: Query[] } {
  const reads: string[] = [];
  const queries: Query[] = [];
  return {
    reads,
    queries,
    async file(_repo, path, ref) {
      reads.push(`${path}@${ref}`);
      return files[path] ?? null;
    },
    async commitDate(_repo, sha) {
      return sha === INSTALLED ? "2026-10-21T12:00:00Z" : "1970-01-01T00:00:00Z";
    },
    async commits(_repo, query) {
      queries.push(query);
      return [commit("c", "genui: tests"), commit("b", "genui: trusted dirs"), commit(INSTALLED, "genui 0.2.6")];
    },
    ...overrides,
  };
}

describe("releaseNotes", () => {
  it("reads the candidate's changelog for the new releases and the commits that touched the plugin since", async () => {
    const github = fakeGitHub({ "plugins/genui/CHANGELOG.md": "## [0.2.7]\n- New\n\n## [0.2.6]\n- Old\n" });
    const result = await releaseNotes(INPUT, github);
    expect(result.notes).toEqual([{ version: "0.2.7", title: "0.2.7", body: "- New" }]);
    expect(result.commits.map((entry) => entry.sha)).toEqual(["c", "b"]);
    expect(result.moreCommits).toBe(0);
    expect(result.commitsCapped).toBe(false);
    expect(result.compareUrl).toBe(`https://github.com/o/r/compare/${INSTALLED}...${CANDIDATE}`);
    expect(result.unavailable).toBeNull();
    expect(github.reads).toEqual([`plugins/genui/CHANGELOG.md@${CANDIDATE}`]);
    expect(github.queries).toEqual([{ head: CANDIDATE, since: "2026-10-21T12:00:00Z", path: "plugins/genui" }]);
  });

  it("finds a monorepo plugin's commits however many other commits the range holds", async () => {
    // The bug this guards: GitHub's compare lists a range's oldest commits first, so a plugin's recent commits in a
    // 632-commit range were never returned. Commits are read by path from the candidate instead.
    const github = fakeGitHub({});
    const result = await releaseNotes({ ...INPUT, subdirectory: "plugins/notes" }, github);
    expect(github.queries[0]!.path).toBe("plugins/notes");
    expect(result.commits).toHaveLength(2);
  });

  it("reads the whole repository's commits for a plugin at the repository root", async () => {
    const github = fakeGitHub({});
    await releaseNotes({ ...INPUT, subdirectory: null }, github);
    expect(github.queries[0]!.path).toBeNull();
  });

  it("lists at most 30 commits and says when GitHub's page was full", async () => {
    const many = Array.from({ length: COMMIT_PAGE }, (_, index) => commit(`s${index}`, `change ${index}`));
    const result = await releaseNotes(INPUT, fakeGitHub({}, { commits: async () => many }));
    expect(result.commits).toHaveLength(30);
    expect(result.moreCommits).toBe(COMMIT_PAGE - 30);
    expect(result.commitsCapped).toBe(true);
  });

  it("reads the candidate's package version when its source names no release", async () => {
    const github = fakeGitHub({
      "plugins/genui/package.json": JSON.stringify({ version: "0.2.7" }),
      "plugins/genui/CHANGELOG.md": "## 0.2.7\n- New\n",
    });
    const result = await releaseNotes({ ...INPUT, candidateVersion: null }, github);
    expect(result.toVersion).toBe("0.2.7");
    expect(result.notes.map((entry) => entry.version)).toEqual(["0.2.7"]);
  });

  it("still lists the commits when the changelog has no entry for the candidate", async () => {
    const result = await releaseNotes(INPUT, fakeGitHub({ "plugins/genui/CHANGELOG.md": "## [0.2.6]\n- Old\n" }));
    expect(result.notes).toEqual([]);
    expect(result.commits).toHaveLength(2);
  });

  it("keeps what it could read when one part fails", async () => {
    const github = fakeGitHub(
      { "plugins/genui/CHANGELOG.md": "## [0.2.7]\n- New\n" },
      {
        async commits() {
          throw new Error("rate limited");
        },
      },
    );
    const result = await releaseNotes(INPUT, github);
    expect(result.notes).toHaveLength(1);
    expect(result.commits).toEqual([]);
    expect(result.unavailable).toBeNull();
    expect(result.commitsError).toBe("rate limited");
    expect(result.changelogError).toBeNull();
  });

  it("says it couldn't read the commits, rather than that there are none, when the changelog has no entry", async () => {
    // Review finding: a 404 for the changelog (null) plus a failed commit lookup read as "No changelog entry or
    // commits since", and that false answer was cached. This happens for a private repository without gh.
    const github = fakeGitHub(
      {},
      {
        async commitDate() {
          throw new Error("gh: Not Found (HTTP 404)");
        },
      },
    );
    const result = await releaseNotes(INPUT, github);
    expect(result.notes).toEqual([]);
    expect(result.commits).toEqual([]);
    expect(result.commitsError).toBe("gh: Not Found (HTTP 404)");
    expect(result.unavailable).toBe("Couldn't read o/r: gh: Not Found (HTTP 404)");
  });

  it("reports a changelog it couldn't read beside the commits it could", async () => {
    const github = fakeGitHub(
      {},
      {
        async file() {
          throw new Error("rate limited");
        },
      },
    );
    const result = await releaseNotes(INPUT, github);
    expect(result.commits).toHaveLength(2);
    expect(result.changelogError).toBe("rate limited");
    expect(result.commitsError).toBeNull();
    expect(result.unavailable).toBeNull();
  });

  it("says why when nothing could be read", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("Could not resolve to a Repository");
    };
    const result = await releaseNotes(INPUT, { file: fail, commitDate: fail, commits: fail });
    expect(result.unavailable).toBe("Couldn't read o/r: Could not resolve to a Repository");
  });

  it("explains that only GitHub sources have a changelog", async () => {
    const result = await releaseNotes({ ...INPUT, source: "git:https://gitlab.com/acme/notes.git@main" }, fakeGitHub({}));
    expect(result.unavailable).toMatch(/read from GitHub/u);
    expect(result.compareUrl).toBeNull();
  });

  it("does not read a repository for an npm update", async () => {
    const github = fakeGitHub({});
    const result = await releaseNotes({ ...INPUT, candidateCommit: "1.4.0" }, github);
    expect(result.unavailable).toMatch(/not a git commit/u);
    expect(github.reads).toEqual([]);
  });
});
