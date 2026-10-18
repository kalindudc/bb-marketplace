import type { FocusEvent, ReactElement, ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

// `bb plugin build` defines `__BB_PLUGIN_ID__`; tests run without it.
declare const __BB_PLUGIN_ID__: string | undefined;

// Plugin Tailwind utilities apply only under these attributes, and a portalled tooltip renders outside the plugin root.
function portalScopeProps(): { "data-bb-portaled-overlay": ""; "data-bb-plugin-root": ""; "data-bb-plugin"?: string } {
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", ...(pluginId === undefined ? {} : { "data-bb-plugin": pluginId }) };
}

// Focus that a closing panel or menu hands back to the button after a click must not leave the hint showing.
let lastInput: "key" | "pointer" = "key";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInput = "key"; }, { capture: true, passive: true });
  window.addEventListener("pointerdown", () => { lastInput = "pointer"; }, { capture: true, passive: true });
}

function keyboardFocusOnly(event: FocusEvent<HTMLElement>): void {
  if (lastInput === "pointer") event.preventDefault();
}

export function Hint({ label, children, side = "bottom" }: {
  label: ReactNode; children: ReactElement; side?: "top" | "right" | "bottom" | "left";
}) {
  return <Tooltip.Provider delayDuration={300} skipDelayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild onFocus={keyboardFocusOnly}>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content {...portalScopeProps()} side={side} sideOffset={6} collisionPadding={8}
          className="z-50 max-w-64 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}
