import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = () => readFileSync(join(process.cwd(), "src/session-log.css"), "utf8");

describe("session-log.css", () => {
  it.each([
    ["agent", "timeline-accent"], ["tool", "pr-merged"], ["command", "attention"],
    ["file", "diff-added"], ["error", "destructive"],
  ])("tints %s rows with the theme's --%s", (tint, token) => {
    expect(css()).toMatch(new RegExp(`\\[data-sl-tint="${tint}"\\]\\s*\\{\\s*--sl-tint:\\s*var\\(--${token}\\)`));
  });

  it("uses theme tokens only, never color literals", () => {
    expect(css()).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/i);
  });

  it("prefixes every class it styles, because plugin CSS is global", () => {
    const classes = [...css().replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-z][\w-]*)/g)].map((match) => match[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) expect(name).toMatch(/^sl-/);
  });
});
