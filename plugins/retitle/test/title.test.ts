import { describe, expect, it } from "vitest";
import { cleanTitle, titlePrompt, titleSource } from "../src/title";

const planInput = [
  {
    type: "text",
    text: "!plan once a loom project is completed or archived, the thread section that was created also needs to be resumed.",
    mentions: [{ start: 0, end: 5, resource: { kind: "plugin" } }],
  },
  {
    type: "text",
    text: 'Context for @plan (resolved by plugin "agent-commands"):\n\nLoad the `cortex-planner` skill and follow its instructions.',
    mentions: [],
    visibility: "agent-only",
  },
];

describe("titleSource", () => {
  it("drops agent-only context and names the command separately", () => {
    expect(titleSource(planInput)).toEqual({
      task: "once a loom project is completed or archived, the thread section that was created also needs to be resumed.",
      commands: ["!plan"],
    });
  });

  it("keeps other mentions such as files in the text", () => {
    const source = titleSource([
      {
        type: "text",
        text: "fix the bug in @src/a.ts please",
        mentions: [{ start: 15, end: 24, resource: { kind: "file" } }],
      },
    ]);
    expect(source).toEqual({ task: "fix the bug in @src/a.ts please", commands: [] });
  });

  it("cuts several command mentions in order", () => {
    const source = titleSource([
      {
        type: "text",
        text: "!plan then !commit the parser fix",
        mentions: [
          { start: 0, end: 5, resource: { kind: "plugin" } },
          { start: 11, end: 18, resource: { kind: "command" } },
        ],
      },
    ]);
    expect(source).toEqual({ task: "then the parser fix", commands: ["!plan", "!commit"] });
  });

  it("returns null when nothing was typed", () => {
    expect(titleSource([{ type: "image" }, { type: "text", text: "ctx", visibility: "agent-only" }])).toBeNull();
  });
});

describe("titlePrompt", () => {
  it("says which commands were invoked and leaves their bodies out", () => {
    const prompt = titlePrompt(titleSource(planInput)!);
    expect(prompt).toContain("The prompt invokes these commands or skills: !plan.");
    expect(prompt).toMatch(/Task:\nonce a loom project/);
    expect(prompt).not.toContain("cortex-planner");
  });

  it("titles the command itself when it is all the user typed", () => {
    expect(titlePrompt({ task: "", commands: ["!handover"] })).toMatch(/Task:\n!handover$/);
  });
});

describe("cleanTitle", () => {
  it("strips quotes, a Title: prefix and trailing punctuation", () => {
    expect(cleanTitle('Title: "Resume Loom thread sections."\n')).toBe("Resume Loom thread sections");
  });

  it("drops reasoning blocks and blank lines", () => {
    expect(cleanTitle("<think>hmm</think>\n\nFix flaky parser test")).toBe("Fix flaky parser test");
  });

  it("cuts long titles at a word boundary", () => {
    expect(cleanTitle("Auto-resume threads for completed or restarted loom projects")).toBe(
      "Auto-resume threads for completed or restarted",
    );
  });

  it("returns null for an empty reply", () => {
    expect(cleanTitle("  \n ")).toBeNull();
  });
});
