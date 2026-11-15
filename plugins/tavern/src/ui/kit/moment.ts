import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { readRemembered, writeRemembered } from "./remember";
import { useChangeCue, useTavernMotion, type Surface } from "./motion";

/**
 * One of the two moments (the party forms, the tale), played once per device: the first time it is active here, on mount or when `active`
 * turns true while mounted (a seal pressed now, data that just arrived). Remembered under `rememberKey`; otherwise the card renders finished. Spread the returned handlers on the card: a key or a
 * pointer inside it finishes the moment, and the event goes on to do its own job (no preventDefault, no stopPropagation).
 */
export function useMoment(ref: RefObject<Element | null>, { surface, kind, rememberKey, active, className, ms }: { surface: Surface; kind: string; rememberKey: string; active: boolean; className: string; ms: number }) {
  const { cue, settle } = useTavernMotion(surface);
  const seen = useRef(readRemembered<unknown>(rememberKey) === true);
  const play = () => { seen.current = true; writeRemembered(rememberKey, true); cue(ref.current, kind, { key: rememberKey, ms, className, moment: true }); };
  useLayoutEffect(() => { if (active && !seen.current) play(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useChangeCue(active, (prev, next) => { if (next && !prev && !seen.current) play(); });
  const finish = useCallback(() => settle(c => !!ref.current && ref.current.contains(c.el)), [settle, ref]);
  return { onKeyDown: finish, onPointerDown: finish };
}
