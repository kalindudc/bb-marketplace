// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execGitSync } from "../../src/shared/git-safety";
import { join } from "node:path";
import { tmpdir } from "node:os";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { ScopeStore } from "../../src/scope/store";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { DEFAULT_SETTINGS, settingsPatchSchema } from "../../src/shared/settings";
import { readCommunicationHolds } from "../../src/scope/communication-holds";
import { awaySelectionRule } from "../../src/scope/away-policy";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

import type { SendTools } from "../../src/shared/communication";
type Rule = SendTools[number];
const policy: Rule[] = [{ pattern: "*_post_message", act: "send", targetKey: "recipient" }, { pattern: "*_create_draft", act: "draft", targetKey: "recipient" }];
function fixture(mode: "enforce" | "watch" | "off", sendTools = policy) {
  const root = mkdtempSync(join(tmpdir(), "send-guard-")); roots.push(root);
  const store = new ScopeStore(root);
  const piLoadout = { skills: [], tools: ["bash", "read", "mcp__fixture__POST_MESSAGE", "proxy", "search", "fixture_read_message", "fixture_post_message", "fixture_create_draft", "fixture_unrelated"] };
  const scope = bindPaths({ ...scopeForClass("keeper"), threadId: "lead", issuedAt: 1, mode, piLoadout }, { home: root, tmp: [root], scopesDir: store.directory, worktree: root });
  const file = store.file("lead");
  const replace = (rules: Rule[]) => store.write("lead", { ...scope, sendTools: rules });
  replace(sendTools);
  vi.stubEnv("BB_THREAD_ID", "lead");
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("lead"));
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  guard({ on: (event, handler) => handlers.set(event, handler), getActiveTools: () => ["bash", "codemode"], setActiveTools() {} });
  let calls = 0;
  return { replace, file, store, scope, root, call: (toolName: string, input: Record<string, unknown> = {}) =>
    handlers.get("tool_call")!({ toolName, toolCallId: "call-" + ++calls, input }, { cwd: root }) as { block?: boolean; reason?: string } | undefined };
}

it.each(["enforce", "watch", "off"] as const)("blocks configured sends in %s including late and proxied calls", mode => {
  const f = fixture(mode);
  const message = { recipient: "room-1", message: "A literal note" };
  const refusal = { block: true, reason: expect.stringMatching(/draft instead/i) };
  expect(f.call("mcp__fixture__POST_MESSAGE", message)).toMatchObject(refusal);
  expect(f.call("proxy", { toolName: "fixture_post_message", arguments: message })).toMatchObject(refusal);
  expect(f.call("proxy", { name: "fixture_post_message", arguments: message })).toMatchObject(refusal);
  for (const input of [
    { method: "tools/call", params: { name: "fixture_post_message", arguments: message } },
    { name: "proxy", arguments: { tool: "fixture_post_message", arguments: message } },
  ]) expect(f.call("proxy", input)).toMatchObject(refusal);
  expect(f.call("search", { name: "fixture_post_message" })).toBeUndefined();
  expect(f.call("fixture_read_message", message)).toBeUndefined();
  f.replace([]);
  expect(f.call("mcp__fixture__POST_MESSAGE", message)).toBeUndefined();
});

