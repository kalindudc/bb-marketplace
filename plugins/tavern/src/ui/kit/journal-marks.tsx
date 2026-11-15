import { memo, useLayoutEffect, useRef, useState } from "react";

export type TallyCounts = { done: number; total: number; blocked?: number; rejected?: number };

/** How many done entries fold into "+N": whole gates, above 40 done. */
export const tallyFold = (done: number) => (done > 40 ? Math.floor(done / 5) * 5 : 0);

/**
 * A chalk tally of the journal (README "Journal tally"): one stroke per finished entry, in gates of five, so it grows by one stroke each
 * time an entry is done. It counts only what is done; the total, blocked and rejected counts are words beside it. The first `verified`
 * strokes are drawn in wax and heavier, so proven work reads apart from ticked work without colour alone.
 */
/** Memoized: its props are plain counts, so a re-render of the journal for anything else (names, decor, the sidebar) skips it. */
export const Tally = memo(function Tally({ done, total, blocked = 0, rejected = 0, verified = 0, variant = "head", maxWidth, reserve = 0 }: TallyCounts & { verified?: number; variant?: "head" | "mini"; maxWidth?: number; reserve?: number }) {
  const slot = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    const parent = slot.current?.parentElement;
    if (maxWidth !== undefined || !parent || typeof ResizeObserver === "undefined") return;
    const read = () => setMeasured(parent.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [maxWidth]);
  if (total <= 0) return null;
  const mini = variant === "mini";
  const width = Math.max(40, (maxWidth ?? measured ?? 240) - reserve);
  const marks = tallyMarks({ done, total }, width, mini);
  const proven = Math.min(Math.max(0, verified), done);
  // Stroke i stands for done entry folded + i + 1; the verified ones come first.
  const wax = Math.max(0, proven - marks.folded);
  const svg = marks.strokes.length > 0 && (
    <svg className={`tally${mini ? " mini" : ""}`} data-tally={variant} width={marks.width} height={marks.height} viewBox={`0 0 ${marks.width} ${marks.height}`} aria-hidden="true" focusable="false">
      {marks.strokes.map((s, i) => <line key={i} className={i < wax ? "tl d v" : "tl d"} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />)}
    </svg>
  );
  const fold = marks.folded > 0 && <span className="tally-fold" title={`${marks.folded} done, folded`}><svg className="gate" viewBox="0 0 9 12" aria-hidden="true" focusable="false"><line x1="1.5" y1="1" x2="1.5" y2="11" /><line x1="4" y1="1" x2="4" y2="11" /><line x1="6.5" y1="1" x2="6.5" y2="11" /><line x1="0" y1="10" x2="9" y2="2" /></svg><span>+{marks.folded}</span></span>;
  if (mini) return <span ref={slot} className="tally-slot mini" aria-hidden="true">{fold}{svg}</span>;
  const label = `Tally: ${done} of ${total} done${proven ? `, ${proven} verified by a Warden` : ""}${blocked ? `, ${blocked} blocked` : ""}${rejected ? `, ${rejected} rejected` : ""}`;
  return <span ref={slot} className="tally-slot" role="img" aria-label={label}>{fold}{svg}</span>;
});

type Stroke = { x1: number; y1: number; x2: number; y2: number };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Stroke geometry for the done entries only. Above 40 done, whole gates fold into "+N", in both variants; none done draws nothing. */
export function tallyMarks({ done }: TallyCounts, maxWidth: number, mini = false) {
  const count = Math.max(0, done);
  const folded = tallyFold(count);
  const n = count - folded;
  const h = mini ? 10 : 14;
  const groups = Math.ceil(n / 5);
  let pitch = 4, gap = 6;
  if (n * pitch + (groups - 1) * gap > maxWidth) { gap = 4; pitch = Math.max(4, (maxWidth - (groups - 1) * gap) / n); }
  const strokes: Stroke[] = [];
  let x = 2;
  for (let i = 0; i < n; i++) {
    if (i % 5 === 4) {
      strokes.push({ x1: r1(x - 4 * pitch - pitch * 0.4), y1: h - 2, x2: r1(x - pitch * 0.6), y2: 2 });
      x += gap;
      continue;
    }
    strokes.push({ x1: r1(x), y1: 2, x2: r1(x), y2: h - 2 });
    x += pitch;
  }
  return { strokes, folded, width: n > 0 ? Math.ceil(x + 2) : 0, height: h };
}

/** The bookmark ribbon: on the current entry's row ("row"), or as the small mark in the journal's now line ("mark"). */
export function Ribbon({ variant = "row" }: { variant?: "row" | "mark" }) {
  return <span className={`ribbon ${variant}`} aria-hidden="true" />;
}
