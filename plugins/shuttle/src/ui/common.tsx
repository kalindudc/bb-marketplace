import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { initials } from "./format";

/**
 * bb scopes a plugin's CSS to elements under [data-bb-plugin=<id>], so anything portalled to
 * document.body loses every class bb's own stylesheet lacks (such as size-[22px]) unless it
 * carries the scope itself, as bb's own overlays do.
 */
export function usePortalScope() {
  const pluginId = experimental_usePluginId();
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": pluginId } as const;
}

export const BUTTON = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const BUTTON_PRIMARY = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-primary bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const BUTTON_GHOST = "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const ICON_BUTTON = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const ICON_GHOST = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50";
export const FIELD = "rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";
export const HEADING = "text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";
export const CARD = "rounded-lg border border-border bg-card";

export type Tone = "neutral" | "ok" | "bad" | "warn" | "info" | "brand";
const TONES: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  ok: "border-success/40 bg-success/10 text-success",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
  warn: "border-warning/40 bg-warning/10 text-warning-text",
  info: "border-primary/40 bg-primary/10 text-primary",
  brand: "border-ring/40 bg-ring/10 text-foreground",
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
    <span title={name} aria-label={name} className={`inline-flex shrink-0 items-center justify-center rounded-md bg-muted font-mono font-bold text-foreground ${large ? "h-6 w-8 text-[11px]" : "h-5 w-6 text-[10px]"}`}>
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
      className={`relative inline-flex h-[17px] w-[30px] shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 ${on ? "bg-primary" : "bg-muted"}`}
    >
      <span className={`absolute top-[2px] size-[13px] rounded-full transition-[left] ${on ? "left-[15px] bg-primary-foreground" : "left-[2px] bg-foreground"}`} />
    </button>
  );
}

export function Checkbox({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange(next: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary" />
      <span>
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

/** A plain modal: Escape and a click on the backdrop close it. */
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
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 px-4 py-14" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`w-full ${wide ? "max-w-3xl" : "max-w-xl"} rounded-xl border border-border bg-card text-foreground shadow-lg focus:outline-none`}>
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {leading}
            <h3 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h3>
            <button type="button" aria-label="Close" className={ICON_GHOST} onClick={onClose}>
              <Icon name="X" className="size-4" aria-hidden />
            </button>
          </div>
          {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <div className="px-4 py-3">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A dropdown in bb's shared Radix menu: it renders in a portal above the page, so a scrolling
 * drawer cannot clip it, and it stacks with bb's own overlays.
 */
export function Menu({ trigger, label, align = "right", children }: {
  trigger: ReactNode;
  label: string;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const scope = usePortalScope();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-r-md border border-l-0 border-border bg-card px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...scope} aria-label={label} align={align === "right" ? "end" : "start"} sideOffset={4} collisionPadding={8}
          className="z-50 flex w-72 flex-col rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export const MenuItem = DropdownMenu.Item;
export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 border-t border-border" />;

export const MENU_ITEM = "flex w-full cursor-pointer flex-col items-start rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

export function SectionTitle({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <h4 className={`${HEADING} mb-2 flex items-center gap-1.5`}>
      {icon && <Icon name={icon} className="size-3" aria-hidden />}
      {children}
    </h4>
  );
}
