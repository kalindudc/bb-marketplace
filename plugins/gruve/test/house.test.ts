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
      "--attention": scheme === "light" ? house.light.orangeStrong : colours.orange,
      "--success": scheme === "light" ? house.light.aquaStrong : colours.aqua,
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

  it("uses dimmed light surfaces while keeping dark and accent colours unchanged", () => {
    expect(PALETTES.house.light.tokens["--canvas"]).toBe("#ebe8e1");
    expect(PALETTES.house.light.tokens["--card"]).toBe("#efede8");
    expect(PALETTES.house.light.tokens["--popover"]).toBe("#efede8");
    expect(PALETTES.house.light.tokens["--sidebar"]).toBe("#ebe8e1");
    expect(PALETTES.house.dark.tokens["--canvas"]).toBe("#24221f");
    expect(PALETTES.house.light.accents.blue[0]).toBe("#3f6b78");
  });

  it("uses visible house-palette thread hover fills in both schemes", () => {
    expect(PALETTES.house.light.tokens["--sidebar-accent"]).toBe(house.light.blueSoft);
    expect(PALETTES.house.dark.tokens["--sidebar-accent"]).toBe(house.dark.blueSoft);
    for (const scheme of ["light", "dark"] as const) {
      expect(PALETTES.house[scheme].tokens["--state-hover"]).toBe("var(--sidebar-accent)");
      expect(PALETTES.house[scheme].tokens["--sidebar-accent"]).not.toBe(PALETTES.house[scheme].tokens["--sidebar"]);
    }
  });

  it.each(["light", "dark"] as const)("matches %s hover and sent bubbles to every chosen accent", (scheme) => {
    const colours = house[scheme];
    for (const [accent, tint] of Object.entries({
      yellow: colours.blueSoft, orange: colours.orangeSoft, red: colours.redSoft,
      green: colours.greenSoft, aqua: colours.aquaSoft, blue: colours.blueSoft, purple: colours.purpleSoft,
    })) {
      const css = appearanceCss(parseAppearance({ mode: "house", accent }));
      expect(css).toContain(scheme === "light"
        ? `--sidebar-accent: color-mix(in srgb, ${tint} 89%, ${PALETTES.house[scheme].accents[accent as keyof typeof PALETTES.house.light.accents][0]});`
        : `--sidebar-accent: ${tint};`);
      expect(css).toContain(`--gruve-sent-background: ${tint};`);
    }
  });

  it("uses firmer panel lines and stronger secondary ink", () => {
    expect(PALETTES.house.light.tokens["--border"]).toBe("#b0aaa0");
    expect(PALETTES.house.light.tokens["--border-hairline"]).toBe("#c4beb4");
    expect(PALETTES.house.light.tokens["--muted-foreground"]).toBe("#5d5852");
    expect(PALETTES.house.dark.tokens["--border"]).toBe("#58534d");
  });

  it("gives only sent message bubbles an accent tint and a clear boundary", () => {
    const css = appearanceCss(parseAppearance({ mode: "house", accent: "orange" }));
    expect(css).toContain('--gruve-sent-border: #8c4b19;');
    expect(css).toContain('--gruve-sent-border: #e78a4e;');
    expect(css).toContain('[data-message-column] > .group\\/message.ml-auto > div > .bg-surface-recessed');
    expect(css).toContain("background: var(--gruve-sent-background);");
    expect(css).toContain("border-color: var(--gruve-sent-border);");
    expect(appearanceCss(parseAppearance({ mode: "crisp" }))).not.toContain("--gruve-sent");
  });

  it("keeps heavier light text and restores regular dark text", () => {
    const css = appearanceCss(parseAppearance({ mode: "house" }));
    const root = css.match(/:root \{([^}]*)\}/u)![1];
    const light = css.match(/:root:not\(\.dark\), \.light \{([^}]*)\}/u)![1];
    const dark = css.match(/\.dark \{([^}]*)\}/u)![1];
    expect(root).not.toContain("--font-weight-normal:");
    expect(root).not.toContain("--font-weight-medium:");
    expect(light).toContain("--font-weight-normal: 500;");
    expect(light).toContain("--font-weight-medium: 600;");
    expect(dark).toContain("--font-weight-normal: 400;");
    expect(dark).toContain("--font-weight-medium: 500;");
    expect(dark).not.toContain("--font-weight-medium: 600;");
  });

  it("uses stronger text weights, native smoothing and sturdier icons only in House style", () => {
    const css = appearanceCss(parseAppearance({ mode: "house" }));
    expect(css).toContain("-webkit-font-smoothing: auto;");
    expect(css).toContain("-moz-osx-font-smoothing: auto;");
    expect(css).toContain("--font-weight-normal: 500;");
    expect(css).toContain("--font-weight-medium: 600;");
    expect(css).toContain("font-weight: var(--font-weight-normal);");
    expect(css).not.toContain("font-smoothing: grayscale;");
    expect(css).toContain("text-rendering: optimizeLegibility;");
    expect(css).toContain("--icon-stroke-width: 2;");
    expect(css).toContain('svg[data-icon-root]:not([data-icon*="/"]) [stroke="currentColor"]');
    expect(css).toContain("stroke-width: var(--icon-stroke-width);");
    expect(css).not.toContain("crispEdges");
    for (const mode of ["classic", "crisp", "soft", "dim"]) {
      const other = appearanceCss(parseAppearance({ mode }));
      expect(other).not.toContain("font-smoothing");
      expect(other).not.toContain("--font-weight-normal");
      expect(other).not.toContain("svg[data-icon-root]");
    }
  });

  it("applies both schemes without changing the separate typography and shape settings", () => {
    const css = appearanceCss(parseAppearance({ mode: "house" }));
    expect(css).toContain(":root:not(.dark), .light {");
    expect(css).toContain("--canvas: #ebe8e1;");
    expect(css).toContain(".dark {");
    expect(css).toContain("--canvas: #24221f;");
    expect(css).toContain("--primary: #3f6b78;");
    expect(css).toContain("--primary: #7daea3;");
    expect(css).not.toContain("--font-sans:");
    expect(css).not.toContain("--font-mono:");
    expect(css).not.toContain("--gruve-corner");
  });
});
