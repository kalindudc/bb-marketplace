import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PageGlyph } from "./glyphs";

type View = { x: number; y: number; k: number };
type Mode = "instant" | "animate" | "pan" | "zoom";
const MIN = 0.25, MAX = 2.5, PAN = 60, SETTLE_MS = 140;
// Past this many nodes a zoom gesture scales one cached bitmap instead of repainting every frame; it repaints sharp on settle.
const HEAVY_NODES = 160;
const clampK = (k: number) => Math.min(MAX, Math.max(MIN, k));
const BOTTOM_GAP = 16;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let e = el.parentElement; e; e = e.parentElement) { const oy = getComputedStyle(e).overflowY; if ((oy === "auto" || oy === "scroll") && e.clientHeight > 0) return e; }
  return null;
}

/**
 * Room from the window's top to the bottom of the scrolling panel, less what sits under the window in its card.
 * Measured against the panel's content, not the scroll position, so scrolling never resizes the map.
 */
export function useRoomBelow(box: React.RefObject<HTMLElement | null>, cardSelector = "figure") {
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const panel = scrollParent(el);
    const card = (el.closest(cardSelector) as HTMLElement | null) ?? el.parentElement!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = panel ? panel.getBoundingClientRect().top : 0;
      const height = panel ? panel.clientHeight : window.innerHeight;
      const scrolled = panel ? panel.scrollTop : window.scrollY;
      const b = el.getBoundingClientRect();
      const under = card.getBoundingClientRect().bottom - b.bottom;
      // The padding, borders and margins between the card and the panel's content edge, so the panel itself never scrolls for it.
      let below = 0;
      for (let e: HTMLElement | null = card; e && e !== panel; e = e.parentElement) { const cs = getComputedStyle(e); below += parseFloat(cs.marginBottom) || 0; if (e !== card) below += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0); }
      if (panel) below += parseFloat(getComputedStyle(panel).paddingBottom) || 0;
      const next = el.closest(".tv-mapgrid.narrow") ? Math.floor(height * 0.7) : Math.floor(height - (b.top - top + scrolled) - under - Math.max(below, BOTTOM_GAP));
      if (height > 0) setRoom((prev) => prev !== null && Math.abs(prev - next) < 2 ? prev : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    if (panel) observer.observe(panel);
    observer.observe(card.parentElement ?? card);
    window.addEventListener("resize", schedule);
    return () => { observer.disconnect(); window.removeEventListener("resize", schedule); if (frame) cancelAnimationFrame(frame); };
  }, [box, cardSelector]);
  return room;
}

/**
 * A fixed-height window onto a picture of any size: drag or scroll to move, pinch, Ctrl or Cmd and scroll to zoom,
 * and the buttons or keys (arrows, plus, minus, 0) for both. A drag never counts as a click on the node under it.
 *
 * Sharp at every zoom: the layer is promoted to its own compositor bitmap only while a gesture needs it (a drag, or a zoom
 * on a very large map), and is released when the gesture settles, so the browser repaints text and lines at the final
 * scale. Moves write the transform straight to the DOM once per frame; React renders only when the zoom level changes.
 */
