// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostContract, type Authority, type HostInput } from "../../src/host-contract";
import * as context from "../../src/host/context";
import * as nativeProcess from "../../src/host/process";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { NativeScopes } from "../../src/host/scopes";
import { scopeForClass } from "../../src/scope/presets";
import * as store from "../../src/scope/store";
import * as engine from "../../src/scope/engine";
import { scopeRenderedFileSchema, type ScopeDeliveryFile } from "../../src/scope/schema";
import guard, { type PiGuardApi } from "../../adapters/pi/extension";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
async function fixture(role = "smith", format: "sha1" | "sha256" = "sha1") {
  const root = realpathSync(mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "native-scopes-"))); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "home"), scratch = join(root, "scratch"), data = join(root, "data"), storage = join(root, "thread-storage"), agent = join(home, "custom-pi");
  for (const path of [repo, home, scratch, data, storage, join(agent, "extensions")]) mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "tavern/member", "--object-format=" + format); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "initial"); git("add", "tracked"); git("commit", "-qm", "initial");
  const registry = new HostRegistry(data), authority: Authority = { placementId: "placement", generation: 1, endpointId: "member-workspace", operationId: "scope" };
  registry.registerEndpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "guest", environmentId: "guest-env", root: repo }, ownerThreadId: "member", access: "member-write", workspaceKind: "dedicated-machine", objectFormat: format, allowedRefs: ["refs/heads/tavern/member"] });
  await inspectHost(registry, authority);
  const service = new NativeScopes(registry, { paths: { home, tmp: [scratch], piAgentDir: agent } });
  const template = { ...scopeForClass(role), threadId: "member", issuedAt: 1234 };
  template.env.variables = { HOME: "/controller/home", TMPDIR: "/controller/tmp", BB_THREAD_STORAGE: "/controller/storage", FEATURE_FLAG: "kept" };
  template.shell.allow.push({ id: "approved-grant", argv: ["git", "push"], remote: "github.com/owner/repo", why: "Approved by user" });
  template.tools.deny.push("private_tool");
  const delivery: ScopeDeliveryFile = { ...template, bindingTemplate: structuredClone(template), workspaceBinding: { kind: "dedicated-machine", hostId: "guest", environmentId: "guest-env", root: repo, placementId: authority.placementId, generation: 1, snapshotId: "snapshot", expectedTree: git("rev-parse", "HEAD^{tree}") } };
  const input = (value = delivery, revision = 1, suffix = ""): HostInput<"bindScope"> => { const scopeFileJson = JSON.stringify(value) + suffix; return { ...authority, revision, scopeDigest: digest(scopeFileJson), scopeFileJson }; };
  const registerStorage = (ownerThreadId = "member", hostId = "guest") => registry.registerEndpoint({ placementId: authority.placementId, generation: 1, endpointId: "storage", endpoint: { hostId, environmentId: null, root: storage }, ownerThreadId, access: "artifact-read", workspaceKind: null, objectFormat: null, allowedRefs: [] });
  return { root, repo, home, scratch, data, storage, agent, git, registry, authority, service, template, delivery, input, registerStorage };
}
function guarded(file: string, cwd: string) {
  vi.stubEnv("TAVERN_SCOPE_FILE", file); vi.stubEnv("BB_THREAD_ID", "member"); vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>(); let active = ["read", "write", "bash", "journal", "quest", "tavern_report", "tavern_ready", "private_tool"];
  const pi: PiGuardApi = { on: (name, handler) => { handlers.set(name, handler); }, getActiveTools: () => active, setActiveTools: names => { active = names; } };
  guard(pi);
  return { emit: (name: string, event = {}) => handlers.get(name)?.(event, { cwd }), tools: () => active };
}
it("requires native variables in bind ACKs and rejects routing/thread overrides", () => {
  const value = { revision: 1, scopeDigest: "a".repeat(64), scopeFile: "/native/scope.json" };
  expect(hostContract.bindScope.output.safeParse(value).success).toBe(false);
  expect(hostContract.bindScope.output.safeParse({ ...value, variables: { HOME: "/native/home" } }).success).toBe(true);
  expect(hostContract.bindScope.output.safeParse({ ...value, variables: { TAVERN_SCOPE_FILE: "/wrong" } }).success).toBe(false);
});
it("renders original policy using native bindings and keeps delivery and rendered digests separate", async () => {
  const f = await fixture(); f.registerStorage(); f.delivery.bindingEndpoints = { threadStorage: "storage" };
  const input = f.input(f.delivery, 1, "\n\n"), before = structuredClone(f.delivery), ack = await f.service.bindScope(input);
  expect(ack).toEqual({ revision: 1, scopeDigest: digest(input.scopeFileJson), scopeFile: expect.stringContaining(f.data), variables: { HOME: f.home, TMPDIR: f.scratch, BB_THREAD_STORAGE: f.storage, FEATURE_FLAG: "kept" } });
  const bytes = readFileSync(ack.scopeFile, "utf8"), rendered = scopeRenderedFileSchema.parse(JSON.parse(bytes));
  expect(digest(bytes)).not.toBe(input.scopeDigest); expect(rendered.hostBinding).toEqual({ placementId: "placement", generation: 1, endpointId: "member-workspace", revision: 1, scopeDigest: input.scopeDigest });
  expect(rendered.expectedWorktree).toBe(f.repo); expect(rendered.workspaceKind).toBe("dedicated-machine"); expect(rendered.writes.allow).toContain(f.repo); expect(rendered.writes.allow).toContain(f.storage);
  expect(rendered.writes.deny).toContain(f.data); expect(rendered.writes.deny).toContain(join(f.agent, "extensions"));
  expect(rendered.shell.allow).toEqual(f.template.shell.allow); expect(rendered.tools.deny).toEqual(f.template.tools.deny); expect(rendered.bindingTemplate).toEqual(f.template); expect(f.delivery).toEqual(before);
});
it("omits undeclared optional storage instead of retaining the controller path", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input());
  expect(ack.variables).not.toHaveProperty("BB_THREAD_STORAGE");
  const rendered = scopeRenderedFileSchema.parse(JSON.parse(readFileSync(ack.scopeFile, "utf8")));
  expect(rendered.env.variables).not.toHaveProperty("BB_THREAD_STORAGE"); expect(rendered.writes.allow).not.toContain("${threadStorage}"); expect(JSON.stringify(rendered.writes)).not.toContain("/controller/");
});
it.each(["missing", "owner", "host", "access"])("rejects declared %s storage authority instead of silently dropping it", async kind => {
  const f = await fixture(); f.delivery.bindingEndpoints = { threadStorage: kind === "access" ? f.authority.endpointId : "storage" };
  if (kind === "owner") f.registerStorage("other-member"); if (kind === "host") f.registerStorage("member", "other-host");
  await expect(f.service.bindScope(f.input())).rejects.toThrow(/storage|endpoint|owner|host|access/i);
});
it.each(["hostId", "environmentId", "root", "placementId", "generation", "kind", "thread"])("rejects mismatched trusted workspace %s", async field => {
  const f = await fixture(), value = structuredClone(f.delivery);
  if (field === "generation") value.workspaceBinding.generation++;
  else if (field === "kind") value.workspaceBinding.kind = "linked-worktree";
  else if (field === "thread") { value.threadId = "other"; value.bindingTemplate.threadId = "other"; }
  else Object.assign(value.workspaceBinding, { [field]: "wrong" });
  await expect(f.service.bindScope(f.input(value))).rejects.toThrow();
});
it("hashes exact UTF-8 delivery bytes and rejects a normalized or unrelated digest", async () => {
  const f = await fixture(), input = f.input(f.delivery, 1, "\n"); input.scopeDigest = digest(input.scopeFileJson.trim());
  await expect(f.service.bindScope(input)).rejects.toThrow(/digest/i);
});
it("retries exact bytes to the same file/map across service restart without rewriting", async () => {
  const f = await fixture(), input = f.input(), ack = await f.service.bindScope(input), bytes = readFileSync(ack.scopeFile, "utf8");
  const restarted = new NativeScopes(f.registry, { paths: { home: "/changed-native-home", tmp: [f.scratch], piAgentDir: f.agent } });
  expect(await restarted.bindScope(input)).toEqual(ack); expect(readFileSync(ack.scopeFile, "utf8")).toBe(bytes);
});
it("rejects older and conflicting same-revision delivery but accepts a newer policy revision", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input(f.delivery, 2));
  await expect(f.service.bindScope(f.input())).rejects.toThrow(/revision|stale/i);
  await expect(f.service.bindScope(f.input(f.delivery, 2, "\n"))).rejects.toThrow(/revision|conflict/i);
  const updated = structuredClone(f.delivery); updated.tools.deny.push("extra"); updated.bindingTemplate.tools.deny.push("extra");
  expect(await f.service.bindScope(f.input(updated, 3))).toMatchObject({ revision: 3, scopeFile: ack.scopeFile });
});
it("does not repair a tampered acknowledged file on an identical retry", async () => {
  const f = await fixture(), input = f.input(), ack = await f.service.bindScope(input); writeFileSync(ack.scopeFile, readFileSync(ack.scopeFile, "utf8") + " ");
  await expect(f.service.bindScope(input)).rejects.toThrow(/integrity|changed|digest/i);
});
it("rejects a symlinked executable file without reading or modifying its target", async () => {
  const f = await fixture(), input = f.input(), ack = await f.service.bindScope(input), outside = join(f.root, "outside"); writeFileSync(outside, "keep"); rmSync(ack.scopeFile); symlinkSync(outside, ack.scopeFile);
  await expect(f.service.bindScope(input)).rejects.toThrow(/integrity|symlink|regular/i); expect(readFileSync(outside, "utf8")).toBe("keep");
});
it("rejects a native env whose complete routing and speed-bump entries exceed the SDK budget", async () => {
  const f = await fixture("ranger");
  for (let i = 0; i < 12; i++) { f.delivery.env.variables["EXTRA_" + i] = "value"; f.delivery.bindingTemplate.env.variables["EXTRA_" + i] = "value"; }
  await expect(f.service.bindScope(f.input())).rejects.toThrow(/env|32|budget/i);
});
it("binds checker commands to the checker-local carried root rather than the maker path", async () => {
  const f = await fixture("warden"); f.delivery.checks!.worktree = "/maker/host/repo"; f.delivery.bindingTemplate.checks!.worktree = "/maker/host/repo";
  const ack = await f.service.bindScope(f.input()), value = scopeRenderedFileSchema.parse(JSON.parse(readFileSync(ack.scopeFile, "utf8")));
  expect(value.checks?.worktree).toBe(f.repo); expect(value.bindingTemplate.checks?.worktree).toBe("/maker/host/repo");
});
it("does not publish a scope or ACK after cancellation during repository validation", async () => {
  const f = await fixture(), controller = new AbortController(), original = context.assertRepository;
  vi.spyOn(context, "assertRepository").mockImplementation(async ctx => { await original(ctx); controller.abort(); });
  await expect(f.service.bindScope(f.input(), controller.signal)).rejects.toThrow(/abort|cancel/i);
  expect(existsSync(f.registry.scopeStatePath(f.authority, "scope.json"))).toBe(false);
});
it("release fences an in-flight bind, removes only owned files and is idempotent after revoke/root loss", async () => {
  const f = await fixture(), first = await f.service.bindScope(f.input()); let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; }), original = context.assertRepository;
  vi.spyOn(context, "assertRepository").mockImplementation(async ctx => { entered(); await gate; await original(ctx); });
  const binding = f.service.bindScope(f.input(f.delivery, 2)); const rejected = expect(binding).rejects.toThrow(/released|cancel/i); await waiting;
  expect(await f.service.releaseScope(f.authority)).toEqual({ released: true }); resume(); await rejected;
  expect(existsSync(first.scopeFile)).toBe(false);
  f.registry.revokePlacement({ placementId: "placement", generation: 1, reason: "released" }); rmSync(f.repo, { recursive: true });
  expect(await f.service.releaseScope(f.authority)).toEqual({ released: true });
});
it("tombstones a never-bound endpoint and rejects late delivery", async () => {
  const f = await fixture(); expect(await f.service.releaseScope(f.authority)).toEqual({ released: true });
  await expect(f.service.bindScope(f.input())).rejects.toThrow(/released/i);
});
it("recovers an interrupted file replacement from its exact persisted native rendering", async () => {
  const f = await fixture(), input = f.input(), original = store.atomicWrite;
  vi.spyOn(store, "atomicWrite").mockImplementation((file, value, check) => { if (file.endsWith("/scope.json")) throw new Error("simulated replacement failure"); original(file, value, check); });
  await expect(f.service.bindScope(input)).rejects.toThrow("simulated replacement failure"); vi.restoreAllMocks();
  const restarted = new NativeScopes(f.registry, { paths: { home: "/unavailable-restarted-home", tmp: ["/changed-scratch"], piAgentDir: f.agent } });
  expect(await restarted.bindScope(input)).toMatchObject({ variables: { HOME: f.home, TMPDIR: f.scratch } });
});
it("does not release a valid scope when the cleanup call was cancelled", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), controller = new AbortController(); controller.abort();
  await expect(f.service.releaseScope(f.authority, controller.signal)).rejects.toThrow(/abort|cancel/i); expect(existsSync(ack.scopeFile)).toBe(true);
});
it("rejects scope storage and cleanup for source/artifact endpoints", async () => {
  const f = await fixture(); f.registerStorage();
  await expect(f.service.releaseScope({ ...f.authority, endpointId: "storage" })).rejects.toThrow(/member|access/i);
});
it("does not accept a valid-looking private binding record from a different tuple", async () => {
  const f = await fixture(), input = f.input(); await f.service.bindScope(input);
  const file = f.registry.scopeStatePath(f.authority, "binding.json"), value = JSON.parse(readFileSync(file, "utf8")); value.binding.generation++;
  const rendered = JSON.parse(value.renderedJson); rendered.hostBinding = value.binding; value.renderedJson = JSON.stringify(rendered); value.renderedDigest = digest(value.renderedJson);
  writeFileSync(f.registry.scopeStatePath(f.authority, "scope.json"), value.renderedJson); writeFileSync(file, JSON.stringify(value));
  await expect(f.service.bindScope(input)).rejects.toThrow(/authority|tuple|identity|generation/i);
});
it("never lets old generation release affect a newer binding", async () => {
  const f = await fixture(); await f.service.bindScope(f.input());
  const registration = f.registry.endpoint(f.authority).registration; f.registry.registerEndpoint({ ...registration, generation: 2 });
  const authority = { ...f.authority, generation: 2 }; await inspectHost(f.registry, authority);
  const value = structuredClone(f.delivery); value.workspaceBinding.generation = 2;
  const input = { ...f.input(value), generation: 2 }, ack = await f.service.bindScope(input);
  await expect(f.service.releaseScope(f.authority)).rejects.toThrow(/generation|stale/i); expect(existsSync(ack.scopeFile)).toBe(true);
});
it("checks cancellation immediately before the executable file rename", async () => {
  const f = await fixture(), controller = new AbortController(), original = store.atomicWrite; let checks = 0;
  vi.spyOn(store, "atomicWrite").mockImplementation((file, value, check) => original(file, value, () => { if (file.endsWith("/scope.json") && ++checks === 2) controller.abort(); check?.(); }));
  await expect(f.service.bindScope(f.input(), controller.signal)).rejects.toThrow(/abort|cancel/i);
  expect(checks).toBe(2); expect(existsSync(f.registry.scopeStatePath(f.authority, "scope.json"))).toBe(false);
});
it("does not ACK a binding released at the final promise boundary", async () => {
  const f = await fixture(), original = store.atomicWrite;
  vi.spyOn(store, "atomicWrite").mockImplementation((file, value, check) => { original(file, value, check); if (file.endsWith("/binding.json") && JSON.parse(value).state === "bound") queueMicrotask(() => { void f.service.releaseScope(f.authority); }); });
  await expect(f.service.bindScope(f.input())).rejects.toThrow(/scope|released|bound/i);
});
it("does not return a decision after release at the final promise boundary", async () => {
  const f = await fixture(); await f.service.bindScope(f.input()); const original = engine.evaluate;
  vi.spyOn(engine, "evaluate").mockImplementation((scope, call) => { const result = original(scope, call); queueMicrotask(() => { void f.service.releaseScope(f.authority); }); return result; });
  await expect(f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "read", toolName: "read", input: {}, cwd: f.repo } })).rejects.toThrow(/scope|released|bound/i);
});
it("native call preparation discards forged path facts and denies a real symlink escape", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), outside = join(f.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(f.repo, "escape"));
  const path = join(f.repo, "escape/file"), result = await f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "write", toolName: "write", input: { path, content: "data" }, cwd: f.repo, resolvedPaths: { [path]: join(f.repo, "forged") }, ownedDraftPrs: ["forged"] } });
  expect(result).toMatchObject({ scopeRevision: 1, scopeDigest: ack.scopeDigest, decision: { allow: false, ruleId: "write-path" } });
  expect(result.call.resolvedPaths?.[path]).toBe(join(outside, "file")); expect(result.call.ownedDraftPrs).not.toContain("forged");
});
it("native call preparation uses native push remotes and branch rather than caller-supplied facts", async () => {
  const f = await fixture(); f.git("remote", "add", "origin", "https://github.com/owner/repo.git"); await f.service.bindScope(f.input());
  const result = await f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "bash", toolName: "bash", input: { command: "git push origin HEAD" }, cwd: f.repo, pushTargets: { fake: ["forged"] }, pushHeads: { fake: "main" }, gitRoots: { fake: "/forged" }, directories: ["/forged"], ownedDraftPrs: ["forged"] } });
  expect(result.decision).toMatchObject({ allow: true, acts: [expect.objectContaining({ kind: "publish" })] }); expect(Object.values(result.call.pushTargets!)).toEqual([["https://github.com/owner/repo.git"]]); expect(Object.values(result.call.pushHeads!)).toContain("tavern/member"); expect(JSON.stringify(result)).not.toContain("forged");
});
it("native call preparation evaluates denied tools against the rendered effective policy", async () => {
  const f = await fixture(); await f.service.bindScope(f.input());
  expect(await f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "read", toolName: "private_tool", input: {}, cwd: f.repo } })).toMatchObject({ decision: { allow: false, ruleId: "tool" } });
});
it("native call preparation rejects altered bytes instead of returning a policy decision", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()); writeFileSync(ack.scopeFile, readFileSync(ack.scopeFile, "utf8") + "\n");
  await expect(f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "read", toolName: "read", input: {}, cwd: f.repo } })).rejects.toThrow(/integrity|bytes|changed/i);
});
it("native call preparation refuses missing, old and released bindings", async () => {
  const f = await fixture(), input: HostInput<"prepareCall"> = { ...f.authority, scopeRevision: 1, call: { kind: "read", toolName: "read", input: {}, cwd: f.repo } };
  await expect(f.service.prepareCall(input)).rejects.toThrow(/scope|bound/i); await f.service.bindScope(f.input(f.delivery, 2));
  await expect(f.service.prepareCall(input)).rejects.toThrow(/revision|stale/i); await f.service.releaseScope(f.authority);
  await expect(f.service.prepareCall({ ...input, scopeRevision: 2 })).rejects.toThrow(/scope|released/i);
});
it("native call preparation fences a new policy revision arriving during repository inspection", async () => {
  const f = await fixture(); await f.service.bindScope(f.input()); const original = context.assertRepository;
  vi.spyOn(context, "assertRepository").mockImplementationOnce(async ctx => { await original(ctx); await f.service.bindScope(f.input(f.delivery, 2)); });
  await expect(f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "read", toolName: "read", input: {}, cwd: f.repo } })).rejects.toThrow(/revision|changed|stale/i);
});
it("native facts resolve draft ownership through cancellable native read processes", async () => {
  const f = await fixture(); f.git("remote", "add", "origin", "https://github.com/owner/repo.git"); await f.service.bindScope(f.input()); const original = nativeProcess.runProcess;
  const spy = vi.spyOn(nativeProcess, "runProcess").mockImplementation((program, args, options) => program !== "gh" ? original(program, args, options) : Promise.resolve({ code: 0, timedOut: false, stderr: "", stdout: JSON.stringify(args[0] === "pr" ? { isDraft: true, author: { login: "viewer" }, headRefName: "tavern/member", headRepositoryOwner: { login: "owner" }, headRepository: { name: "repo" } } : { login: "viewer" }) }));
  const result = await f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "bash", toolName: "bash", input: { command: "gh pr edit --title Updated" }, cwd: f.repo } });
  expect(result.decision).toMatchObject({ allow: true, acts: [expect.objectContaining({ kind: "publish" })] }); expect(result.call.ownedDraftPrs).toHaveLength(1);
  const queries = spy.mock.calls.filter(([program]) => program === "gh"); expect(queries).toHaveLength(2); for (const [, , options] of queries) expect(options.signal).toBeInstanceOf(AbortSignal);
});
it("native facts abort while awaiting a read and never return an allow", async () => {
  const f = await fixture(); await f.service.bindScope(f.input()); const original = nativeProcess.runProcess, controller = new AbortController(); let entered!: () => void, finish!: (value: nativeProcess.ProcessResult) => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<nativeProcess.ProcessResult>(resolve => { finish = resolve; });
  vi.spyOn(nativeProcess, "runProcess").mockImplementation((program, args, options) => { if (program !== "gh") return original(program, args, options); entered(); return gate; });
  const pending = f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "bash", toolName: "bash", input: { command: "gh pr edit --title Updated" }, cwd: f.repo } }, controller.signal);
  const rejected = expect(pending).rejects.toThrow(/abort|cancel/i); await waiting; controller.abort(); finish({ code: 0, stdout: "{}", stderr: "", timedOut: false }); await rejected;
});
it("native facts timeout is an explicit unavailable hold, not an allow or fabricated violation", async () => {
  const f = await fixture(); await f.service.bindScope(f.input()); const original = nativeProcess.runProcess;
  vi.spyOn(nativeProcess, "runProcess").mockImplementation((program, args, options) => program !== "gh" ? original(program, args, options) : Promise.resolve({ code: null, timedOut: true, stdout: "", stderr: "" }));
  await expect(f.service.prepareCall({ ...f.authority, scopeRevision: 1, call: { kind: "bash", toolName: "bash", input: { command: "gh pr edit --title Updated" }, cwd: f.repo } })).rejects.toThrow(/facts|timeout|deadline|unavailable/i);
});
it("binds and observes SHA256 repositories without confusing Git and scope digests", async () => {
  const f = await fixture("smith", "sha256"); expect(f.delivery.workspaceBinding.expectedTree).toHaveLength(64);
  const ack = await f.service.bindScope(f.input()); guarded(ack.scopeFile, f.repo).emit("session_start");
  expect(await f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest })).toMatchObject({ state: "armed" });
});
it("binds a linked native workspace without weakening the dedicated mode checks", async () => {
  const f = await fixture(), linked = join(f.root, "linked"); f.git("worktree", "add", "-q", "-b", "tavern/linked", linked);
  const authority = { ...f.authority, endpointId: "linked-member" }, registration = f.registry.endpoint(f.authority).registration;
  f.registry.registerEndpoint({ ...registration, endpointId: authority.endpointId, endpoint: { ...registration.endpoint, root: linked }, workspaceKind: "linked-worktree", allowedRefs: ["refs/heads/tavern/linked"] }); await inspectHost(f.registry, authority);
  const delivery = structuredClone(f.delivery); delivery.workspaceBinding.root = linked; delivery.workspaceBinding.kind = "linked-worktree";
  const ack = await f.service.bindScope({ ...f.input(delivery), endpointId: authority.endpointId }); guarded(ack.scopeFile, linked).emit("session_start");
  expect(await f.service.sessionStatus({ ...authority, revision: 1, scopeDigest: ack.scopeDigest })).toMatchObject({ state: "armed" });
});
it("native session proof uses exact identity and tuple rather than controller-host clock ordering", async () => {
  const f = await fixture(); f.delivery.issuedAt = Date.now() + 60_000; f.delivery.bindingTemplate.issuedAt = f.delivery.issuedAt;
  const ack = await f.service.bindScope(f.input()); guarded(ack.scopeFile, f.repo).emit("session_start");
  expect(await f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest })).toMatchObject({ state: "armed" });
});
it("native session status distinguishes delivered policy from a real guard-loaded receipt", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), input = { ...f.authority, revision: 1, scopeDigest: ack.scopeDigest };
  expect(await f.service.sessionStatus(input)).toMatchObject({ state: "not-observed" });
  const pi = guarded(ack.scopeFile, f.repo); pi.emit("session_start");
  expect(pi.tools()).toContain("private_tool"); expect(pi.emit("tool_call", { toolName: "read", input: { path: "tracked" } })).toBeUndefined();
  expect(await f.service.sessionStatus(input)).toEqual({ state: "armed", revision: 1, scopeDigest: ack.scopeDigest });
  const marker = JSON.parse(readFileSync(store.armedFile(ack.scopeFile), "utf8")); expect(marker).toMatchObject({ threadId: "member", pid: process.pid, hostBinding: { placementId: "placement", generation: 1, endpointId: "member-workspace", revision: 1, scopeDigest: ack.scopeDigest }, renderedDigest: digest(readFileSync(ack.scopeFile, "utf8")) });
});
it.each(["placementId", "generation", "endpointId", "revision", "scopeDigest", "renderedDigest", "threadId", "issuedAt"])("native session rejects stale marker %s", async field => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()); guarded(ack.scopeFile, f.repo).emit("session_start");
  const file = store.armedFile(ack.scopeFile), marker = JSON.parse(readFileSync(file, "utf8"));
  if (["generation", "revision"].includes(field)) marker.hostBinding[field]++;
  else if (field === "issuedAt") marker.issuedAt++;
  else if (field === "renderedDigest") marker.renderedDigest = "f".repeat(64);
  else if (field === "threadId") marker.threadId = "other";
  else marker.hostBinding[field] = field === "scopeDigest" ? "f".repeat(64) : "other";
  writeFileSync(file, JSON.stringify(marker)); expect(await f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest })).toMatchObject({ state: "stale" });
});
it("native session rejects a locally shaped marker and never lets a native marker arm controller storage", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), input = { ...f.authority, revision: 1, scopeDigest: ack.scopeDigest };
  store.armScope(ack.scopeFile, f.template); expect(await f.service.sessionStatus(input)).toMatchObject({ state: "stale" });
  guarded(ack.scopeFile, f.repo).emit("session_start");
  const local = new store.ScopeStore(join(f.root, "controller-data")); local.write("member", f.template);
  writeFileSync(store.armedFile(local.file("member")), readFileSync(store.armedFile(ack.scopeFile), "utf8")); expect(local.isArmed("member")).toBe(false);
});
it("native session rechecks actual bytes and a live native PID rather than trusting old arming", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), input = { ...f.authority, revision: 1, scopeDigest: ack.scopeDigest }; guarded(ack.scopeFile, f.repo).emit("session_start");
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  expect(await f.service.sessionStatus(input)).toMatchObject({ state: "stale" }); expect(kill).toHaveBeenCalledWith(process.pid, 0); kill.mockRestore();
  writeFileSync(ack.scopeFile, readFileSync(ack.scopeFile, "utf8") + " "); expect(await f.service.sessionStatus(input)).toMatchObject({ state: "stale" });
});
it("native session invalidates old revision receipts and observes a running guard's new policy read", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), pi = guarded(ack.scopeFile, f.repo); pi.emit("session_start"); const old = readFileSync(store.armedFile(ack.scopeFile), "utf8");
  const next = await f.service.bindScope(f.input(f.delivery, 2));
  expect(await f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest })).toEqual({ state: "stale", revision: 2, scopeDigest: next.scopeDigest });
  expect(await f.service.sessionStatus({ ...f.authority, revision: 2, scopeDigest: next.scopeDigest })).toMatchObject({ state: "not-observed" });
  writeFileSync(store.armedFile(next.scopeFile), old); expect(await f.service.sessionStatus({ ...f.authority, revision: 2, scopeDigest: next.scopeDigest })).toMatchObject({ state: "stale" });
  pi.emit("before_agent_start"); expect(await f.service.sessionStatus({ ...f.authority, revision: 2, scopeDigest: next.scopeDigest })).toMatchObject({ state: "armed" });
});
it.each(["watch", "off"] as const)("native session does not claim armed prevention for %s mode", async mode => {
  const f = await fixture(); f.delivery.mode = mode; f.delivery.bindingTemplate.mode = mode;
  const ack = await f.service.bindScope(f.input()); guarded(ack.scopeFile, f.repo).emit("session_start");
  expect(await f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest })).toMatchObject({ state: "not-observed" });
});
it("native session receipts cannot cross two hosts with identical workspace paths and PIDs", async () => {
  const f = await fixture(), a = await f.service.bindScope(f.input()); guarded(a.scopeFile, f.repo).emit("session_start"); const marker = readFileSync(store.armedFile(a.scopeFile), "utf8"), data = join(f.root, "host-b"); mkdirSync(data);
  const registry = new HostRegistry(data), registration = f.registry.endpoint(f.authority).registration; registry.registerEndpoint({ ...registration, endpoint: { ...registration.endpoint, hostId: "guest-b" } }); await inspectHost(registry, f.authority);
  const service = new NativeScopes(registry, { paths: { home: f.home, tmp: [f.scratch], piAgentDir: f.agent } }), delivery = structuredClone(f.delivery); delivery.workspaceBinding.hostId = "guest-b";
  const b = await service.bindScope(f.input(delivery)); writeFileSync(store.armedFile(b.scopeFile), marker);
  const kill = vi.spyOn(process, "kill"); expect(await service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: b.scopeDigest })).toMatchObject({ state: "stale" }); expect(kill).not.toHaveBeenCalled();
});
it("native session status respects cancellation before any receipt/PID probe", async () => {
  const f = await fixture(), ack = await f.service.bindScope(f.input()), controller = new AbortController(); controller.abort(); const kill = vi.spyOn(process, "kill");
  await expect(f.service.sessionStatus({ ...f.authority, revision: 1, scopeDigest: ack.scopeDigest }, controller.signal)).rejects.toThrow(/abort|cancel/i); expect(kill).not.toHaveBeenCalled();
});
