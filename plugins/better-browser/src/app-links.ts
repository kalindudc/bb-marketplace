export interface AppLinkOptions {
  open(url: string): void;
  /** Tests replace it, because jsdom marks every dispatched event untrusted. */
  isTrusted?: (event: MouseEvent) => boolean;
}

/** The http(s) address of the link a click landed on, or null for anything else, including a link to bb itself. */
export function webLinkOf(event: Event, appOrigin: string): string | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element) || (node.localName !== "a" && node.localName !== "area")) continue;
    const href = node.getAttribute("href");
    if (href === null) return null;
    try {
      const url = new URL(href, node.ownerDocument.baseURI);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin === appOrigin ? null : url.href;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cmd+click (Ctrl+click off macOS) on a web link in bb's own window, such as one in a conversation, opens it with `open`
 * where bb would open it in its Browser. The listener captures on the window, ahead of bb's own link handlers, which
 * open every click the same way. Links to bb itself keep bb's behaviour, where Cmd+click opens a split.
 */
export function interceptAppLinks(win: Window, { open, isTrusted = (event) => event.isTrusted }: AppLinkOptions): () => void {
  const mac = /Mac|iPhone|iPad|iPod/.test(win.navigator.platform || win.navigator.userAgent);
  const onClick = (event: MouseEvent) => {
    if (!isTrusted(event) || event.button !== 0 || !(mac ? event.metaKey : event.ctrlKey)) return;
    const url = webLinkOf(event, win.location.origin);
    if (url === null) return;
    event.preventDefault();
    event.stopPropagation();
    open(url);
  };
  win.addEventListener("click", onClick, true);
  return () => win.removeEventListener("click", onClick, true);
}
