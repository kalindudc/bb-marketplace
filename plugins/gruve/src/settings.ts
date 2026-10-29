import type { PluginSettingDescriptors, StandardSchemaV1 } from "@get-bb/plugin-sdk";

/** The realtime channel the server publishes on when a setting changes. */
export const SETTINGS_CHANNEL = "appearance";

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;

export type Accent = "yellow" | "orange" | "red" | "green" | "aqua" | "blue" | "purple";
export type InterfaceFont = "jetbrains" | "plex" | "fira" | "source" | "cascadia" | "system-mono" | "system-sans";
export type CodeFont = Exclude<InterfaceFont, "system-sans">;
export type Corners = "square" | "soft" | "rounded";
export type Prompt = "chevron" | "angle" | "dollar" | "lambda" | "none";

export interface GruveAppearance {
  accent: Accent;
  interfaceFont: InterfaceFont;
  codeFont: CodeFont;
  /** Root font size in px; the whole interface is laid out in rem. */
  fontSize: number;
  corners: Corners;
  prompt: Prompt;
}

/** What the theme ships as written: these values inject no CSS at all. */
export const DEFAULT_APPEARANCE: GruveAppearance = {
  accent: "yellow",
  interfaceFont: "jetbrains",
  codeFont: "jetbrains",
  fontSize: 16,
  corners: "square",
  prompt: "chevron",
};

const ACCENTS: readonly Accent[] = ["yellow", "orange", "red", "green", "aqua", "blue", "purple"];
const INTERFACE_FONTS: readonly InterfaceFont[] = ["jetbrains", "plex", "fira", "source", "cascadia", "system-mono", "system-sans"];
const CODE_FONTS: readonly CodeFont[] = ["jetbrains", "plex", "fira", "source", "cascadia", "system-mono"];
const CORNERS: readonly Corners[] = ["square", "soft", "rounded"];
const PROMPTS: readonly Prompt[] = ["chevron", "angle", "dollar", "lambda", "none"];

const isWholeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE;

const fontSizeSchema: StandardSchemaV1<number, number> = {
  "~standard": {
    version: 1,
    vendor: "gruve",
    validate: (value) =>
      isWholeNumber(value)
        ? { value }
        : { issues: [{ message: `Enter a whole number of pixels from ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}.` }] },
  },
};

export const SETTING_DESCRIPTORS = {
  accent: {
    type: "select",
    label: "Accent colour",
    description: "Links, the composer prompt and focused controls. Each mode gets its own shade of the colour, so both stay readable.",
    options: [...ACCENTS],
    experimental_optionLabels: {
      yellow: "Yellow (default)",
      orange: "Orange",
      red: "Red",
      green: "Green",
      aqua: "Aqua",
      blue: "Blue",
      purple: "Purple",
    },
    default: DEFAULT_APPEARANCE.accent,
  },
  interfaceFont: {
    type: "select",
    label: "Interface font",
    description: "What the app, its menus and your messages are set in. Proportional is not gruvbox, but it suits long messages.",
    options: [...INTERFACE_FONTS],
    experimental_optionLabels: {
      jetbrains: "JetBrains Mono (default)",
      plex: "IBM Plex Mono",
      fira: "Fira Code",
      source: "Source Code Pro",
      cascadia: "Cascadia Code",
      "system-mono": "System monospace",
      "system-sans": "System sans (proportional)",
    },
    default: DEFAULT_APPEARANCE.interfaceFont,
  },
  codeFont: {
    type: "select",
    label: "Code and terminal font",
    description: "Code blocks, diffs, file previews and the integrated terminal.",
    options: [...CODE_FONTS],
    experimental_optionLabels: {
      jetbrains: "JetBrains Mono (default)",
      plex: "IBM Plex Mono",
      fira: "Fira Code",
      source: "Source Code Pro",
      cascadia: "Cascadia Code",
      "system-mono": "System monospace",
    },
    default: DEFAULT_APPEARANCE.codeFont,
  },
  fontSize: {
    type: "number",
    label: "Text size (px)",
    description: "The whole interface is laid out in rem, so this scales it. 16 is bb's own size.",
    default: DEFAULT_APPEARANCE.fontSize,
    experimental_schema: fontSizeSchema,
  },
  corners: {
    type: "select",
    label: "Corners",
    description: "Gruve squares every corner. Soft and Rounded keep the flat surfaces but give cards, menus and buttons a radius.",
    options: [...CORNERS],
    experimental_optionLabels: { square: "Square (0px, default)", soft: "Soft (3px)", rounded: "Rounded (6px)" },
    default: DEFAULT_APPEARANCE.corners,
  },
  prompt: {
    type: "select",
    label: "Composer prompt",
    description: "The glyph before the first line of the composer. Grav is the shape gruvbox's own prompt uses.",
    options: [...PROMPTS],
    experimental_optionLabels: { chevron: "❯  chevron (default)", angle: "›  angle", dollar: "$  dollar", lambda: "λ  lambda", none: "None" },
    default: DEFAULT_APPEARANCE.prompt,
  },
} satisfies PluginSettingDescriptors;

const oneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (options as readonly string[]).includes(value);

/**
 * Stored values as an appearance, keeping the default for anything missing or
 * invalid: a value written by an older version, or a text box the user emptied,
 * must still leave a usable theme.
 */
export function parseAppearance(values: Readonly<Record<string, unknown>> | undefined): GruveAppearance {
  const read = values ?? {};
  return {
    accent: oneOf(ACCENTS, read.accent) ? read.accent : DEFAULT_APPEARANCE.accent,
    interfaceFont: oneOf(INTERFACE_FONTS, read.interfaceFont) ? read.interfaceFont : DEFAULT_APPEARANCE.interfaceFont,
    codeFont: oneOf(CODE_FONTS, read.codeFont) ? read.codeFont : DEFAULT_APPEARANCE.codeFont,
    fontSize: isWholeNumber(read.fontSize) ? read.fontSize : DEFAULT_APPEARANCE.fontSize,
    corners: oneOf(CORNERS, read.corners) ? read.corners : DEFAULT_APPEARANCE.corners,
    prompt: oneOf(PROMPTS, read.prompt) ? read.prompt : DEFAULT_APPEARANCE.prompt,
  };
}
