import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { batchQuery, ghQueue, MERGE_REFUSED_EXIT, MERGE_REJECTED_EXIT, prFeedback, prMerge, prRequestReview, prReviewState, teamMembers } from "../src/host/ops";

const URL = "https://github.com/acme/shop/pull/7";
const SHA = "0123456789abcdef0123456789abcdef01234567";
let scratch: string;
let bin: string;
let repo: string;
let savedPath: string | undefined;
let counter = 0;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "loom-merge-host-")));
  savedPath = process.env.PATH;
});
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  bin = join(scratch, `bin-${counter}`);
  repo = join(scratch, `repo-${counter++}`);
  mkdirSync(bin);
  mkdirSync(repo);
  process.env.PATH = `${bin}:${savedPath}`;
});

const fakeGh = (script: string) => {
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ndir="${bin}"\nprintf '%s\\n' "$@" >> "$dir/args.txt"\nprintf -- '--\\n' >> "$dir/args.txt"\n${script}\n`);
  chmodSync(join(bin, "gh"), 0o755);
};
const calls = (): string[][] =>
  existsSync(join(bin, "args.txt"))
    ? readFileSync(join(bin, "args.txt"), "utf8")
        .split("--\n")
        .filter((chunk) => chunk !== "")
        .map((chunk) => chunk.trimEnd().split("\n"))
    : [];
const gh = (method: "squash" | "merge" | "rebase" | "queue" | "comment", comment?: string) => ({ kind: "gh" as const, method, ...(comment === undefined ? {} : { comment }) });
const merge = (forge: Parameters<typeof prMerge>[0]["forge"]) => prMerge({ repo, url: URL, sha: SHA, head: "loom/csv-1", base: "main", attempt: 2, forge });

describe("prMerge through gh", () => {
  it("merges with the method and the pushed commit, or adds the pull request to the merge queue with --auto", async () => {
    fakeGh("exit 0");
    expect(await merge(gh("squash"))).toEqual({ outcome: "ok" });
    expect(await merge(gh("rebase"))).toEqual({ outcome: "ok" });
    expect(await merge(gh("queue"))).toEqual({ outcome: "ok" });
    expect(calls()).toEqual([
      ["pr", "merge", URL, "--match-head-commit", SHA, "--squash"],
      ["pr", "merge", URL, "--match-head-commit", SHA, "--rebase"],
      ["pr", "merge", URL, "--match-head-commit", SHA, "--auto"],
    ]);
  });

  it("posts the merge service's comment with the body on stdin", async () => {
    fakeGh(`cat > "$dir/stdin.txt"`);
    expect(await merge(gh("comment", "/merge"))).toEqual({ outcome: "ok" });
    expect(calls()).toEqual([["pr", "comment", URL, "--body-file", "-"]]);
    expect(readFileSync(join(bin, "stdin.txt"), "utf8")).toBe("/merge");
  });

  it("calls a conflict a rejection the worker can fix, another refusal one it cannot, and a server error temporary", async () => {
    fakeGh(`echo "GraphQL: Pull Request is not mergeable (mergePullRequest)" 1>&2\nexit 1`);
    expect(await merge(gh("squash"))).toEqual({ outcome: "rejected", fix: true, message: expect.stringContaining("not mergeable") });
    fakeGh(`echo "GraphQL: Required status check \\"deploy\\" is expected. (mergePullRequest)" 1>&2\nexit 1`);
    expect(await merge(gh("squash"))).toEqual({ outcome: "rejected", fix: false, message: expect.stringContaining("Required status check") });
    fakeGh(`echo "HTTP 502: Bad Gateway" 1>&2\nexit 1`);
    expect(await merge(gh("squash"))).toMatchObject({ outcome: "unavailable", transient: "server" });
  });
});

describe("prMerge through a merge command", () => {
  it("gives the command the pull request, its branches, its commit and the attempt, and reads its exit code", async () => {
    const command = `env | grep '^LOOM_' | sort > "${bin}/env.txt"; exit "$CODE"`;
    process.env.CODE = "0";
    expect(await merge({ kind: "command", merge: command })).toEqual({ outcome: "ok" });
    expect(readFileSync(join(bin, "env.txt"), "utf8").trim().split("\n")).toEqual(["LOOM_ATTEMPT=2", "LOOM_BASE=main", "LOOM_HEAD=loom/csv-1", `LOOM_PR_NUMBER=7`, `LOOM_SHA=${SHA}`, `LOOM_URL=${URL}`]);
    process.env.CODE = String(MERGE_REJECTED_EXIT);
    expect(await merge({ kind: "command", merge: `echo "conflict in a.ts"; exit ${MERGE_REJECTED_EXIT}` })).toEqual({ outcome: "rejected", fix: true, message: "conflict in a.ts" });
    expect(await merge({ kind: "command", merge: `echo "the base is frozen"; exit ${MERGE_REFUSED_EXIT}` })).toEqual({ outcome: "rejected", fix: false, message: "the base is frozen" });
    expect(await merge({ kind: "command", merge: `echo "Error: 503: try again later"; exit 1` })).toMatchObject({ outcome: "unavailable", transient: "server" });
    expect(await merge({ kind: "command", merge: "exit 1" })).toMatchObject({ outcome: "unavailable" });
    expect(await merge({ kind: "command", merge: "exit 1" })).not.toHaveProperty("transient");
    delete process.env.CODE;
  });
});

describe("reviewer requests on the host", () => {
  it("reads the author, the people asked and those who reviewed, leaving teams out", async () => {
    fakeGh(`echo '{"author":{"login":"kalindudc"},"reviewRequests":[{"__typename":"User","login":"bob"},{"__typename":"Team","name":"edge","slug":"edge"}],"reviews":[{"author":{"login":"carol"}},{"author":{"login":"carol"}}]}'`);
    expect(await prReviewState({ repo, url: URL })).toEqual({ outcome: "ok", author: "kalindudc", requested: ["bob"], reviewed: ["carol"] });
    expect(calls()).toEqual([["pr", "view", URL, "--json", "author,reviewRequests,reviews"]]);
  });

  it("lists a GitHub team's members with gh api, every page, and a command forge's team with its command", async () => {
    fakeGh(`printf 'alice\\tUser\\nci-bot\\tBot\\n'`);
    expect(await teamMembers({ repo, team: "acme/edge", forge: { kind: "gh", host: "github.example.com" } })).toEqual({ outcome: "ok", members: [{ login: "alice", bot: false }, { login: "ci-bot", bot: true }] });
    expect(calls()).toEqual([["api", "--hostname", "github.example.com", "--paginate", "orgs/acme/teams/edge/members?per_page=100", "--jq", ".[] | [.login, .type] | @tsv"]]);
    const listed = await teamMembers({ repo, team: "edge", forge: { kind: "command", team_members: `[ "$LOOM_TEAM" = edge ] && printf 'warning: slow\\nalice@example.com\\nbob@example.com\\n\\nalice@example.com\\n'` } });
    expect(listed).toEqual({ outcome: "ok", members: [{ login: "alice@example.com", bot: false }, { login: "bob@example.com", bot: false }] });
  });

  it("asks through a command forge's request_reviews with every login in LOOM_REVIEWERS", async () => {
    const asked = await prRequestReview({ repo, url: URL, reviewers: ["alice@example.com", "bob"], forge: { kind: "command", request_reviews: `printf '%s' "$LOOM_REVIEWERS|$LOOM_PR_NUMBER" > "${bin}/asked.txt"` } });
    expect(asked).toEqual({ outcome: "ok", requested: ["alice@example.com", "bob"], failed: [] });
    expect(readFileSync(join(bin, "asked.txt"), "utf8")).toBe("alice@example.com,bob|7");
  });
});

describe("the merge queue in a poll's read", () => {
  it("asks for queue fields only when told to, and reads the newest removal", () => {
    expect(batchQuery([1], false)).not.toContain("mergeQueueEntry");
    expect(batchQuery([1, 2], false, true)).toContain("p1: pullRequest(number: 2) { ...F ...Q }");
    expect(batchQuery([1], true, true)).toContain("fragment Q on PullRequest {\n  mergeQueueEntry { state } autoMergeRequest { enabledAt }");
    expect(ghQueue({ mergeQueueEntry: { state: "QUEUED" }, autoMergeRequest: null, timelineItems: { nodes: [] } })).toEqual({ queued: true, auto: false, removed: null });
    expect(ghQueue({ mergeQueueEntry: null, autoMergeRequest: null, timelineItems: { nodes: [{ createdAt: "2026-11-04T17:32:53Z", reason: "FAILED_CHECKS" }, { createdAt: "2026-11-04T18:00:00Z", reason: "manual" }] } })).toEqual({
      queued: false,
      auto: false,
      removed: { at: Date.parse("2026-11-04T18:00:00Z"), reason: "manual" },
    });
  });
});

describe("a comment's identity across edits, for auto_merge's rejected", () => {
  const pull = (body: string) => ({
    data: { repository: { pullRequest: { state: "OPEN", headRefOid: "f00d", author: { __typename: "User", login: "me" }, commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [{ databaseId: 41, author: { __typename: "Bot", login: "merge-bot" }, body, url: "https://gh/c41", createdAt: "2026-11-05T01:30:22Z" }] } } } },
  });

  it("gives each gh comment a stable id and its creation time, while its key still changes with an edit", async () => {
    const read = async (body: string) => {
      writeFileSync(join(bin, "response.json"), JSON.stringify(pull(body)));
      fakeGh(`cat "${bin}/response.json"`);
      const answer = await prFeedback({ repo, url: URL, forge: { kind: "gh" } });
      if (answer.outcome !== "ok") throw new Error(answer.message);
      return answer.items[0]!;
    };
    const first = await read("❌ **Merge conflict**");
    const edited = await read("❌ **Merge conflict** (edited)");
    expect(first).toMatchObject({ stableId: "comment:41", createdAt: Date.parse("2026-11-05T01:30:22Z") });
    expect(edited.stableId).toBe(first.stableId);
    expect(edited.key).not.toBe(first.key);
    expect(calls()[0]!.join("\n")).toContain("comments(last: 50) { nodes { databaseId author { __typename login } body url createdAt } }");
  });

  it("reads a command forge's stable_id and created_at, and leaves them out when it gives none", async () => {
    const json = JSON.stringify({ state: "open", head: "f00d", items: [{ id: "c7-v2", stable_id: 7, created_at: "2026-11-05T01:30:22Z", kind: "comment", author: "bot", body: "x" }, { id: "c8", kind: "comment", author: "bot", body: "y" }] });
    const answer = await prFeedback({ repo, url: URL, forge: { kind: "command", feedback: `echo '${json}'` } });
    if (answer.outcome !== "ok") throw new Error(answer.message);
    expect(answer.items[0]).toMatchObject({ key: "comment:c7-v2", stableId: "comment:7", createdAt: Date.parse("2026-11-05T01:30:22Z") });
    expect(answer.items[1]).not.toHaveProperty("stableId");
    expect(answer.items[1]).not.toHaveProperty("createdAt");
  });
});

describe("a forge command stopped after it started", () => {
  const stopAfterStart = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const pending = run(controller.signal);
    // The command prints its marker at once, then sleeps: wait for the marker, so the process has started.
    for (let waited = 0; !existsSync(join(bin, "started")) && waited < 5000; waited += 20) await new Promise((done) => setTimeout(done, 20));
    controller.abort();
    return pending;
  };

  it("answers unknown for request_reviews, since it may have asked them", async () => {
    const asked = await stopAfterStart((signal) => prRequestReview({ repo, url: URL, reviewers: ["alice"], forge: { kind: "command", request_reviews: `echo "review assignment accepted"; touch "${bin}/started"; sleep 30` } }, signal));
    expect(asked).toEqual({ outcome: "unknown", message: expect.stringContaining("was stopped before it finished") });
  });

  it("answers a stopped merge command as a temporary failure, which keeps a comment or command attempt open", async () => {
    const merged = await stopAfterStart((signal) => prMerge({ repo, url: URL, sha: SHA, head: "loom/csv-1", base: "main", attempt: 1, forge: { kind: "command", merge: `echo "/merge posted"; touch "${bin}/started"; sleep 30` } }, signal));
    expect(merged).toMatchObject({ outcome: "unavailable", transient: "server", message: expect.stringContaining("was stopped before it finished") });
  });

  it("keeps a command that could not start a definite failure", async () => {
    const asked = await prRequestReview({ repo: join(scratch, "no-such-dir"), url: URL, reviewers: ["alice"], forge: { kind: "command", request_reviews: "true" } }).catch((error: unknown) => ({ thrown: String(error) }));
    expect(asked).not.toMatchObject({ outcome: "unknown" });
  });
});
