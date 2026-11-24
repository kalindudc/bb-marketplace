import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PluginBrowserBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { InfoCardBody } from "./info-card-body";
import { portalScopeProps } from "./portal-scope";
import type { InfoCardMode } from "./settings";
import { infoPlacement, sidebarScrollParent } from "./sidebar-viewport";
import { rowState } from "./status";

type Position = ReturnType<typeof infoPlacement> & { anchorTop: number };

export function ThreadInspector({ thread, opener, sidebar, fallback, onDismiss, projectName, stale, now, mode, sdk, location,
  compact: sidebarCompact, allowFocusReturn }: {
  thread: PluginSidebarThread;
  opener: { trigger: HTMLButtonElement };
  sidebar: RefObject<HTMLElement | null>;
  fallback: RefObject<HTMLInputElement | null>;
  onDismiss(): void;
  projectName: string;
  stale: boolean;
  now: number;
  mode: Exclude<InfoCardMode, "off">;
  sdk: PluginBrowserBbSdk;
  location: string;
  compact: boolean;
  allowFocusReturn: RefObject<boolean>;
}) {
  const { trigger } = opener;
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const restoreRequested = useRef(false);
  const [position, setPosition] = useState<Position | null>(null);
  const positioned = position !== null;
  const compact = sidebarCompact || (positioned && !position.fitsBeside);
  const closeFromDetails = () => {
    restoreRequested.current = true;
    onDismiss();
  };
  useLayoutEffect(() => {
    const list = sidebar.current;
    if (!list) return;
    const scroller = sidebarScrollParent(list) ?? list;
    const measure = () => {
      const next = {
        ...infoPlacement(scroller.getBoundingClientRect(), window.innerWidth, window.innerHeight),
        anchorTop: trigger.getBoundingClientRect().top,
      };
      setPosition(current => current && (Object.keys(next) as (keyof Position)[])
        .every(key => current[key] === next[key]) ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    if (scroller !== list) observer?.observe(list);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [sidebar, trigger]);

  useLayoutEffect(() => {
    if (!positioned) return;
    const dialog = dialogRef.current!;
    restoreRequested.current = false;
    const escapeOutside = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onDismiss();
    };
    if (compact) {
      if (!dialog.open) dialog.showModal();
    } else window.addEventListener("keydown", escapeOutside);
    return () => {
      window.removeEventListener("keydown", escapeOutside);
      const active = document.activeElement;
      if (!restoreRequested.current && !dialog.contains(active)) return;
      // Removing the modal from the DOM avoids the browser's implicit focus return on close().
      queueMicrotask(() => {
        if (!allowFocusReturn.current || dialogRef.current?.open ||
            (document.activeElement !== active && document.activeElement !== document.body)) return;
        const target = trigger.isConnected ? trigger : fallback.current;
        target?.focus({ preventScroll: true });
        if (document.activeElement !== target) fallback.current?.focus({ preventScroll: true });
      });
    };
  }, [positioned, compact, trigger, fallback, onDismiss, allowFocusReturn]);
  useLayoutEffect(() => {
    if (positioned) titleRef.current?.focus({ preventScroll: true });
  }, [positioned, compact, opener]);

  if (!position) return null;
  const style: CSSProperties & Record<`--switchboard-inspector-${string}`, string> = {
    "--switchboard-inspector-left": `${compact ? position.left : position.besideLeft}px`,
    "--switchboard-inspector-top": `${compact ? position.top : position.anchorTop}px`,
    "--switchboard-inspector-width": `${compact ? position.width : position.besideWidth}px`,
    "--switchboard-inspector-height": `${position.height}px`,
  };
  const details = <dialog ref={dialogRef} aria-labelledby={titleId} aria-modal={compact || undefined}
    open={!compact || undefined} data-switchboard-inspector-compact={compact ? "" : undefined} style={style}
    {...(compact ? {} : portalScopeProps())}
    className={`switchboard-info-card switchboard-info-${mode} switchboard-inspector`}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); closeFromDetails(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); closeFromDetails(); }
    }}>
    <div className="switchboard-inspector-header">
      <span>Thread details</span>
      <h2 ref={titleRef} id={titleId} tabIndex={-1} className="switchboard-info-title">{thread.displayTitle}</h2>
      <button type="button" aria-label="Close details" onClick={closeFromDetails}
        className="switchboard-control switchboard-icon-button switchboard-inspector-close">
        <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5">
          <path d="m4 4 8 8m0-8-8 8" />
        </svg>
      </button>
    </div>
    <InfoCardBody thread={thread} state={rowState(thread)} projectName={projectName} stale={stale}
      now={now} mode={mode} sdk={sdk} location={location} />
  </dialog>;
  return compact ? details : createPortal(details, document.body);
}
