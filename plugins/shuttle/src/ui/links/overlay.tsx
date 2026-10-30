// The app overlay: mounted once per window, it is the page script's bridge (dom.ts). It says which links
// Shuttle can read, asks Shuttle's copy for their PRs' states to colour them, and shows the card for the
// link under the pointer or in focus, or as a sheet after a tap on a phone.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../contract";
import { linkKey, parseGitLink } from "../../links";
import { Dialog, usePortalScope } from "../common";
import { useShuttleQuery } from "../data";
import { useViewport } from "../viewport";
import { LinkCardBody } from "./card";
import { markOpen, paintState, registerBridge, type LinkTargetRef } from "./dom";

const SHOW_DELAY = 250;
const HIDE_DELAY = 260;
const WIDTH = 340;
const BATCH = 100;
/** The longest link linkStates takes; a longer one is never asked about, so it cannot fail its batch. */
const MAX_URL = 2000;
const FOCUSABLE = "button:not([disabled]), a[href]";

type Open = { target: LinkTargetRef; sheet: boolean };

export function LinkOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const config = useShuttleQuery("getConfig", {});
  const servers = config.data?.config.servers;
  const [open, setOpen] = useState<Open | null>(null);
  const [moved, setMoved] = useState(0);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hovered = useRef(false);

  useEffect(() => {
    if (servers === undefined) return;
    let pending: string[] = [];
    let flush: ReturnType<typeof setTimeout> | undefined;
    const keyOf = (url: string) => { const target = parseGitLink(url, servers); return target ? linkKey(target) : null; };
    const ask = async (all: string[]) => {
      for (const url of all) if (url.length > MAX_URL) { const key = keyOf(url); if (key) paintState(key, null); }
      const urls = all.filter((url) => url.length <= MAX_URL);
      for (let i = 0; i < urls.length; i += BATCH) {
        const chunk = urls.slice(i, i + BATCH);
        try {
          const { links } = await rpcRef.current.call("linkStates", { urls: chunk });
          for (const link of links) {
            const key = keyOf(link.url);
            if (key) paintState(key, link.state);
          }
        } catch {
          // Shuttle's server is restarting: the links stay grey, and the page script's two-minute recheck asks
          // again, rather than every change to the page.
          for (const url of chunk) { const key = keyOf(url); if (key) paintState(key, null); }
        }
      }
    };
    const unregister = registerBridge({
      read: (url) => {
        const target = parseGitLink(url, servers);
        return target ? { key: linkKey(target), kind: target.kind } : null;
      },
      enter: (target) => {
        clearTimeout(hideTimer.current);
        clearTimeout(showTimer.current);
        showTimer.current = setTimeout(() => setOpen((current) => (current?.sheet ? current : { target, sheet: false })), SHOW_DELAY);
      },
      leave: () => {
        clearTimeout(showTimer.current);
        hideTimer.current = setTimeout(() => setOpen((current) => (current?.sheet ? current : null)), HIDE_DELAY);
      },
      tap: (target) => setOpen({ target, sheet: true }),
      into: () => {
        const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE);
        if (!first) return false;
        first.focus();
        // Leaving the link for the card is not leaving the card.
        clearTimeout(hideTimer.current);
        return true;
      },
      want: (urls) => {
        pending.push(...urls);
        flush ??= setTimeout(() => {
          const batch = pending;
          pending = [];
          flush = undefined;
          void ask(batch);
        }, 50);
      },
    });
    return () => {
      unregister();
      clearTimeout(flush);
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, [servers]);

  useEffect(() => {
    markOpen(open?.target.el ?? null);
    // A new card opens under its link, not under the pointer.
    hovered.current = false;
    if (!open || open.sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape from inside the card goes back to its link, as a menu's does. Focusing the link reads as entering it,
      // so the card it would schedule is cancelled: Escape closes it for good.
      if (cardRef.current?.contains(document.activeElement)) open.target.el.focus();
      clearTimeout(showTimer.current);
      setOpen(null);
    };
    // A streaming thread scrolls by itself: follow the link, and close once it leaves the screen.
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = open.target.el.getBoundingClientRect();
        if (!open.target.el.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) setOpen(null);
        else setMoved((n) => n + 1);
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [open]);

  useEffect(() => () => markOpen(null), []);

  if (!open) return null;
  if (open.sheet) return <LinkSheet target={open.target} onClose={() => setOpen(null)} />;
  return (
    <HoverCard key={open.target.key} target={open.target} moved={moved} cardRef={cardRef}
      onPointerEnter={() => { hovered.current = true; clearTimeout(hideTimer.current); }}
      onPointerLeave={() => {
        hovered.current = false;
        // Keyboard focus inside the card keeps it; leaving with the keyboard closes it.
        if (cardRef.current?.contains(document.activeElement)) return;
        hideTimer.current = setTimeout(() => setOpen(null), HIDE_DELAY);
      }}
      onFocusIn={() => clearTimeout(hideTimer.current)}
      onFocusOut={(next) => {
        if (next !== null && (cardRef.current?.contains(next) || next === open.target.el)) return;
        // A click on the card's text takes focus to nowhere, but the pointer is still on the card.
        if (next === null && hovered.current) return;
        hideTimer.current = setTimeout(() => setOpen(null), HIDE_DELAY);
      }}
      onDone={() => setOpen(null)} />
  );
}

function HoverCard({ target, moved, cardRef, onPointerEnter, onPointerLeave, onFocusIn, onFocusOut, onDone }: {
  target: LinkTargetRef;
  moved: number;
  cardRef: { current: HTMLDivElement | null };
  onPointerEnter(): void;
  onPointerLeave(): void;
  onFocusIn(): void;
  onFocusOut(next: Element | null): void;
  onDone(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    cardRef.current = ref.current;
    return () => { if (cardRef.current === ref.current) cardRef.current = null; };
  });
  // The card sits at the end of the page, so Tab order would leave its link behind: Shift+Tab from its first
  // control and Tab from its last go back to the link, whose next Tab carries on through the thread.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab") return;
    const controls = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (edge !== undefined && document.activeElement === edge) {
      event.preventDefault();
      target.el.focus();
    }
  };
  const scope = usePortalScope();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const card = useShuttleQuery("linkCard", { url: target.url });
  const navigate = useBbNavigate();

  useLayoutEffect(() => {
    const rect = target.el.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 180;
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - height) : below;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
    setPos({ top, left });
  }, [target, moved, card.data, card.error]);

  return createPortal(
    <div {...scope} ref={ref} role="dialog" data-shuttle-card="" aria-label={`About ${target.url}`}
      onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onKeyDown={onKeyDown}
      onFocus={onFocusIn} onBlur={(event) => onFocusOut(event.relatedTarget instanceof Element ? event.relatedTarget : null)}
      style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: WIDTH, maxWidth: "calc(100vw - 16px)", zIndex: 60 }}
      className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
      <LinkCardBody url={target.url} kind={target.kind} card={card.data} error={card.error} navigate={navigate} onDone={onDone} />
    </div>,
    document.body,
  );
}

/** A phone has no hover: the card opens as a bottom sheet, and its Open button follows the link. */
function LinkSheet({ target, onClose }: { target: LinkTargetRef; onClose(): void }) {
  const card = useShuttleQuery("linkCard", { url: target.url });
  const navigate = useBbNavigate();
  const phone = useViewport() === "phone";
  return (
    <Dialog title={card.data?.label ?? "Link"} onClose={onClose}>
      <div data-shuttle-card="" className={phone ? "-mx-4" : ""}>
        <LinkCardBody url={target.url} kind={target.kind} card={card.data} error={card.error} navigate={navigate} onDone={onClose} sheet />
      </div>
    </Dialog>
  );
}
