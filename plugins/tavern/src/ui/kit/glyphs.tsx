import { useEffect, useId, useRef, useState, type ReactNode, Fragment, memo } from "react";

// Tavern's own line glyphs: square caps and mitred joins, drawn in currentColor so every theme colours them.
const PATHS = {
  check: "M4 12.5 9.5 18 20 6.5",
  play: "M8 5.5v13l10-6.5Z",
  block: "M5 12h14M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  undo: "M9 4.75 4.5 9.25 9 13.75M5 9.25h9.5a5 5 0 0 1 0 10H11",
  redo: "M15 4.75l4.5 4.5L15 13.75M19 9.25H9.5a5 5 0 0 0 0 10H13",
  sweep: "M4 20h16M7 20l2-9h6l2 9M10 11V4h4v7",
  plus: "M12 5v14M5 12h14",
  chevron: "M9 6l6 6-6 6",
  link: "M6 5v7a3 3 0 0 0 3 3h9M14 11l4 4-4 4",
  close: "M6 6l12 12M18 6 6 18",
  panel: "M4 5h16v14H4ZM14 5v14",
  list: "M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1",
  book: "M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4ZM20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6Z",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20.5h4",
  route: "M4 19a2 2 0 1 0 0-.01M16 5a2 2 0 1 0 0-.01M4 17V9a3 3 0 0 1 3-3h4M16 7v8a3 3 0 0 1-3 3h-4",
  pin: "M9 4h6l-1 6 3 3H7l3-3ZM12 13v7",
  seal: "M12 2.5l2.4 1.8 3-.1.9 2.8 2.4 1.8-.9 2.8.9 2.8-2.4 1.8-.9 2.8-3-.1L12 21.5l-2.4-1.8-3 .1-.9-2.8-2.4-1.8.9-2.8-.9-2.8 2.4-1.8.9-2.8 3 .1Z",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  edit: "M5 19h4L19.5 8.5l-4-4L5 15Z",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13",
  hide: "M4 4l16 16M9.9 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.4M6.4 7.6A16 16 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 3.4-.7",
  // Tavern ideas, from icons/*.svg (see icons/README.md). wax-seal is for under 28 px, wax-seal-large from 28 px.
  "board-quest": "M5.5 6.875h13v14h-13ZM12 3.125v6.5M9.5 3.125h5M8.5 13.375h7M8.5 16.875h4.5",
  "journal": "M3.5 5.5 5.5 7.5 9 4M12.5 6h8M3.5 11.5 5.5 13.5 9 10M12.5 12h8M4 16h4v4H4ZM12.5 18h8",
  "quest-map": "M3 5.5 9 3l6 2.5L21 3v15.5L15 21l-6-2.5L3 21ZM9 3v15.5M15 5.5V21",
  "ask": "M3.5 3h17v14h-8.5l-4.5 4v-4h-4ZM9.75 7.75V6.25h4.5V9.5L12 11v1.25M12 14.25v.01",
  "decided": "M12 21.5V2.5M12 4.5h6.5l2.5 2.75-2.5 2.75H12M12 12.5H5.5L3 15.25 5.5 18H12",
  "party": "M14.5 8v-5h-11v6c0 3.2 2 5.6 5 7.1M9.5 8h11v5.5c0 3.4-2.3 5.9-5.5 7.5-3.2-1.6-5.5-4.1-5.5-7.5Z",
  "ledger": "M5 3h14v18H5ZM8.5 3v18M11.5 8h4.5M11.5 12h4.5M11.5 16h4.5",
  "report": "M5.5 2.5h9l4 4v15h-13ZM14.5 2.5v4h4M8.5 11h7M8.5 14.5h7M8.5 18h4",
  "wax-seal": "M18.5 9.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 1 1 13 0ZM9.25 15.4 7.75 21M14.75 15.4 16.25 21M9.75 7h4.5v2.25c0 1.3-.9 2.3-2.25 2.9-1.35-.6-2.25-1.6-2.25-2.9Z",
  "wax-seal-large": "M14.77 4.56A3.3 3.3 0 0 1 19.01 8.12A3.3 3.3 0 0 1 19.98 13.58A3.3 3.3 0 0 1 17.21 18.37A3.3 3.3 0 0 1 12 20.27A3.3 3.3 0 0 1 6.79 18.37A3.3 3.3 0 0 1 4.02 13.58A3.3 3.3 0 0 1 4.99 8.12A3.3 3.3 0 0 1 9.23 4.56A3.3 3.3 0 0 1 14.77 4.56ZM9.75 9.17h4.5v2.25c0 1.3-.9 2.3-2.25 2.9-1.35-.6-2.25-1.6-2.25-2.9Z",
  "tick": "M2.5 12.5h4.5l2.5-7 4 13 2.5-6h5.5",
  "side-quest": "M7.5 21.5V2.5M7.5 15.5l8-8M11.5 6.5h5v5",
  "verified": "M12 2.5 21.5 12 12 21.5 2.5 12ZM8 12.25l2.75 2.75L16 9.75",
  "rejected": "M12 2.5 21.5 12 12 21.5 2.5 12ZM9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5",
  "pause": "M9 5.5v13M15 5.5v13",
  "gate": "M4 20.25V3.75M20 20.25V3.75M2.5 4.25h19M2.5 7.75h19M7 11.75h10M7 15.75h10",
  // State marks (StateMark), drawn as the page drew them.
  // Work and busy: a ring half filled, the still "in progress" mark. An open arc read as a spinner that had frozen.
  "st-work": "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
  "st-wait": "M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5-8 8.5s8 3.5 8 8.5",
  "st-fail": "M4.5 4.5h15v15h-15ZM8.5 8.5l7 7M15.5 8.5l-7 7",
  "st-stale": "M12 4v9M12 17.5v2",
  "st-none": "M7 12h10",
  "st-idle": "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  "st-busy": "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
  "archive": "M3.5 4.5h17v4.5h-17ZM5 9v10.5h14V9M10 13h4",
} as const;
export type GlyphName = keyof typeof PATHS;

