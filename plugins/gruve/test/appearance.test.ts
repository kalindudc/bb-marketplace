import { describe, expect, it } from "vitest";
import { appearanceCss } from "../src/appearance";
import { DEFAULT_APPEARANCE, parseAppearance, SETTING_DESCRIPTORS, type GruveAppearance } from "../src/settings";

const changed = (patch: Partial<GruveAppearance>): GruveAppearance => ({ ...DEFAULT_APPEARANCE, ...patch });

describe("appearanceCss", () => {
  it("writes nothing while every value is the theme's own", () => {
    expect(appearanceCss(DEFAULT_APPEARANCE)).toBe("");
  });

  it("scales the interface with one root font size", () => {
    const css = appearanceCss(changed({ fontSize: 18 }));
    expect(css).toContain("font-size: 18px;");
    expect(css.match(/font-size/gu)).toHaveLength(1);
  });

  it("changes the interface font without touching code", () => {
    const css = appearanceCss(changed({ interfaceFont: "system-sans" }));
    expect(css).toContain('--font-sans: "Inter Variable", Inter, system-ui');
    expect(css).not.toContain("--font-mono");
  });

  it("changes code and terminal fonts together", () => {
    const css = appearanceCss(changed({ codeFont: "fira" }));
    expect(css).toContain('--font-mono: "Fira Code"');
    expect(css).toContain('--font-terminal: "Fira Code"');
  });

  it("gives each mode its own accent shade", () => {
    const css = appearanceCss(changed({ accent: "blue" }));
    expect(css).toMatch(/:root \{[^}]*--primary: #076678;/u);
    expect(css).toMatch(/\.dark \{[^}]*--primary: #8fb8ac;/u);
    const [lightPrimary] = [css.indexOf("--primary: #076678"), css.indexOf(".dark")];
    expect(lightPrimary).toBeLessThan(css.indexOf(".dark"));
  });

  it("writes the light shade where the theme's own base block is, so dark can override it", () => {
    const css = appearanceCss(changed({ accent: "green" }));
    expect(css.startsWith("/* Gruve appearance settings. */\n:root {")).toBe(true);
  });

  it("rounds every corner the theme squares", () => {
    expect(appearanceCss(changed({ corners: "rounded" }))).toContain("--gruve-corner: 6px;");
    expect(appearanceCss(changed({ corners: "soft" }))).toContain("--gruve-corner: 3px;");
  });

  it("draws the chosen prompt glyph", () => {
    expect(appearanceCss(changed({ prompt: "dollar" }))).toContain('--gruve-prompt: "$";');
  });

  it("gives the prompt's room back when there is no glyph", () => {
    const css = appearanceCss(changed({ prompt: "none" }));
    expect(css).toContain('--gruve-prompt: "";');
    expect(css).toContain("--gruve-prompt-indent: 0rem;");
  });

  it("keeps every rule inside the scope it declares and never names another plugin", () => {
    const css = appearanceCss(changed({ accent: "orange", interfaceFont: "fira", codeFont: "plex", fontSize: 19, corners: "soft", prompt: "lambda" }));
    expect(css).not.toMatch(/\.sb-/u);
    const blocks = [...css.matchAll(/[^{}]+\{/gu)].map(([block]) => block.replace(/\{\s*$/u, "").replace(/\/\*[\s\S]*?\*\//gu, "").trim());
    expect(blocks).toEqual([":root", ".dark"]);
  });
});

describe("parseAppearance", () => {
  it("falls back to the theme's own values when nothing is stored", () => {
    expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({})).toEqual(DEFAULT_APPEARANCE);
  });

  it("reads every stored value", () => {
    const stored = { accent: "purple", interfaceFont: "plex", codeFont: "source", fontSize: 15, corners: "rounded", prompt: "angle" };
    expect(parseAppearance(stored)).toEqual(stored);
  });

  it.each([
    [{ accent: "pink" }, "accent"],
    [{ interfaceFont: "comic-sans" }, "interfaceFont"],
    [{ codeFont: "system-sans" }, "codeFont"],
    [{ corners: "blob" }, "corners"],
    [{ prompt: "zsh" }, "prompt"],
  ])("keeps the default for %s", (stored, key) => {
    const appearance = parseAppearance(stored);
    expect(appearance).toEqual({ ...DEFAULT_APPEARANCE, ...stored, [key]: DEFAULT_APPEARANCE[key as keyof GruveAppearance] });
  });

  it.each([11, 21, 15.5, Number.NaN, "16", null])("keeps the default text size for %s", (fontSize) => {
    expect(parseAppearance({ fontSize }).fontSize).toBe(DEFAULT_APPEARANCE.fontSize);
  });

  it.each([12, 16, 20])("accepts %s pixels", (fontSize) => {
    expect(parseAppearance({ fontSize }).fontSize).toBe(fontSize);
  });
});

describe("setting descriptors", () => {
  it("declares every default the theme ships with", () => {
    for (const [key, descriptor] of Object.entries(SETTING_DESCRIPTORS)) {
      expect(descriptor.default).toEqual(DEFAULT_APPEARANCE[key as keyof GruveAppearance]);
    }
  });

  it("offers a label for every option it offers", () => {
    for (const descriptor of Object.values(SETTING_DESCRIPTORS)) {
      if (descriptor.type !== "select") continue;
      expect(Object.keys(descriptor.experimental_optionLabels ?? {}).sort()).toEqual([...descriptor.options].sort());
    }
  });

  it("shows the default in the accent and font labels, so the form says what it ships with", () => {
    expect(SETTING_DESCRIPTORS.accent.experimental_optionLabels[DEFAULT_APPEARANCE.accent]).toMatch(/default/u);
    expect(SETTING_DESCRIPTORS.interfaceFont.experimental_optionLabels[DEFAULT_APPEARANCE.interfaceFont]).toMatch(/default/u);
    expect(SETTING_DESCRIPTORS.codeFont.experimental_optionLabels[DEFAULT_APPEARANCE.codeFont]).toMatch(/default/u);
    expect(SETTING_DESCRIPTORS.corners.experimental_optionLabels[DEFAULT_APPEARANCE.corners]).toMatch(/default/u);
    expect(SETTING_DESCRIPTORS.prompt.experimental_optionLabels[DEFAULT_APPEARANCE.prompt]).toMatch(/default/u);
  });
});
