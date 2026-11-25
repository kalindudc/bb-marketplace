import { expect, it } from "vitest";
import { checkName, doneParts, roleOf, scheduledWord, sentenceChanges, sentences, wordDiff } from "../../src/shared/plan-text";

it("splits the plan's setup, exact checks and limits without cutting a version or abbreviation", () => {
  const text = "Compare 0.4.2 on identical workloads, e.g. Idle and cold starts. Keep old settings working. Run `npm --prefix tools/lamp test`, `npm --prefix tools/lamp run typecheck`, `npm --prefix tools/lamp run build`, `git diff --check`. No release, live install or commit.";
  const parts = doneParts(text);
  expect(parts).toEqual({
    criteria: ["Compare 0.4.2 on identical workloads, e.g. Idle and cold starts.", "Keep old settings working."],
    checks: ["npm --prefix tools/lamp test", "npm --prefix tools/lamp run typecheck", "npm --prefix tools/lamp run build", "git diff --check"],
    never: ["release", "live install", "commit"],
    neverSource: ["No release, live install or commit."],
  });
  expect(parts.checks.map(checkName)).toEqual(["test", "typecheck", "build", "git diff --check"]);
});

it("leaves ordinary and ambiguous instructions intact", () => {
  const text = "The `Ready. On` label is visible. Capture the lamp in low light. Run `echo \"A. B\"` after loading the fixture.";
  expect(sentences(text)).toEqual(["The `Ready. On` label is visible.", "Capture the lamp in low light.", "Run `echo \"A. B\"` after loading the fixture."]);
  expect(doneParts(text)).toEqual({ criteria: sentences(text), checks: [], never: [], neverSource: [] });
});

it.each([
  "No one should need a restart.",
  "No test is skipped or weakened.",
  "No findings remain open.",
  "No tests fail.",
  "No manual actions on a branch outside the workspace.",
  "No one else.",
  "No visible change until the lease ends.",
])("keeps a full or ambiguous No sentence verbatim: %s", criterion => {
  expect(doneParts(criterion)).toEqual({ criteria: [criterion], checks: [], never: [], neverSource: [] });
});

it.each(["No A, no B, or C.", "No A, no B, or C"])("strips repeated negation from a short list: %s", text => {
  expect(doneParts(text)).toEqual({ criteria: [], checks: [], never: ["A", "B", "C"], neverSource: [text] });
});

it("keeps duplicate sentences and additions or removals distinct", () => {
  expect(sentenceChanges("Light the lamp. Record it. Record it.", "Light the lamp. Record it. Note the time.")).toEqual({
    removed: ["Record it."], added: ["Note the time."], unchanged: 2,
  });
  expect(sentenceChanges("", "Record it.")).toEqual({ removed: [], added: ["Record it."], unchanged: 0 });
  expect(sentenceChanges("Record it.", "")).toEqual({ removed: ["Record it."], added: [], unchanged: 0 });
});

it("merges nearby changes as a removed phrase followed by its replacement", () => {
  expect(wordDiff("Ready on Monday with two lamp checks.", "Ready on Tuesday with three lamp checks.")).toEqual([
    { text: "Ready on" }, { before: "Monday with two", after: "Tuesday with three" }, { text: "lamp checks." },
  ]);
  expect(wordDiff("Keep the old lamp with steady light tonight.", "Keep the new lamp with steady light tomorrow.")).toEqual([
    { text: "Keep the" }, { before: "old", after: "new" }, { text: "lamp with steady light" }, { before: "tonight.", after: "tomorrow." },
  ]);
  expect(wordDiff("", "Night watch")).toEqual([{ before: "", after: "Night watch" }]);
  expect(wordDiff("Same forecast.", "Same forecast.")).toEqual([{ text: "Same forecast." }]);
});

it("names explicit roles without turning ordinary purpose text into a role", () => {
  expect(roleOf({ purpose: "Night watcher: patrol the harbor" })).toBe("Night watcher");
  expect(roleOf({ purpose: "Patrol the harbor" })).toBeNull();
});

it("matches schedule words, not substrings of other words", () => {
  expect(["Set up automations.", "Install in Crontab.", "Reset launchd.", "Install a systemd unit."].map(scheduledWord)).toEqual(["automations", "Crontab", "launchd", "systemd"]);
  expect(scheduledWord("Synchronize the lights.")).toBeNull();
  expect(scheduledWord(null)).toBeNull();
});