it.each(["enforce", "watch", "off"] as const)("uses the rewritten scope for unrelated calls in %s when the sidecar is stale", mode => {
  const f = fixture(mode, [...policy, { shell: "fixture-cli post", act: "send" }]);
  const sidecar = f.file + ".message-policy";
  const previous = readFileSync(sidecar, "utf8");
  const base = JSON.parse(readFileSync(f.file, "utf8"));
  writeFileSync(f.file, JSON.stringify({ ...base, issuedAt: base.issuedAt + 1, tools: { ...base.tools, deny: [...base.tools.deny, "fixture_unrelated"] } }));
  const rebuilt = new ScopeStore(f.root);
  expect(f.call("bash", { command: "git status" })).toBeUndefined();
  expect(f.call("read", { path: join(f.root, "notes") })).toBeUndefined();
  expect(f.call("fixture_unrelated")).toBeUndefined();
  const refusal = { block: true, reason: expect.stringMatching(/message policy.*does not match/i) };
  expect(f.call("fixture_post_message", { recipient: "fixture", message: "message" })).toMatchObject(refusal);
  expect(f.call("fixture_create_draft", { recipient: "fixture", message: "draft" })).toMatchObject(refusal);
  expect(f.call("bash", { command: "fixture-cli post room hi" })).toMatchObject(refusal);
  expect(rebuilt.messagePolicyProblem("lead")).toMatch(/does not match/);
  expect(rebuilt.isArmed("lead", true)).toBe(true);
  expect(rebuilt.isArmed("lead", false, true)).toBe(false);
  expect(readCommunicationHolds(f.file)).toEqual([]);
  writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(previous), issuedAt: base.issuedAt + 1 }));
  expect(f.call("fixture_post_message", { recipient: "fixture", message: "message" })).toMatchObject({ block: true, reason: expect.stringMatching(/draft instead/i) });
  expect(rebuilt.messagePolicyProblem("lead")).toBeUndefined();
  expect(rebuilt.isArmed("lead", false, true)).toBe(true);
});

it("keeps the main scope and its template compatible with pre-send-guard readers", () => {
  const f = fixture("enforce");
  f.store.write("lead", { ...f.scope, sendTools: policy }, { ...f.scope, sendTools: policy });
  const data = JSON.parse(readFileSync(f.file, "utf8"));
  expect(data).not.toHaveProperty("sendTools");
  expect(data.bindingTemplate).not.toHaveProperty("sendTools");
  expect(f.call("fixture_post_message", { recipient: "room-1", message: "fixture" })).toMatchObject({ block: true });
});

it("proves ownership before judging a Smith's own PR comment", () => {
  const f = fixture("off");
  f.store.write("lead", { ...f.scope, role: "smith", github: "draft-pr-only", preset: "worktree", assignedBranch: "feature", pullRequestPolicy: { owned: [], grants: [], alwaysAsk: false } });
  const git = { encoding: "utf8" as const, timeout: 5000 };
  execGitSync(f.root, ["init", "-q", "-b", "feature"], git);
  execGitSync(f.root, ["remote", "add", "origin", "https://github.com/fixture-team/fixture.git"], git);
  writeFileSync(join(f.root, "gh"), `#!/bin/sh
if [ "$1" = api ] && [ "$2" = user ]; then
  printf '%s\\n' '{"login":"fixture-user"}'
elif [ "$1" = pr ] && [ "$2" = view ]; then
  case "$3" in
    12) author=fixture-user ;;
    13) author=someone-else ;;
    *) exit 42 ;;
  esac
  printf '{"isDraft":true,"author":{"login":"%s"},"headRefName":"feature","headRepository":{"name":"fixture"},"headRepositoryOwner":{"login":"fixture-team"}}\\n' "$author"
else
  exit 42
fi
`, { mode: 0o700 });
  vi.stubEnv("PATH", f.root + ":" + process.env.PATH);
  expect(f.call("bash", { command: "gh pr comment 12 --body fixture" })).toBeUndefined();
  expect(f.call("bash", { command: "gh pr comment 13 --body fixture" })).toMatchObject({ block: true });
});

it("matches configured shell prefixes on parsed tokens without matching lookalike reads", () => {
  const f = fixture("off", [{ shell: "fixture-cli post", act: "send" }, { shell: "fixture-cli draft", act: "draft" }]);
  for (const command of ["fixture-cli post room hi", "X=1 /usr/bin/fixture-cli post room hi", "bash -c 'fixture-cli post room hi'", "fixture-cli draft room hi"]) {
    expect(f.call("bash", { command }), command).toMatchObject({ block: true });
  }
  expect(f.call("bash", { command: "fixture-cli draft room hi; fixture-cli post room hi" })).toMatchObject({ block: true, reason: expect.stringContaining("Agents do not send as you") });
  for (const command of ["fixture-cli read", "fixture-cli posts", "fixture-cli post --help", "echo 'fixture-cli post room hi'"]) {
    expect(f.call("bash", { command }), command).toBeUndefined();
  }
  expect(settingsPatchSchema.safeParse({ scopes: { sendTools: [{ pattern: "**", act: "send" }] } }).success).toBe(false);
});

