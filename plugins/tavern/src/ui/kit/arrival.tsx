import { useEffect, useLayoutEffect, useMemo, useRef, memo } from "react";
import { readRemembered, writeRemembered } from "./remember";
import { useTavernMotion, type Surface } from "./motion";

/**
 * When this device last looked at `scope` (a page, a room section), read once per view; leaving the view, or hiding the window,
 * records now. Display memory only, in local storage through remember.ts; nothing reaches the server.
 */
export function useLookedSince(scope: string): number | undefined {
  const key = `looked:${scope}`;
  const since = useMemo(() => { const v = readRemembered<unknown>(key); return typeof v === "number" ? v : undefined; }, [key]);
  useEffect(() => {
    const mark = () => writeRemembered(key, Date.now());
    const onVisibility = () => { if (document.hidden) mark(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); mark(); };
  }, [key]);
  return since;
}

/**
 * The still "new" mark (the primary mark and the word) on something that changed since the last look, faded in once as a one-shot cue.
 * Nothing shows on a first visit, when there is no last look to compare with. `still` shows the mark without the fade (asks, failures).
 */
export const ArrivalMark = memo(function ArrivalMark({ at, since, surface, cueKey, still = false }: { at: number; since: number | undefined; surface: Surface; cueKey: string; still?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isNew = since !== undefined && at > since;
  const { cue } = useTavernMotion(surface);
  useLayoutEffect(() => { if (isNew && !still) cue(ref.current, "arrival", { key: cueKey, ms: 300, className: "mo-arrive" }); }, [isNew, still, cueKey, cue]);
  if (!isNew) return null;
  return <span ref={ref} className="arrival-mark" data-part="ArrivalMark"><i aria-hidden="true" />new</span>;
});