/** The focused quest with its one hop; `lx` is the focused quest's left edge and `ay` its middle. */
export type Box = { x: number; y: number; w: number; h: number; lx: number; ay: number };
export function MapViewport({ width, height, label, children, bar, controls, status, note, nodes = 0, focus, focusKey = "", onBoxWidth }: { width: number; height: number; label: string; children: ReactNode; bar?: ReactNode; controls?: ReactNode; status?: string | null; note?: ReactNode; nodes?: number; focus?: Box | null; focusKey?: string; onBoxWidth?: (width: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const noteBox = useRef<HTMLDivElement>(null);
  const [noteHeight, setNoteHeight] = useState(0);
  const layer = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const [k, setK] = useState(1);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const suppress = useRef(false);
  const fitted = useRef("");
  const framedNote = useRef(0);
  const touched = useRef(false);
  const heavy = nodes > HEAVY_NODES;
  const room = useRoomBelow(box);
  const widthCb = useRef(onBoxWidth);
  widthCb.current = onBoxWidth;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    widthCb.current?.(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => widthCb.current?.(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = noteBox.current;
    if (!el) { setNoteHeight(0); return; }
    const measure = () => setNoteHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [note]);
  const availableHeight = useCallback((el: HTMLElement) => Math.max(24, el.clientHeight - (noteHeight ? noteHeight + 12 : 0)), [noteHeight]);

  const paint = useCallback(() => {
    frame.current = 0;
    const v = viewRef.current;
    if (layer.current) layer.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  }, []);
  const settle = useCallback(() => {
    const el = layer.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1, v = viewRef.current;
    // Whole device pixels keep glyph edges on the pixel grid once the bitmap is repainted.
    viewRef.current = { k: v.k, x: Math.round(v.x * dpr) / dpr, y: Math.round(v.y * dpr) / dpr };
    paint();
    el.classList.remove("moving", "animate");
  }, [paint]);
  const setView = useCallback((v: View, mode: Mode) => {
    const prevK = viewRef.current.k;
    viewRef.current = v;
    const el = layer.current;
    if (el) {
      el.classList.toggle("animate", mode === "animate");
      if (mode === "pan" || (mode === "zoom" && heavy)) el.classList.add("moving");
    }
    if (mode === "instant" || mode === "animate") { if (frame.current) cancelAnimationFrame(frame.current); paint(); }
    else if (!frame.current) frame.current = requestAnimationFrame(paint);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, mode === "animate" ? 220 : mode === "instant" ? 0 : SETTLE_MS);
    if (v.k !== prevK) setK(v.k);
  }, [heavy, paint, settle]);
  useEffect(() => () => { clearTimeout(settleTimer.current); if (frame.current) cancelAnimationFrame(frame.current); }, []);

  const keepInside = useCallback((v: View): View => {
    const el = box.current;
    if (!el) return v;
    const vw = el.clientWidth, vh = el.clientHeight, cw = width * v.k, ch = height * v.k, keep = 80;
    return { k: v.k, x: Math.min(vw - keep, Math.max(keep - cw, v.x)), y: Math.min(vh - keep, Math.max(keep - ch, v.y)) };
  }, [width, height]);
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    touched.current = true;
    const vw = el.clientWidth, vh = availableHeight(el);
    const fitted = Math.min(1, (vw - 24) / width, (vh - 24) / height);
    const k = clampK(fitted);
    setView({ k, x: (vw - width * k) / 2, y: k > fitted ? 12 : Math.max(12, (vh - height * k) / 2) }, "animate");
  }, [width, height, setView, availableHeight, noteHeight]);
  /**
   * The first view: the whole map when it fits at 100%, else 100% centred on the focused quest and its one hop, so text
   * always opens at its own size (at 90% an 11 px label draws at 9.9 px). The fit button still gives the overview.
   */
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const start = useCallback((smooth = false) => {
    const el = box.current;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const vw = el.clientWidth, vh = availableHeight(el);
    const kFit = Math.min((vw - 24) / width, (vh - 24) / height);
    if (kFit >= 1) { setView({ k: 1, x: (vw - width) / 2, y: Math.max(8, (vh - height) / 2) }, smooth ? "animate" : "instant"); return; }
    const f = focusRef.current;
    const clampAxis = (view: number, size: number, offset: number) => size + 24 <= view ? (view - size) / 2 : Math.min(12, Math.max(view - size - 12, offset));
    // When the quest and its hop are wider than the window, the quest leads at the left; taller, the quest sits in the middle.
    const x = !f ? 12 : f.w + 24 <= vw ? vw / 2 - (f.x + f.w / 2) : 28 - f.lx;
    const y = !f ? 8 : f.h + 24 <= vh ? vh / 2 - (f.y + f.h / 2) : vh / 2 - f.ay;
    setView({ k: 1, x: clampAxis(vw, width, x), y: clampAxis(vh, height, y) }, smooth ? "animate" : "instant");
  }, [width, height, setView, availableHeight, noteHeight]);
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number, smooth = false) => {
    touched.current = true;
    const el = box.current;
    if (!el) return;
    const v = viewRef.current;
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    const k = clampK(v.k * factor);
    if (k === v.k) return;
    setView(keepInside({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }), smooth ? "animate" : "zoom");
  }, [keepInside, setView]);
  const panBy = useCallback((dx: number, dy: number, smooth = false) => {
    touched.current = true;
    const v = viewRef.current;
    const next = keepInside({ ...v, x: v.x + dx, y: v.y + dy });
    if (next.x === v.x && next.y === v.y) return false;
    setView(next, smooth ? "animate" : "pan");
    return true;
  }, [keepInside, setView]);

  useLayoutEffect(() => {
    const key = `${width}x${height}:${focusKey}`;
    const changed = fitted.current !== key;
    const noteChanged = framedNote.current !== noteHeight;
    framedNote.current = noteHeight;
    if (!changed && (!noteChanged || touched.current)) return;
    const first = fitted.current === "";
    fitted.current = key;
    if (changed) touched.current = false;
    start(!first);
  }, [width, height, focusKey, noteHeight, start]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!touched.current) start(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [start]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".tv-mv-note")) return;
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top); return; }
      // At the picture's edge the wheel scrolls the page instead of being swallowed.
      if (panBy(-e.deltaX, -e.deltaY)) e.preventDefault();
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt, panBy]);

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: viewRef.current.k }; drag.current = null; return; }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    suppress.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = box.current!.getBoundingClientRect();
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      zoomAt((pinch.current.k * (d / pinch.current.d)) / viewRef.current.k, (a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top);
      suppress.current = true;
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; setDragging(true); box.current?.setPointerCapture(e.pointerId); }
    suppress.current = true;
    d.x = e.clientX; d.y = e.clientY;
    panBy(dx, dy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.id === e.pointerId) { if (drag.current.moved) setDragging(false); drag.current = null; }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== box.current) return;
    const keys: Record<string, () => void> = { ArrowLeft: () => panBy(PAN, 0, true), ArrowRight: () => panBy(-PAN, 0, true), ArrowUp: () => panBy(0, PAN, true), ArrowDown: () => panBy(0, -PAN, true), "+": () => zoomAt(1.2, undefined, undefined, true), "=": () => zoomAt(1.2, undefined, undefined, true), "-": () => zoomAt(1 / 1.2, undefined, undefined, true), "0": () => fit() };
    const run = keys[e.key];
    if (run) { e.preventDefault(); run(); }
  };
  /** Tabbing to a node outside the window brings it into view. */
  const onFocus = (e: React.FocusEvent) => {
    const el = box.current;
    if (!el || e.target === el || (e.target as Element).closest(".tv-mv-note")) return;
    const r = (e.target as HTMLElement).getBoundingClientRect(), b = el.getBoundingClientRect(), m = 16;
    const dx = r.left < b.left + m ? b.left + m - r.left : r.right > b.right - m ? b.right - m - r.right : 0;
    const dy = r.top < b.top + m ? b.top + m - r.top : r.bottom > b.bottom - m ? b.bottom - m - r.bottom : 0;
    if (dx || dy) panBy(dx, dy, true);
  };
  const pct = Math.round(k * 100);
  return <div className="tv-mv">
    <div className="tv-mv-bar">
      {bar}
      <span className="tv-mv-status" role="status">{status}</span>
      <div className="tv-mv-ctl" role="toolbar" aria-label="Map view">
        <button type="button" onClick={() => zoomAt(1 / 1.25, undefined, undefined, true)} disabled={k <= MIN} aria-label="Zoom out" title="Zoom out (minus)"><PageGlyph name="zoomout" size={14} /></button>
        <button type="button" className="tv-mv-pct" onClick={() => { touched.current = true; setView(keepInside({ ...viewRef.current, k: 1 }), "animate"); }} aria-label={`Zoom ${pct}%, reset to 100%`} title="Reset to 100%"><span className="num">{pct}%</span></button>
        <button type="button" onClick={() => zoomAt(1.25, undefined, undefined, true)} disabled={k >= MAX} aria-label="Zoom in" title="Zoom in (plus)"><PageGlyph name="zoomin" size={14} /></button>
        <button type="button" onClick={fit} aria-label="Fit the whole map" title="Fit the whole map (0)"><PageGlyph name="fit" size={14} /></button>
      </div>
      {controls}
    </div>
    <div ref={box} className={`tv-mv-box ${dragging ? "dragging" : ""}`} style={room !== null ? { "--mv-pane": `${room}px` } as React.CSSProperties : undefined} tabIndex={0} role="group" aria-label={`${label}. Drag or use the arrow keys to move; plus and minus zoom; 0 fits the whole map.`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown} onFocus={onFocus}
      onDoubleClick={(e) => { if ((e.target as HTMLElement).closest(".tv-mn, .tv-mv-note")) return; const r = box.current!.getBoundingClientRect(); zoomAt(1.5, e.clientX - r.left, e.clientY - r.top, true); }}
      onClickCapture={(e) => { if (suppress.current) { e.preventDefault(); e.stopPropagation(); suppress.current = false; } }}>
      <div ref={layer} className="tv-mv-layer" style={{ width, height }}>{children}</div>
      {note && <div ref={noteBox} className="tv-mv-note" onPointerDown={event => { suppress.current = false; event.stopPropagation(); }}>{note}</div>}
    </div>
  </div>;
}

