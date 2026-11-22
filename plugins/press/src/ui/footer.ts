import { useLayoutEffect, useState, useSyncExternalStore } from "react";

declare const __BB_PLUGIN_ID__: string | undefined;

// Adapted from Burn's extensions/bb/footer.ts; these selectors are bb markup, not an SDK contract.
const FOOTER_SELECTOR = "[data-follow-up-composer-footer]";
const PANE_SELECTOR = "[data-split-pane-id]";
const CIRCLE_SELECTOR = ':scope > button[aria-label^="Context window"]';
const mounted = new WeakMap<Element, Set<HTMLElement>>();
const listeners = new Set<() => void>();

function pluginScopeAttributes(): Record<string, string> {
  return {
    "data-bb-plugin-root": "",
    ...(typeof __BB_PLUGIN_ID__ === "string" ? { "data-bb-plugin": __BB_PLUGIN_ID__ } : {}),
  };
}

export function placeInFooter(node: HTMLElement, pane: ParentNode): Element | null {
  const group = pane.querySelector(FOOTER_SELECTOR)?.lastElementChild;
  const circle = group?.querySelector(CIRCLE_SELECTOR);
  if (!group || !circle) {
    node.remove();
    return null;
  }
  // Burn never reorders its connected chip, so move once if it arrived after Press.
  if (node.parentElement !== group || circle.previousElementSibling?.hasAttribute("data-burn-chip")) {
    group.insertBefore(node, circle);
  }
  return circle;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFooterPresence(anchor: HTMLElement | null): boolean {
  return useSyncExternalStore(subscribe, () => {
    const pane = anchor?.closest(PANE_SELECTOR);
    return pane != null && (mounted.get(pane)?.size ?? 0) > 0;
  }, () => false);
}

export function useFooterMount(anchor: HTMLElement | null): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const pane = anchor?.closest(PANE_SELECTOR);
    if (!pane || !anchor) {
      setMount(null);
      return;
    }
    const view = anchor.ownerDocument.defaultView;
    if (!view) return;
    const node = anchor.ownerDocument.createElement("span");
    node.setAttribute("data-press-chip", "");
    for (const [name, value] of Object.entries(pluginScopeAttributes())) node.setAttribute(name, value);
    node.className = "inline-flex shrink-0 items-center";
    const mounts = mounted.get(pane) ?? new Set<HTMLElement>();
    mounted.set(pane, mounts);
    let circle: Element | null = null;
    let frame: number | null = null;
    const place = () => {
      frame = null;
      try {
        circle = placeInFooter(node, pane);
      } catch {
        circle = null;
        node.remove();
      }
      const wasMounted = mounts.has(node);
      if (circle) mounts.add(node);
      else mounts.delete(node);
      setMount(circle ? node : null);
      if (wasMounted !== mounts.has(node)) listeners.forEach((listener) => listener());
    };
    const observer = new view.MutationObserver(() => {
      if (node.isConnected && circle && node.parentElement === circle.parentElement
        && !circle.previousElementSibling?.hasAttribute("data-burn-chip")
        && circle.matches('button[aria-label^="Context window"]')
        && node.parentElement?.parentElement?.matches(FOOTER_SELECTOR)
        && node.parentElement.parentElement.lastElementChild === node.parentElement) return;
      if (frame === null) frame = view.requestAnimationFrame(place);
    });
    observer.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
    place();
    return () => {
      observer.disconnect();
      if (frame !== null) view.cancelAnimationFrame(frame);
      node.remove();
      if (mounts.delete(node)) listeners.forEach((listener) => listener());
    };
  }, [anchor]);
  return mount;
}
