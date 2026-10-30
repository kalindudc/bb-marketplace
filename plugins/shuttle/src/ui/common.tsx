import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { initials } from "./format";
import { useViewport } from "./viewport";

/**
 * bb scopes a plugin's CSS to elements under [data-bb-plugin=<id>], so anything portalled to
 * document.body loses every class bb's own stylesheet lacks (such as size-[22px]) unless it
 * carries the scope itself, as bb's own overlays do.
 */
export function usePortalScope() {
  const pluginId = experimental_usePluginId();
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": pluginId } as const;
}

// The button vocabulary of bb's own Button: outline, the main action in --foreground (bb fills nothing with --primary), and ghost.
// Tailwind orders utilities in its stylesheet, not by their order in className, so a class added after one of these never
// reliably beats one it already sets: each kind, size and state is a style of its own (test/ui/class-overrides.test.ts).
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
const FRAME = `inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md ${FOCUS}`;
const SMALL = "h-7 px-2.5 text-xs";
export const BUTTON = `${FRAME} ${SMALL} border border-input bg-transparent text-foreground hover:bg-state-hover`;
/** A pressed toggle, or the current one of a few choices. */
export const BUTTON_ON = `${FRAME} ${SMALL} border border-input bg-state-active text-foreground`;
/** A toggle that is off: a button's size without its outline. */
export const BUTTON_OFF = `${FRAME} ${SMALL} border border-transparent bg-transparent text-foreground hover:bg-state-hover`;
/** An outline button that removes, archives or deletes. */
export const BUTTON_DANGER = `${FRAME} ${SMALL} border border-destructive/40 bg-transparent text-destructive-text hover:bg-surface-destructive`;
export const BUTTON_PRIMARY = `${FRAME} ${SMALL} border border-foreground bg-foreground font-medium text-background hover:bg-foreground/90`;
/** The main action at the foot of a long form, such as posting a review. */
export const BUTTON_PRIMARY_LARGE = `${FRAME} h-8 px-3 text-[13px] border border-foreground bg-foreground font-medium text-background hover:bg-foreground/90`;
/** A main action that is a go-ahead, such as Merge or Approve. */
export const BUTTON_SUCCESS = `${FRAME} ${SMALL} border border-success bg-success font-medium text-background hover:bg-success/90`;
export const BUTTON_GHOST = `${FRAME} h-7 px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground`;
/** A ghost button in a tight row, such as a log's Copy. */
export const BUTTON_GHOST_SMALL = `${FRAME} h-6 px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground`;
export const BUTTON_GHOST_DANGER = `${FRAME} h-7 px-2 text-xs text-destructive-text hover:bg-surface-destructive`;
const ICON_FRAME = `inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md ${FOCUS}`;
const ICON_TONE = "text-muted-foreground hover:bg-state-hover hover:text-foreground";
export const ICON_GHOST = `${ICON_FRAME} size-7 ${ICON_TONE}`;
/** An icon button in a phone's top bar, a thumb's size. */
export const ICON_GHOST_LARGE = `${ICON_FRAME} size-9 ${ICON_TONE}`;
export const ICON_GHOST_LARGE_ON = `${ICON_FRAME} size-9 bg-state-active text-foreground hover:bg-state-hover`;
/** An icon button inside a line of text, such as copying a branch name. */
export const ICON_GHOST_SMALL = `${ICON_FRAME} size-5 ${ICON_TONE}`;
const FIELD_FRAME = "rounded-md border border-input bg-background px-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";
export const FIELD = `${FIELD_FRAME} py-1.5 text-sm`;
/** A field for code or commands, in the smaller monospace text. */
export const FIELD_CODE = `${FIELD_FRAME} py-1.5 font-mono text-xs`;
/** A select in a toolbar, as tall as the buttons beside it. */
export const FIELD_SMALL = `${FIELD_FRAME} h-7 py-0 text-xs`;
export const HEADING = "text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";
export const CARD = "rounded-lg border border-border bg-card";
export const CARD_SELECTED = "rounded-lg border border-surface-selected-border bg-card";
/** A form label that opens its section, without the gap above the others. */
export const LABEL_FIRST = "mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";

