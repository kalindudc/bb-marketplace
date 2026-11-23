import type { ReactNode } from "react";
import type { GlyphName } from "./runway";

const PATHS: Record<GlyphName, ReactNode> = {
  check: <><circle cx="8" cy="8" r="6.2" /><path d="M5.3 8.2l1.9 1.9 3.6-3.8" /></>,
  pause: <><circle cx="8" cy="8" r="6.2" /><path d="M6.6 5.6v4.8M9.4 5.6v4.8" /></>,
  press: <><path d="M2.5 8h11" /><path d="M5.5 2.8L8 5.3l2.5-2.5M5.5 13.2L8 10.7l2.5 2.5" /></>,
  alert: <><path d="M8 2.4l6 11H2z" /><path d="M8 6.6v3.2M8 11.7v.1" /></>,
  slash: <><circle cx="8" cy="8" r="6.2" /><path d="M3.7 12.3l8.6-8.6" /></>,
  dot: <circle cx="8" cy="8" r="4.2" fill="currentColor" />,
  ring: <circle cx="8" cy="8" r="4" />,
  dash: <path d="M4 8h8" />,
  chev: <path d="M4.5 6.2L8 9.7l3.5-3.5" />,
  cross: <><circle cx="8" cy="8" r="6.2" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></>,
};

/** Press's state marks, drawn on the current text colour; always paired with a word. */
export function Glyph({ name }: { name: GlyphName }) {
  return <svg className="pp-g" viewBox="0 0 16 16" aria-hidden="true" data-glyph={name}>{PATHS[name]}</svg>;
}
