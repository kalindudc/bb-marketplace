import { useSyncExternalStore } from "react";

type Viewport = "phone" | "narrow" | "wide";

/** bb's own compact breakpoint; below it the page is one column and menus become bottom sheets. */
const PHONE = "(max-width: 767px)";
/** Below Tailwind's xl the PR panel slides over the list instead of sitting beside it. */
const NARROW = "(max-width: 1279px)";

// A nav panel gets no isCompactViewport prop (only thread surfaces do), so the page asks the window.
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

export function useViewport(): Viewport {
  const phone = useMedia(PHONE);
  const narrow = useMedia(NARROW);
  return phone ? "phone" : narrow ? "narrow" : "wide";
}
