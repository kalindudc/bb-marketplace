// Loom's controls in bb's title bar: Jump to on every route; on a project, Sync pull requests, the one-click Pause or
// Resume, and a menu with the rarer controls. A risky one arms in place, here in the bar, and waits for the person: no
// timer disarms it. While the page is rewound every control that writes is disabled, and the dispatcher refuses it too.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { experimental_Icon as Icon, useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useLoom, useSyncPullRequests } from "./common";
import { canSyncPullRequests, controlsOf, leadOf, offerTarget, useControl, type ControlOffer } from "./controls";
import { REWOUND_REASON, palette, useRewound } from "./dispatch";
import { AnchoredPanel, KBD, Menu, MenuItem, MenuSeparator, Tip, TipProvider } from "./kit";
import { TAP } from "./common";
import { lastRoute, narrowPage, routeOf, shortCrumb } from "./page";
import { useStored } from "./remember";
import { useLoomTheme } from "./theme";
import { projectViews } from "./views";

// Decision 7 on a phone and on a touch screen, inside bb's 48 px title bar: the button keeps bb's 28 px look, and its hit area is 44 by 44.
// The area is a fixed 44 px centred on the button, since insets would start inside a bordered button's border.
const HIT = "relative max-[576px]:min-w-11 pointer-coarse:min-w-11 max-[576px]:before:absolute max-[576px]:before:inset-x-0 max-[576px]:before:top-1/2 max-[576px]:before:h-11 max-[576px]:before:-translate-y-1/2 max-[576px]:before:content-[''] pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";
const BAR_BUTTON = `inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border-seam px-2.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-55 ${HIT}`;
const ICON_BUTTON = `inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${HIT}`;
const YES = `inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold hover:opacity-90 ${HIT}`;

/** Whether an armed group in the bar would leave the window or squeeze its Yes: then it confirms in a panel instead. */
export function armedFits(group: DOMRect, viewport: number, yes: { scrollWidth: number; clientWidth: number } | null): boolean {
  if (group.width === 0) return true;
  return group.left >= 0 && group.right <= viewport - 2 && (yes === null || yes.scrollWidth <= yes.clientWidth + 1);
}

function Armed({ offer, busy, narrow, onYes, onBack }: { offer: ControlOffer; busy: boolean; narrow: boolean; onYes(): void; onBack(): void }) {
  const yes = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLSpanElement>(null);
  // In bb's fixed title bar a long consequence ran off a phone screen and took Back with it (and at 200% text at any
  // width), so where the group does not fit it confirms in a panel under the bar, with the whole consequence and Back.
  const [panel, setPanel] = useState(narrow);
  useLayoutEffect(() => {
    if (panel) return;
    const check = () => {
      if (group.current !== null && !armedFits(group.current.getBoundingClientRect(), window.innerWidth, yes.current)) setPanel(true);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [panel]);
  useEffect(() => {
    if (!panel) yes.current?.focus();
  }, [panel]);
  if (panel)
    return (
      <AnchoredPanel label={offer.label} onClose={onBack} initialFocus={() => yes.current} className="w-[22rem]">
        <div
          data-confirm-armed
          data-confirm-panel
          role="group"
          aria-label={offer.label}
          className="grid gap-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onBack();
          }}
        >
          <p className="m-0 text-xs font-semibold">{offer.label}</p>
          {offer.hint !== "" && <p className="m-0 text-xs text-[var(--loom-muted)]">{offer.hint}</p>}
          <div className="flex flex-wrap gap-2">
            <button ref={yes} type="button" disabled={busy} className={`inline-flex min-h-8 min-w-0 max-w-full cursor-pointer items-center rounded-md px-3 py-1.5 text-left text-xs leading-snug font-semibold [overflow-wrap:anywhere] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50 ${TAP} ${offer.danger === true ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`} onClick={onYes}>
              {offer.yes}
            </button>
            <button type="button" className={`inline-flex min-h-8 shrink-0 cursor-pointer items-center rounded-md border border-border-seam px-3 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${TAP}`} onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </AnchoredPanel>
    );
  return (
    <span
      role="group"
      aria-label={offer.label}
      ref={group}
      data-confirm-armed
      className="inline-flex items-center gap-1.5"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onBack();
      }}
    >
      <button ref={yes} type="button" disabled={busy} className={`${YES} ${offer.danger === true ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`} onClick={onYes}>
        {offer.yes}
      </button>
      <button type="button" className={BAR_BUTTON} onClick={onBack}>
        Back
      </button>
    </span>
  );
}

