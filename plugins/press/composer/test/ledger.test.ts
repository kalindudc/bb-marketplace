import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as composerLedger from "../src/ledger.ts";
import { summaryRelativePath } from "../src/ledger-format.ts";
import type { ComposerRow, LedgerIo } from "../src/types.ts";

const NOW = "2026-11-22T00:00:00.000Z";
const { capLedger, constraintsFromText, emptyLedger, mergeLedger, readLedger, writeLedger } = composerLedger;

function workspace(t: TestContext): string {
  const path = mkdtempSync(fileURLToPath(new URL("../node_modules/.press-ledger-", import.meta.url)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("constraints keep imperatives, not incidental words or questions", () => {
  const text = "The build is not slow. It only edits logs. We keep a count. I don’t see a crash. " +
    "Never commit unless I ask. Use tabs, not spaces. The queue must stay ordered. Do not update production. " +
    "Must we change the config? Thanks!";
  const rows = constraintsFromText(text, "user#2", NOW);
  assert.deepEqual(rows.map((row) => row.text), [
    "Never commit unless I ask.", "Use tabs, not spaces.", "The queue must stay ordered.", "Do not update production.",
  ]);
  assert.equal(rows[0]!.source, "user#2");
});

test("caps constraint count and UTF-8 bytes, dropping the oldest before rendering", () => {
  const first = emptyLedger("thr_x", NOW);
  first.constraints = constraintsFromText(Array.from({ length: 39 }, (_, i) => `Never commit rule ${i}.`).join("\n"), "user#1", NOW);
  const second = emptyLedger("thr_x", NOW);
  second.constraints = constraintsFromText(Array.from({ length: 37 }, (_, i) => `Never change rule ${i}.`).join("\n"), "user#2", NOW);
  const merged = mergeLedger(first, second);
  assert.equal(merged.constraints.length, 40);
  assert.equal(merged.constraints[0]?.text, "Never commit rule 36.");
  second.constraints = constraintsFromText(Array.from({ length: 26 }, (_, i) => `Never change ${i} ${"漢".repeat(320)}.`).join("\n"), "user#3", NOW);
  const capped = mergeLedger(first, second).constraints;
  assert.ok(Buffer.byteLength(capped.map((row) => row.text).join("\n")) <= 6_000);
  assert.ok(capped.length < 26);
  assert.ok(capped.at(-1)?.text.startsWith("Never change 25"));
});

test("caps the actual serialized ledger, keeping the newest files and high-value state", () => {
  const ledger = emptyLedger("thr_x", NOW);
  ledger.constraints = [{ id: "c1", text: "never commit", source: "user#1", at: NOW }];
  ledger.state.filesRead = Array.from({ length: 400 }, (_, i) => ({ path: `src/${i}-${"x".repeat(70)}.ts`, at: NOW }));
  const capped = capLedger(ledger, 4_000);
  assert.ok(Buffer.byteLength(`${JSON.stringify(capped, null, 2)}\n`) <= 4_000);
  assert.equal(capped.constraints.length, 1);
  assert.deepEqual(capped.state.filesRead.at(-1), ledger.state.filesRead.at(-1));
  ledger.resume = { state: "x".repeat(45_000), next: "do work", verify: "run tests" };
  ledger.state.openQuestions = Array.from({ length: 50 }, () => "?".repeat(300));
  const huge = capLedger(ledger);
  assert.ok(Buffer.byteLength(`${JSON.stringify(huge, null, 2)}\n`) <= 24_000);
  assert.equal(huge.constraints[0]?.text, "never commit");
});

test("history yields to recent cross-span state before the ledger reaches 24 KB", () => {
  const threadId = "thr_ledgertest";
  const ledger = emptyLedger(threadId, NOW);
  ledger.constraints = constraintsFromText(
    Array.from({ length: 20 }, (_, i) => `Never change fixture ${i} without permission from the owner.`).join("\n"),
    "user#1", NOW,
  );
  ledger.state.filesRead = Array.from({ length: 60 }, (_, i) => ({ path: `plugins/press/src/feature-${i}/index.ts`, at: NOW }));
  ledger.state.filesWritten = Array.from({ length: 20 }, (_, i) => ({ path: `plugins/press/test/feature-${i}.test.ts`, at: NOW }));
  ledger.state.commands = Array.from({ length: 40 }, (_, i) => ({ cmd: `npx vitest run test/feature-${i}.test.ts`, exit: 0, at: NOW }));
  ledger.history = Array.from({ length: 50 }, (_, i): ComposerRow => {
    const id = `press-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    return { id, at: NOW, finishedAt: Date.parse(NOW), point: "manual", tokensBefore: 165_575, tokensAfter: null,
      model: "openrouter/anthropic/claude-sonnet-4.6", ms: 4_501, summaryPath: summaryRelativePath(threadId, id), outcome: "ok" };
  });
  const capped = capLedger(ledger);
  assert.ok(Buffer.byteLength(`${JSON.stringify(capped, null, 2)}\n`) <= 24_000);
  assert.deepEqual(capped.state, ledger.state);
  assert.deepEqual(capped.constraints, ledger.constraints);
  assert.ok(capped.history.length < 50);
  assert.ok(capped.history.length >= 10);
  assert.deepEqual(capped.history, ledger.history.slice(-capped.history.length));
});

test("mergeLedger unions constraints and keeps the original goal", () => {
  const first = emptyLedger("thr_x", NOW);
  first.constraints = [{ id: "c1", text: "never commit", source: "user#1", at: NOW }];
  first.state.goal = "old goal";
  first.state.commands = [{ cmd: "npm test", exit: 1, at: NOW }];
  const second = emptyLedger("thr_x", NOW);
  second.constraints = [first.constraints[0]!, { id: "c2", text: "use tabs", source: "user#3", at: NOW }];
  second.state.goal = "new goal";
  second.state.commands = [{ cmd: "npm test", exit: 0, at: NOW }];
  const merged = mergeLedger(first, second);
  assert.deepEqual(merged.constraints.map((row) => row.text), ["never commit", "use tabs"]);
  assert.equal(merged.state.goal, "old goal");
  assert.equal(merged.state.commands.length, 2);
});

test("a failed ledger replace leaves the real ledger untouched", async (t) => {
  const path = join(workspace(t), "ledger.json");
  const live = emptyLedger("thr_x", NOW);
  live.state.goal = "original";
  await writeLedger(composerLedger.nodeLedgerIo, path, live);
  const before = readFileSync(path, "utf8");
  const attempts: string[] = [];
  const broken: LedgerIo = { ...composerLedger.nodeLedgerIo, async rename(from, to) {
    assert.equal(to, path);
    assert.equal(readFileSync(path, "utf8"), before);
    attempts.push(from);
    throw new Error("rename refused");
  } };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(writeLedger(broken, path, emptyLedger("thr_x", NOW)), /rename refused/);
    assert.equal(readFileSync(path, "utf8"), before);
  }
  assert.equal(new Set(attempts).size, 2);
});

test("readLedger tolerates corrupt files and fills missing fields", async (t) => {
  const path = join(workspace(t), "ledger.json");
  assert.equal(await readLedger(composerLedger.nodeLedgerIo, path), null);
  writeFileSync(path, "{not json", "utf8");
  assert.equal(await readLedger(composerLedger.nodeLedgerIo, path), null);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, constraints: [{ text: "x" }] }), "utf8");
  const ledger = await readLedger(composerLedger.nodeLedgerIo, path);
  assert.ok(ledger);
  assert.deepEqual(ledger.state.filesRead, []);
  assert.equal(ledger.compactions, 0);
});
