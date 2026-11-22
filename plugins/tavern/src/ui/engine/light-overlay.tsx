import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { experimental_useRpcQuery, type PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { settingsContract, type TavernSettings } from "../../shared/settings";
import { STUCK_IN_VIEW } from "../kit/motion";
import type { LightAnchor } from "./art";
import { LANTERN_BANDS, LANTERN_RADIUS, hasArea, hasStripLantern, intersect, lanternAlpha, lanternIslands, lightMap, roundToLightCell, sameLightMap, sourceGlow, subscribeLanternPresence, subscribeStripLantern, type LightSpan, type LightSurface } from "./light";
import { REPORT_READING } from "./report-reading";
import "./light-overlay.css";

type Options = Pick<TavernSettings["tavern"], "lanternLight" | "lanternStrength" | "lanternLightBb">;
type Rect = LightSurface["rect"];
const TIMELINE = '[data-timeline-row-list="top-level"]';
const PANE = "[data-split-pane-id], [data-thread-window]";
const COMPOSER = "[data-app-composer]";
const MESSAGE_BUBBLE = "[data-message-column] > .ml-auto > div > .rounded-xl.border-border-seam.bg-surface-recessed";
const EXCLUDED = `${STUCK_IN_VIEW}, ${REPORT_READING}, [data-tavern-still], .num, time, [contenteditable]:not([contenteditable="false"]), textarea, input`;
const clips = (overflow: string) => /^(auto|scroll|hidden|clip|overlay)$/.test(overflow);
const viewport = (): Rect => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });
const offsetY = ({ left, top, right, bottom }: Rect, dy: number): Rect => ({ left, top: top + dy, right, bottom: bottom + dy });
const clipBottom = (rect: Rect, bottom: number) => ({ ...rect, bottom: Math.min(rect.bottom, bottom) });

function cornerGutter(radius: string, width: number, height: number) {
  const [x = "0", y = x] = radius.split(" ");
  const px = (value: string, size: number) => Math.min(size / 2, (Number.parseFloat(value) || 0) * (value.endsWith("%") ? size / 100 : 1));
  return [px(x, width), px(y, height)] as const;
}

type TextCache = WeakMap<HTMLElement, { width: number; height: number; rects: Rect[] }>;
function protectedNearRim(el: HTMLElement, rect: DOMRect, cache: TextCache) {
  let saved = cache.get(el);
  if (!saved || saved.width !== rect.width || saved.height !== rect.height) {
    const rects: Rect[] = [];
    const add = (text: Rect) => {
      if (!hasArea(text) || (text.left > rect.left + 5 && text.right < rect.right - 5 && text.top > rect.top + 5 && text.bottom < rect.bottom - 5)) return;
      rects.push({ left: text.left - rect.left - 1, right: text.right - rect.left + 1, top: text.top - rect.top - 1, bottom: text.bottom - rect.top + 1 });
    };
    for (const node of el.querySelectorAll(EXCLUDED)) add(node.getBoundingClientRect());
    const range = document.createRange();
    if (typeof range.getClientRects === "function") {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        range.selectNodeContents(node);
        for (const text of range.getClientRects()) add(text);
      }
    }
    cache.set(el, saved = { width: rect.width, height: rect.height, rects });
  }
  return saved.rects.map(box => ({ left: box.left + rect.left, right: box.right + rect.left, top: box.top + rect.top, bottom: box.bottom + rect.top }));
}

type Rim = { surface: LightSurface; exclusions: Rect[] };
function readRim(el: HTMLElement, rect: DOMRect, clip: Rect, cache: TextCache): Rim | null {
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || el.closest(EXCLUDED)) return null;
  const [tl, tr, br, bl] = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map(radius => cornerGutter(radius, rect.width, rect.height));
  return { surface: { rect, clip, rim: [Math.max(tl![0], tr![0]), Math.max(tr![1], br![1]), Math.max(bl![0], br![0]), Math.max(tl![1], bl![1])] },
    exclusions: protectedNearRim(el, rect, cache) };
}

