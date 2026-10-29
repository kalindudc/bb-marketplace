import { useEffect, useState } from "react";
import { experimental_usePluginId, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { accentColours, applyAppearance, codeFontStack, interfaceFontStack, isGruveTheme, promptGlyph } from "./appearance";
import { DEFAULT_APPEARANCE, parseAppearance, SETTINGS_CHANNEL, type GruveAppearance } from "./settings";

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
  const [primary, onPrimary] = accentColours(shown.accent, useDarkMode() ? "dark" : "light");
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