function ProjectControls({ slug }: { slug: string }) {
  const navigate = useBbNavigate();
  const view = useLoom("project", { slug }, { keep: true }).data;
  const rewound = useRewound();
  const { busy, run } = useControl(slug);
  const { syncing, sync } = useSyncPullRequests(slug);
  const narrow = useSyncExternalStore(narrowPage.subscribe, narrowPage.get, narrowPage.get);
  const [armedOffer, setArmed] = useState<ControlOffer | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const offers = view === undefined ? [] : controlsOf(view);
  // Armed only while that very offer is still offered: a new version, or an offer that went away, disarms it at once.
  const armed = armedOffer !== null && !rewound && offers.some((offer) => offerTarget(offer) === offerTarget(armedOffer)) ? armedOffer : null;
  useEffect(() => {
    if (armedOffer === null || armed !== null) return;
    setArmed(null);
    if (document.activeElement === null || document.activeElement === document.body) trigger.current?.focus();
  }, [armedOffer, armed, rewound]);
  if (view === undefined) return null;
  const lead = leadOf(view);
  const toggle = offers.find((offer) => offer.action === "pause" || offer.action === "resume") ?? null;
  const rest = offers.filter((offer) => offer !== toggle && !(lead !== null && offer.action === lead.action && offer.version === lead.version));
  const writes = rest.filter((offer) => offer.action !== "archive");
  const archive = rest.find((offer) => offer.action === "archive") ?? null;
  const syncable = canSyncPullRequests(view.overview);
  const go = (offer: ControlOffer) => {
    if (offer.yes === null) void run(offer.action, offer.version);
    else setArmed(offer);
  };
  const disabledWhy = rewound ? REWOUND_REASON : undefined;
  const back = () => {
    setArmed(null);
    trigger.current?.focus();
  };
  return (
    <span data-title-controls className="inline-flex items-center gap-1.5">
      {syncable && !narrow && (
        <Tip text={disabledWhy ?? "Sync pull requests: read every open one now and act on what it says"}>
          <button type="button" data-sync-prs aria-label="Sync pull requests" aria-busy={syncing} aria-disabled={rewound || undefined} disabled={syncing || busy} className={ICON_BUTTON} onClick={() => (rewound ? void toast.error(REWOUND_REASON) : void sync())}>
            <Icon name="ArrowReloadHorizontal" aria-hidden className={`size-4 ${syncing ? "animate-spin" : ""}`} />
          </button>
        </Tip>
      )}
      {armed !== null && (
        <Armed
          key={offerTarget(armed)}
          offer={armed}
          busy={busy}
          narrow={narrow}
          onBack={back}
          onYes={() => {
            const offer = armed;
            setArmed(null);
            void run(offer.action, offer.version);
          }}
        />
      )}
      {armed === null && toggle !== null && (
        <Tip text={disabledWhy ?? toggle.hint}>
          <button type="button" data-title-toggle={toggle.action} aria-label={narrow ? toggle.label : undefined} aria-disabled={rewound || undefined} disabled={busy} className={BAR_BUTTON} onClick={() => (rewound ? void toast.error(REWOUND_REASON) : void run(toggle.action))}>
            <Icon name={toggle.icon} aria-hidden className="size-3.5" />
            {!narrow && toggle.label}
          </button>
        </Tip>
      )}
      <Menu
        label="More project controls"
        trigger={
          <button ref={trigger} type="button" aria-label="More project controls" className={ICON_BUTTON}>
            <Icon name="MoreHorizontal" aria-hidden className="size-4" />
          </button>
        }
      >
        {syncable && (
          <MenuItem icon="ArrowReloadHorizontal" disabled={rewound || syncing} hint={disabledWhy ?? "Read every open pull request now"} onSelect={() => void sync()}>
            Sync pull requests
          </MenuItem>
        )}
        {writes.map((offer) => (
          <MenuItem key={`${offer.action}-${offer.version ?? ""}`} icon={offer.icon} disabled={rewound || busy} hint={disabledWhy ?? offer.hint} onSelect={() => go(offer)}>
            <span className="grid">
              <span data-menu-label>{offer.label}</span>
              <span className="text-xs text-[var(--loom-muted)]">{offer.hint}</span>
            </span>
          </MenuItem>
        ))}
        {view.overview.plannerThreadId !== null && (
          <MenuItem
            icon="MessageSquare"
            onSelect={() => {
              projectViews.put(slug, "planner");
              navigate.toPluginPanel("loom", { subPath: slug });
            }}
          >
            Planner
          </MenuItem>
        )}
        {archive !== null && (
          <>
            <MenuSeparator />
            <MenuItem icon="Archive" danger disabled={rewound || busy} hint={disabledWhy ?? archive.hint} onSelect={() => go(archive)}>
              Archive project…
            </MenuItem>
          </>
        )}
      </Menu>
    </span>
  );
}

