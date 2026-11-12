import { describe, expect, it } from "vitest";
import { appearanceCss } from "../src/appearance";
import { PALETTES } from "../src/palettes";
import house from "../src/house-tokens.json";
import { parseAppearance, SETTING_DESCRIPTORS } from "../src/settings";

describe("House style", () => {
  it("is a selectable mode and survives parsing stored settings", () => {
    expect(SETTING_DESCRIPTORS.mode.options).toContain("house");
    expect(parseAppearance({ mode: "house" }).mode).toBe("house");
  });

  it.each(["light", "dark"] as const)("uses the house %s colours without gruvbox fallbacks", (scheme) => {
    const colours = house[scheme];
    const palette = PALETTES.house[scheme];
    expect(palette.tokens).toMatchObject({
      "--canvas": colours.paper,
      "--card": colours.card,
      "--sidebar": colours.paper,
      "--surface-recessed-solid": colours.deep,
      "--border": colours.rule,
      "--border-hairline": colours.ruleSoft,
      "--ink": colours.ink,
      "--muted-foreground": colours.inkSoft,
      "--readback-foreground": colours.inkSoft,
      "--subtle-foreground": colours.inkSoft,
      "--warning": colours.orange,
      "--attention": colours.orange,
      "--success": colours.aqua,
      "--destructive": colours.red,
      "--destructive-foreground": colours.onAccent,
      "--pr-merged": colours.purple,
      "--ansi-3": colours.orange,
      "--ansi-11": colours.orange,
    });
    for (const value of Object.values(palette.tokens)) {
      if (value.startsWith("#")) expect(Object.values(colours)).toContain(value);
    }
    for (const [accent, colour] of Object.entries({
      yellow: colours.blue, blue: colours.blue, orange: colours.orange,
      red: colours.red, green: colours.green, aqua: colours.aqua, purple: colours.purple,
    })) expect(palette.accents[accent as keyof typeof palette.accents]).toEqual([colour, colours.onAccent]);
  });

  it("applies both schemes without changing the separate typography and shape settings", () => {
    const css = appearanceCss(parseAppearance({ mode: "house" }));
    expect(css).toContain(":root:not(.dark), .light {");
    expect(css).toContain("--canvas: #f6f3ec;");
    expect(css).toContain(".dark {");
    expect(css).toContain("--canvas: #24221f;");
    expect(css).toContain("--primary: #3f6b78;");
    expect(css).toContain("--primary: #7daea3;");
    expect(css).not.toContain("--font-");
    expect(css).not.toContain("--gruve-corner");
  });
});
