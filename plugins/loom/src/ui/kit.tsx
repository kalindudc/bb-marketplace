// Loom's overlays, on the Radix primitives bb shares with plugins at run time, so they stack with bb's own and own focus,
// Escape and outside clicks. Everything portalled carries Loom's scope, so bb's stylesheet and Loom's theme layer apply.
import { cloneElement, createContext, useContext, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { experimental_Icon as Icon, experimental_usePluginId } from "@get-bb/plugin-sdk/app";

/** bb scopes a plugin's CSS to elements under [data-bb-plugin=<id>]; a portal carries the scope itself, as bb's overlays do. */
export function usePortalScope() {
  const pluginId = experimental_usePluginId();
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", "data-bb-plugin": pluginId, "data-loom-root": "" } as const;
}

const OVERLAY = "z-50 border border-border bg-popover text-popover-foreground shadow-lg outline-none";
export const KBD = "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded border border-border px-1 font-mono text-[11px] leading-none text-[var(--loom-muted)]";

/** The scrollLeft that brings `tab` wholly into `bar`'s view, with `margin` to spare; null when it is in view already. */
export function sidewaysInto(bar: Pick<DOMRect, "left" | "right">, tab: Pick<DOMRect, "left" | "right">, scrollLeft: number, margin = 16): number | null {
  if (tab.left < bar.left) return Math.max(0, scrollLeft - (bar.left - tab.left) - margin);
  if (tab.right > bar.right) return scrollLeft + (tab.right - bar.right) + margin;
  return null;
}

const TipScope = createContext(false);

export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={300}>
      <TipScope.Provider value>{children}</TipScope.Provider>
    </Tooltip.Provider>
  );
}

