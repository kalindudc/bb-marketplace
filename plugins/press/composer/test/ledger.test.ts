import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  capLedger,
  constraintsFromText,
  emptyLedger,
  ledgerPath,
  mergeLedger,
  readLedger,
  writeLedger,
} from "../src/ledger.ts";

const NOW = "2026-11-22T00:00:00.000Z";

test("ledgerPath lives under the workspace", () => {
  assert.equal(ledgerPath("/repo"), "/repo/.bb/press/ledger.json");
});

test("constraintsFromText keeps only instruction-shaped sentences", () => {
  const rows = constraintsFromText("The build is slow. Never commit unless I ask. Thanks!", "user#2", NOW);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["Never commit unless I ask."],
  );
  assert.equal(rows[0]!.source, "user#2");
});

test("capLedger drops files before constraints", () => {
  const ledger = emptyLedger("thr_x", NOW);
  ledger.constraints = [{ id: "c1", text: "never commit", source: "user#1", at: NOW }];
  for (let index = 0; index < 400; index += 1) {
    ledger.state.filesRead.push({ path: `src/file-${index}-${"x".repeat(40)}.ts`, at: NOW });
  }
  const capped = capLedger(ledger, 4_000);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= 4_000);
  assert.equal(capped.constraints.length, 1);
  assert.ok(capped.state.filesRead.length < ledger.state.filesRead.length);
});

test("mergeLedger unions constraints and keeps the newest goal", () => {
  const first = emptyLedger("thr_x", NOW);
  first.constraints = [{ id: "c1", text: "never commit", source: "user#1", at: NOW }];
  first.state.goal = "old goal";
  first.state.commands = [{ cmd: "npm test", exit: 1, at: NOW }];

  const second = emptyLedger("thr_x", NOW);
  second.constraints = [
    { id: "c1", text: "never commit", source: "user#1", at: NOW },
    { id: "c2", text: "use tabs", source: "user#3", at: NOW },
  ];
  second.state.goal = "new goal";
  second.state.commands = [{ cmd: "npm test", exit: 0, at: NOW }];

  const merged = mergeLedger(first, second);
  assert.deepEqual(
    merged.constraints.map((row) => row.text),
    ["never commit", "use tabs"],
  );
  assert.equal(merged.state.goal, "new goal");
  assert.equal(merged.state.commands.length, 2);
});

test("writeLedger is atomic and keeps a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "press-ledger-"));
  const path = join(dir, "ledger.json");
  const first = emptyLedger("thr_x", NOW);
  first.state.goal = "first";
  writeLedger(path, first);
  const second = emptyLedger("thr_x", NOW);
  second.state.goal = "second";
  writeLedger(path, second);

  const written = JSON.parse(readFileSync(path, "utf8")) as { state: { goal: string } };
  assert.equal(written.state.goal, "second");
  const backup = JSON.parse(readFileSync(`${path}.bak`, "utf8")) as { state: { goal: string } };
  assert.equal(backup.state.goal, "first");
});

test("readLedger tolerates a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "press-ledger-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, "{not json", "utf8");
  assert.equal(readLedger(path), null);
});

test("readLedger fills missing fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "press-ledger-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, constraints: [{ text: "x" }] }), "utf8");
  const ledger = readLedger(path);
  assert.ok(ledger);
  assert.deepEqual(ledger!.state.filesRead, []);
  assert.equal(ledger!.compactions, 0);
});
