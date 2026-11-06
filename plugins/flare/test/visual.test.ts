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