// ---------- Export ----------

type Colours = Record<"bg" | "board" | "card" | "fg" | "muted" | "line" | "road" | "primary" | "you" | "youFill" | "bad", string> & { font: string };

/** The theme's resolved colours, read from the live page, so the export looks like what the user sees. */
export function readColours(el: HTMLElement): Colours {
  const probe = (v: string, prop: "color" | "backgroundColor" = "color") => { const d = document.createElement("span"); d.style[prop] = `var(${v})`; el.appendChild(d); const c = getComputedStyle(d)[prop]; d.remove(); return c; };
  return { bg: probe("--background"), board: probe("--tavern-elev-recessed-bg", "backgroundColor"), card: probe("--card"), fg: probe("--foreground"), muted: probe("--tavern-muted"), line: probe("--tavern-line"), road: probe("--tavern-road"), primary: probe("--primary"), you: probe("--tavern-you"), youFill: probe("--tavern-you-fill", "backgroundColor"), bad: probe("--tavern-bad"), font: getComputedStyle(el).fontFamily || "monospace" };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Text widths in the page's font, so the export can size its columns to the longest label instead of cutting it. */
export function textMeasurer(root: HTMLElement) {
  const ctx = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(root).fontFamily || "monospace";
  return (text: string, size: number, bold = false) => { if (!ctx) return text.length * size * 0.62; ctx.font = `${bold ? 700 : 400} ${size}px ${family}`; return ctx.measureText(text).width; };
}

/** A crest drawn in the page, copied with its resolved colours so it survives outside the page's CSS. */
function inlineSvg(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")] as Element[];
  const dst = [clone, ...clone.querySelectorAll("*")] as Element[];
  src.forEach((s, i) => { const cs = getComputedStyle(s); const d = dst[i]!; for (const p of ["fill", "stroke", "stroke-width", "opacity"]) { const v = cs.getPropertyValue(p); if (v) d.setAttribute(p, v); } d.removeAttribute("class"); });
  return clone.innerHTML;
}

export type ExportNode = { id: string; x: number; y: number; w: number; h: number; label: string; sub: string; kind: string; focused: boolean };
export type ExportEdge = { d: string; hot: boolean; dashed: boolean; quiet?: boolean };
export function mapSvg({ root, nodes, edges, headings, width, height, title, caption }: { root: HTMLElement; nodes: ExportNode[]; edges: ExportEdge[]; headings: { x: number; y: number; w: number; text: string }[]; width: number; height: number; title: string; caption: string }) {
  const c = readColours(root);
  const top = 56, pad = 16, W = width + pad * 2, H = height + top + pad + 28;
  const crest = (id: string) => { const svg = root.querySelector(`[data-node="${CSS.escape(id)}"] svg`) as SVGSVGElement | null; return svg ? { body: inlineSvg(svg), box: svg.getAttribute("viewBox") ?? "0 0 24 24" } : null; };
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(c.font)}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${c.bg}"/>`);
  out.push(`<text x="${pad}" y="26" font-size="15" font-weight="700" fill="${c.fg}">${esc(title)}</text><text x="${pad}" y="44" font-size="11" fill="${c.muted}">${esc(caption)}</text>`);
  out.push(`<g transform="translate(${pad} ${top})"><rect width="${width}" height="${height}" fill="${c.board}" stroke="${c.line}"/>`);
  for (const h of headings) out.push(`<text x="${h.x}" y="${h.y + 12}" font-size="10" font-weight="700" letter-spacing="0.6" fill="${c.muted}">${esc(h.text.toUpperCase())}</text>`);
  for (const e of edges) out.push(`<path d="${e.d}" fill="none" stroke="${e.hot ? c.primary : c.road}" stroke-opacity="${e.hot ? 1 : e.quiet ? 0.45 : 0.7}" stroke-width="${e.hot ? 2 : 1.5}"${e.dashed || e.quiet ? ` stroke-dasharray="${e.quiet ? "2 4" : "4 4"}"` : ""}/>`);
  for (const n of nodes) {
    const dashed = n.kind === "errand" || n.kind === "outside" || n.kind === "gate" || n.kind === "returned";
    const fill = n.kind === "you" ? c.youFill : n.kind === "outside" || n.kind === "returned" ? "none" : c.card;
    out.push(`<g transform="translate(${n.x} ${n.y})"><rect width="${n.w}" height="${n.h}" fill="${fill}" stroke="${n.focused ? c.primary : c.line}" stroke-width="${n.focused ? 2 : 1}"${dashed ? ` stroke-dasharray="4 3"` : ""}/>`);
    if (n.kind === "you" || n.kind === "blocked") out.push(`<rect width="3" height="${n.h}" fill="${n.kind === "you" ? c.you : c.bad}"/>`);
    const cr = crest(n.id);
    const tx = cr ? 38 : 10;
    if (cr) out.push(`<svg x="9" y="${(n.h - 22) / 2}" width="22" height="22" viewBox="${cr.box}">${cr.body}</svg>`);
    out.push(`<text x="${tx}" y="${n.h / 2 - 2}" font-size="12" font-weight="700" fill="${c.fg}">${esc(n.label)}</text><text x="${tx}" y="${n.h / 2 + 13}" font-size="11" fill="${c.muted}">${esc(n.sub)}</text></g>`);
  }
  out.push(`</g><text x="${pad}" y="${H - 10}" font-size="10" fill="${c.muted}">Exported from Tavern · ${esc(new Date().toLocaleString())}</text></svg>`);
  return { svg: out.join(""), width: W, height: H };
}

/** Renders the SVG to a PNG at twice the size, for chat and docs that do not take SVG. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("The map image could not be drawn")); img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