/**
 * Sets `shortCrumb` while a ticket's project crumb, by its full name, would end over Loom's controls. It reads only where
 * Loom's own slot starts and where the crumb link Loom gave bb (found by its address) starts and how wide it is with the
 * name; the width is kept from when the name showed, so the shorter key it falls back to does not flip it back.
 */
function useCrumbRoom(bar: RefObject<HTMLElement | null>, slug: string | null, key: string | null) {
  useLayoutEffect(() => {
    const mine = bar.current;
    if (mine === null || slug === null || key === null) return shortCrumb.set(false);
    const scope = mine.closest("header") ?? document.body;
    let full: { width: number; chars: number } | null = null;
    const measure = () => {
      const link = scope.querySelector<HTMLElement>(`a[href$="/loom/${encodeURIComponent(slug)}"]`);
      if (link === null) return;
      const box = link.getBoundingClientRect();
      if (!shortCrumb.get()) full = { width: box.width, chars: Math.max(1, (link.textContent ?? "").length) };
      if (full === null || box.width === 0) return;
      // The ticket's own crumb follows: a chevron, gaps and its key, at the name's width per character.
      const after = 36 + (key.length * full.width) / full.chars;
      shortCrumb.set(box.left + full.width + after + 8 > mine.getBoundingClientRect().left);
    };
    measure();
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(mine);
    // bb draws the crumb after the title changes, so measure again when it does.
    const redrawn = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    redrawn?.observe(scope, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", measure);
    return () => {
      resized?.disconnect();
      redrawn?.disconnect();
      window.removeEventListener("resize", measure);
      shortCrumb.set(false);
    };
  }, [bar, slug, key]);
}

export function LoomHeader({ subPath }: PluginNavPanelProps) {
  useLoomTheme();
  useStored(lastRoute);
  const narrow = useSyncExternalStore(narrowPage.subscribe, narrowPage.get, narrowPage.get);
  const navigate = useBbNavigate();
  const route = routeOf(subPath);
  const slug = route.view === "project" || route.view === "ticket" ? route.slug : null;
  const bar = useRef<HTMLSpanElement>(null);
  useCrumbRoom(bar, slug, route.view === "ticket" ? route.key : null);
  return (
    <TipProvider>
      <span ref={bar} data-loom-root data-loom-header className="inline-flex items-center gap-1.5 text-foreground">
        <Tip text="Jump to a ticket, project, view or place" keys="/">
          <button type="button" aria-keyshortcuts="/" aria-label={narrow ? "Jump to" : undefined} className={`${BAR_BUTTON} border-transparent`} onClick={() => palette.set(true)}>
            <Icon name="Search" aria-hidden className="size-3.5" />
            {!narrow && "Jump to"}
            {!narrow && <kbd className={KBD}>/</kbd>}
          </button>
        </Tip>
        {slug === null && !narrow && route.view !== "new" && (
          <button type="button" className={BAR_BUTTON} onClick={() => navigate.toPluginPanel("loom", { subPath: "_new" })}>
            <Icon name="Plus" aria-hidden className="size-3.5" />
            New project
          </button>
        )}
        {slug !== null && <ProjectControls key={slug} slug={slug} />}
      </span>
    </TipProvider>
  );
}
