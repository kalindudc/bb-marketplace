import { expect, it, vi } from "vitest";
import { checkName, doneParts, listChanges, roleOf, scheduledWord, sentenceChanges, sentences, wordDiff } from "../../src/shared/plan-text";

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

function legacyPairs(a: string[], b: string[]) {
  const length = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    length[i]![j] = a[i] === b[j] ? 1 + length[i + 1]![j + 1]! : Math.max(length[i + 1]![j]!, length[i]![j + 1]!);
  }
  const pairs: [number, number][] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (length[i + 1]![j]! >= length[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

function legacyWordRuns(a: string[], b: string[], pairs: [number, number][]) {
  const runs: ({ text: string } | { before: string; after: string })[] = [];
  let i = 0, j = 0;
  let common: string[] = [];
  for (const [x, y] of [...pairs, [a.length, b.length] as const]) {
    if (x > i || y > j) {
      const before = a.slice(i, x).join(" "), after = b.slice(j, y).join(" ");
      const last = runs.at(-1);
      if (last && "before" in last && common.length <= 2) {
        last.before = [last.before, ...common, before].filter(Boolean).join(" ");
        last.after = [last.after, ...common, after].filter(Boolean).join(" ");
      } else {
        if (common.length) runs.push({ text: common.join(" ") });
        runs.push({ before, after });
      }
      common = [];
    }
    if (x < a.length) common.push(a[x]!);
    i = x + 1; j = y + 1;
  }
  if (common.length) runs.push({ text: common.join(" ") });
  return runs;
}

it("keeps the earlier match when blindly trimming the suffix would move a highlight", () => {
  expect(wordDiff("map lamp", "lamp lamp")).toEqual([{ before: "map lamp", after: "lamp lamp" }]);
  expect(wordDiff("map lamp watch after dark", "lamp lamp watch after dark")).toEqual([
    { before: "map lamp", after: "lamp lamp" }, { text: "watch after dark" },
  ]);
});

it("matches the former list and word output on seeded random revisions and repeated words", () => {
  let seed = 7168;
  const next = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const words = ["read", "the", "lamp", "night", "watch", "again"];
  const sample = () => Array.from({ length: next(32) }, () => words[next(words.length)]!);
  for (let i = 0; i < 1_500; i++) {
    const prefix = i % 3 === 0 ? sample() : [];
    const suffix = i % 3 !== 0 ? sample() : [];
    const a = [...prefix, ...sample(), ...suffix], b = [...prefix, ...sample(), ...suffix];
    const pairs = legacyPairs(a, b);
    const keptA = new Set(pairs.map(pair => pair[0])), keptB = new Set(pairs.map(pair => pair[1]));
    expect(listChanges(a, b)).toEqual({ removed: a.filter((_, i) => !keptA.has(i)), added: b.filter((_, i) => !keptB.has(i)), unchanged: pairs.length });
    expect(wordDiff(a.join(" "), b.join(" "))).toEqual(legacyWordRuns(a, b, pairs));
  }
});

it("does not allocate a row per token while comparing a reordered middle", () => {
  const a = Array.from({ length: 512 }, (_, i) => String(i));
  const b = [...a].reverse();
  let cells = 0;
  const types = ["Uint16Array", "Uint32Array", "Int32Array"] as const;
  try {
    for (const name of types) vi.stubGlobal(name, new Proxy(globalThis[name], {
      construct(target, args) {
        const array = Reflect.construct(target, args) as Uint16Array | Uint32Array | Int32Array;
        cells += array.length;
        return array;
      },
    }));
    expect(listChanges(a, b).unchanged).toBe(1);
    expect(cells).toBeLessThanOrEqual(4 * (a.length + b.length + 2));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("handles two 64,000-character fields with a small edit among repeated words", () => {
  const half = "map ".repeat(8_000);
  const tail = "map ".repeat(7_999);
  const before = half + "map " + tail, after = half + "log " + tail;
  expect([before.length, after.length]).toEqual([64_000, 64_000]);
  expect(wordDiff(before, after)).toEqual([{ text: half.trim() }, { before: "map", after: "log" }, { text: tail.trim() }]);
});

it("handles two entirely different 64,000-character fields", () => {
  const before = "map ".repeat(16_000), after = "log ".repeat(16_000);
  expect([before.length, after.length]).toEqual([64_000, 64_000]);
  expect(wordDiff(before, after)).toEqual([{ before: before.trim(), after: after.trim() }]);
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
