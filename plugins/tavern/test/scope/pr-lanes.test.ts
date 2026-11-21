// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths } from "../../src/scope/paths";
import { ScopeStore } from "../../src/scope/store";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";
import { createHash } from "node:crypto";
import { observedPullRequestReceipt, pullRequestGrantAvailable } from "../../src/scope/pr-grants";

const own = "https://github.com/example/repo/pull/12", other = "https://github.com/example/repo/pull/13";
const call = (command: string) => ({ kind: "bash" as const, toolName: "bash", cwd: process.cwd(), input: { command } });
const policy = (role: string, alwaysAsk: boolean) => bindPaths({ ...scopeForClass(role), pullRequestPolicy: { alwaysAsk, owned: [own], grants: [] } },
  { home: tmpdir(), tmp: [tmpdir()], worktree: process.cwd(), threadStorage: tmpdir(), scopesDir: join(tmpdir(), "scopes") });

it.each(["keeper", "wanderer"])("records own PR writes and follows Always ask for unknown targets in %s", role => {
  for (const command of [`gh pr comment ${own} -b hi`, `gh pr edit ${own} --body hi`, "gh api -X POST repos/example/repo/pulls/12/comments/5/replies -f body=hi"]) {
    expect(evaluate(policy(role, true), call(command))).toMatchObject({ allow: true, acts: [{ kind: "publish" }] });
  }
  const read = vi.fn(() => JSON.stringify({ url: own }));
  expect(evaluate(policy(role, true), prepareCall(call("gh pr edit 12 --body hi"), { scope: policy(role, true), readCommand: read })).allow).toBe(true);
  for (const command of [`gh pr review ${other} --approve`, "gh api -X POST repos/example/repo/pulls/13/reviews -f body=hi"]) {
    for (const alwaysAsk of [true, false]) expect(evaluate(policy(role, alwaysAsk), call(command))).toMatchObject({ allow: false, ruleId: "send-guard" });
  }
  const edit = call(`dt pr edit ${other} --title hi`);
  expect(evaluate(policy(role, true), edit)).toMatchObject({ allow: false, ruleId: "pr-sends-as-you" });
  expect(evaluate(policy(role, false), edit)).toMatchObject({ allow: true });
});

it("claims an exact non-message PR exception once across guard reloads", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-grant-"));
  const store = new ScopeStore(root), threadId = "keeper-one";
  const command = `gh pr edit ${other} --title hi`;
  const grant = { id: "decision-fixture", digest: createHash("sha256").update(command).digest("hex") };
  const scope = policy("keeper", true);
  store.write(threadId, { ...scope, pullRequestPolicy: { alwaysAsk: true, owned: [], grants: [grant] } });
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file(threadId)); vi.stubEnv("BB_THREAD_ID", threadId);
  const load = () => {
    const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
    guard({ on: (name, handler) => handlers.set(name, handler), getActiveTools: () => ["bash"], setActiveTools: () => {} });
    return {
      call: (source: string, toolCallId: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId, input: { command: source } }, { cwd: process.cwd() }),
      result: (toolCallId: string) => handlers.get("tool_result")!({ toolName: "bash", toolCallId, content: [{ type: "text", text: "ok" }] }, { cwd: process.cwd() }),
    };
  };
  try {
    const first = load();
    expect(first.call(command.replace("--title", "--body"), "different")).toMatchObject({ block: true });
    expect(first.call(command, "use-one")).toBeUndefined();
    const receipt = observedPullRequestReceipt({ result: first.result("use-one") });
    expect(receipt).toMatch(/^[a-f0-9-]{36}$/);
    expect(pullRequestGrantAvailable(store.file(threadId), grant.id, receipt)).toBe(true);
    expect(pullRequestGrantAvailable(store.file(threadId), grant.id, "bb-event-with-a-different-id")).toBe(false);
    expect(load().call(command, "use-two")).toMatchObject({ block: true });
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
