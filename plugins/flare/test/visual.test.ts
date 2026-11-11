// @vitest-environment node
import { describe, expect, it } from "vitest";
import { drawHint, drawable } from "../src/visual";

const numbers =
  "Replayed every memory lookup from Oct 21 to Nov 5: 1,727 lookups in 1,496 sessions. Agents loaded 202 of 6,525 hits, " +
  "about 3%. Child threads received 815 lookups and loaded 37 hits, and 32 of those were their parent's own streams.";

const bullets = [
  "Three pieces split the work, and each needs something extra:",
  "- **Step one is a script.** It needs scripting turned on for every namespace, and its headers reach the app.",
  "- **Steps two and three are the built-in check.** It calls the verifier through a backend object.",
  "- **Each app ships four objects:** the script, the policy, the backend and the header filter.",
].join("\n");

describe("drawable", () => {
  it("finds the numbers in a paragraph that is all text", () => {
    expect(drawable(numbers)).toEqual({ numbers: 10, items: 0, files: [] });
  });

  it("finds list items and the thread-storage files a body names", () => {
    expect(drawable(bullets)).toMatchObject({ items: 3, files: [] });
    const file = "The inventory of every route is done and the hard features sit in four workloads. Data: `$BB_THREAD_STORAGE/research/features.json`.";
    expect(drawable(file.padEnd(320, " The rest of the note explains which features matter."))).toMatchObject({
      files: ["$BB_THREAD_STORAGE/research/features.json"],
    });
  });

  it("leaves alone a body that already has a block, a directive, a table or an image", () => {
    expect(drawable(`${numbers}\n\n\`\`\`ui\nCard("Hits", [Metric("Loaded", "202")])\n\`\`\``)).toBeNull();
    expect(drawable(`${numbers}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``)).toBeNull();
    expect(drawable(`${numbers}\n\n::inline-vis{source="thread-storage" file="report.html"}`)).toBeNull();
    expect(drawable(`${numbers}\n\n| Hits | Loaded |\n| --- | --- |\n| 6,525 | 202 |`)).toBeNull();
    expect(drawable(`${numbers}\n\n![The page at 360px](/tmp/shot.png)`)).toBeNull();
  });

  it("leaves alone a short note and a long one with nothing to draw", () => {
    expect(drawable("909 tests and the typecheck pass; checking untested review sequences next.")).toBeNull();
    expect(drawable("The rewritten page reads better. ".repeat(12))).toBeNull();
  });

  it("recognizes the real timing comparison that previously bypassed the hint", () => {
    const body = [
      "The fixture-only fix was insufficient. The direct mount preserves every assertion; loaded repetitions and fresh full runs are underway.",
      "",
      "| Phase-test version | Focused timing | Loaded evidence |",
      "| --- | ---: | --- |",
      "| Original | 2,163 ms | 2 failures in 4 runs |",
      "| Reduced diff only | 1,034 ms | 2 failures in 4 runs |",
      "| Direct SpecPage mount | 236 ms | First repetition passed |",
    ].join("\n");
    const found = drawable(body);
    expect(found).toMatchObject({ timingRows: 3 });
    expect(drawHint(found!)).toContain("Chart");
    expect(drawHint(found!)).toContain("If genui is available");
  });

  it("does not nag categorical tables, configured timeouts, single measurements or short statuses", () => {
    const lead = "The inventory is complete. ".repeat(10);
    expect(drawable(`${lead}\n\n| Piece | State |\n| --- | --- |\n| Controller | Ready |\n| Proxy | Ready |`)).toBeNull();
    expect(drawable(`${lead}\n\n| Route | Timeout (ms) |\n| --- | --- |\n| Checkout | 500 |\n| Admin | 1000 |`)).toBeNull();
    expect(drawable(`${lead}\n\n| Run | Latency |\n| --- | --- |\n| One | 200 ms |\n| Two | Pending |`)).toBeNull();
    expect(drawable("| Run | Latency |\n| --- | --- |\n| One | 200 ms |\n| Two | 100 ms |")).toBeNull();
  });

  it("ignores configured timing targets and unitless durations", () => {
    const lead = "These values describe configuration, not observed performance. ".repeat(5);
    for (const header of ["Latency SLO", "TTL duration", "Latency target", "Duration budget", "Duration limit", "Max latency"]) {
      expect(drawable(`${lead}\n\n| Route | ${header} |\n| --- | --- |\n| One | 200 ms |\n| Two | 500 ms |`), header).toBeNull();
    }
    expect(drawable(`${lead}\n\n| Work | Duration |\n| --- | --- |\n| One | 3 |\n| Two | 8 |`)).toBeNull();
  });

  it("recognizes conventional measurement tables without leading pipes and with units in headers", () => {
    const lead = "Both runs preserve every assertion; the repeat checks are still in progress. ".repeat(4);
    expect(drawable(`${lead}\n\nVersion | Time (ms)\n--- | ---:\nOriginal | 2163\nDirect | 236`)).toMatchObject({ timingRows: 2 });
    expect(drawable(`${lead}\n\n| Version | Wall time |\n| --- | --- |\n| Original | 3m 20s |\n| Direct | 20s |`)).toMatchObject({ timingRows: 2 });
    expect(drawable(`${lead}\n\n| Version | Focused timing |\n| --- | --- |\n| Original | 2163 ms |\n| Direct | 236 ms (-89%) |`)).toMatchObject({ timingRows: 2 });
    expect(drawable(`${lead}\n\n| Version | Time (ms) |\n| --- | --- |\n| Original \\| baseline | 2163 |\n| Direct \\| focused | 236 |`)).toMatchObject({ timingRows: 2 });
  });

  it("does not count commit hashes, PR numbers or versions inside words as numbers", () => {
    const ids = "Pushed 594cb62 to #87935 and #87998 for v1.9.3-rc on lx7 and jw9, and the reviewers replied. ".repeat(4);
    expect(drawable(ids)).toBeNull();
  });
});

describe("drawHint", () => {
  it("says the final-message rule does not cover flares and names what fits what it found", () => {
    const hint = drawHint({ numbers: 10, items: 3, files: ["$BB_THREAD_STORAGE/research/features.json"] });
    expect(hint).toContain("does not cover a flare");
    expect(hint).toContain("Load `$BB_THREAD_STORAGE/research/features.json`");
    expect(hint).toContain("Metric row");
    expect(hint).toContain("3 bullets");
  });

  it("names only what it found", () => {
    const hint = drawHint({ numbers: 7, items: 0, files: [] });
    expect(hint).toContain("Metric row");
    expect(hint).not.toContain("bullets");
    expect(hint).not.toContain("Load");
  });
});
