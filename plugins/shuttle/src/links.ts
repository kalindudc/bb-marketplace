// Which git thing a link names, for the link cards in threads: a PR or one of its pages, a comment or
// review on it, a commit, a check run, or an issue. Pure, so the page script and the server read links the same way.
import type { ServerConfig } from "./config";
import { linkPattern, prKey, REPO, type PrRef } from "./keys";

export const LINK_KINDS = ["pr", "comment", "review", "commit", "check", "issue"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const PR_PARTS = ["overview", "files", "commits", "checks"] as const;
export type PrPart = (typeof PR_PARTS)[number];

export type LinkTarget =
  | { kind: "pr"; server: string; repo: string; ref: PrRef; part: PrPart }
  /** `anchor` as the server writes it after the "#": issuecomment-123 or discussion_r123. */
  | { kind: "comment"; server: string; repo: string; ref: PrRef; anchor: string }
  /** pullrequestreview-123. */
  | { kind: "review"; server: string; repo: string; ref: PrRef; anchor: string }
  /** `ref` is the PR the link is on, when it is a PR's commit. */
  | { kind: "commit"; server: string; repo: string; sha: string; ref: PrRef | null }
  /** A check run by its id, or a workflow run by its id (and the job, which is a check run). */
  | { kind: "check"; server: string; repo: string; checkRun: number | null; run: number | null; ref: PrRef | null }
  /** An issue, or a comment on one. Its number can be a PR's too, which only the server or Shuttle's copy can say. */
  | { kind: "issue"; server: string; repo: string; number: number; ref: null };

/** The host of a server's repository pages: GitHub's, or the one its PR link template names. */
function hostOf(server: ServerConfig): string | null {
  if (server.kind === "github") return server.hostname ?? "github.com";
  const match = server.link ? /^https?:\/\/([^/]+)\/\{repo\}\/pull\/\{number\}\/?$/u.exec(server.link) : null;
  return match?.[1] ?? null;
}

function split(rest: string): { path: string; query: URLSearchParams; hash: string } {
  const hashAt = rest.indexOf("#");
  const hash = hashAt < 0 ? "" : rest.slice(hashAt + 1);
  const before = hashAt < 0 ? rest : rest.slice(0, hashAt);
  const queryAt = before.indexOf("?");
  return {
    path: (queryAt < 0 ? before : before.slice(0, queryAt)).replace(/\/+$/u, ""),
    query: new URLSearchParams(queryAt < 0 ? "" : before.slice(queryAt + 1)),
    hash,
  };
}

function onPr(server: ServerConfig, ref: PrRef, rest: string): LinkTarget | null {
  // The PR's number must end where its pattern stopped: /pull/12 is not /pull/123.
  if (rest !== "" && !/^[/?#]/u.test(rest)) return null;
  const base = { server: server.id, repo: ref.repo, ref };
  const { path, query, hash } = split(rest);
  const comment = /^(issuecomment-\d+|discussion_r\d+)$/u.exec(hash)?.[1] ?? (/^r(\d+)$/u.exec(hash) ? `discussion_${hash}` : null);
  if (comment !== null) return { kind: "comment", ...base, anchor: comment };
  const review = /^pullrequestreview-\d+$/u.exec(hash)?.[0];
  if (review !== undefined) return { kind: "review", ...base, anchor: review };
  const commit = /^\/(?:commits|files|changes)\/([0-9a-f]{7,40})$/u.exec(path)?.[1];
  if (commit !== undefined) return { kind: "commit", ...base, sha: commit };
  if (path === "/checks") {
    const id = Number(query.get("check_run_id"));
    return Number.isInteger(id) && id > 0 ? { kind: "check", ...base, checkRun: id, run: null } : { kind: "pr", ...base, part: "checks" };
  }
  const part: PrPart = path === "/files" || path === "/changes" ? "files" : path === "/commits" ? "commits" : "overview";
  return { kind: "pr", ...base, part };
}

function onRepo(server: ServerConfig, repo: string, rest: string): LinkTarget | null {
  const { path } = split(rest);
  const commit = /^\/commit\/([0-9a-f]{7,40})$/u.exec(path)?.[1];
  if (commit !== undefined) return { kind: "commit", server: server.id, repo, sha: commit, ref: null };
  const job = /^\/actions\/runs\/(\d+)\/job\/(\d+)$/u.exec(path);
  if (job) return { kind: "check", server: server.id, repo, run: Number(job[1]), checkRun: Number(job[2]), ref: null };
  const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/u.exec(path);
  if (run) return { kind: "check", server: server.id, repo, run: Number(run[1]), checkRun: null, ref: null };
  const checkRun = /^\/runs\/(\d+)$/u.exec(path);
  if (checkRun) return { kind: "check", server: server.id, repo, run: null, checkRun: Number(checkRun[1]), ref: null };
  const issue = /^\/issues\/(\d+)$/u.exec(path);
  if (issue && Number(issue[1]) > 0) return { kind: "issue", server: server.id, repo, number: Number(issue[1]), ref: null };
  return null;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** What a link names on one of the enabled servers; null for anything else, such as a file or a repository. */
export function parseGitLink(url: string, servers: readonly ServerConfig[]): LinkTarget | null {
  const value = url.trim();
  if (!/^https?:\/\//iu.test(value)) return null;
  for (const server of servers) {
    if (!server.enabled) continue;
    const found = linkPattern(server).exec(value);
    // A pattern written without ^ must still match from the start, or a link to any site that quotes one would pass.
    const match = found?.index === 0 ? found : null;
    const repo = match?.groups?.repo;
    const number = Number(match?.groups?.number);
    if (match && repo && REPO.test(repo) && Number.isInteger(number) && number > 0) {
      const target = onPr(server, { server: server.id, repo, number }, value.slice(match.index + match[0].length));
      if (target !== null) return target;
    }
    const host = hostOf(server);
    if (host === null) continue;
    const page = new RegExp(`^https?://(?:www\\.)?${escape(host)}/([^/\\s?#]+/[^/\\s?#]+)(/.*)?$`, "u").exec(value);
    if (page && REPO.test(page[1]!) && !/^\/pull\//u.test(page[2] ?? "")) {
      const target = onRepo(server, page[1]!, page[2] ?? "");
      if (target !== null) return target;
    }
  }
  return null;
}

/** One string per thing a link names, so two links to it share one card. */
export function linkKey(target: LinkTarget): string {
  switch (target.kind) {
    case "pr": return `pr ${prKey(target.ref)}`;
    case "comment":
    case "review": return `${target.kind} ${prKey(target.ref)} ${target.anchor}`;
    case "commit": return `commit ${target.server}:${target.repo}@${target.sha.slice(0, 12)}`;
    case "check": return `check ${target.server}:${target.repo} ${target.run ?? ""}/${target.checkRun ?? ""}`;
    case "issue": return `issue ${target.server}:${target.repo}#${target.number}`;
  }
}
