import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { BUTTON } from "./common";

/** A phone's menu: a sheet from the bottom with a handle, a title and Done. Escape and the scrim close it. */
function BottomSheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // bb's "Back to app" also listens for Escape; this sheet owns it while open.
      event.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // In a portal, like bb's own menus, so no scrolling or transformed ancestor can clip it.
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div data-scrim className="absolute inset-0 bg-background/70" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 flex max-h-[78vh] flex-col rounded-t-2xl border-t border-border bg-card text-foreground shadow-lg animate-in slide-in-from-bottom duration-200">
        <div aria-hidden className="mx-auto mb-1 mt-2 h-1 w-10 rounded-full bg-muted" />
        <div className="flex items-center gap-2 px-3 pb-2 pt-1">
          <b id={titleId} className="flex-1 text-sm">{title}</b>
          <button type="button" className={BUTTON} onClick={onClose}>Done</button>
        </div>
        <div className="min-h-0 overflow-y-auto px-1 pb-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

interface PickerContext {
  mode: "menu" | "sheet";
  close(): void;
}
const Context = createContext<PickerContext>({ mode: "menu", close: () => {} });

/**
 * A menu of choices: bb's Radix dropdown in a portal on a desktop, a bottom sheet on a phone.
 * The children mount only while it is open, so they can load what they offer then.
 */
export function Picker({ phone, title, trigger, triggerClassName, triggerLabel, disabled = false, disabledReason, align = "end", children }: {
  phone: boolean;
  title: string;
  trigger: ReactNode;
  triggerClassName: string;
  triggerLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const label = triggerLabel ?? title;
  if (phone) {
    return (
      <>
        <button type="button" aria-label={label} aria-haspopup="dialog" disabled={disabled} title={disabled ? disabledReason : undefined} className={triggerClassName} onClick={() => setOpen(true)}>
          {trigger}
        </button>
        {open && (
          <BottomSheet title={title} onClose={() => setOpen(false)}>
            <Context.Provider value={{ mode: "sheet", close: () => setOpen(false) }}>
              <div role="menu" aria-label={title}>{children}</div>
            </Context.Provider>
          </BottomSheet>
        )}
      </>
    );
  }
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" aria-label={label} title={disabled ? disabledReason : undefined} className={triggerClassName}>{trigger}</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={4} collisionPadding={8}
          className="z-50 flex max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-80 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <Context.Provider value={{ mode: "menu", close: () => setOpen(false) }}>{children}</Context.Provider>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const ROW = "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent data-[highlighted]:bg-accent data-[disabled]:cursor-default data-[disabled]:opacity-60 disabled:cursor-default disabled:opacity-60";

function Box({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={`inline-flex size-4 shrink-0 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
      {checked && <Icon name="Check" className="size-3" />}
    </span>
  );
}

/** A row that toggles one choice; the picker stays open for the next. */
export function PickerCheckbox({ checked, disabled = false, onToggle, children }: { checked: boolean; disabled?: boolean; onToggle(): void; children: ReactNode }) {
  const { mode } = useContext(Context);
  if (mode === "menu") {
    return (
      <DropdownMenu.CheckboxItem checked={checked} disabled={disabled} className={ROW} onSelect={(event) => { event.preventDefault(); onToggle(); }}>
        <Box checked={checked} />
        {children}
      </DropdownMenu.CheckboxItem>
    );
  }
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} disabled={disabled} className={ROW} onClick={onToggle}>
      <Box checked={checked} />
      {children}
    </button>
  );
}

/** A row that does one thing; it closes the picker unless `keepOpen`. */
export function PickerAction({ onSelect, keepOpen = false, className = "", children }: { onSelect(): void; keepOpen?: boolean; className?: string; children: ReactNode }) {
  const { mode, close } = useContext(Context);
  if (mode === "menu") {
    return (
      <DropdownMenu.Item className={`${ROW} ${className}`} onSelect={(event) => { if (keepOpen) event.preventDefault(); onSelect(); }}>
        {children}
      </DropdownMenu.Item>
    );
  }
  return (
    <button type="button" role="menuitem" className={`${ROW} ${className}`} onClick={() => { onSelect(); if (!keepOpen) close(); }}>
      {children}
    </button>
  );
}

export function PickerGroup({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</div>;
}

export function PickerSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />;
}

/** The filter at the top of a picker. In a Radix menu, typing would otherwise jump focus to a matching row. */
export function PickerFilter({ label, value, onChange }: { label: string; value: string; onChange(next: string): void }) {
  return (
    <label className="mx-1.5 mb-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
      <Icon name="Search" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input aria-label={label} placeholder={label} value={value} autoFocus onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }}
        className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground" />
    </label>
  );
}
