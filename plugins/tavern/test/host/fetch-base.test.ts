// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostContract, type Authority, type TransferRegistration } from "../../src/host-contract";
import * as gitHost from "../../src/host/git";
import { inspectHost } from "../../src/host/inspect";
import { HostRegistry } from "../../src/host/registry";
import { createTransport } from "../../src/host/transport";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(method: "import" | "carry", format: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(join(process.env.TAVERN_TEST_FIXTURES ?? tmpdir(), "fetch-base-")); roots.push(root);
  const source = join(root, "source"), target = join(root, "target"), data = join(root, "data");
  for (const [path, branch, value] of [[source, "release", "base"], [target, "member", "seed"]]) {
    mkdirSync(path!); git(path!, "init", "-q", "-b", branch!, "--object-format=" + format); git(path!, "config", "user.name", "Fixture"); git(path!, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(path!, "tracked"), value!); git(path!, "add", "tracked"); git(path!, "commit", "-qm", value!);
  }
  mkdirSync(data); const base = git(source, "rev-parse", "HEAD"), tree = git(source, "rev-parse", "HEAD^{tree}");
  writeFileSync(join(source, "tracked"), "newer remote tip"); git(source, "commit", "-qam", "tip"); const tip = git(source, "rev-parse", "HEAD");
  const seed = git(target, "rev-parse", "HEAD"), seedTree = git(target, "rev-parse", "HEAD^{tree}"), registry = new HostRegistry(data), port = createTransport(registry);
  const authority: Authority = { placementId: "placement", generation: 1, endpointId: "target", operationId: "operation" };
  registry.registerEndpoint({ placementId: "placement", generation: 1, endpointId: "target", endpoint: { hostId: "target-host", environmentId: "target-env", root: target }, ownerThreadId: method === "carry" ? "member-thread" : null, access: method === "carry" ? "member-write" : "home-import", workspaceKind: method === "carry" ? "dedicated-machine" : null, objectFormat: format, allowedRefs: method === "carry" ? ["refs/heads/member"] : ["refs/tavern/keeper/snapshot"] });
  await inspectHost(registry, authority);
  const transfer: TransferRegistration = { ...authority, transferId: "transfer", snapshotId: "snapshot", direction: method === "carry" ? "carry-out" : "bring-home", objectFormat: format, base, head: base, tree, fromEndpointId: "source", toEndpointId: "target", allowedRefs: method === "carry" ? [] : ["refs/tavern/keeper/snapshot"], uploads: [], artifacts: [] };
  registry.registerTransfer(transfer); const input = { ...authority, transferId: "transfer", remote: source, baseBranch: "refs/heads/release", networkTimeoutMs: 3000 };
  const author = { name: "Fixture", email: "fixture@example.invalid", date: "1700000000 +0000" }, fetches: string[][] = [], original = gitHost.runGit;
  vi.spyOn(gitHost, "runGit").mockImplementation((path, args, options) => { if (args.includes("fetch")) fetches.push([...args]); return original(path, args, options); });
  const run = (extra: Record<string, unknown> = {}) => method === "carry" ? port.carryStart({ ...input, paths: [], replaces: seedTree, ...extra }) : port.importCommit({ ...input, author, message: "pinned snapshot", entries: [], refs: ["refs/tavern/keeper/snapshot"], ...extra });
  return { source, target, base, tree, tip, seed, seedTree, port, input, fetches, run };
}
it.each([["import", "sha1"], ["import", "sha256"], ["carry", "sha1"], ["carry", "sha256"]] as const)("uses the full ref verbatim for %s/%s and materializes the pinned base, not the newer remote tip", async (method, format) => {
  const f = await fixture(method, format), index = readFileSync(join(f.target, ".git/index"));
  expect(await f.run()).toMatchObject({ outcome: "ok" }); expect(f.fetches[0]?.at(-1)).toBe("refs/heads/release"); expect(f.fetches).toHaveLength(1);
  expect(existsSync(join(f.target, ".git/FETCH_HEAD"))).toBe(false); expect(git(f.target, "for-each-ref", "refs/remotes")).toBe(""); expect(git(f.source, "rev-parse", "HEAD")).toBe(f.tip);
  if (method === "import") {
    const made = git(f.target, "rev-parse", "refs/tavern/keeper/snapshot"); expect(git(f.target, "rev-parse", made + "^")).toBe(f.base); expect(git(f.target, "rev-parse", made + "^{tree}")).toBe(f.tree);
    expect(git(f.target, "rev-parse", "HEAD")).toBe(f.seed); expect(readFileSync(join(f.target, ".git/index"))).toEqual(index); expect(readFileSync(join(f.target, "tracked"), "utf8")).toBe("seed");
  } else { expect(git(f.target, "rev-parse", "HEAD")).toBe(f.base); expect(readFileSync(join(f.target, "tracked"), "utf8")).toBe("base"); }
});
it("keeps short legacy import refs compatible", async () => {
  const f = await fixture("import"); expect(await f.run({ baseBranch: "release" })).toMatchObject({ outcome: "ok" }); expect(f.fetches[0]?.at(-1)).toBe("refs/heads/release");
});
it("holds an exact-ref carry that would drop an unproven existing checkout instead of guessing tracking refs", async () => {
  const f = await fixture("carry"); const result = await f.run({ replaces: undefined }); expect(result).toMatchObject({ outcome: "unavailable", code: "carry-blocked", message: expect.stringMatching(/trusted|preserv/i) }); expect(f.fetches).toEqual([]); expect(git(f.target, "rev-parse", "HEAD")).toBe(f.seed); expect(readFileSync(join(f.target, "tracked"), "utf8")).toBe("seed");
});
it.each(["import", "carry"] as const)("blocks %s when neither the requested full ref nor exact SHA provides the registered base", async method => {
  const f = await fixture(method), index = readFileSync(join(f.target, ".git/index"));
  expect(await f.run({ remote: f.target })).toMatchObject({ outcome: "unavailable", code: "base-unavailable" }); expect(f.fetches.map(args => args.at(-1))).toEqual(["refs/heads/release", f.base]);
  expect(git(f.target, "rev-parse", "HEAD")).toBe(f.seed); expect(readFileSync(join(f.target, ".git/index"))).toEqual(index); expect(readFileSync(join(f.target, "tracked"), "utf8")).toBe("seed"); expect(existsSync(join(f.target, ".git/FETCH_HEAD"))).toBe(false);
});
it("validates full fetch refs at the wire boundary instead of silently treating malformed refs as short branches", async () => {
  const f = await fixture("carry"); expect(hostContract.carryStart.input.safeParse({ ...f.input, paths: [], baseBranch: "refs/heads/bad." }).success).toBe(false);
});