/** Solid parts drawn under a glyph's lines, for marks whose meaning is a filled area. */
const FILLS: Partial<Record<GlyphName, string>> = { "st-work": "M12 6.75a5.25 5.25 0 0 1 0 10.5Z", "st-busy": "M12 6.75a5.25 5.25 0 0 1 0 10.5Z" };

export const Glyph = memo(function Glyph({ name, size = 14, className = "" }: { name: GlyphName; size?: number; className?: string }) {
  const dots = name === "more";
  const fill = FILLS[name];
  return (
    <svg className={`tavern-glyph ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={dots ? 3.2 : 1.9} strokeLinecap="square" strokeLinejoin="miter">
      {fill && <path d={fill} fill="currentColor" stroke="none" />}
      <path d={PATHS[name]} />
    </svg>
  );
});

/** Trailing mark on a control that opens something elsewhere: a thread, a tab or a page. */
export const OpensMark = memo(function OpensMark() { return <Glyph name="chevron" size={11} className="act-i" />; });
/** Trailing mark on a control that expands something in place; it turns up while open. */
export function ExpandsMark({ open }: { open: boolean }) { return <Glyph name="chevron" size={11} className={`act-i ${open ? "up" : "down"}`} />; }

/** A small icon button with a visible tooltip name; `label` is the accessible name. */
export function IconButton({ glyph, label, onClick, disabled, className = "", pressed, expanded, controls, children }: { glyph: GlyphName; label: string; onClick?: () => void; disabled?: boolean; className?: string; pressed?: boolean; expanded?: boolean; controls?: string; children?: ReactNode }) {
  return (
    <button type="button" className={`ibtn ${className}`} aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
      <Glyph name={glyph} />
      {children}
    </button>
  );
}

/** `content` draws a rich row in place of the glyph and label; `label` stays its accessible name. `divider` draws a separator above the row. */
export type MenuItem = { id: string; label: string; glyph?: GlyphName; disabled?: boolean; danger?: boolean; run: () => void; content?: ReactNode; title?: string; divider?: boolean };

/** An overflow menu: a real menu button, arrow keys between items, Escape and outside clicks close it and return focus. */
export function OverflowMenu({ label, items, glyph = "more", className = "", align = "end", trigger, triggerClassName }: { label: string; items: MenuItem[]; glyph?: GlyphName; className?: string; align?: "start" | "end"; trigger?: ReactNode; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const enabled = items.filter(i => !i.disabled);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const away = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  return (
    <span className={`menu-anchor ${className}`}>
      <button ref={button} type="button" className={trigger ? triggerClassName ?? "menu-trigger" : "ibtn"} aria-label={trigger ? undefined : label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={enabled.length === 0}
        onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        {trigger ?? <Glyph name={glyph} />}
      </button>
      {open && (
        <div ref={list} id={id} role="menu" aria-label={label} className={`tavern-menu ${align}`}
          onKeyDown={e => {
            const nodes = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
            const at = nodes.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === "ArrowDown" ? (at + 1) % nodes.length : e.key === "ArrowUp" ? (at - 1 + nodes.length) % nodes.length : e.key === "Home" ? 0 : e.key === "End" ? nodes.length - 1 : null;
            if (next !== null) { e.preventDefault(); nodes[next]?.focus(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            if (e.key === "Tab") setOpen(false);
          }}>
          {items.map(item => (
            <Fragment key={item.id}>
              {item.divider && <div role="separator" className="menu-sep" />}
              <button type="button" role="menuitem" disabled={item.disabled} className={`${item.danger ? "danger" : ""} ${item.content ? "rich" : ""}`} aria-label={item.content ? item.label : undefined} title={item.title} onClick={() => { close(); item.run(); }}>
                {item.content ?? <>{item.glyph ? <Glyph name={item.glyph} /> : <span className="gap" />}<span>{item.label}</span></>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
}