export function collectLanternSurfaces(strip: HTMLElement, lightBb: boolean, cache: TextCache = new WeakMap()) {
  const pane = strip.closest<HTMLElement>(PANE);
  const stack = strip.closest<HTMLElement>(".tavern-thread-stack") ?? strip;
  const composer = strip.closest<HTMLElement>(COMPOSER);
  const scope = pane ?? composer ?? stack;
  const scroll = lightBb ? strip.closest<HTMLElement>("[data-page-scroll-viewport]") ?? scope.querySelector<HTMLElement>("[data-page-scroll-viewport]") : null;
  const timeline = lightBb ? (scroll ?? scope).querySelector<HTMLElement>(TIMELINE) : null;
  const bounds = pane?.getBoundingClientRect();
  let paneClip = bounds ? intersect(viewport(), bounds) : viewport();
  const observed = new Set<HTMLElement>([strip, scope]);
  for (let el = scope.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el);
    const x = clips(overflowX), y = clips(overflowY);
    if (!x && !y) continue;
    const rect = el.getBoundingClientRect();
    paneClip = intersect(paneClip, { left: x ? rect.left : 0, right: x ? rect.right : innerWidth, top: y ? rect.top : 0, bottom: y ? rect.bottom : innerHeight });
    observed.add(el);
  }
  const stripRect = strip.getBoundingClientRect();
  const view = scroll?.getBoundingClientRect();
  const chatClip = view ? intersect(paneClip, view) : paneClip;
  const localClip = scroll?.contains(strip) ? chatClip : paneClip;
  const widget = stack.querySelector<HTMLElement>('[data-part="TavernWidget"]');
  const prompt = lightBb ? composer?.querySelector<HTMLElement>("[data-composer-box] form[data-promptbox]") ?? null : null;
  const local = [widget, prompt].filter((el): el is HTMLElement => !!el);
  const visible = hasArea(intersect(stripRect, localClip)) && !strip.closest(EXCLUDED) && getComputedStyle(strip).visibility !== "hidden";
  const fixed: Rim[] = [];
  if (visible) for (const el of local) {
    observed.add(el);
    if (el === widget && (strip.hasAttribute("data-light-held") || el.querySelector("[data-ask]"))) continue;
    const rect = el.getBoundingClientRect();
    const rim = hasArea(intersect(rect, localClip)) && readRim(el, rect, localClip, cache);
    if (rim) fixed.push(rim);
  }
  const bubbleRims: Rim[] = [];
  const bubbles = new Set<HTMLElement>();
  if (scroll) observed.add(scroll);
  if (timeline) {
    observed.add(timeline);
    if (visible) for (const el of timeline.querySelectorAll<HTMLElement>(MESSAGE_BUBBLE)) {
      if (el.closest(PANE) !== pane) continue;
      const rect = el.getBoundingClientRect();
      if (!hasArea(rect)) continue;
      const rim = readRim(el, rect, chatClip, cache);
      if (rim) { bubbleRims.push(rim); bubbles.add(el); observed.add(el); }
    }
  }
  const until = clipBottom(chatClip, stripRect.top);
  return { stripRect, fixed, bubbleRims, observed, bubbles, local, stack, timeline, scroll,
    sharedScroll: !!scroll?.contains(strip), scrollTop: scroll?.scrollTop ?? 0, visible, chatClip: until,
    surfaces: [...fixed.map(r => r.surface), ...bubbleRims.map(r => ({ ...r.surface, clip: until }))],
    exclusions: [...fixed, ...bubbleRims].flatMap(r => r.exclusions) };
}

