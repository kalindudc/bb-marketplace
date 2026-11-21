import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export const FIRST_BODIES = 2;
const FIRST_PAINT_WAIT_MS = 1_000;

export function useCardBodies(
  streamRef: RefObject<HTMLDivElement | null>,
  cardKeys: readonly string[],
  forced: ReadonlySet<string>,
  preferred: readonly string[],
  visible: boolean,
) {
  const [admitted, setAdmitted] = useState<ReadonlySet<string>>(() => new Set());
  const [afterPaint, setAfterPaint] = useState(false);
  const activeKeys = useMemo(() => new Set(cardKeys), [cardKeys]);
  const eager = useMemo(() => {
    if (!visible || afterPaint) return forced;
    const keys = new Set(forced);
    let used = cardKeys.filter((key) => keys.has(key) || admitted.has(key)).length;
    for (const key of preferred) {
      if (used >= FIRST_BODIES) break;
      if (!keys.has(key) && !admitted.has(key)) {
        keys.add(key);
        used++;
      }
    }
    return keys;
  }, [admitted, cardKeys, forced, preferred, visible, afterPaint]);
  const painted = useRef(false);
  const paintFrame = useRef<number | undefined>(undefined);
  const wake = useRef<(() => void) | undefined>(undefined);
  const hasCards = cardKeys.length > 0;

  useEffect(() => {
    setAdmitted((before) => {
      const keep = new Set([...before, ...eager].filter((key) => activeKeys.has(key)));
      return keep.size === before.size && [...keep].every((key) => before.has(key)) ? before : keep;
    });
  }, [activeKeys, eager]);

  const onDiffCommit = useCallback(() => {
    if (afterPaint || !visible || paintFrame.current !== undefined) return;
    // The second frame starts after the browser has had a chance to paint the committed diff.
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = requestAnimationFrame(() => setAfterPaint(true));
    });
  }, [afterPaint, visible]);
  useEffect(() => {
    if (!visible || !hasCards || afterPaint) return;
    const deadline = setTimeout(() => setAfterPaint(true), FIRST_PAINT_WAIT_MS);
    return () => {
      clearTimeout(deadline);
      if (paintFrame.current !== undefined) cancelAnimationFrame(paintFrame.current);
      paintFrame.current = undefined;
    };
  }, [visible, hasCards, afterPaint]);

  useEffect(() => {
    const stream = streamRef.current;
    if (!visible || stream === null || !hasCards) return;
    const cards = [...stream.querySelectorAll<HTMLElement>("[data-card-key]")];
    const near = new Set<HTMLElement>();
    let frame: number | undefined;
    let observer: IntersectionObserver | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      if (![...near].some((card) => card.dataset.bodyDeferred !== undefined)) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const slots = painted.current ? 1 : FIRST_BODIES - stream.querySelectorAll("[data-card-body]").length;
        if (slots <= 0) return;
        const { top, bottom } = stream.getBoundingClientRect();
        const candidates = [...near].flatMap((card) => {
          if (card.dataset.bodyDeferred === undefined || !card.isConnected) return [];
          const bounds = card.getBoundingClientRect();
          const distance = Math.max(0, bounds.top - bottom, top - bounds.bottom);
          return painted.current || distance === 0 ? [{ key: card.dataset.cardKey!, top: bounds.top, distance }] : [];
        });
        candidates.sort((a, b) => a.distance - b.distance || a.top - b.top);
        const next = candidates.slice(0, slots).map(({ key }) => key);
        if (next.length > 0) setAdmitted((before) => new Set([...before, ...next]));
      });
    };
    const observe = () => {
      observer?.disconnect();
      near.clear();
      if (typeof IntersectionObserver === "undefined") {
        for (const card of cards) near.add(card);
        schedule();
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          for (const { target, isIntersecting } of entries) {
            if (!(target instanceof HTMLElement)) continue;
            if (isIntersecting) near.add(target);
            else near.delete(target);
          }
          schedule();
        },
        { root: stream, rootMargin: `${stream.clientHeight}px 0px` },
      );
      for (const card of cards) observer.observe(card);
    };
    let height = stream.clientHeight;
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (height === stream.clientHeight) return;
            height = stream.clientHeight;
            observe();
          });
    resize?.observe(stream);
    observe();
    wake.current = schedule;
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      resize?.disconnect();
      wake.current = undefined;
    };
  }, [streamRef, hasCards, cardKeys, visible]);

  // A commit can free a slot or open a folded card already in the observer's near set.
  useEffect(() => {
    painted.current = afterPaint;
    wake.current?.();
  });
  return { admitted, eager, onDiffCommit };
}
