import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COMPOSER_CONFIG } from "../src/config.ts";
import { emptyLedger } from "../src/ledger.ts";
import {
  assembleSummary,
  buildSummaryPrompt,
  parseResume,
  synthesiseResume,
  truncateConversation,
} from "../src/prompt.ts";

const NOW = "2026-11-22T00:00:00.000Z";

function ledgerWithState() {
  const ledger = emptyLedger("thr_x", NOW);
  ledger.constraints = [{ id: "c1", text: "Never commit unless I ask.", source: "user#1", at: NOW }];
  ledger.state.goal = "Build the governor";
  ledger.state.branch = "feat/press";
  ledger.state.filesWritten = [{ path: "src/policy.ts", at: NOW }];
  ledger.state.commands = [{ cmd: "npm test", exit: 1, at: NOW }];
  ledger.state.failingTests = ["queue > requeue drops payload"];
  return ledger;
}

test("parseResume extracts the three fields and strips the block", () => {
  const parsed = parseResume("## Goal\nship it\n\nRESUME:\nstate: half done\nnext: run tests\nverify: npm test\n");
  assert.equal(parsed.narrative, "## Goal\nship it");
  assert.deepEqual(parsed.resume, { state: "half done", next: "run tests", verify: "npm test" });
});

test("parseResume returns null when the block is absent", () => {
  const parsed = parseResume("## Goal\nship it");
  assert.equal(parsed.resume, null);
  assert.equal(parsed.narrative, "## Goal\nship it");
});

test("parseResume tolerates a partial block", () => {
  const parsed = parseResume("body\nRESUME:\nnext: only this\n");
  assert.equal(parsed.resume?.next, "only this");
  assert.equal(parsed.resume?.state, "(not stated)");
});

test("synthesiseResume falls back to the failing test", () => {
  const resume = synthesiseResume(ledgerWithState());
  assert.equal(resume.state, "Build the governor");
  assert.equal(resume.verify, "run the failing test: queue > requeue drops payload");
});

test("assembleSummary keeps constraints verbatim and appends the resume block", () => {
  const summary = assembleSummary({
    narrative: "## Goal\nBuild the governor",
    resume: { state: "half done", next: "run tests", verify: "npm test" },
    ledger: ledgerWithState(),
    config: DEFAULT_COMPOSER_CONFIG,
    threadId: "thr_x",
    tokensBefore: 808_380,
  });
  assert.match(summary, /Never commit unless I ask\./);
  assert.match(summary, /src\/policy\.ts/);
  assert.match(summary, /`npm test` → exit 1/);
  assert.match(summary, /## Resume\nstate: half done\nnext: run tests\nverify: npm test/);
  assert.match(summary, /808,380 tokens/);
});

test("assembleSummary omits the ledger when disabled", () => {
  const summary = assembleSummary({
    narrative: "body",
    resume: null,
    ledger: ledgerWithState(),
    config: { ...DEFAULT_COMPOSER_CONFIG, ledger: false, resumeContract: false },
    tokensBefore: 1000,
  });
  assert.doesNotMatch(summary, /Never commit unless I ask\./);
  assert.doesNotMatch(summary, /## Resume/);
});

test("buildSummaryPrompt carries constraints, previous summary and focus", () => {
  const prompt = buildSummaryPrompt({
    conversationText: "[User]: hello",
    previousSummary: "earlier work",
    ledger: ledgerWithState(),
    customInstructions: "focus on the queue",
    maxSummaryTokens: 2000,
    resumeContract: true,
  });
  assert.match(prompt, /Never commit unless I ask\./);
  assert.match(prompt, /<previous-summary>/);
  assert.match(prompt, /focus on the queue/);
  assert.match(prompt, /RESUME:/);
  assert.match(prompt, /<conversation>\n\[User\]: hello\n<\/conversation>/);
});

test("truncateConversation keeps the newest text", () => {
  const text = `${"a".repeat(500)}\n[User]: newest message`;
  const result = truncateConversation(text, 100);
  assert.equal(result.truncated, true);
  assert.match(result.text, /newest message/);
  assert.match(result.text, /earlier messages omitted/);
});

test("truncateConversation leaves short text alone", () => {
  const result = truncateConversation("short", 100);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "short");
});
