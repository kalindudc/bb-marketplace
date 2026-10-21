// Draws what needs you in Loom on its nav rail button. SDK 0.6.49 has no badge for a nav panel, so this
// decorates bb's rail from a content script and polls the plugin's badge route. A rail bb renders differently shows no count.
import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import type { Badge } from "../badge";

export const BADGE_POLL_MS = 15_000;
const ATTR = "data-loom-badge";
// Inline, not a class: React rewrites the button's className on re-render, and Loom ships no stylesheet.
const STYLE =
  "position: absolute; top: 1px; right: 1px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; background: var(--primary, #7c5cff); color: var(--primary-foreground, #fff); font-size: 9px; font-weight: 600; line-height: 15px; text-align: center; pointer-events: none";

export function mountRailBadge(context: PluginContentScriptContext): () => void {
  const selector = `[data-nav-rail-item="${context.pluginId}/loom"] button`;
  const buttons = () => document.querySelectorAll<HTMLElement>(selector);
  let shown: Badge = { count: 0, label: "" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  const clear = (button: HTMLElement) => {
    button.querySelector(`[${ATTR}]`)?.remove();
    button.removeAttribute("aria-description");
    button.style.removeProperty("position");
  };

  const paint = () => {
    for (const button of buttons()) {
      if (shown.count === 0) {
        clear(button);
        continue;
      }
      let span = button.querySelector<HTMLElement>(`[${ATTR}]`);
      if (span === null) {
        span = document.createElement("span");
        span.setAttribute(ATTR, "");
        span.setAttribute("aria-hidden", "true");
        span.style.cssText = STYLE;
        button.append(span);
      }
      if (button.style.position !== "relative") button.style.position = "relative";
      const text = shown.count > 9 ? "9+" : String(shown.count);
      if (span.textContent !== text) span.textContent = text;
      if (button.getAttribute("aria-description") !== shown.label) button.setAttribute("aria-description", shown.label);
    }
  };

  const poll = async () => {
    polling = true;
    try {
      const response = await fetch(`/api/v1/plugins/${context.pluginId}/http/badge`, { signal: context.signal, headers: { accept: "application/json" } });
      const body = response.ok ? ((await response.json()) as Partial<Badge>) : null;
      if (!context.signal.aborted && typeof body?.count === "number" && typeof body.label === "string") {
        shown = { count: body.count, label: body.label };
        paint();
      }
    } catch {
      // A restarting server or a reloading plugin: keep the last count.
    }
    polling = false;
    if (!context.signal.aborted) timer = setTimeout(() => void poll(), document.hidden ? BADGE_POLL_MS * 4 : BADGE_POLL_MS);
  };

  // The rail re-renders on route changes and compact navigation; draw again when a button lost the count.
  const observer = new MutationObserver(() => {
    if (shown.count === 0) return;
    for (const button of buttons()) {
      if (button.style.position !== "relative" || button.querySelector(`[${ATTR}]`) === null) return paint();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  const onVisible = () => {
    if (document.hidden || polling) return;
    clearTimeout(timer);
    void poll();
  };
  document.addEventListener("visibilitychange", onVisible);
  void poll();

  return () => {
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
    for (const button of buttons()) clear(button);
  };
}
