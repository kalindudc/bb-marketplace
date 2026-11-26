// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readerFallback } from "../../src/scope/worktree";
import { evaluate, type ScopeCall } from "../../src/scope/engine";
import { scopeForClass } from "../../src/scope/presets";
import { bindPaths, realPath } from "../../src/scope/paths";
import { shellCommands, commandWritePaths } from "../../src/scope/shell";
import { prepareCall } from "../../src/scope/prepare";
import { ScopeStore } from "../../src/scope/store";
import extension, { type PiGuardApi } from "../../adapters/pi/extension";
import { linkedWorktree } from "./git-fixture";

const scope = (role = "ranger", worktree: string | null = "/repo") => bindPaths(scopeForClass(role), { home: "/home/me", tmp: ["/tmp"], threadStorage: "/storage/t1", scopesDir: "/scopes", worktree: worktree ?? undefined });
const call = (command: string, cwd = "/repo"): ScopeCall => ({ kind: "bash", toolName: "bash", cwd, input: { command }, containment: "sandbox" });
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface ReplayRow { i: number; threadId: string; expectedRule?: string | null; scope: { role?: string; preset: Parameters<typeof scopeForClass>[2] }; call: { toolName: string; cwd?: string; input?: Record<string, unknown> } }
function replay(rows: ReplayRow[]) {
  const results = new Map<string, ReturnType<typeof evaluate>>();
  return rows.flatMap(row => {
    const key = JSON.stringify([row.scope, row.threadId, row.call, row.i === 0]);
    const previous = results.get(key);
    if (previous) return previous.allow ? [] : [{ i: row.i, rule: previous.ruleId, command: row.call.input?.command ?? row.call.input?.cmd }];
    const s = bindPaths(scopeForClass(row.scope.role ?? "replay", undefined, row.scope.preset), { home: "/home/fixture", tmp: ["/tmp", "/private/tmp", "/private/var/folders/fixture/T"], threadStorage: `/home/fixture/.bb/thread-storage/${row.threadId}`, scopesDir: "/home/fixture/.bb/plugins/tavern/scopes", worktree: row.i === 0 ? undefined : "/worktree" });
    const input = Object.fromEntries(Object.entries(row.call.input ?? {}).map(([key, value]) => [key, typeof value === "string" ? value.replaceAll("$HOME", "/home/fixture") : value]));
    const command = input.command ?? input.cmd;
    const c: ScopeCall = { kind: typeof command === "string" ? "bash" : "tool", toolName: row.call.toolName, input, cwd: (row.call.cwd ?? "/home/fixture").replaceAll("$HOME", "/home/fixture"), containment: "sandbox" };
    const decision = evaluate(row.i === 0 ? readerFallback(s) : s, c);
    results.set(key, decision);
    return decision.allow ? [] : [{ i: row.i, rule: decision.ruleId, command }];
  });
}
it("replays 30 hand-written public synthetic shapes with only the main push refused", () => {
  const shapes = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/effect-synthetic.json"), "utf8"));
  expect(shapes).toHaveLength(30);
  const rows = shapes.map((shape: { preset: ReplayRow["scope"]["preset"]; command?: string; tool?: string }, i: number) => ({ i, threadId: "synthetic", scope: { preset: shape.preset }, call: { toolName: shape.tool ?? "bash", cwd: "/workspace", input: shape.command ? { command: shape.command } : {} } }));
  expect(replay(rows)).toEqual([{ i: 1, rule: "git-push-main", command: expect.any(String) }]);
});
it.skipIf(!process.env.TAVERN_SCOPE_REPLAY)("opt-in replay keeps only the expected act-list refusals", () => {
  const rows: ReplayRow[] = readFileSync(process.env.TAVERN_SCOPE_REPLAY!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const expected = rows.every(row => Object.hasOwn(row, "expectedRule"))
    ? rows.flatMap(row => row.expectedRule ? [{ i: row.i, rule: row.expectedRule }] : [])
    : [{ i: 1, rule: "git-push-main" }];
  expect(rows.length).toBeGreaterThan(0);
  const refusals = replay(rows);
  expect(refusals.map(({ i, rule }) => ({ i, rule }))).toEqual(expected);
  console.info(`Opt-in replay: ${rows.length - refusals.length} allowed, ${refusals.length} refused.`);
}, 120_000);
it("allows a Ranger Python heredoc with a redirect into its storage", () => {
  expect(evaluate(scope(), call("python3 - <<'EOF' > $BB_THREAD_STORAGE/x.txt\nprint('fixture')\nEOF")).allow).toBe(true);
});
it("resolves prior assignments and both finite loop writes into thread storage", () => {
  const commands = shellCommands("S=$BB_THREAD_STORAGE/state; for p in a b; do echo > $S/$p.json; done", "/repo", { env: scope().env.variables, containment: "sandbox" });
  expect(commands.flatMap(commandWritePaths)).toEqual(["/storage/t1/state/a.json", "/storage/t1/state/b.json"]);
});
it("treats fetch as ordinary for a Ranger without gathering a write allowance", () => {
  const readCommand = vi.fn();
  const fetch = prepareCall(call("git status && git fetch"), { scope: scope(), readCommand });
  expect(evaluate(scope(), fetch)).toMatchObject({ allow: true });
  expect(readCommand).not.toHaveBeenCalled();
});
it("allows unparsable research but retains the raw deploy fallback", () => {
  expect(evaluate(scope(), call("echo 'unfinished")).allow).toBe(true);
  expect(evaluate(scope(), call("terraform apply 'unfinished"))).toMatchObject({ allow: false, ruleId: "cluster-write" });
});
it("lets an unbound Smith do local work without assuming publish authority", () => {
  const s = scope("smith", null);
  expect(evaluate(s, call("cat /repo/a")).allow).toBe(true);
  expect(evaluate(s, call("echo x > $BB_THREAD_STORAGE/x")).allow).toBe(true);
  expect(evaluate(s, call("echo x > /repo/x")).allow).toBe(true);
  expect(evaluate(s, call("git push origin feature")).allow).toBe(false);
});
const tools = ["mcp__tool_gateway__tool_gateway_enable_backend", "mcp__tool_gateway__tool_gateway_disable_backend", "mcp__tool_gateway__tool_gateway_list_backends", "mcp__tool_gateway__slack_who_am_i", "incident_get_postmortem", "mcp__x__check_write_access"];
it("makes all requested tools available in every preset", () => {
  for (const preset of ["readonly", "checker", "worktree", "keeper", "open"] as const) {
    const s = bindPaths(scopeForClass("test", undefined, preset), { home: "/home/me", tmp: ["/tmp"], threadStorage: "/storage/t1", scopesDir: "/scopes", worktree: "/repo" });
    expect(s.tools.hide).toBe(false);
    for (const toolName of tools) expect(evaluate(s, { kind: "tool", toolName, input: {}, cwd: "/repo" }).allow).toBe(true);
  }
});
it("passes ordinary tool and shell writes but keeps Ranger pushes guarded", () => {
  for (const role of ["ranger", "smith"]) {
    expect(evaluate(scope(role), call("echo x > /outside/x")).allow).toBe(true);
    expect(evaluate(scope(role), { kind: "write", toolName: "write", cwd: "/repo", input: { path: "/outside/x" } }).allow).toBe(true);
  }
  expect(evaluate(scope(), call("git push origin feature")).allow).toBe(false);
  for (const role of ["ranger", "warden", "smith"]) expect(evaluate(scope(role), { ...call("python3 -c 'print(1)'"), containment: undefined }).allow).toBe(true);
});
it("applies the same availability and boundary checks to calls emitted from codemode", () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "tavern-codemode-"))); roots.push(root);
  const { worktree } = linkedWorktree(root);
  vi.spyOn(process, "cwd").mockReturnValue(worktree);
  const store = new ScopeStore(root);
  vi.stubEnv("TAVERN_SCOPE_FILE", store.file("t1")); vi.stubEnv("BB_THREAD_ID", "t1");
  for (const preset of ["readonly", "checker", "worktree", "keeper", "open"] as const) {
    const s = bindPaths({ ...scopeForClass("test", undefined, preset), threadId: "t1", issuedAt: 1 }, { home: root, tmp: [join(root, "temp")], threadStorage: join(root, "storage"), scopesDir: store.directory });
    store.write("t1", s);
    const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
    const pi: PiGuardApi = { on: (name, handler) => handlers.set(name, handler), getActiveTools: () => tools, setActiveTools: () => {} };
    extension(pi);
    const emit = (toolName: string, input = {}) => handlers.get("tool_call")!({ toolName, input }, { cwd: worktree });
    expect(emit("codemode")).toBeUndefined();
    for (const toolName of tools) expect(emit(toolName)).toBeUndefined();
    expect(emit("write", { path: join(store.directory, "t1.json") })).toMatchObject({ block: true });
  }
});