it("does not confuse definite shell sends with generic writes or reads", () => {
  const f = fixture("off");
  for (const command of ["slack post hello", "mail -s subject recipient@example.test <<< 'Hello'", "gh pr comment 12 --body hello", "gh pr review 12 --comment --body hello"]) {
    expect(f.call("bash", { command }), command).toMatchObject({ block: true });
  }
  for (const command of ["slack read 12", "curl -X POST https://example.test", "gh pr close 12", "gh pr edit 12 --title fixture", "echo 'slack post hello'"]) {
    expect(f.call("bash", { command }), command).toBeUndefined();
  }
});

it("holds an unapproved draft, but does not allow a competing draft rule to authorize a send", () => {
  const f = fixture("off", [...policy, { pattern: "*post_message", act: "draft", targetKey: "recipient" }]);
  expect(f.call("fixture_create_draft", { recipient: "room-1", body: "a draft" })).toMatchObject({ block: true, reason: expect.stringMatching(/draft.*(?:ask|approval)/i) });
  expect(f.call("fixture_post_message", { recipient: "room-1", body: "a message" })).toMatchObject({ block: true, reason: expect.stringMatching(/draft instead/i) });
});

it("keeps the full literal payload from a blocked proxy in a private record", () => {
  const f = fixture("watch");
  const body = "first line\n" + "much more text. ".repeat(700) + "\nlast line";
  f.call("proxy", { toolName: "fixture_post_message", recipient: "incorrect", arguments: { recipient: "room-1", message: body } });
  expect(readCommunicationHolds(f.file)).toEqual([expect.objectContaining({ act: "send", target: "room-1", body, tool: "fixture_post_message" })]);
  f.call("bash", { command: "mail -s Subject recipient@example.test <<'MESSAGE'\nfirst\n\nlast\nMESSAGE\n" });
  expect(readCommunicationHolds(f.file)).toContainEqual(expect.objectContaining({ act: "send", target: "recipient@example.test", body: "first\n\nlast\n" }));
});

it("binds a draft receipt to exact arguments and refuses replay or Closing time", () => {
  const f = fixture("enforce");
  const args = { recipient: "room-1", message: "fixture only" };
  expect(f.call("fixture_create_draft", args)).toMatchObject({ block: true });
  const [hold] = readCommunicationHolds(f.file);
  const communicationAuthority = { questId: "quest-1", active: true, delegationIds: [], receipts: [
    { askId: "ask-1", callDigest: hold.callDigest!, rulesDigest: hold.rulesDigest, scopeIssuedAt: hold.scopeIssuedAt },
  ] };
  const withReceipt = { ...f.scope, sendTools: policy, communicationAuthority };
  f.store.write("lead", { ...withReceipt, shell: { ...f.scope.shell, deny: [awaySelectionRule("1".repeat(64), ["other-writes"])] } });
  expect(f.call("fixture_create_draft", args)).toMatchObject({ block: true });
  f.store.write("lead", withReceipt);
  expect(f.call("fixture_create_draft", { ...args, message: "changed" })).toMatchObject({ block: true });
  expect(f.call("fixture_create_draft", { message: args.message, recipient: args.recipient })).toBeUndefined();
  expect(f.call("fixture_create_draft", args)).toMatchObject({ block: true });
});

it("defaults to no rules and distinguishes an omitted patch from clearing the list", () => {
  expect(DEFAULT_SETTINGS.scopes).toMatchObject({ sendTools: [] });
  expect(settingsPatchSchema.parse({ scopes: { mode: "off" } })).toEqual({ scopes: { mode: "off" } });
  expect(settingsPatchSchema.parse({ scopes: { sendTools: [] } })).toEqual({ scopes: { sendTools: [] } });
});
