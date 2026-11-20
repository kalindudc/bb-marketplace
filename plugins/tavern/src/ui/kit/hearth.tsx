import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { AwayStatus } from "../../shared/away";
import type { KeeperStatus } from "./rows";
import { VOCABULARY } from "./primitives";
import { useChangeCue, useTavernMotion, type Surface } from "./motion";

/** Internal state names. People read the words from `hearthWords`, which never say "working". */
export type HearthState = "working" | "banked" | "out";
export type HearthWords = { state: HearthState; lead: string; detail: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fullHearths = new Set<{ visible: boolean }>();
const hearthListeners = new Set<() => void>();
const notifyHearths = () => { for (const listener of hearthListeners) listener(); };
/** Closing time's clock: local 24-hour time, with the day in front when it isn't today ("Mon 08:00"). The status line uses it too. */
export function awayClock(at: number, now = Date.now()): string {
  const d = new Date(at), today = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === today.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

/**
 * The hearth's state and words, counted through `keeperStatus` so they can never disagree with the rows.
 * Pass every Keeper the board counts, and the room's closing-time status once the room carries it. When closed, the words stay "Out":
 * "closed until 08:00", then "was due back at 08:00" once the server says the Back at time has passed (`dueBack`), or "closed" with no end.
 */
/**
 * The hearth is lit while the tavern is at work: a Keeper busy, or a member on the road (`onRoad`, the room's `onTheRoad(room)`).
 * The words name only what is at work, never a total. Leave out `onRoad` only where no party can be on the road (decoration, previews).
 */
export function hearthWords(statuses: readonly Pick<KeeperStatus, "tone">[], opts: { away?: Pick<AwayStatus, "closed" | "until" | "dueBack"> | null; now?: number; onRoad?: number; showRoad?: boolean } = {}): HearthWords {
  // Archived Keepers can't work, so they stay out of the total; the rows flag them.
  const live = statuses.filter(s => s.tone !== "archived");
  const n = live.length;
  const away = opts.away;
  if (away?.closed) return { state: "out", lead: "Out", detail: away.until === null ? "closed" : `${away.dueBack ? "was due back at" : "closed until"} ${awayClock(away.until, opts.now)}` };
  if (statuses.length === 0) return { state: "out", lead: "Not lit yet", detail: "no Keeper" };
  const busy = live.filter(s => s.tone === "busy").length, road = opts.onRoad ?? 0;
  const atWork = [busy > 0 && `${busy} ${busy === 1 ? "Keeper" : "Keepers"} busy`, road > 0 && opts.showRoad !== false && `${road} ${VOCABULARY.road[0].toLowerCase()}`].filter(Boolean).join(" · ");
  if (atWork || road > 0) return { state: "working", lead: "Lit", detail: atWork || "party at work" };
  if (n === 0) return { state: "out", lead: "Not lit", detail: "no active Keeper" };
  return { state: "banked", lead: "Banked", detail: "nobody at work" };
}

/** The replay: one flicker cycle while work runs, at a gap drawn from HEARTH_REPLAY_MIN_MS to HEARTH_REPLAY_MAX_MS. */
export const HEARTH_REPLAY_MS = 1500;
export const HEARTH_REPLAY_MIN_MS = 18_000;
export const HEARTH_REPLAY_MAX_MS = 26_000;
/** Each gap is drawn afresh, so the replay never ticks like a clock. */
export const hearthReplayGap = (random: () => number = Math.random) => HEARTH_REPLAY_MIN_MS + Math.floor(random() * (HEARTH_REPLAY_MAX_MS - HEARTH_REPLAY_MIN_MS));

/**
 * The tavern's state in one glyph with its words, 24 to 40 px, inside a heading or a scene. The icon-only navigation variant starts at 14 px and yields to a visible full hearth.
 * Its flames flicker once when the surface comes into view lit and when it becomes lit, flare once when `flareKey` changes (a quest returned),
 * and go out at closing time. The flames only move, never dim, so they keep 3:1 on every surface.
 * With `replay` (the Motion group’s Ambient motion setting), a lit hearth also replays one shorter flicker at a jittered gap: Tavern's
 * one repeating cue. It yields to every other cue and stop condition, and a replay re-renders nothing: plain timers, no state. Its words
 * then end with the flicker and a link to the setting (`settingsHref`), so the control is one step from the thing that moves.
 */
export function Hearth({ words, surface, size = 24, flareKey, replay = false, settingsHref, ambientMotion = "calm", repeatSeconds = 20, iconOnly = false, clearView = false }: { iconOnly?: boolean; clearView?: boolean; ambientMotion?: "calm" | "lively" | "off"; repeatSeconds?: number; words: HearthWords; surface: Surface; size?: number; flareKey?: string | number; replay?: boolean; settingsHref?: string }) {
  const px = Math.min(40, Math.max(iconOnly ? 14 : 24, size));
  const ref = useRef<HTMLSpanElement>(null);
  const { cue, settle, reduced } = useTavernMotion(surface);
  const allowed = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (iconOnly) {
      const update = () => {
        allowed.current = ![...fullHearths].some(hearth => hearth.visible);
        if (!allowed.current) settle(c => c.el === el);
      };
      hearthListeners.add(update);
      update();
      return () => { hearthListeners.delete(update); };
    }
    const shown = getComputedStyle(el).visibility !== "hidden";
    const hasObserver = typeof IntersectionObserver !== "undefined";
    const inViewport = () => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    // Until IO delivers its first entry, the full hearth owns the slot conservatively.
    const hearth = { visible: shown && (hasObserver || inViewport()) };
    fullHearths.add(hearth);
    allowed.current = hearth.visible;
    notifyHearths();
    const update = (visible: boolean) => {
      if (hearth.visible === visible) return;
      hearth.visible = visible;
      allowed.current = visible;
      if (!visible) settle(c => c.el === el);
      notifyHearths();
    };
    const observer = hasObserver ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === el) update(shown && entry.isIntersecting);
    }) : null;
    const fallback = () => update(shown && inViewport());
    if (observer) observer.observe(el);
    else {
      window.addEventListener("scroll", fallback, true);
      window.addEventListener("resize", fallback);
    }
    return () => {
      observer?.disconnect();
      if (!observer) { window.removeEventListener("scroll", fallback, true); window.removeEventListener("resize", fallback); }
      fullHearths.delete(hearth);
      notifyHearths();
    };
  }, [iconOnly, settle]);
  const [first, ...rest] = words.detail.split(" · ");
  const replaying = replay && ambientMotion !== "off" && words.state === "working" && !reduced;
  useEffect(() => {
    if (!replaying) return;
    const el = ref.current;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { timer = setTimeout(() => { if (allowed.current) cue(ref.current, "hearth replay", { key: "hearth-replay", ms: HEARTH_REPLAY_MS, className: "mo-flick1", ambient: true, yields: true, clearView, repeat: ambientMotion === "lively", restMs: HEARTH_REPLAY_MIN_MS }); next(); }, ambientMotion === "lively" ? repeatSeconds * 1000 : hearthReplayGap()); };
    next();
    // Banked, switched off or gone: no more turns, and a replay in flight stills at once.
    return () => { clearTimeout(timer); settle(c => c.el === el && c.kind === "hearth replay"); };
  }, [replaying, cue, settle, ambientMotion, repeatSeconds, clearView]);
  // Every hearth cue counts toward the window only for itself (ownWindow), so the hearth never takes motion time from the party.
  const flicker = () => allowed.current && ambientMotion !== "off" && cue(ref.current, "hearth flicker", { key: "hearth", ms: 3600, className: "mo-flick", ambient: true, ownWindow: true, clearView });
  // Arrival: once per view; the coordinator's rest stops a remount from replaying it.
  useLayoutEffect(() => { if (words.state === "working") flicker(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useChangeCue(words.state, (_prev, next) => {
    if (next === "working") flicker();
    else if (next === "out" && allowed.current) cue(ref.current, "hearth out", { key: "hearth", ms: 600, className: "mo-out", ownWindow: true, clearView });
  });
  useChangeCue(flareKey, () => { if (flareKey !== undefined && allowed.current) cue(ref.current, "hearth flare", { key: "hearth", ms: 500, className: "mo-flare", ownWindow: true, clearView }); });
  return <span ref={ref} className={`tavern-hearth ${words.state}`} data-part="Hearth" data-icon={iconOnly || undefined} aria-hidden={iconOnly || undefined}>
    <svg className="hearth-g" width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
      <path className="arch" d="M3 21V11a9 9 0 0 1 18 0v10M1.5 21h21" />
      <path className="ember" d="M7.5 19.6h9" />
      <path className="fl f2" d="M8.6 18.8c-1.4 0-2-1-1.6-2.1.3-.8.9-1.2 1-2.3 1 .8 2 1.8 1.9 3 0 .9-.6 1.4-1.3 1.4z" />
      <path className="fl f1" d="M12 18.8c-3 0-4-2-3.2-4.2.5-1.4 1.8-2.2 1.9-4.3 1.9 1.3 4.3 3.6 4.1 6-.1 1.6-1.2 2.5-2.8 2.5z" />
      <path className="fl f3" d="M15.6 18.8c-.8 0-1.3-.5-1.3-1.3 0-1.1.9-2 1.6-2.9.3 1 1 1.5 1.2 2.4.2.9-.5 1.8-1.5 1.8z" />
    </svg>
    {!iconOnly && <span className="hearth-t">
      {/* The words never wrap. The replay's line can, so a no-break space goes before each of its "·": a "·" ends a line and never starts one. */}
      {/* Each part stays whole with the "·" after it, and the line breaks only between parts: a state word is never cut, and a "·" never starts a line. */}
      <span className="hearth-w"><span className="hearth-p"><b>{words.lead}</b> <span className="m">· {first}{rest.length > 0 && " ·"}</span></span>{rest.map((part, i) => <Fragment key={i}>{" "}<span className="hearth-p m">{part}{i < rest.length - 1 && " ·"}</span></Fragment>)}{replay && settingsHref && <span className="hearth-dot m" aria-hidden="true">{"\u00a0·"}</span>}</span>
      {replay && settingsHref && <span className="hearth-x m">{" "}Flickers while work runs{"\u00a0"}· <UrlLink href={settingsHref} className="hearth-set act" aria-label="Ambient motion: open Tavern’s Atmosphere settings" title="Choose Calm, Lively or Off in Tavern’s Atmosphere settings">Settings<span aria-hidden="true"> ›</span></UrlLink></span>}
    </span>}
  </span>;
}
