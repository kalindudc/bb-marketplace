import { describe, expect, it } from "vitest";
import { aboutOf } from "../src/about";
import { parseSpec } from "../src/spec";
import { specToml } from "./helpers";

describe("aboutOf", () => {
  it("takes the summary, done_when, the goal's first paragraph and its issue and pull request links, each once, in order", () => {
    const spec = parseSpec(
      specToml((doc) => {
        doc.project.goal = [
          "Implement items 1 to 3 of https://github.com/acme/shop/issues/42 and https://delta.example.io/shop/world/pull/7.",
          "",
          "Replaces https://github.com/acme/shop/pull/9, see https://github.com/acme/shop/issues/42 again, and https://gitlab.example.com/a/b/-/merge_requests/3.",
        ].join("\n");
        doc.project.done_when = ["The file downloads"];
        doc.project.non_goals = ["Excel"];
      }),
    ).spec!;
    expect(aboutOf(spec)).toEqual({
      summary: "Let people export their orders as a CSV file from the admin page.",
      lead: "Implement items 1 to 3 of https://github.com/acme/shop/issues/42 and https://delta.example.io/shop/world/pull/7.",
      doneWhen: ["The file downloads"],
      links: ["https://github.com/acme/shop/issues/42", "https://delta.example.io/shop/world/pull/7", "https://github.com/acme/shop/pull/9", "https://gitlab.example.com/a/b/-/merge_requests/3"],
      nonGoals: 1,
    });
  });

  it("has no summary and no done_when for a spec that predates them", () => {
    const spec = parseSpec(specToml((doc) => delete doc.project.summary)).spec!;
    expect(aboutOf(spec)).toMatchObject({ summary: null, doneWhen: [], lead: "Let people export their orders as a CSV file from the admin page." });
  });
});
