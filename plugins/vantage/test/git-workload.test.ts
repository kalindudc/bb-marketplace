// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";

const sha = "a".repeat(40);
const oid = "b".repeat(40);
const harness = experimental_createHostEntryHarness(hostEntry);
afterAll(() => harness.experimental_dispose());
let home: string;
let repo: string;
let trace: string;
let savedEnv: NodeJS.ProcessEnv;

function calls(): string[][] {
  return existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];
}

beforeEach(() => {
  savedEnv = { ...process.env };
  home = realpathSync(mkdtempSync(join(tmpdir(), "vantage-budget-")));
  repo = join(home, "repo");
  trace = join(home, "argv.jsonl");
  mkdirSync(repo);
  writeFileSync(
    join(home, "git"),
    `#!${process.execPath}
const fs = require('node:fs');
const all = process.argv.slice(2);
const at = all.indexOf('-C');
const root = all[at + 1];
const args = all.slice(at + 2).filter((a) => !a.startsWith('-c'));
fs.appendFileSync(process.env.VANTAGE_TEST_TRACE, JSON.stringify(all) + '\\n');
const sha = '${sha}', oid = '${oid}';
const count = Number(process.env.VANTAGE_TEST_PATHS || '1');
const paths = Array.from({length: count}, (_, i) => i === 0 ? 'file.txt' : 'path-' + i);
const bytes = process.env.VANTAGE_TEST_BLOB_SIZE || '10';
let out = '';
if (args.includes('rev-parse')) {
  out = args.includes('--show-toplevel') ? root + '\\n' : sha + '\\n';
  if (args.includes('--is-shallow-repository')) out += 'false\\n' + sha + '\\ntopic\\n';
}
if (args.includes('status')) {
  out = '# branch.oid ' + (process.env.VANTAGE_TEST_STATUS_HEAD || sha) + '\\0# branch.head topic\\0';
  out += paths.map((p) => '1 .M N... 100644 100644 100644 ' + sha + ' ' + oid + ' ' + p + '\\0').join('');
}
if (args.includes('--raw')) out = paths.map((p) => ':100644 100644 ' + sha + ' ' + oid + ' M\\0' + p + '\\0').join('');
if (args.includes('--name-status')) out = 'M\\0file.txt\\0';
if (args.includes('--numstat')) out = '1\\t1\\tfile.txt\\0';
if (args.includes('ls-tree')) out = '100644 blob ' + oid + ' ' + bytes + '\\tfile.txt\\0';
if (args.some((a) => a.startsWith('--batch-check'))) {
  const input = fs.readFileSync(0, 'utf8').trim().split('\\n');
  out = input.map((id) => id + ' blob ' + bytes + '\\n').join('');
}
if (args.includes('cat-file') && args.includes('blob')) process.exit(17);
process.stdout.write(out);
`,
    { mode: 0o700 },
  );
  process.env.HOME = home;
  process.env.PATH = `${home}:${savedEnv.PATH ?? ""}`;
  process.env.VANTAGE_TEST_TRACE = trace;
});

