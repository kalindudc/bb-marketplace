/* Appearance settings turn into one stylesheet that bb loads after the theme's
   own sheet. Everything here is generated from values the user chose; the
   theme CSS on its own, with every value at its default, is the theme. */

import {
  DEFAULT_APPEARANCE,
  type Accent,
  type CodeFont,
  type Corners,
  type GruveAppearance,
  type InterfaceFont,
  type Prompt,
} from "./settings";

/** Marks the injected stylesheet, so it can be found and removed again. */
export const STYLE_ATTRIBUTE = "data-gruve-appearance";

/**
 * A token only Gruve's theme defines. bb writes the active theme's CSS into
 * `<style id="bb-app-theme">`, so its presence there means Gruve is the theme in
 * use and the settings have something to change.
 */
export const THEME_MARKER = "--gruve-prompt";

const THEME_ELEMENT_ID = "bb-app-theme";

/* Gruvbox accents, one pair per mode: the bright shade on gruvbox soft in dark
   mode, the faded shade on paper in light mode. Every shade clears 4.5:1 as
   text on the canvas, cards, menus and sidebar, and each foreground clears
   4.5:1 on its own fill; test/theme.test.ts checks the whole matrix. */
const ACCENTS: Record<Accent, { light: readonly [string, string]; dark: readonly [string, string] }> = {
  yellow: { light: ["#7d520b", "#faf8f1"], dark: ["#fabd2f", "#282828"] },
  orange: { light: ["#a63c06", "#faf8f1"], dark: ["#fe8019", "#282828"] },
  red: { light: ["#9d0006", "#faf8f1"], dark: ["#fd8270", "#1d2021"] },
  green: { light: ["#67620a", "#faf8f1"], dark: ["#b8bb26", "#282828"] },
  aqua: { light: ["#356b4d", "#faf8f1"], dark: ["#8ec07c", "#282828"] },
  blue: { light: ["#076678", "#faf8f1"], dark: ["#8fb8ac", "#1d2021"] },
  purple: { light: ["#8f3f71", "#faf8f1"], dark: ["#dc95aa", "#282828"] },
};

const INTERFACE_FONTS: Record<InterfaceFont, string> = {
  jetbrains: '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  plex: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fira: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
  source: '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  "system-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  "system-sans": '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
};

const CODE_FONTS: Record<CodeFont, string> = {
  jetbrains: INTERFACE_FONTS.jetbrains,
  plex: INTERFACE_FONTS.plex,
  fira: INTERFACE_FONTS.fira,
  source: INTERFACE_FONTS.source,
  cascadia: INTERFACE_FONTS.cascadia,
  "system-mono": INTERFACE_FONTS["system-mono"],
};

/* The terminal prefers the Nerd Font build, whose extra glyphs are why the theme
   asks for it separately; the other families have no such split. */
const TERMINAL_FONTS: Record<CodeFont, string> = {
  ...CODE_FONTS,
  jetbrains: '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

const CORNERS: Record<Corners, string> = { square: "0px", soft: "3px", rounded: "6px" };

const PROMPTS: Record<Prompt, string | null> = { chevron: "❯", angle: "›", dollar: "$", lambda: "λ", none: null };

/**
 * The stylesheet for these settings, or "" when every value is the theme's own.
 * It only rewrites theme tokens, so the theme stays the one thing that styles
 * bb; the light shade goes where the theme's own base block is and the dark one
 * in a `.dark` block after it, exactly as the theme does.
 */
export function appearanceCss(appearance: GruveAppearance): string {
  const root: string[] = [];
  const dark: string[] = [];

  if (appearance.fontSize !== DEFAULT_APPEARANCE.fontSize) root.push(`font-size: ${appearance.fontSize}px;`);
  if (appearance.interfaceFont !== DEFAULT_APPEARANCE.interfaceFont) root.push(`--font-sans: ${INTERFACE_FONTS[appearance.interfaceFont]};`);
  if (appearance.codeFont !== DEFAULT_APPEARANCE.codeFont) {
    root.push(`--font-mono: ${CODE_FONTS[appearance.codeFont]};`);
    root.push(`--font-terminal: ${TERMINAL_FONTS[appearance.codeFont]};`);
  }
  if (appearance.corners !== DEFAULT_APPEARANCE.corners) root.push(`--gruve-corner: ${CORNERS[appearance.corners]};`);

  if (appearance.accent !== DEFAULT_APPEARANCE.accent) {
    const accent = ACCENTS[appearance.accent];
    root.push(`--primary: ${accent.light[0]};`, `--primary-foreground: ${accent.light[1]};`);
    dark.push(`--primary: ${accent.dark[0]};`, `--primary-foreground: ${accent.dark[1]};`);
  }

  const glyph = PROMPTS[appearance.prompt];
  if (appearance.prompt !== DEFAULT_APPEARANCE.prompt) {
    if (glyph === null) {
      // No glyph: the theme's left rail and its room for the glyph go too.
      root.push(`--gruve-prompt: "";`);
      root.push(`--gruve-prompt-indent: 0rem;`);
    } else {
      root.push(`--gruve-prompt: "${glyph}";`);
    }
  }

  const rules: string[] = [];
  if (root.length > 0) rules.push(`:root {\n  ${root.join("\n  ")}\n}`);
  if (dark.length > 0) rules.push(`.dark {\n  ${dark.join("\n  ")}\n}`);
  if (rules.length === 0) return "";
  return `/* Gruve appearance settings. */\n${rules.join("\n")}\n`;
}

/** Whether Gruve's theme sheet is the one bb applied to this document. */
export function isGruveTheme(doc: Document): boolean {
  return doc.getElementById(THEME_ELEMENT_ID)?.textContent?.includes(THEME_MARKER) ?? false;
}

/** The families the settings name, for the preview on the settings page. */
export const interfaceFontStack = (font: InterfaceFont): string => INTERFACE_FONTS[font];
export const codeFontStack = (font: CodeFont): string => CODE_FONTS[font];
export const promptGlyph = (prompt: Prompt): string | null => PROMPTS[prompt];
export const accentColours = (accent: Accent, mode: "light" | "dark"): readonly [string, string] => ACCENTS[accent][mode];

/** The appearance in effect in this window, set by whoever read the settings. */
let applied: GruveAppearance | null = null;

/**
 * Put the appearance into the document, or take it out when there is nothing to
 * apply (no settings yet, every value default, or another theme in use). The
 * stylesheet sits straight after the theme's own sheet so that later themes and
 * styles cannot outrank it by document order.
 */
export function applyAppearance(doc: Document, appearance: GruveAppearance | null): void {
  applied = appearance;
  paint(doc);
}

/**
 * Re-apply what this window already knows. The theme sheet, the content script
 * and the settings page all land in the same stylesheet, so they read the one
 * value here rather than each keeping its own: a theme change repaints the
 * current settings, and the settings page's newer values are not undone by a
 * repaint.
 */
export function refreshAppearance(doc: Document): void {
  paint(doc);
}

function paint(doc: Document): void {
  const css = applied !== null && isGruveTheme(doc) ? appearanceCss(applied) : "";
  const existing = doc.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);
  if (css === "") {
    existing?.remove();
    return;
  }

  const style = existing ?? doc.createElement("style");
  if (existing === null) {
    style.setAttribute(STYLE_ATTRIBUTE, "");
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;

  const theme = doc.getElementById(THEME_ELEMENT_ID);
  if (theme !== null && style.previousElementSibling !== theme) theme.insertAdjacentElement("afterend", style);
}
