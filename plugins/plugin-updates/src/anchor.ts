// bb has no slot on its Installed plugins page, so the group is placed through the page's markup. These are the
// only selectors this plugin depends on; when a bb release changes them the group stops showing and nothing breaks.
export const ROW_SELECTOR = '[data-testid^="plugin-row-"]';
export const HOST_ATTRIBUTE = "data-plugin-updates-group";

const SCAN_DELAY_MS = 150;

/** The Installed page's card grid: the element that holds its plugin rows. */
export function findInstalledGrid(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(ROW_SELECTOR)?.parentElement ?? null;
}

/**
 * Keeps one host element just before the Installed page's card grid while that page is on screen, and reports it,
 * or null once the page is gone. The host carries the plugin's scope attributes so its styles apply inside it.
 */
export function watchInstalledGrid(
  doc: Document,
  pluginId: string,
  onHost: (host: HTMLElement | null) => void,
): () => void {
  const win = doc.defaultView ?? window;
  let host: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const setHost = (next: HTMLElement | null) => {
    if (next === host) return;
    host = next;
    onHost(next);
  };

  const scan = () => {
    timer = null;
    if (disposed) return;
    const grid = win.location.pathname.includes("plugins") ? findInstalledGrid(doc) : null;
    const parent = grid?.parentElement ?? null;
    if (grid === null || parent === null) {
      host?.remove();
      setHost(null);
      return;
    }
    if (host !== null && host.isConnected && host.nextElementSibling === grid) return;
    const next = host ?? doc.createElement("div");
    next.setAttribute(HOST_ATTRIBUTE, "");
    next.setAttribute("data-bb-plugin-root", "");
    next.setAttribute("data-bb-plugin", pluginId);
    parent.insertBefore(next, grid);
    setHost(next);
  };

  const schedule = () => {
    if (timer === null && !disposed) timer = setTimeout(scan, SCAN_DELAY_MS);
  };

  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true });
  scan();

  return () => {
    disposed = true;
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    host?.remove();
    host = null;
  };
}
