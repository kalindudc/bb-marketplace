import { useEffect, useState } from "react";
import { experimental_usePluginId, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { accentColours, applyAppearance, codeFontStack, interfaceFontStack, isGruveTheme, palette, promptGlyph } from "./appearance";
import { DEFAULT_APPEARANCE, parseAppearance, SETTING_DESCRIPTORS, SETTINGS_CHANNEL, type GruveAppearance, type Mode } from "./settings";

/**
 * The section under the settings form: a preview of the choices, and the way a
 * change reaches the window it was made in right away. The content script that
 * applies the appearance cannot hear the settings channel, so while this section
 * is on screen it applies the values the server just saved.
 */
export function GruveAppearanceSettings() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const [appearance, setAppearance] = useState<GruveAppearance | null>(null);
  const [revision, setRevision] = useState(0);
  useRealtime(SETTINGS_CHANNEL, () => setRevision((current) => current + 1));

  useEffect(() => {
    const controller = new AbortController();
    sdk.plugins.getSettings({ pluginId, signal: controller.signal }).then(
      (response) => {
        if (controller.signal.aborted) return;
        const next = parseAppearance(response.values);
        setAppearance(next);
        applyAppearance(document, next);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) console.warn("Gruve could not read its appearance settings.", error);
      },
    );
    return () => controller.abort();
  }, [sdk, pluginId, revision]);

  const shown = appearance ?? DEFAULT_APPEARANCE;
  const [primary, onPrimary] = accentColours(shown.accent, useDarkMode() ? "dark" : "light", shown.mode);
  const glyph = promptGlyph(shown.prompt);

  return (
    <div className="flex flex-col gap-3">
      {isGruveTheme(document) ? null : (
        <p className="text-sm text-muted-foreground">
          These options change the Gruve theme. Pick Gruve under Appearance to see them everywhere.
        </p>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
        <p className="text-foreground" style={{ fontFamily: interfaceFontStack(shown.interfaceFont), fontSize: `${shown.fontSize}px` }}>
          The quick brown fox jumps over the lazy dog.
        </p>
        <p className="text-muted-foreground" style={{ fontFamily: codeFontStack(shown.codeFont), fontSize: `${shown.fontSize}px` }}>
          {"const yellow = '#fabd2f';"}
        </p>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden style={{ color: primary, fontFamily: interfaceFontStack(shown.interfaceFont) }}>
            {glyph ?? "no prompt"}
          </span>
          <span className="rounded px-2 py-0.5" style={{ background: primary, color: onPrimary }}>
            Accent
          </span>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{SETTING_DESCRIPTORS.mode.experimental_optionLabels[shown.mode]}</p>
      {/* Drawn from the palettes themselves, so both schemes show whichever one bb is in. */}
      <div className="grid grid-cols-2 gap-2">
        <ModeSample mode={shown.mode} scheme="light" appearance={shown} />
        <ModeSample mode={shown.mode} scheme="dark" appearance={shown} />
      </div>
    </div>
  );
}

function ModeSample({ mode, scheme, appearance }: { mode: Mode; scheme: "light" | "dark"; appearance: GruveAppearance }) {
  const colours = palette(mode, scheme);
  const [accent] = accentColours(appearance.accent, scheme, mode);
  return (
    <div
      aria-label={`${scheme === "light" ? "Light" : "Dark"} preview`}
      className="flex flex-col gap-1.5 rounded-lg p-2 text-sm"
      style={{ background: colours["--canvas"], border: `1px solid ${colours["--border"]}`, fontFamily: interfaceFontStack(appearance.interfaceFont) }}
    >
      <div
        className="flex flex-wrap items-center gap-2 rounded px-2 py-1.5"
        style={{ background: colours["--card"], border: `1px solid ${colours["--border-seam"]}`, color: colours["--ink"] }}
      >
        <span>{scheme === "light" ? "Light" : "Dark"}</span>
        <span className="rounded px-1.5" style={{ background: colours["--secondary"], color: colours["--muted-foreground"] }}>
          chip
        </span>
        <span style={{ color: accent }}>link</span>
      </div>
      <span className="px-2 text-xs" style={{ color: colours["--subtle-foreground"] }}>
        timestamps and hints
      </span>
    </div>
  );
}

/** bb keeps the mode as a class on the root element, the same one the theme's blocks use. */
function useDarkMode(): boolean {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
