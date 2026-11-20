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
[ "$1" = pr ] || exit 1
case "$2" in
  view) state=OPEN; if [ -f closed ]; then state=CLOSED; fi
        printf '{"state":"%s","headRefOid":"${head}","headRefName":"work","baseRefName":"main","isDraft":true}\n' "$state" ;;
  close) printf '%s\n' "$*" > closed ;;
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

it("passes the recorded target to the configured forge and confirms the result with its state command", async () => {
  const f = await fixture();
  const url = "https://forge.example/project/merge_requests/23";
  const profile: HostInput<"forgePullRequest">["profile"] = { id: "custom", name: "Custom", kind: "command", enabled: true, open: "false", state: "if [ -f custom-closed ]; then echo closed; else echo open; fi", close: 'printf "%s\n%s\n%s\n%s" "$FORGE_URL" "$LOOM_PR_NUMBER" "$FORGE_HEAD" "$FORGE_BASE" > custom-closed' };
  expect(await f.call({ profile, url })).toEqual({ state: "closed" });
  expect(readFileSync(join(f.repo, "custom-closed"), "utf8")).toBe(`${url}\n23\nwork\nmain`);
});
