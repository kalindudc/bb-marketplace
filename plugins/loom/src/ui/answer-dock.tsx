// The answer region of Home's phone reader: the controls that answer an item (Release draft, Confirm merge, the ask's
// current step, Resume) render there, in thumb reach, through a portal, armed state and all. Anywhere without a dock
// (the ticket pane, Planner, Home on a wide page) they render where they are.
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const DockContext = createContext<HTMLElement | null>(null);

export const AnswerDockProvider = DockContext.Provider;

/** Its children in the answer dock when there is one, with `label` before them; in place otherwise. */
export function Docked({ label, children }: { label?: string; children: ReactNode }) {
  const dock = useContext(DockContext);
  if (dock === null) return <>{children}</>;
  return createPortal(
    <div data-docked className="flex flex-wrap items-center gap-2">
      {label !== undefined && <span className="w-full text-xs font-semibold text-[var(--loom-muted)]">{label}</span>}
      {children}
    </div>,
    dock,
  );
}
