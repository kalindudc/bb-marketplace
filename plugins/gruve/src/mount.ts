/* The content script that applies the appearance settings to bb's window.
   bb hands a content script no React hooks, so the values are read from bb's
   own plugin-settings endpoint; the settings page pushes later changes in
   (src/settings-section.tsx), and refocusing the window re-reads them for
   changes made elsewhere. */

import { applyAppearance, refreshAppearance } from "./appearance";
import { parseAppearance } from "./settings";

export interface MountAppearanceOptions {
  document: Document;
  /** The plugin's own id, which names its settings endpoint. */
  pluginId: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Defaults to this document's window, for the focus listener. */
  window?: Window;
}

const SETTINGS_PATH = "/api/v1/plugins/";

/** BB's own client reads settings from here through the same endpoint. */
const settingsUrl = (pluginId: string): string => `${SETTINGS_PATH}${encodeURIComponent(pluginId)}/settings`;

/**
 * Install the appearance into a bb window and return the disposer bb calls
 * when the plugin reloads, is disabled or the window closes.
 */
export function mountGruveAppearance(options: MountAppearanceOptions): () => void {
  const { document: doc, pluginId, signal } = options;
  const view = options.window ?? doc.defaultView;
  const request = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let loaded = false;
  let attempts = 0;

  // Only while mounted: a reload that finished an in-flight read must not leave
  // its stylesheet behind for the next generation to trip over.
  const render = (): void => {
    if (!signal.aborted) refreshAppearance(doc);
  };

  const read = async (): Promise<void> => {
    const attempt = ++attempts;
    let values: Record<string, unknown> | undefined;
    try {
      const response = await request(settingsUrl(pluginId), {
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`bb answered ${response.status}`);
      const body = (await response.json()) as { values?: Record<string, unknown> };
      values = body.values;
    } catch (error) {
      if (signal.aborted) return;
      // A theme setting that cannot be read is not worth a broken window: the
      // theme's own values stay, and the next refocus tries again.
      if (!loaded) console.warn("Gruve could not read its appearance settings, so the theme is unmodified.", error);
      return;
    }
    if (signal.aborted || attempt !== attempts) return;
    loaded = true;
    applyAppearance(doc, parseAppearance(values));
  };

  const observer = new MutationObserver(() => render());
  // The theme sheet is rewritten in place when the theme changes, so watching
  // the head is what makes switching to or away from Gruve take effect now.
  observer.observe(doc.head, { childList: true, characterData: true, subtree: true });

  const onFocus = (): void => void read();
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === "visible") void read();
  };
  view?.addEventListener("focus", onFocus);
  doc.addEventListener("visibilitychange", onVisibilityChange);

  void read();

  return () => {
    attempts++;
    observer.disconnect();
    view?.removeEventListener("focus", onFocus);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    applyAppearance(doc, null);
  };
}
