import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface GitHubRepo {
  owner: string;
  name: string;
}

export interface GitHubCommit {
  sha: string;
  title: string;
  url: string;
}

export interface GitHub {
  /** A file's text at a commit, or null when the file is not there. */
  file(repo: GitHubRepo, path: string, ref: string): Promise<string | null>;
  /** A commit's committer date, as GitHub's ISO 8601 text. */
  commitDate(repo: GitHubRepo, sha: string): Promise<string>;
  /**
   * Up to COMMIT_PAGE commits reachable from `head`, newest first, committed at or after `since`, touching `path`
   * when one is given. GitHub's compare endpoint is not used: it returns the oldest commits of a range first and stops
   * at 250, so in a busy monorepo the plugin's own commits fall outside it.
   */
  commits(repo: GitHubRepo, query: { head: string; since: string; path: string | null }): Promise<GitHubCommit[]>;
}

export const COMMIT_PAGE = 100;

/** Reads one GitHub REST path. Throws NotFoundError for a 404. */
export type Transport = (path: string, accept: "json" | "raw") => Promise<string>;

export class NotFoundError extends Error {}

/** Signals that a transport cannot be used at all, so the next one should be tried. */
export class TransportUnavailableError extends Error {}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/u;

/**
 * owner and name from any of bb's git source forms, or null unless the source's host is github.com itself.
 * Handles URLs (https, ssh, git), scp-style "git@github.com:owner/repo", a bare "github.com/owner/repo", bb's "git:"
 * prefix, and the "@ref (commit)" bb appends when it shows a resolved source.
 */
export function parseGitHubRepo(source: string): GitHubRepo | null {
  let text = source.trim().split(/\s/u)[0] ?? "";
  if (/^git:(?!\/\/)/iu.test(text)) text = text.slice("git:".length);

  let host: string;
  let path: string;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(text);
  if (hasScheme || /^github\.com\//iu.test(text)) {
    let url: URL;
    try {
      url = new URL(hasScheme ? text : `https://${text}`);
    } catch {
      return null;
    }
    host = url.hostname;
    path = url.pathname;
  } else {
    const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(.+)$/u.exec(text);
    if (scp === null) return null;
    host = scp[1]!;
    path = scp[2]!;
  }
  if (host.toLowerCase() !== "github.com") return null;

  const [owner, repo] = path.replace(/^\/+/u, "").split("/");
  const name = repo?.split(/[@#?]/u)[0]?.replace(/\.git$/u, "");
  if (owner === undefined || name === undefined || !GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(name)) return null;
  if (name === "." || name === "..") return null;
  return { owner, name };
}

export function repoUrl(repo: GitHubRepo): string {
  return `https://github.com/${repo.owner}/${repo.name}`;
}

export function createGitHub(transport: Transport): GitHub {
  const base = (repo: GitHubRepo) => `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  return {
    async file(repo, path, ref) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      try {
        return await transport(`${base(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, "raw");
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    async commitDate(repo, sha) {
      const body = JSON.parse(await transport(`${base(repo)}/commits/${encodeURIComponent(sha)}`, "json")) as {
        commit: { committer: { date: string } };
      };
      return body.commit.committer.date;
    },
    async commits(repo, { head, since, path }) {
      const query = new URLSearchParams({ sha: head, since, per_page: String(COMMIT_PAGE) });
      if (path !== null) query.set("path", path);
      const body = JSON.parse(await transport(`${base(repo)}/commits?${query}`, "json")) as Array<{
        sha: string;
        html_url: string;
        commit: { message: string };
      }>;
      return body.map((commit) => ({
        sha: commit.sha,
        title: commit.commit.message.split("\n")[0]!.trim(),
        url: commit.html_url,
      }));
    },
  };
}

/** Tries each transport in order, moving on only when one cannot be used at all. */
export function firstAvailable(...transports: Transport[]): Transport {
  return async (path, accept) => {
    let last: unknown = new Error("no GitHub transport");
    for (const transport of transports) {
      try {
        return await transport(path, accept);
      } catch (error) {
        if (!(error instanceof TransportUnavailableError)) throw error;
        last = error;
      }
    }
    throw last;
  };
}

export type Exec = (
  file: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const GH_TIMEOUT_MS = 20_000;
const GH_MAX_BUFFER = 32 * 1024 * 1024;

/** bb can start without a login shell's PATH, so the usual tool directories are added. */
export function toolPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin")]) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(delimiter);
}

export const execProcess: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env: { ...process.env, PATH: toolPath() }, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout, stderr });
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      },
    );
  });

/** `gh api`, signed in as the user, so private repositories read too. */
export function ghTransport(exec: Exec = execProcess): Transport {
  return async (path, accept) => {
    const args = ["api", path, "-H", `Accept: ${accept === "raw" ? "application/vnd.github.raw" : "application/vnd.github+json"}`];
    let result: Awaited<ReturnType<Exec>>;
    try {
      result = await exec("gh", args);
    } catch (error) {
      throw new TransportUnavailableError(`gh could not start: ${(error as Error).message}`);
    }
    if (result.code === 0) return result.stdout;
    const message = result.stderr.trim();
    if (/HTTP 404/u.test(message)) throw new NotFoundError(message);
    if (result.code === 4 || /gh auth login|not logged in/iu.test(message)) throw new TransportUnavailableError(message);
    throw new Error(message.split("\n").slice(-2).join(" ") || `gh api exited with ${result.code}`);
  };
}

/** The public API without a token: enough for public repositories, within GitHub's anonymous rate limit. */
export function publicTransport(fetchImpl: typeof fetch = fetch): Transport {
  return async (path, accept) => {
    const response = await fetchImpl(`https://api.github.com/${path}`, {
      headers: {
        Accept: accept === "raw" ? "application/vnd.github.raw" : "application/vnd.github+json",
        "User-Agent": "bb-plugin-update-shelf",
      },
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status === 404) throw new NotFoundError(`GitHub has no ${path}`);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${text.slice(0, 200)}`);
    return text;
  };
}
