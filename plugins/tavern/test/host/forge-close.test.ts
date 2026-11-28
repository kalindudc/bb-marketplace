// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostInput } from "../../src/host-contract";
import { forgePullRequest } from "../../src/host/forge";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "forge-close-"))); roots.push(root);
  const repo = join(root, "repo"), bin = join(root, "bin"); mkdirSync(repo); mkdirSync(bin); mkdirSync(join(root, "data"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "work"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Base");
  const head = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://github.com/example/demo.git"); git("update-ref", "refs/remotes/origin/main", head);
  git("config", "branch.work.remote", "origin"); git("config", "branch.work.merge", "refs/heads/main");
  const registry = new HostRegistry(join(root, "data"));
  const binding = { placementId: "fixture", generation: 1, endpointId: "home" };
  registry.registerEndpoint({ ...binding, endpoint: { hostId: "host", environmentId: "env", root: repo }, git: "full", access: "source-read", ownerThreadId: "keeper", workspaceKind: null, objectFormat: "sha1", allowedRefs: [] });
  await inspectHost(registry, { ...binding, operationId: "inspect" });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const input: HostInput<"forgePullRequest"> = { ...binding, operationId: "close", profile: { id: "gh", name: "GitHub", kind: "github", enabled: true }, action: "close", url: "https://github.com/example/demo/pull/12", head: "work", base: "main", headCommit: head, state: "draft" };
  writeFileSync(join(bin, "gh"), `#!/bin/sh
if [ "$1" = api ]; then
  case "$2" in
    repos/example/demo/pulls/comments/*)
        n=12; if [ "$2" = repos/example/demo/pulls/comments/999 ]; then n=13; fi
        printf '{"pull_request_url":"https://api.github.com/repos/example/demo/pulls/%s"}\\n' "$n" ;;
    repos/example/demo/pulls/12/comments/*/replies) printf '%s\\n' "$@" > reply ;;
    graphql)
        case "$*" in
          *'query('*)
              n=12; case "$*" in *id=PRRT_foreign*) n=13 ;; esac
              printf '{"data":{"node":{"pullRequest":{"url":"https://github.com/example/demo/pull/%s"}}}}\\n' "$n" ;;
          *'mutation('*) printf '%s\\n' "$@" > resolved; printf '{"data":{"resolveReviewThread":{"clientMutationId":null},"unresolveReviewThread":{"clientMutationId":null}}}\\n' ;;
          *) exit 1 ;;
        esac ;;
    *) exit 1 ;;
  esac
  exit
fi
[ "$1" = pr ] || exit 1
case "$2" in
  view) state=OPEN; if [ -f closed ]; then state=CLOSED; fi
        draft=true; if [ -f ready ]; then draft=false; fi
        printf '{"state":"%s","headRefOid":"${head}","headRefName":"work","baseRefName":"main","isDraft":%s}\n' "$state" "$draft" ;;
  close) printf '%s\n' "$*" > closed ;;
  ready) if [ "$3" = "--undo" ]; then rm ready; else touch ready; fi ;;
  edit) printf '%s\n' "$*" > reviewers ;;
  *) exit 1 ;;
esac`, { mode: 0o700 });
  const call = (overrides: Partial<HostInput<"forgePullRequest">> = {}) => forgePullRequest(registry, { ...input, ...overrides }, new AbortController().signal);
  return { repo, input, call };
}

it("closes only the recorded GitHub pull request without deleting its branch", async () => {
  const f = await fixture();
  expect(await f.call()).toEqual({ state: "closed", headCommit: f.input.headCommit });
  expect(readFileSync(join(f.repo, "closed"), "utf8").trim()).toBe(`pr close ${f.input.url}`);
});

it("refuses a GitHub head or repository different from the one on the card before closing", async () => {
  const f = await fixture();
  await expect(f.call({ operationId: "wrong-head", headCommit: "0".repeat(40) })).rejects.toThrow(/head or review state changed/i);
  await expect(f.call({ operationId: "wrong-repo", url: "https://github.com/example/other/pull/12" })).rejects.toThrow(/does not belong/i);
  expect(existsSync(join(f.repo, "closed"))).toBe(false);
});

it("makes only the recorded head ready, requests the specified reviewers, and returns it to draft", async () => {
  const f = await fixture();
  await expect(f.call({ action: "ready", operationId: "ready-stale", headCommit: "0".repeat(40), reviewers: ["one"] })).rejects.toThrow(/head or review state changed/i);
  expect(existsSync(join(f.repo, "reviewers"))).toBe(false);
  expect(await f.call({ action: "ready", operationId: "ready", reviewers: ["one", "example/team"] })).toEqual({ state: "ready", headCommit: f.input.headCommit });
  expect(readFileSync(join(f.repo, "reviewers"), "utf8").trim()).toBe(`pr edit ${f.input.url} --add-reviewer one,example/team`);
  expect(await f.call({ action: "draft", operationId: "draft", state: "ready" })).toEqual({ state: "draft", headCommit: f.input.headCommit });
});

it("checks reply and resolution targets in the forge before writing", async () => {
  const f = await fixture();
  await expect(f.call({ action: "reply", operationId: "reply-foreign", commentId: "999", comment: "Fixture" })).rejects.toThrow(/does not belong/i);
  await expect(f.call({ action: "resolve", operationId: "resolve-foreign", threadId: "PRRT_foreign", resolved: true })).rejects.toThrow(/does not belong/i);
  expect(existsSync(join(f.repo, "reply"))).toBe(false);
  expect(existsSync(join(f.repo, "resolved"))).toBe(false);
  await f.call({ action: "reply", operationId: "reply-own", commentId: "123", comment: "Fixture reply" });
  expect(readFileSync(join(f.repo, "reply"), "utf8")).toContain("body=Fixture reply");
  for (const [resolved, verb] of [[true, "resolveReviewThread"], [false, "unresolveReviewThread"]] as const) {
    await f.call({ action: "resolve", operationId: verb, threadId: "PRRT_own", resolved });
    expect(readFileSync(join(f.repo, "resolved"), "utf8")).toContain(verb + "(input");
  }
});

it("passes the recorded target to the configured forge and confirms the result with its state command", async () => {
  const f = await fixture();
  const url = "https://forge.example/project/merge_requests/23";
  const profile: HostInput<"forgePullRequest">["profile"] = { id: "custom", name: "Custom", kind: "command", enabled: true, open: "false", state: "if [ -f custom-closed ]; then echo closed; else echo open; fi", close: 'printf "%s\n%s\n%s\n%s" "$FORGE_URL" "$LOOM_PR_NUMBER" "$FORGE_HEAD" "$FORGE_BASE" > custom-closed' };
  expect(await f.call({ profile, url })).toEqual({ state: "closed" });
  expect(readFileSync(join(f.repo, "custom-closed"), "utf8")).toBe(`${url}\n23\nwork\nmain`);
});
