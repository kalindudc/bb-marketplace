import type { FocusEvent, ReactElement, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { portalScopeProps } from "./portal-scope";

// A hint opens on focus only after keyboard input. Focus a menu or dialog hands
// back to its trigger after a click would otherwise leave a hint showing with
// the pointer elsewhere; Chrome can count that returned focus as :focus-visible.
let lastInput: "key" | "pointer" = "key";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInput = "key"; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInput = "pointer"; }, { capture: true, passive: true });
}

export function keyboardFocusOnly(event: FocusEvent<HTMLElement>): void {
  if (lastInput === "pointer") event.preventDefault();
}

export function Hint({ label, children, side = "bottom" }: {
  label: ReactNode; children: ReactElement; side?: "top" | "right" | "bottom" | "left";
}) {
  return <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild onFocus={keyboardFocusOnly}>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content {...portalScopeProps()} side={side} sideOffset={6} collisionPadding={8}
          className="sb-hint z-50 max-w-64 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}
