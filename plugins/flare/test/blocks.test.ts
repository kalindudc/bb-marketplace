// @vitest-environment node
import { describe, expect, it } from "vitest";
import { blockCount, leadLine, parseBody, previewBody, proseBody } from "../src/blocks";

const body = [
  "## Tests pass",
  "",
  "All **59** passed.",
  "",
  "```ui",
  'Card("Test run", [Metric("Passed", "59")])',
  "```",
  "",
  '::inline-vis{source="thread-storage" file="report.html"}',
  "",
  "```",
  "plain code stays prose",
  "```",
  "",
  "````chart",
  "```nested```",
  "````",
].join("\n");

describe("parseBody", () => {
  it("splits prose from fenced blocks with a language and directive lines, knowing no language", () => {
    expect(parseBody(body)).toEqual([
      { type: "prose", text: "## Tests pass\n\nAll **59** passed." },
      { type: "block", language: "ui", text: '```ui\nCard("Test run", [Metric("Passed", "59")])\n```' },
      { type: "directive", name: "inline-vis", text: '::inline-vis{source="thread-storage" file="report.html"}' },
      { type: "prose", text: "```\nplain code stays prose\n```" },
      { type: "block", language: "chart", text: "````chart\n```nested```\n````" },
    ]);
    expect(blockCount(parseBody(body))).toBe(3);
  });

  it("keeps an unclosed fence and a directive inside a fence as prose", () => {
    const text = ["```text", '::inline-vis{file="a.html"}', "```", "", "```ui", "unclosed"].join("\n");
    expect(parseBody(text)).toEqual([
      { type: "block", language: "text", text: '```text\n::inline-vis{file="a.html"}\n```' },
      { type: "prose", text: "```ui\nunclosed" },
    ]);
  });
});

describe("the forms that are not a reply", () => {
  it("names each block in the prose a notification or an agent gets", () => {
    expect(proseBody(body)).toBe(
      [
        "## Tests pass\n\nAll **59** passed.",
        "_[A ui block; see it in the Flares tab.]_",
        "_[A inline-vis view; see it in the Flares tab.]_",
        "```\nplain code stays prose\n```",
        "_[A chart block; see it in the Flares tab.]_",
      ].join("\n\n"),
    );
  });

  it("previews the prose alone and counts what it left out", () => {
    expect(previewBody(body)).toEqual({ text: "## Tests pass\n\nAll **59** passed.\n\n```\nplain code stays prose\n```", blocks: 3 });
  });

  it("takes the first readable line for a notification", () => {
    expect(leadLine(body)).toBe("Tests pass");
    expect(leadLine("```ui\nx\n```\n\n- [x] Done the thing")).toBe("Done the thing");
    expect(leadLine("```ui\nx\n```")).toBeNull();
  });
});