export type Tone = "neutral" | "ok" | "bad" | "warn" | "info" | "brand";
const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface-recessed text-muted-foreground",
  ok: "border-success/25 bg-success/5 text-success",
  bad: "border-surface-destructive-border bg-surface-destructive text-destructive-text",
  warn: "border-warning/20 bg-warning/5 text-warning-text",
  info: "border-border bg-surface-raised text-foreground",
  brand: "border-border bg-surface-raised text-foreground",
};

type NextTone = "ok" | "bad" | "warn" | "info" | "neutral";
export const TONE_TEXT: Record<NextTone, string> = {
  ok: "text-success",
  bad: "text-destructive-text",
  warn: "text-warning-text",
  info: "text-foreground",
  neutral: "text-muted-foreground",
};
/** A card's coloured left edge. */
export const TONE_EDGE: Record<NextTone, string> = {
  ok: "border-l-success",
  bad: "border-l-destructive",
  warn: "border-l-warning",
  info: "border-l-foreground",
  neutral: "border-l-muted-foreground",
};
/** A banner's tinted border and background. */
export const TONE_PANEL: Record<NextTone, string> = {
  ok: "border-success/25 bg-success/5",
  bad: "border-surface-destructive-border bg-surface-destructive",
  warn: "border-warning/20 bg-warning/5",
  info: "border-border bg-surface-raised",
  neutral: "border-border bg-card",
};

export function Pill({ tone = "neutral", icon, title, children }: { tone?: Tone; icon?: string; title?: string; children: ReactNode }) {
  return (
    <span data-pill={tone} title={title} className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11.5px] leading-none ${TONES[tone]}`}>
      {icon && <Icon name={icon} fallback="Circle" className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

export function ServerBadge({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span title={name} aria-label={name} className={`inline-flex shrink-0 items-center justify-center rounded-md bg-surface-recessed font-mono font-bold text-foreground ${large ? "h-6 w-8 text-[11px]" : "h-5 w-6 text-[10px]"}`}>
      {initials(name)}
    </span>
  );
}

export function Toggle({ on, label, onChange, disabled = false }: { on: boolean; label: string; onChange(next: boolean): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-[17px] w-[30px] shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 ${on ? "border border-foreground bg-foreground" : "border border-input bg-muted"}`}
    >
      {/* The knob sits inside the border in both states, so it does not move when the colour does. */}
      <span className={`absolute top-px size-[13px] rounded-full transition-[left] ${on ? "left-[14px] bg-background" : "left-px bg-muted-foreground"}`} />
    </button>
  );
}