/** Why a control does what it does, or a cut text whole: on a pointer's rest and on keyboard focus, with the control's key. */
export function Tip({ text, keys, side = "top", children }: { text: ReactNode; keys?: string; side?: "top" | "bottom" | "left" | "right"; children: ReactElement }) {
  const scope = usePortalScope();
  const shared = useContext(TipScope);
  const root = (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content {...scope} side={side} sideOffset={6} collisionPadding={8} className={`${OVERLAY} loom-pop flex max-w-80 items-center gap-2 px-2 py-1 text-xs leading-snug`}>
          <span className="[overflow-wrap:anywhere]">{text}</span>
          {keys !== undefined && <kbd className={KBD}>{keys}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
  return shared ? root : <Tooltip.Provider delayDuration={300}>{root}</Tooltip.Provider>;
}

/**
 * A tooltip a touch can open too. A mouse resting on the trigger and keyboard focus show `text` as a Tip, and a click or
 * Enter does what the trigger does. A tap has no rest and no focus to show a tip on, so it opens `text` as a popover
 * instead and does nothing else; the popover offers the trigger's own action as a button, and Escape, a tap outside or
 * that button closes it.
 */
export function TapTip({ text, label, action, side = "top", children }: { text: ReactNode; label: string; action?: { label: string; run(): void }; side?: "top" | "bottom" | "left" | "right"; children: ReactElement<{ onClick?(event: MouseEvent): void; onPointerDown?(event: PointerEvent): void }> }) {
  const scope = usePortalScope();
  const [open, setOpen] = useState(false);
  const tapped = useRef(false);
  const trigger = cloneElement(children, {
    onPointerDown: (event: PointerEvent) => {
      tapped.current = event.pointerType === "touch" || event.pointerType === "pen";
      children.props.onPointerDown?.(event);
    },
    onClick: (event: MouseEvent) => {
      if (!tapped.current) return children.props.onClick?.(event);
      tapped.current = false;
      event.preventDefault();
      setOpen(true);
    },
  });
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tip text={text} side={side}>
        <PopoverPrimitive.Anchor asChild>{trigger}</PopoverPrimitive.Anchor>
      </Tip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content {...scope} role="dialog" aria-label={label} side="bottom" align="start" sideOffset={6} collisionPadding={8} className={`${OVERLAY} loom-pop grid max-w-[min(20rem,calc(100vw-16px))] gap-2 p-3 text-xs leading-snug`}>
          <div className="[overflow-wrap:anywhere]">{text}</div>
          {action !== undefined && (
            <button
              type="button"
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border-seam px-3 text-sm text-foreground hover:bg-state-hover"
              onClick={() => {
                setOpen(false);
                action.run();
              }}
            >
              {action.label}
            </button>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * A disclosure for an operational fact: a popover that click, Enter, Space and a tap open and Escape closes, with its
 * state on the trigger (aria-expanded). With `hover`, a mouse resting on the trigger opens it too, as a hover card, and
 * leaving closes it; focus stays where it was unless the keyboard or a click opened it.
 */
export function Disclosure({ trigger, label, children, hover = false, side = "bottom", align = "start", className = "w-80", open: shown, onOpenChange }: { trigger: ReactElement; label: string; children: ReactNode | ((close: () => void) => ReactNode); hover?: boolean; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; className?: string; open?: boolean; onOpenChange?(open: boolean): void }) {
  const scope = usePortalScope();
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const byHover = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const set = (next: boolean) => {
    setOwn(next);
    onOpenChange?.(next);
  };
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const enter = (event: { pointerType: string }) => {
    if (!hover || event.pointerType !== "mouse") return;
    clear();
    if (open) return;
    timer.current = setTimeout(() => {
      byHover.current = true;
      set(true);
    }, 380);
  };
  const leave = (event: { pointerType: string }) => {
    if (!hover || event.pointerType !== "mouse") return;
    clear();
    if (!open || !byHover.current) return;
    timer.current = setTimeout(() => set(false), 220);
  };
  const close = () => set(false);
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        clear();
        if (next) byHover.current = false;
        set(next);
      }}
    >
      <PopoverPrimitive.Trigger asChild onPointerEnter={enter} onPointerLeave={leave}>
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...scope}
          aria-label={label}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onOpenAutoFocus={(event) => {
            if (byHover.current) event.preventDefault();
          }}
          className={`${OVERLAY} loom-pop max-w-[calc(100vw-16px)] p-3 text-sm ${className}`}
        >
          {typeof children === "function" ? children(close) : children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** An open panel under a spot in the page, with no trigger of its own: the caller opens it and Escape or an outside click
 * closes it through onClose. Focus goes to initialFocus on open; the caller decides where it goes on close. */
export function AnchoredPanel({ label, onClose, initialFocus, children, className = "w-80" }: { label: string; onClose(): void; initialFocus?: () => HTMLElement | null; children: ReactNode; className?: string }) {
  const scope = usePortalScope();
  return (
    <PopoverPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <PopoverPrimitive.Anchor asChild>
        <span aria-hidden data-panel-anchor className="inline-block h-7 w-0" />
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          {...scope}
          aria-label={label}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            const target = initialFocus?.();
            if (target == null) return;
            event.preventDefault();
            target.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={`${OVERLAY} loom-pop max-w-[calc(100vw-16px)] p-3 text-sm ${className}`}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

const MENU_ROW = "flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-1.5 max-[576px]:min-h-11 pointer-coarse:min-h-11 text-left text-sm text-popover-foreground outline-none data-[highlighted]:bg-state-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-55";

/** A menu of rare actions behind a trigger: arrows move, Enter picks, Escape closes and returns focus to the trigger. */
export function Menu({ trigger, label, children, align = "end" }: { trigger: ReactElement; label: string; children: ReactNode; align?: "start" | "center" | "end" }) {
  const scope = usePortalScope();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...scope} aria-label={label} align={align} sideOffset={4} collisionPadding={8} className={`${OVERLAY} loom-pop min-w-60 max-w-[calc(100vw-16px)] p-1`}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ icon, children, onSelect, disabled = false, danger = false, hint }: { icon?: string; children: ReactNode; onSelect(): void; disabled?: boolean; danger?: boolean; hint?: string }) {
  return (
    <DropdownMenu.Item disabled={disabled} title={hint} className={MENU_ROW} onSelect={() => onSelect()}>
      {icon !== undefined && <Icon name={icon} aria-hidden className={`size-4 shrink-0 ${danger ? "text-destructive" : "text-[var(--loom-muted)]"}`} />}
      <span className="min-w-0 flex-1">{children}</span>
      {hint !== undefined && disabled && <span className="sr-only">{hint}</span>}
    </DropdownMenu.Item>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-border" />;

/** A modal sheet: the palette and the keys sheet. Escape and a click outside close it; focus returns to where it was. */
export function Sheet({ open, onOpenChange, label, children, className = "", initialFocus }: { open: boolean; onOpenChange(open: boolean): void; label: string; children: ReactNode; className?: string; initialFocus?: () => HTMLElement | null }) {
  const scope = usePortalScope();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay {...scope} className="fixed inset-0 z-50 bg-black/35" style={{ animation: "loom-fade-in 120ms ease-out both" }} />
        <DialogPrimitive.Content
          {...scope}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const target = initialFocus?.();
            if (target == null) return;
            event.preventDefault();
            target.focus();
          }}
          className={`${OVERLAY} loom-pop fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[76vh] w-[min(600px,calc(100vw-24px))] flex-col ${className}`}
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