function paintSpans(ctx: CanvasRenderingContext2D, spans: LightSpan[], colour: string, alpha: number) {
  ctx.fillStyle = colour;
  for (const [i, bandAlpha] of LANTERN_BANDS.entries()) {
    ctx.globalAlpha = alpha * bandAlpha;
    ctx.beginPath();
    for (const r of spans) if (r.band === i + 1) ctx.rect(r.left, r.top, r.right - r.left, r.bottom - r.top);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const ISLAND_WIDTH = 124;
function drawIslands(layer: HTMLCanvasElement, rect: DOMRect, anchor: LightAnchor, colour: string, alpha: number) {
  const left = roundToLightCell(anchor.x) - ISLAND_WIDTH / 2;
  const position = `translateX(${left}px)`;
  if (layer.style.transform !== position) layer.style.transform = position;
  const y = roundToLightCell(anchor.y), height = Math.ceil(rect.height);
  const tag = `${height}:${y}:${colour}:${alpha}`;
  if (layer.dataset.paint === tag) return;
  layer.dataset.paint = tag;
  layer.width = ISLAND_WIDTH;
  layer.height = height;
  const ctx = layer.getContext("2d");
  if (!ctx) return;
  const { halo, pool } = lanternIslands(ISLAND_WIDTH / 2, y, roundToLightCell(height - 10));
  const cells = new Map<number, LightSpan>();
  for (const cell of [...halo, ...pool]) {
    const key = cell.top * ISLAND_WIDTH + cell.left;
    if ((cells.get(key)?.band ?? 0) < cell.band) cells.set(key, cell);
  }
  paintSpans(ctx, [...cells.values()], colour, alpha);
}

type Scene = ReturnType<typeof collectLanternSurfaces>;
type LightPaint = { map: LightSpan[]; colour: string; alpha: number };
type Carrier = { anchor: LightAnchor; scene: Scene; layer: HTMLCanvasElement | null; paint: LightPaint | null; x: number; y: number };

export function watchLantern(canvas: HTMLCanvasElement, { lanternLight, lanternLightBb, lanternStrength }: Options,
  paint?: (spans: LightSpan[], colour: string, alpha: number) => void) {
  if (!lanternLight) return { draw() {}, dispose() {} } satisfies { draw(strip: HTMLElement, anchor: LightAnchor | null): void; dispose(): void };
  const carriers = new Map<HTMLElement, Carrier>();
  let previous: LightPaint[] = [];
  let colour = "", alpha = 0, dirtyTheme = true;
  let width = innerWidth, height = innerHeight;
  let observed = new Set<HTMLElement>();
  let watched = new Map<HTMLElement, boolean>();
  let scrollers = new Set<HTMLElement>();
  let frame: number | null = null;
  let measure = false;
  let cache: TextCache = new WeakMap();

  function update(carrier: Carrier, layout = false) {
    const { anchor, scene } = carrier;
    if (carrier.layer) carrier.layer.hidden = !scene.visible;
    if (!scene.visible) { carrier.paint = null; return; }
    const x = roundToLightCell(scene.stripRect.left + anchor.x), y = roundToLightCell(scene.stripRect.top + anchor.y);
    if (!layout && !dirtyTheme && x === carrier.x && y === carrier.y) return;
    const glow = sourceGlow(anchor.kind, colour, alpha);
    if (carrier.layer) drawIslands(carrier.layer, scene.stripRect, anchor, glow.colour, glow.alpha);
    carrier.x = x;
    carrier.y = y;
    const dy = scene.scrollTop - (scene.scroll?.scrollTop ?? 0);
    const surfaces = scene.fixed.map(r => r.surface);
    const exclusions = scene.fixed.flatMap(r => r.exclusions);
    for (const { surface, exclusions: blocked } of scene.bubbleRims) {
      const rect = offsetY(surface.rect, dy);
      if (rect.bottom < y - LANTERN_RADIUS || rect.top >= scene.chatClip.bottom) continue;
      surfaces.push({ ...surface, rect, clip: scene.chatClip });
      for (const box of blocked) exclusions.push(offsetY(box, dy));
    }
    carrier.paint = { ...glow, map: lightMap({ ...anchor, x, y }, surfaces, exclusions) };
  }
  function refreshColour() {
    colour = getComputedStyle(canvas).color;
    alpha = lanternAlpha(lanternStrength, true);
  }
  function render() {
    const lights = [...carriers.values()].flatMap(({ paint }) => paint?.map.length ? [paint] : []);
    const resized = width !== innerWidth || height !== innerHeight || (!paint && (canvas.width !== innerWidth || canvas.height !== innerHeight));
    if (!dirtyTheme && !resized && lights.length === previous.length && lights.every((light, i) => {
      const prior = previous[i]!;
      return light === prior || (light.colour === prior.colour && light.alpha === prior.alpha && sameLightMap(prior.map, light.map));
    })) return;
    dirtyTheme = false;
    width = innerWidth;
    height = innerHeight;
    if (paint) {
      if (lights.length === 0) paint([], colour, alpha);
      for (const light of lights) paint(light.map, light.colour, light.alpha);
    } else {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        if (resized) { canvas.width = width; canvas.height = height; }
        else if (previous.length) {
          let left = width, right = 0, top = height, bottom = 0;
          for (const light of previous) for (const r of light.map) {
            left = Math.min(left, Math.floor(r.left)); right = Math.max(right, Math.ceil(r.right));
            top = Math.min(top, Math.floor(r.top)); bottom = Math.max(bottom, Math.ceil(r.bottom));
          }
          ctx.clearRect(left, top, right - left, bottom - top);
        }
        for (const light of lights) paintSpans(ctx, light.map, light.colour, light.alpha);
      }
    }
    previous = lights;
  }
  function observe() {
    const nextObserved = new Set<HTMLElement>(), nextWatched = new Map<HTMLElement, boolean>(), nextScrollers = new Set<HTMLElement>();
    for (const [strip, { scene }] of carriers) {
      for (const el of scene.observed) nextObserved.add(el);
      for (const el of [...scene.local, ...scene.bubbles]) nextWatched.set(el, true);
      for (const el of [strip, scene.stack, scene.timeline, scene.timeline?.closest<HTMLElement>("[data-timeline-items]")]) {
        if (el) nextWatched.set(el, false);
      }
      if (scene.scroll) nextScrollers.add(scene.scroll);
    }
    for (const el of observed) if (!nextObserved.has(el)) resize?.unobserve(el);
    for (const el of nextObserved) if (!observed.has(el)) resize?.observe(el);
    observed = nextObserved;
    for (const el of scrollers) if (!nextScrollers.has(el)) el.removeEventListener("scroll", onScroll);
    for (const el of nextScrollers) if (!scrollers.has(el)) el.addEventListener("scroll", onScroll, { passive: true });
    scrollers = nextScrollers;
    if (nextWatched.size === watched.size && [...nextWatched].every(([el, deep]) => watched.get(el) === deep)) return;
    watched = nextWatched;
    mutation.disconnect();
    for (const [el, deep] of watched) mutation.observe(el, deep ? { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["class", "hidden", "data-ask", "data-stuck", "data-tavern-still"] } : el.matches('[data-part="TavernWalk"]')
      ? { attributes: true, attributeFilter: ["data-light-held"] } : { childList: true });
  }
  function refresh() {
    frame = null;
    if (!carriers.size) return;
    if (dirtyTheme) refreshColour();
    let rescanned = false;
    for (const [strip, carrier] of carriers) {
      const moved = carrier.scene.sharedScroll && (() => {
        const box = strip.getBoundingClientRect();
        return box.top !== carrier.scene.stripRect.top || box.left !== carrier.scene.stripRect.left;
      })();
      if (measure || moved) {
        carrier.scene = collectLanternSurfaces(strip, lanternLightBb, cache);
        rescanned = true;
      }
      update(carrier, true);
    }
    if (rescanned) observe();
    measure = false;
    render();
  }
  function invalidate(layout: boolean) {
    if (!carriers.size) return;
    measure ||= layout;
    frame ??= requestAnimationFrame(refresh);
  }
  const onScroll = () => invalidate(false);
  const onResize = () => invalidate(true);
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  const mutation = new MutationObserver(records => {
    for (const { target } of records) {
      const el = target instanceof HTMLElement ? target : target.parentElement;
      const rim = el?.closest<HTMLElement>(`${MESSAGE_BUBBLE}, [data-part="TavernWidget"], form[data-promptbox]`);
      if (rim) cache.delete(rim);
    }
    invalidate(true);
  });
  const theme = new MutationObserver(() => { dirtyTheme = true; cache = new WeakMap(); onResize(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  window.addEventListener("resize", onResize);
  return {
    draw(strip: HTMLElement, anchor: LightAnchor | null) {
      let carrier = carriers.get(strip);
      if (!anchor) {
        if (carrier) { carrier.layer?.remove(); carriers.delete(strip); observe(); render(); }
        return;
      }
      if (dirtyTheme) refreshColour();
      const changedKind = carrier?.anchor.kind !== anchor.kind;
      if (carrier) carrier.anchor = anchor;
      else {
        const scene = collectLanternSurfaces(strip, lanternLightBb, cache);
        const sprite = strip.querySelector(".twalk-canvas");
        const layer = sprite && !paint ? document.createElement("canvas") : null;
        if (layer) {
          layer.className = "tv-lantern-islands";
          layer.setAttribute("aria-hidden", "true");
          sprite?.before(layer);
        }
        carrier = { anchor, scene, layer, paint: null, x: NaN, y: NaN };
        carriers.set(strip, carrier);
        observe();
      }
      update(carrier, changedKind);
      render();
    },
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      for (const carrier of carriers.values()) carrier.layer?.remove();
      for (const el of scrollers) el.removeEventListener("scroll", onScroll);
      resize?.disconnect();
      mutation.disconnect();
      theme.disconnect();
      window.removeEventListener("resize", onResize);
    },
  };
}

export function LanternCanvas({ lanternLight, lanternLightBb, lanternStrength }: Options) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!canvas.current) return;
    const observer = watchLantern(canvas.current, { lanternLight, lanternLightBb, lanternStrength });
    const unsubscribe = subscribeStripLantern(observer.draw);
    return () => { unsubscribe(); observer.dispose(); };
  }, [lanternLight, lanternLightBb, lanternStrength]);
  return lanternLight ? <canvas key={`${lanternLightBb}:${lanternStrength}`} ref={canvas} className="tavern tv-lantern-light" aria-hidden="true" /> : null;
}

function LanternOverlay() {
  const present = useSyncExternalStore(subscribeLanternPresence, hasStripLantern);
  const { data } = experimental_useRpcQuery({ contract: settingsContract, method: "settings", input: null, enabled: present });
  return present && data ? <LanternCanvas {...data.effective.tavern} /> : null;
}

export function registerLanternLight(app: PluginAppBuilder) {
  app.slots.experimental_appOverlay({ id: "tavern-lantern-light", component: LanternOverlay });
}