export function Checkbox({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange(next: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4 shrink-0 cursor-pointer accent-foreground" />
      <span>
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-text">
      {children}
    </div>
  );
}

/** A plain modal: Escape and a click on the backdrop close it. On a phone it is a sheet from the bottom. */
export function Dialog({ title, subtitle, leading, onClose, footer, children, wide = false }: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  onClose(): void;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const phone = useViewport() === "phone";
  const scope = usePortalScope();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // bb's "Back to app" and the PR panel also listen for Escape; the dialog on top owns it.
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const head = (
    <div className={phone ? "px-4 pb-2 pt-1" : "border-b border-border px-4 py-3"}>
      <div className="flex items-center gap-2">
        {leading}
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h3>
        <button type="button" aria-label="Close" className={ICON_GHOST} onClick={onClose}>
          <Icon name="X" className="size-4" aria-hidden />
        </button>
      </div>
      {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
    </div>
  );
  if (phone) {
    // In a portal, like bb's own sheets, so no scrolling or transformed ancestor can clip it.
    return createPortal(
      <div {...scope} className="fixed inset-0 z-50">
        <div data-scrim className="absolute inset-0 bg-background/70" onClick={onClose} />
        <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
          className="absolute inset-x-0 bottom-0 flex max-h-[86vh] flex-col rounded-t-2xl border-t border-border bg-card text-foreground shadow-lg animate-in slide-in-from-bottom duration-200 focus:outline-none">
          <div aria-hidden className="mx-auto mb-1 mt-2 h-1 w-10 shrink-0 rounded-full bg-muted" />
          {head}
          <div className="min-h-0 overflow-y-auto px-4 pb-3">{children}</div>
          {footer && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 pb-5 pt-3">{footer}</div>}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 px-4 py-14" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-xl"} rounded-xl border border-border bg-card text-foreground shadow-lg focus:outline-none`}>
        {head}
        <div className="px-4 py-3">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** One of a few choices, as in Fix it / Just tell it / Off. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T;
  options: readonly { value: NoInfer<T>; label: string; icon?: string; disabled?: boolean }[];
  onChange(next: NoInfer<T>): void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 rounded-lg border border-border bg-background p-0.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} disabled={disabled || option.disabled} onClick={() => !on && onChange(option.value)}
            className={`inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs disabled:cursor-default disabled:opacity-50 ${on ? "bg-state-active font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover hover:text-foreground"}`}>
            {option.icon && <Icon name={option.icon} fallback="Circle" className="size-3.5" aria-hidden />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A choice in a dialog's list of choices. */
export function Choice({ on, disabled = false, title, hint, onPick, trailing }: { on: boolean; disabled?: boolean; title: ReactNode; hint?: ReactNode; onPick(): void; trailing?: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-disabled={disabled || undefined} onClick={() => !disabled && onPick()}
      className={`mb-1.5 flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm ${disabled ? "cursor-default opacity-50" : "cursor-pointer"} ${on ? "border-surface-selected-border bg-surface-selected" : `border-border ${disabled ? "" : "hover:bg-state-hover"}`}`}>
      <span aria-hidden className={`mt-0.5 size-3.5 shrink-0 rounded-full border-[1.5px] ${on ? "border-4 border-foreground" : "border-muted-foreground"}`} />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      {trailing}
    </button>
  );
}

/** A small uppercase label above a group of fields. */
export const LABEL = "mb-1.5 mt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";

export function SectionTitle({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <h4 className={`${HEADING} mb-2 flex items-center gap-1.5`}>
      {icon && <Icon name={icon} className="size-3" aria-hidden />}
      {children}
    </h4>
  );
}

export function PageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="mb-2.5 flex flex-wrap items-start gap-2.5">
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** An area's page, at most 900px wide. */
/** A page fills the area beside bb's sidebar; its sections choose their columns from its width (a container), not the window's. */
export const PAGE = "@container w-full px-4 pb-10 pt-4 sm:px-5";
/** Card columns: one in a narrow area, two from 64rem, three from 110rem. */
export const CARD_GRID = "grid items-stretch gap-2.5 @5xl:grid-cols-2 @[110rem]:grid-cols-3";

const CONTROLS = "button, a, input, textarea, select, label, [role=menuitem], [role=option]";

/** A click on a card opens its PR, unless it landed on one of its controls or came from a menu portalled out of it. */
export function onCardClick(open: () => void) {
  return (event: { target: EventTarget; currentTarget: HTMLElement }) => {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || target.closest(CONTROLS) !== null) return;
    // Selecting a title or a reason to copy it is not a click.
    if (window.getSelection()?.toString()) return;
    open();
  };
}
export const STRIP = "my-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs";

/**
 * The PR open in the panel. Cards and rows share one tint and a ring in the primary colour, so the open
 * PR stands out on every page and never looks like a hovered one, which only gets the accent colour.
 */
const SELECTED_TINT = "bg-surface-selected";
export const SELECTED_CARD = `${SELECTED_TINT} shadow-[0_0_0_2px_var(--surface-selected-border)]`;
export const SELECTED_ROW = `${SELECTED_TINT} shadow-[inset_3px_0_0_var(--primary),inset_0_0_0_1px_var(--surface-selected-border)]`;

/** A titled part of a PR view's tab, such as People or Open threads, in sentence case. */
export function PaneSection({ title, label = title, count, aside, className = "mb-6", children }: {
  title: string;
  label?: string;
  count?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={className}>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {count}
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  );
}
