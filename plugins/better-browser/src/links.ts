/** How long one refresh keeps Cmd+click interception on; the toolbar refreshes it well inside this window. */
export const LINK_LEASE_MS = 6_000;

/**
 * Runs in the Browser tab's isolated world, which binds `bb.postMessage`: a capture-phase click listener on the window,
 * ahead of every page handler, that turns Cmd+click (Ctrl+click off macOS) on an http(s) link into a message for the
 * toolbar instead of bb opening the link in a new bb tab. Each evaluation extends interception until `until`; when the
 * toolbar goes away (plugin disabled, setting off, tab hidden) it lapses and the page behaves as it would without the
 * plugin. Kept as source text: a bundler's helpers would not exist inside the page.
 */
export function linkHandlerExpression(until: number): string {
  return `(() => {
  window.__betterBrowserLinksUntil = ${Math.floor(until)};
  if (window.__betterBrowserLinks) return false;
  window.__betterBrowserLinks = true;
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const linkOf = (event) => {
    for (const node of event.composedPath()) {
      if (!node || node.nodeType !== 1) continue;
      if (node.localName !== "a" && node.localName !== "area") continue;
      const href = node.getAttribute("href") ?? node.getAttribute("xlink:href");
      if (href === null) continue;
      try {
        const url = new URL(href, node.ownerDocument.baseURI);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
      } catch {
        return null;
      }
    }
    return null;
  };
  window.addEventListener("click", (event) => {
    if (Date.now() > window.__betterBrowserLinksUntil) return;
    if (event.button !== 0 || !(mac ? event.metaKey : event.ctrlKey)) return;
    const url = linkOf(event);
    if (url === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    bb.postMessage({ type: "better-browser:open", url });
  }, true);
  return true;
})()`;
}

/** Turns interception off at once, for when the setting is switched off while the page stays open. */
export const LINK_HANDLER_OFF = "(window.__betterBrowserLinksUntil = 0, true)";

export function parseOpenMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== "better-browser:open" || typeof url !== "string" || url.length > 8192) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * True when the page shows a sign-in form: a password, username, email or passkey field, or the Okta, Microsoft or
 * Google sign-in widget. Sign-in hosts also serve pages that are not sign-in (the Okta dashboard, for one), so the
 * handoff waits for a visible form. Null means the document is still loading, not that sign-in has finished.
 */
export const SIGN_IN_FORM_PROBE = `(() => {
  const selectors = [
    "#okta-sign-in", "[data-se='o-form']", "input[type='password']", "input[autocomplete~='username']",
    "input[autocomplete~='webauthn']", "input[type='email']", "input[name='loginfmt']", "#identifierId",
    "input[name='identifier']", "input[name='username']",
  ];
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  if (selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(visible))) return true;
  return document.readyState === "loading" ? null : false;
})()`;