afterEach(() => {
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

describe("Git workload safety", () => {
  it("blocks configured paths and their aliases, including missing files, without starting Git", async () => {
    const physical = join(home, "physical");
    const checkout = join(physical, "nested", "fake", "src");
    mkdirSync(checkout, { recursive: true });
    symlinkSync(physical, join(home, "checkouts"));
    const alias = join(home, "alias");
    symlinkSync(checkout, alias);
    const target = { type: "uncommitted" } as const;
    const excludedRoots = ["~/checkouts"];
    for (const root of [join(home, "checkouts", "nested", "missing"), checkout, alias]) {
      expect(await harness.experimental_call("repoFiles", { root, target, excludedRoots })).toMatchObject({
        outcome: "unavailable",
        message: expect.stringMatching(/excluded/),
      });
    }
    const paths = [
      "~/checkouts/nested/fake/src/file",
      `${home}/outside/../checkouts/nested/missing/file`,
      join(alias, "gone", "file"),
      checkout,
    ];
    const { results } = await harness.experimental_call("resolveRoots", { paths, excludedRoots });
    expect(results).toEqual(paths.map((path) => ({ path, root: null, relative: null, excluded: true })));
    expect(calls()).toEqual([]);
  });

  it.each([
    [1, "200000000000"],
    [130, "10"],
    [5, "1048576"],
  ])("keeps the file list but never runs numstat for %i paths of %s bytes", async (paths, bytes) => {
    process.env.VANTAGE_TEST_PATHS = String(paths);
    process.env.VANTAGE_TEST_BLOB_SIZE = bytes;
    const result = await harness.experimental_call("repoFiles", { root: repo, target: { type: "commit", sha } });
    expect(result).toMatchObject({
      outcome: "available",
      files: expect.arrayContaining([expect.objectContaining({ path: "file.txt", additions: null, deletions: null })]),
    });
    expect(calls().some((args) => args.includes("--raw"))).toBe(true);
    expect(calls().some((args) => args.some((arg) => arg === "--numstat" || arg === "-M"))).toBe(false);
    for (const args of calls().filter((argv) => argv.includes("--raw"))) expect(args).toContain("--no-renames");
  });

  it("uses at most six Git processes on a cold checkout with ordinary working edits", async () => {
    writeFileSync(join(repo, "file.txt"), "current\n");
    expect(await harness.experimental_call("checkoutStatus", { root: repo, base: null, pick: true })).toMatchObject({
      outcome: "available",
      uncommitted: [{ path: "file.txt", additions: 1, deletions: 1 }],
    });
    expect(calls()).toHaveLength(5);
    expect(calls().find((args) => args.includes("status"))).toEqual(
      expect.arrayContaining(["--porcelain=v2", "--no-renames"]),
    );
  });

  it("keeps the 128-path count guard on the checkout status path", async () => {
    process.env.VANTAGE_TEST_PATHS = "130";
    expect(await harness.experimental_call("checkoutStatus", { root: repo, base: null })).toMatchObject({
      outcome: "available",
      uncommitted: expect.arrayContaining([expect.objectContaining({ path: "file.txt", additions: null })]),
    });
    expect(calls().some((args) => args.includes("--numstat"))).toBe(false);
  });

  it("never does a numstat with object sizes from a different HEAD", async () => {
    process.env.VANTAGE_TEST_STATUS_HEAD = oid;
    expect(await harness.experimental_call("checkoutStatus", { root: repo, base: null })).toMatchObject({
      outcome: "unavailable",
      message: expect.stringMatching(/HEAD changed/),
    });
    expect(calls().some((args) => args.includes("--numstat"))).toBe(false);
  });

  it("blocks provider paths forwarded by a server on another host", async () => {
    const alias = join(home, "provider-alias");
    symlinkSync(repo, alias);
    const paths = [join(repo, "missing.txt"), join(alias, "missing.txt")];
    expect((await harness.experimental_call("resolveRoots", { paths, excludedRoots: [alias] })).results).toEqual(
      paths.map((path) => ({ path, root: null, relative: null, excluded: true })),
    );
    expect(calls()).toEqual([]);
  });

  it("allows numstat for bounded blobs with explicitly disabled diff drivers and rename detection", async () => {
    const result = await harness.experimental_call("repoFiles", { root: repo, target: { type: "commit", sha } });
    expect(result).toMatchObject({
      outcome: "available",
      files: [expect.objectContaining({ additions: 1, deletions: 1 })],
    });
    expect(calls().find((args) => args.includes("--numstat"))).toEqual(
      expect.arrayContaining([
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--",
        ":(literal)file.txt",
      ]),
    );
  });

  it("refuses an oversized committed patch before Git diff", async () => {
    const input = {
      root: repo,
      target: { type: "commit", sha } as const,
      path: "file.txt",
      previousPath: null,
      untracked: false,
    };
    process.env.VANTAGE_TEST_BLOB_SIZE = "200000000000";
    expect(await harness.experimental_call("repoPatch", input)).toMatchObject({
      outcome: "unavailable",
      message: expect.stringMatching(/large|limit/i),
    });
    expect(calls().some((args) => args.includes("diff"))).toBe(false);
  });

  it("reports a failed binary blob read", async () => {
    const input = {
      root: repo,
      target: { type: "commit", sha } as const,
      path: "file.txt",
      previousPath: null,
      untracked: false,
    };
    expect(await harness.experimental_call("imageSides", input)).toMatchObject({ outcome: "unavailable" });
    expect(calls().some((args) => args.includes("cat-file") && args.includes("blob"))).toBe(true);
  });

  it("does not diff an untracked symlink or probe up an arbitrarily deep missing path", async () => {
    symlinkSync(trace, join(repo, "link.txt"));
    expect(
      await harness.experimental_call("repoPatch", {
        root: repo,
        target: { type: "uncommitted" },
        path: "link.txt",
        previousPath: null,
        untracked: true,
      }),
    ).toMatchObject({ outcome: "unavailable" });
    expect(calls().some((args) => args.includes("--no-index"))).toBe(false);
    const path = join(repo, ...Array<string>(40).fill("missing"), "file");
    expect((await harness.experimental_call("resolveRoots", { paths: [path] })).results[0]).toMatchObject({
      path,
      root: null,
    });
    expect(calls().filter((args) => args.includes("--show-toplevel"))).toHaveLength(1);
  });
});
