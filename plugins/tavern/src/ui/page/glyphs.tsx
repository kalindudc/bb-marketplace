import { memo } from "react";
import { Glyph, type GlyphName } from "../kit";
// Page marks in the kit's line style (square caps, mitred joins, currentColor). Shape carries the state, so none relies on colour.
const PATHS = {
  "road-flag": "M6 21V3h12l-3 5 3 5H6",
  "road-hammer": "M4 5h13v5H4ZM13 10v11H9V10",
  "road-hearth": "M4 21V8l8-5 8 5v13M8 21v-7h8v7M10 17l2-3 2 3-2 3Z",
  you: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20.5h4",
  diamond: "M12 3.5 20.5 12 12 20.5 3.5 12Z",
  work: "M12 4a8 8 0 1 1-8 8",
  wait: "M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5-8 8.5s8 3.5 8 8.5",
  done: "M4 12.5 9.5 18 20 6.5",
  fail: "M4.5 4.5h15v15h-15ZM8.5 8.5l7 7M15.5 8.5l-7 7",
  stale: "M12 4v9M12 17.5v2",
  listen: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  busy: "M12 4a8 8 0 1 1-8 8M12 8v4l3 2",
  steer: "M5 19 19 5M19 5h-8M19 5v8",
  question: "M9 9a3 3 0 1 1 4.5 2.6c-1 .6-1.5 1.3-1.5 2.4M12 18v1",
  aside: "M5 6h14M5 12h9M5 18h5",
  quest: "M9 4h6l-1 6 3 3H7l3-3ZM12 13v7",
  plan: "M6 19a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M6 17V9a3 3 0 0 1 3-3h4M18 7v8a3 3 0 0 1-3 3h-4",
  seal: "M12 2.5l2.4 1.8 3-.1.9 2.8 2.4 1.8-.9 2.8.9 2.8-2.4 1.8-.9 2.8-3-.1L12 21.5l-2.4-1.8-3 .1-.9-2.8-2.4-1.8.9-2.8-.9-2.8 2.4-1.8.9-2.8 3 .1Z",
  undo: "M9 7 4.5 11.5 9 16M5 11.5h9.5a5 5 0 0 1 0 10H11",
  rule: "M6 3.5h12v17H6ZM9 8h6M9 12h6M9 16h3",
  hire: "M12 5v14M5 12h14",
  told: "M4 5h16v11H9l-5 4Z",
  anchor: "M12 3v18M7 8h10M5 14a7 7 0 0 0 14 0",
  stop: "M6 6h12v12H6Z",
  skip: "M6 6l7 6-7 6ZM16 6v12",
  wrap: "M4 20h16M6 20V10l6-6 6 6v10",
  phase: "M4 12h16M14 6l6 6-6 6",
  tick: "M12 6v6l4 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  note: "M5 4h14v16H5ZM8 9h8M8 13h8",
  gate: "M4 21V6M20 21V6M3 6.5h18M3 10h18",
  map: "M3.5 6 9 4l6 2 5.5-2v14L15 20l-6-2-5.5 2ZM9 4v14M15 6v14",
  shield: "M4 3.5h16v8c0 5-3.5 8-8 9.5-4.5-1.5-8-4.5-8-9.5Z",
  file: "M6 3.5h8l4 4v13H6ZM14 3.5v4h4",
  layers: "m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5",
  character: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2c0-3 4-5 8-5s8 2 8 5v2z",
  moon: "M19 15A8 8 0 0 1 9 5a8 8 0 1 0 10 10Z",
  lantern: "M9 3.5h6M10 3.5V6M14 3.5V6M7 6h10v13H7ZM12 10v5M5 21h14",
  home: "M4 11 12 4l8 7M6 9.5V20h12V9.5",
  pin: "M9 4h6l-1 6 3 3H7l3-3ZM12 13v7",
  thread: "M4 5h16v11H9l-5 4Z",
  lock: "M6.5 11h11v9h-11ZM9 11V8a3 3 0 0 1 6 0v3",
  report: "M6 3.5h12v17H6ZM9 8h6M9 12h6M9 16h3",
  party: "M8 11a3 3 0 1 0 0-.01M16 11a3 3 0 1 0 0-.01M3 20c0-3 2-5 5-5s5 2 5 5M11 20c0-3 2-5 5-5s5 2 5 5",
  ledger: "M5 4h14v16H5ZM9 4v16",
  errand: "M5 12h14M13 6l6 6-6 6",
  rejected: "M6 6l12 12M18 6 6 18",
  archive: "M3.5 4.5h17v4.5h-17ZM5 9v10.5h14V9M10 13h4",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  pause: "M8 5v14M16 5v14",
  play: "M8 5.5v13l10-6.5Z",
  pr: "M7 4v16M7 4a2 2 0 1 0 0 .01M17 20a2 2 0 1 0 0-.01M17 18V9a3 3 0 0 0-3-3H10",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  zoomin: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20.5 20.5M7.5 10.5h6M10.5 7.5v6",
  zoomout: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20.5 20.5M7.5 10.5h6",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  export: "M12 15V3.5M7.5 8 12 3.5 16.5 8M5 13v7h14v-7",
  typing: "M6 12h.01M12 12h.01M18 12h.01",
  // A two-unit rack, for where work runs. Its gap keeps the units apart at 14 px, unlike archive's lid and body.
  machine: "M4 4h16v6H4ZM4 14h16v6H4ZM7.5 7h.01M7.5 17h.01M11 7h5.5M11 17h5.5",
} as const;
export type PageGlyphName = keyof typeof PATHS;

/** Page names drawn by Keela's kit set; the rest stay page glyphs until the set covers them. */
const KIT: Partial<Record<PageGlyphName, GlyphName>> = { seal: "decided", you: "ask", quest: "board-quest", plan: "quest-map", done: "verified", tick: "tick", pin: "pin", undo: "undo", report: "report", party: "party", ledger: "ledger", errand: "side-quest", rejected: "rejected", pause: "pause", typing: "more" };

export const PageGlyph = memo(function PageGlyph({ name, size = 14, className = "" }: { name: PageGlyphName; size?: number; className?: string }) {
  const kit = KIT[name];
  if (kit) return <Glyph name={kit} size={size} className={`tv-g tv-g-${name} ${className}`} />;
  // Event data can name an icon the set has not drawn yet; a dot keeps the row aligned instead of an empty gap.
  const d = PATHS[name] ?? "M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z";
  return (
    <svg className={`tv-g tv-g-${name} ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill={name === "diamond" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={name === "diamond" ? 1.2 : 1.9} strokeLinecap="square" strokeLinejoin="miter">
      <path d={d} />
    </svg>
  );
});
