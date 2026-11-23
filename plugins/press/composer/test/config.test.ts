import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPublishedConfig, DEFAULT_COMPOSER_CONFIG, resolveComposerConfig } from "../src/config.ts";

function workspace(policy?: unknown): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "press-config-"));
  const cwd = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".bb", "press"), { recursive: true });
  mkdirSync(join(home, ".bb", "press"), { recursive: true });
  if (policy) writeFileSync(join(cwd, ".bb", "press", "policy.json"), JSON.stringify(policy), "utf8");
  return { cwd, home };
}

test("returns defaults with no policy files", () => {
  const { cwd, home } = workspace();
  assert.deepEqual(resolveComposerConfig(cwd, home), DEFAULT_COMPOSER_CONFIG);
});

test("workspace policy overrides the composer block", () => {
  const { cwd, home } = workspace({
    composer: { model: "z-ai/glm-5.3-flash", maxSummaryTokens: 1200, keepRecentTurns: 3 },
  });
  const config = resolveComposerConfig(cwd, home);
  assert.equal(config.model, "z-ai/glm-5.3-flash");
  assert.equal(config.maxSummaryTokens, 1200);
  assert.equal(config.keepRecentTurns, 3);
  assert.equal(config.ledger, true);
});

test("providers.pi.enabled false disables the composer", () => {
  const { cwd, home } = workspace({ providers: { pi: { enabled: false } } });
  assert.equal(resolveComposerConfig(cwd, home).enabled, false);
});

test("keeps an unprefixed model so the hook can report it", () => {
  const { cwd, home } = workspace({ composer: { model: "glm-5.3-flash" } });
  assert.equal(resolveComposerConfig(cwd, home).model, "glm-5.3-flash");
});

test("ignores out-of-range numbers and unknown keys", () => {
  const { cwd, home } = workspace({
    composer: { maxSummaryTokens: -5, inputBudgetRatio: 4, keepRecentTurns: "many", nonsense: true },
  });
  const config = resolveComposerConfig(cwd, home);
  assert.equal(config.maxSummaryTokens, DEFAULT_COMPOSER_CONFIG.maxSummaryTokens);
  assert.equal(config.inputBudgetRatio, DEFAULT_COMPOSER_CONFIG.inputBudgetRatio);
  assert.equal(config.keepRecentTurns, DEFAULT_COMPOSER_CONFIG.keepRecentTurns);
  assert.equal("nonsense" in config, false);
});

test("survives a corrupt policy file", () => {
  const { cwd, home } = workspace();
  writeFileSync(join(cwd, ".bb", "press", "policy.json"), "{oops", "utf8");
  assert.deepEqual(resolveComposerConfig(cwd, home), DEFAULT_COMPOSER_CONFIG);
});

test("a published composer config wins over the files", () => {
  const { cwd, home } = workspace({ composer: { model: "z-ai/glm-5.3-flash", maxSummaryTokens: 1200 } });
  const config = resolveComposerConfig(cwd, home);
  const published = applyPublishedConfig(config, {
    model: "deepseek/deepseek-v4.1-flash",
    maxSummaryTokens: 4000,
    ledger: false,
    resumeContract: true,
  });
  assert.equal(published.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(published.maxSummaryTokens, 4000);
  assert.equal(published.ledger, false);
});

test("a published null model means the thread's own model", () => {
  const { cwd, home } = workspace({ composer: { model: "z-ai/glm-5.3-flash" } });
  const published = applyPublishedConfig(resolveComposerConfig(cwd, home), { model: null });
  assert.equal(published.model, null);
});

test("a missing or malformed published config changes nothing", () => {
  const { cwd, home } = workspace({ composer: { model: "z-ai/glm-5.3-flash" } });
  const base = resolveComposerConfig(cwd, home);
  assert.deepEqual(applyPublishedConfig(base, null), base);
  assert.deepEqual(applyPublishedConfig(base, "nope"), base);
  assert.deepEqual(applyPublishedConfig(base, { model: 42 }), base);
});
