import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  capLedger,
  emptyLedger,
  ledgerBytes,
  ledgerPath,
  mergeCompaction,
  mergeComposer,
  parseLedger,
  sameComposer,
  readLedger,
  serializeLedger,
  writeLedgerAtomic,
  type Ledger,
  type LedgerIo,
} from "../src/ledger";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "press-ledger-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A LedgerIo over a real temp dir, with the same semantics as the bb.sdk.files adapter. */
async function nodeIo(): Promise<{ io: LedgerIo; dir: string }> {
  const dir = await tempRoot();
  const io: LedgerIo = {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async write(path, content) {
      await mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    async move(from, to) {
      await rename(from, to);
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
  };
  return { io, dir };
}

function ledger(rows: number, constraints = 0): Ledger {
  const base = emptyLedger("thr_test", "2026-11-22T00:00:00Z");
  base.constraints = Array.from({ length: constraints }, (_, i) => ({
    id: `c${i}`,
    text: `constraint number ${i} never drop me`,
    source: `user#${i}`,
    at: "2026-11-22T00:00:00Z",
  }));
  base.state.filesRead = Array.from({ length: rows }, (_, i) => ({ path: `src/file${i}.ts`, at: `2026-11-22T00:${String(i).padStart(2, "0")}:00Z` }));
  base.state.commands = Array.from({ length: rows }, (_, i) => ({ cmd: `npm test ${i}`, exit: i % 2, at: "2026-11-22T00:00:00Z" }));
  return base;
}

describe("parseLedger", () => {
  it("returns null on missing, corrupt and non-object files", () => {
    expect(parseLedger(null)).toBeNull();
    expect(parseLedger("not json")).toBeNull();
    expect(parseLedger("[1,2]")).toBeNull();
  });

  it("preserves unknown fields", () => {
    const parsed = parseLedger(JSON.stringify({ schemaVersion: 1, threadId: "thr_x", futureField: { deep: true } }));
    expect(parsed).not.toBeNull();
    expect((parsed as { futureField?: unknown }).futureField).toEqual({ deep: true });
  });
});

describe("capLedger", () => {
  it("keeps a small ledger byte-identical", () => {
    const small = ledger(2);
    expect(capLedger(small)).toEqual(small);
  });

  it("drops the oldest filesRead rows first, then commands, never constraints", () => {
    const big = ledger(400, 3);
    const capped = capLedger(big, 12_000);
    expect(ledgerBytes(capped)).toBeLessThanOrEqual(12_000);
    expect(capped.constraints).toHaveLength(3);
    expect(capped.state.filesRead.length).toBeLessThan(400);
    if (capped.state.filesRead.length > 0) {
      // oldest first dropped: what survives is the tail
      expect(capped.state.filesRead[0]?.path).not.toBe("src/file0.ts");
    }
  });

  it("never drops constraints even when nothing else fits", () => {
    const big = ledger(0, 200);
    const capped = capLedger(big, 4_000);
    expect(capped.constraints).toHaveLength(200);
  });
});

describe("mergeCompaction", () => {
  it("bumps the counter and appends a history row, newest last", () => {
    const base = ledger(1);
    base.compactions = 2;
    const next = mergeCompaction(
      base,
      {
        id: "cmp_1",
        at: "2026-11-22T21:04:00Z",
        point: "phase",
        tokensBefore: 808_380,
        tokensAfter: 96_000,
        model: "z-ai/glm-5.3-flash",
        ms: 372_000,
        keptTurns: 6,
        summaryHash: "abc",
      },
      "2026-11-22T21:04:00Z",
    );
    expect(next.compactions).toBe(3);
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toMatchObject({ id: "cmp_1", point: "phase", tokensBefore: 808_380 });
    expect(next.state.filesRead).toEqual(base.state.filesRead);
  });

  it("does not double-count a re-merged outcome", () => {
    const once = mergeCompaction(null, { id: "cmp_1", at: "x", point: "phase", tokensBefore: 1, tokensAfter: null, model: null, ms: null, keptTurns: null, summaryHash: "" }, "x");
    const twice = mergeCompaction(once, { id: "cmp_1", at: "x", point: "phase", tokensBefore: 1, tokensAfter: null, model: null, ms: null, keptTurns: null, summaryHash: "" }, "x");
    expect(twice.compactions).toBe(1);
    expect(twice.history).toHaveLength(1);
  });
});

describe("writeLedgerAtomic", () => {
  it("writes the ledger, keeps the previous file as .bak, and leaves no temp", async () => {
    const { io, dir } = await nodeIo();
    const path = ledgerPath(dir);
    const first = ledger(1);
    await writeLedgerAtomic(io, path, first);

    expect(parseLedger(await io.read(path))).toMatchObject({ compactions: first.compactions });

    const second = mergeCompaction(first, { id: "cmp_2", at: "y", point: "idle", tokensBefore: 2, tokensAfter: 3, model: null, ms: null, keptTurns: null, summaryHash: "" }, "y");
    await writeLedgerAtomic(io, path, second);

    const live = parseLedger(await io.read(path));
    expect(live).not.toBeNull();
    expect((live as Ledger).history.at(-1)?.id).toBe("cmp_2");

    const bak = parseLedger(await io.read(`${path}.bak`));
    expect(bak).not.toBeNull();
    expect((bak as Ledger).compactions).toBe(first.compactions);

    expect(await io.read(`${path}.tmp`)).toBeNull();
  });

  it("readLedger is null before any write", async () => {
    const { io, dir } = await nodeIo();
    expect(await readLedger(io, ledgerPath(dir))).toBeNull();
  });

  it("serializes stably with a trailing newline", () => {
    expect(serializeLedger(emptyLedger("thr_x", "2026-11-22T00:00:00Z")).endsWith("\n")).toBe(true);
  });
});
describe("mergeComposer", () => {
  const composer = { model: "openai/gpt-4o-mini", maxSummaryTokens: 900, ledger: true, resumeContract: true } as const;

  it("sets the composer config and preserves every other field", () => {
    const existing = emptyLedger("thr_1", "2026-01-01T00:00:00.000Z");
    existing.constraints.push({ id: "c1", text: "never touch composer/", source: "user", at: "2026-01-01T00:00:00.000Z" });
    const withHistory = mergeCompaction(existing, {
      id: "cmp_1",
      at: "2026-01-01T00:01:00.000Z",
      point: "phase",
      tokensBefore: 100,
      tokensAfter: 50,
      model: null,
      ms: 10,
      keptTurns: 6,
      summaryHash: "abc",
    }, "2026-01-01T00:01:00.000Z");
    const merged = mergeComposer(withHistory, composer, "2026-01-02T00:00:00.000Z");
    expect(merged.composer).toEqual(composer);
    expect(merged.constraints).toHaveLength(1);
    expect(merged.history).toHaveLength(1);
    expect(merged.compactions).toBe(1);
    expect(merged.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("creates an empty ledger when none exists", () => {
    const merged = mergeComposer(null, composer, "2026-01-02T00:00:00.000Z");
    expect(merged.composer).toEqual(composer);
    expect(merged.constraints).toEqual([]);
    expect(merged.history).toEqual([]);
  });

  it("round-trips through parseLedger", () => {
    const merged = mergeComposer(null, composer, "2026-01-02T00:00:00.000Z");
    const parsed = parseLedger(serializeLedger(merged));
    expect(parsed?.composer).toEqual(composer);
  });
});

describe("sameComposer", () => {
  const composer = { model: null, maxSummaryTokens: 3000, ledger: true, resumeContract: true } as const;

  it("matches only the exact config", () => {
    expect(sameComposer(composer, composer)).toBe(true);
    expect(sameComposer({ ...composer, model: "z-ai/glm-5.3-flash" }, composer)).toBe(false);
    expect(sameComposer({ ...composer, maxSummaryTokens: 2500 }, composer)).toBe(false);
    expect(sameComposer({ model: null, maxSummaryTokens: 3000 }, composer)).toBe(false);
    expect(sameComposer(null, composer)).toBe(false);
    expect(sameComposer("nope", composer)).toBe(false);
  });
});
