import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as ledgerApi from "../src/ledger";
import type { ComposerRow, LedgerIo, PublishedComposer } from "../src/ledger";

const at = "2026-11-22T00:00:00.000Z";
const summaryPath = ".bb/press/threads/thr_a/summaries/press-abc.md";
const historyRow: ComposerRow = {
  id: "press-abc", at, finishedAt: Date.parse(at), point: "manual", tokensBefore: 209_544,
  tokensAfter: 3_227, model: null, ms: 78_600, summaryPath, outcome: "ok",
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function nodeIo(): Promise<{ io: LedgerIo; root: string }> {
  const root = await mkdtemp(resolve("node_modules/.press-ledger-"));
  roots.push(root);
  const io: LedgerIo = {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(path, content) {
      await writeFile(path, content, "utf8");
    },
    rename,
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
  };
  return { io, root };
}

describe("per-thread ledger", () => {
  it("reads only the thread's ledger, never the legacy workspace file", async () => {
    const { io, root } = await nodeIo();
    const path = ledgerApi.ledgerPath(root, "thr_a");
    expect(path).toBe(join(root, ".bb/press/threads/thr_a/ledger.json"));
    await io.mkdir(join(root, ".bb/press"));
    await io.write(join(root, ".bb/press/ledger.json"), JSON.stringify({ threadId: "thr_a", history: [historyRow] }));
    expect(await ledgerApi.readLedger(io, path)).toBeNull();
    await io.mkdir(join(root, ".bb/press/threads/thr_a"));
    await io.write(path, JSON.stringify({ threadId: "thr_a", history: [historyRow] }));
    expect(await ledgerApi.readLedger(io, path)).toMatchObject({ threadId: "thr_a", history: [historyRow] });
    expect(await ledgerApi.readLedger(io, ledgerApi.ledgerPath(root, "thr_b"))).toBeNull();
    expect(() => ledgerApi.ledgerPath(root, "../thr_b")).toThrow();
    await io.write(path, "{not JSON");
    expect(await ledgerApi.readLedger(io, path)).toBeNull();
  });

  it("exposes only composer compactions that Pi applied, with normalized finish times", () => {
    const ledger = ledgerApi.parseLedger(JSON.stringify({ history: [
      historyRow,
      { ...historyRow, id: "no-time", finishedAt: undefined, preview: "extra" },
      { ...historyRow, id: "failed", outcome: "failed" },
      { ...historyRow, id: "cancelled", outcome: "cancelled" },
      { ...historyRow, id: "native", outcome: undefined },
      { ...historyRow, id: "malformed", at: "not a date" },
      null,
    ] }));
    expect(ledgerApi.composerRows(ledger!)).toEqual([historyRow, { ...historyRow, id: "no-time", finishedAt: null }]);
  });

  it("accepts only markdown files within the requested thread's summary directory", () => {
    expect(ledgerApi.summaryFilePath("/repo", "thr_a", historyRow)).toBe(`/repo/${summaryPath}`);
    expect(ledgerApi.summaryFilePath("/repo", "thr_a", { summaryPath: summaryPath.replaceAll("/", "\\") }))
      .toBe(`/repo/${summaryPath}`);
    expect(ledgerApi.summaryFilePath("/repo", "thr_b", historyRow)).toBeNull();
    expect(ledgerApi.summaryFilePath("/repo", "../thr_a", historyRow)).toBeNull();
    for (const path of [null, "", `/${summaryPath}`, ".bb/press/summaries/press-abc.md", ".bb/press/threads/thr_a/summaries/../x.md", ".bb/press/threads/thr_a/summaries/archive/x.md", `${summaryPath}.bak`]) {
      expect(ledgerApi.summaryFilePath("/repo", "thr_a", { summaryPath: path })).toBeNull();
    }
  });
});

describe("published composer config", () => {
  const config: PublishedComposer = { model: "p/m", maxSummaryTokens: 900, ledger: false, resumeContract: true, updatedAt: at };

  it("atomically replaces the config with unique sibling files and leaves the ledger alone", async () => {
    const { io, root } = await nodeIo();
    const path = ledgerApi.composerConfigPath(root, "thr_a");
    expect(path).toBe(join(root, ".bb/press/threads/thr_a/composer.json"));
    const ledgerPath = ledgerApi.ledgerPath(root, "thr_a");
    const tempPaths: string[] = [];
    const observed: Array<string | null> = [];
    const tracked = { ...io, async rename(from: string, to: string) {
      tempPaths.push(from);
      observed.push(await io.read(to));
      await io.rename(from, to);
    } };
    await ledgerApi.writeComposerConfig(tracked, path, config);
    const original = await io.read(path);
    expect(JSON.parse(original!)).toEqual(config);
    expect(await io.read(ledgerPath)).toBeNull();
    await io.write(ledgerPath, "only the composer can write this file");
    const changed = { ...config, model: null, resumeContract: false };
    await ledgerApi.writeComposerConfig(tracked, path, changed);
    expect(observed).toEqual([null, original]);
    expect(new Set(tempPaths).size).toBe(2);
    for (const file of tempPaths) {
      expect(file).toMatch(`${path}.`);
      expect(await io.read(file)).toBeNull();
    }
    expect(JSON.parse((await io.read(path))!)).toEqual(changed);
    expect(await io.read(ledgerPath)).toBe("only the composer can write this file");
    expect(await io.read(ledgerApi.composerConfigPath(root, "thr_b"))).toBeNull();
  });

  it("preserves the previous config if the rename fails", async () => {
    const { io, root } = await nodeIo();
    const path = ledgerApi.composerConfigPath(root, "thr_a");
    await ledgerApi.writeComposerConfig(io, path, config);
    await expect(ledgerApi.writeComposerConfig({ ...io, async rename() { throw new Error("rename failed"); } }, path, { ...config, model: null }))
      .rejects.toThrow("rename failed");
    expect(JSON.parse((await io.read(path))!)).toEqual(config);
  });
});
