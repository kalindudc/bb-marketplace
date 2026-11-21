import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { CharacterDef } from "../../shared/schema";
import { clockTime } from "../../shared/time";
import { readPalette, type CharacterPalette } from "../kit/characters";
import { motion, stuckInView, type Surface } from "../kit/motion";
import { Actor, type Reaction } from "./actor";
import { CUE_MS, type Cue, type LightAnchor, type Mood } from "./art";
import { CharacterMenu } from "./character-menu";
import { connectStripLantern, holdsLantern } from "./light";
import { isAttentionMood, type MotionMode } from "./rules";
import { observeWorld, scheduler, type EngineWorld } from "./scheduler";
import { createArt } from "./sprites";
import "./engine.css";

const SCALE = 2;
const HEIGHT = 64;
const GROUND = 58;
const THREAD_HOP_ROOM = 12;
const THREAD_FOOT_ROOM = 2;
const BUBBLE_GAP = 8;
const LONG_PRESS_MS = 500;
const LONG_PRESS_TRAVEL_PX = 8;
const MENU_HINT = "Right-click or Shift+F10 for character settings";
const SCENE_BURST = 2000;
const SCENE_GAP = 32_000;
const MOOD_WORD: Record<Mood, string> = {
  idle: "idle", working: "at work", waiting: "needs you", reported: "just reported",
  verified: "verified", blocked: "blocked", resting: "resting", error: "failed",
};

export function walkSpan(composerWidth: number | null, stripWidth: number, spriteWidth: number) {
  return Math.max(0, Math.min(composerWidth || stripWidth, stripWidth) - spriteWidth);
}

export type StripSpeech = { actorId: string; text: string };

type PartyStripProps = {
  character: Pick<CharacterDef, "id" | "avatar" | "name" | "hue" | "charge" | "look">;
  classId: string | null;
  classLabel: string;
  mood: Mood;
  keeper: boolean;
  memberId?: string;
  surface: Surface;
  region?: "widget";
  pageScene?: { threadId: string; road?: boolean };
  mode?: MotionMode;
  held?: boolean;
  quiet?: boolean;
  speech?: StripSpeech | null;
  canClickSpeak?: boolean;
  onActorClick?: (actorId: string) => void;
  onMoodCueEnd?: () => void;
  actorMenu?: Pick<ComponentProps<typeof CharacterMenu>, "mode" | "voice" | "voiceBeforeOff" | "quietUntil" | "change" | "openSheet">;
};

export function PartyStrip(props: PartyStripProps) {
  const { character, classId, classLabel, keeper, mood, speech } = props;
  const scene = props.pageScene;
  const menuId = useId();
  const [menuTrigger, setMenuTrigger] = useState<HTMLButtonElement | null>(null);
  const touchPress = useRef<{ pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressTap = useRef(false);
  const cancelPress = useCallback((pointerId?: number) => {
    const press = touchPress.current;
    if (!press || (pointerId !== undefined && press.pointerId !== pointerId)) return;
    clearTimeout(press.timer);
    touchPress.current = null;
  }, []);
  useEffect(() => () => cancelPress(), [cancelPress]);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuTrigger(null);
    if (restoreFocus) button.current?.focus({ preventScroll: true });
  }, []);
  const actorId = scene?.threadId ?? character.id;
  const memberId = props.memberId ?? actorId;
  const seed = character.avatar ?? character.id;
  const art = useMemo(() => createArt({
    seed, classId, hue: character.hue, charge: character.charge, look: character.look, keeper,
  }), [seed, classId, character.hue, character.charge, character.look, keeper]);
  const height = scene ? HEIGHT : art.height * SCALE + THREAD_HOP_ROOM + THREAD_FOOT_ROOM;
  const ground = scene ? GROUND : art.ground * SCALE + THREAD_HOP_ROOM;
  const actor = useMemo(() => new Actor(actorId, art, mood, memberId), [actorId, memberId]);
  const strip = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const need = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const runtime = useRef<{ invalidate(change?: () => void): void; cue(kind: Cue, auto: boolean, onEnd?: () => void): void; click(): void }>(null);
  const latest = useRef(props);
  const words = !props.held && speech?.actorId === actor.id ? speech.text : null;

  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => {
    const applyMood = () => { actor.art = art; return actor.setMood(mood); };
    let cue: Cue | null = null;
    if (runtime.current) runtime.current.invalidate(() => { cue = applyMood(); });
    else cue = applyMood();
    if (scene && (props.held || props.quiet || isAttentionMood(mood) || props.mode === "off")) motion.settle(c => c.el === button.current);
    if (cue && !scene) {
      if (runtime.current) runtime.current.cue(cue, true, props.onMoodCueEnd);
      else props.onMoodCueEnd?.();
    }
  }, [actor, art, mood, props.mode, props.held, props.quiet, words, scene]);

  useLayoutEffect(() => {
    const el = strip.current!, board = canvas.current!, control = button.current!;
    const lantern = props.region === "widget" && !scene ? connectStripLantern(el) : null;
    let ctx: CanvasRenderingContext2D | null | undefined;
    const composer = el.closest<HTMLElement>("[data-app-composer]");
    let palette: CharacterPalette = readPalette(control);
    let width = 0;
    let span = 0;
    let lastPosition = "";
    let cueNumber = 0;
    let sceneMode: MotionMode = "off";
    let drawnLight: LightAnchor | null = null;
    let drawnX = 0;
    let drawnY = 0;
    const holds = () => {
      const { surface, held } = latest.current;
      const current = motion.getHolds(surface);
      return { typing: current.typing, held: held ?? current.held };
    };
    const mode = () => latest.current.quiet ? "off" : scene ? sceneMode : latest.current.mode ?? "calm";
    let activeRules = { mode: mode(), ...holds() };
    let painted: { x: number; y: number; key: number; art: typeof art; palette: CharacterPalette } | null = null;
    const world: EngineWorld = {
      mode,
      refresh() {
        activeRules = { mode: mode(), ...holds() };
        return actor.setRules(activeRules);
      },
      update(seconds, steps) {
        if (scene && (!motion.mayLoop("page") || stuckInView())) motion.settle(cue => cue.el === control);
        actor.update(seconds, span, activeRules, steps);
      },
      nextDraw: () => actor.nextDraw(span),
      draw(still) {
        const spriteWidth = actor.art.width * SCALE;
        const spriteHeight = actor.art.height * SCALE;
        const x = scene && (still || !scene.road) ? Math.max(0, Math.floor((width - spriteWidth) / 2)) : Math.round(Math.min(span, actor.body.x) / SCALE) * SCALE;
        const y = Math.max(0, ground - actor.art.ground * SCALE - (still || actor.small ? 0 : Math.round(actor.body.lift / SCALE) * SCALE));
        const speechEl = bubble.current;
        if (speechEl) {
          const left = x - BUBBLE_GAP;
          const right = width - x - spriteWidth - BUBBLE_GAP;
          speechEl.hidden = Math.max(left, right) < 48;
          const onRight = right >= left;
          speechEl.style.setProperty("--speech-origin", `${onRight ? x + spriteWidth + BUBBLE_GAP : left}px`);
          speechEl.style.setProperty("--speech-room", `${Math.max(left, right)}px`);
          speechEl.dataset.side = onRight ? "right" : "left";
        }
        const position = scene ? "" : `translate(${x}px, ${y}px)`;
        if (lastPosition !== position) {
          control.style.transform = position;
          lastPosition = position;
        }
        const mark = need.current;
        if (mark && mark.style.transform !== position) mark.style.transform = position;
        const frame = actor.frame(still);
        if (scene) control.dataset.pose = frame.still ? "still" : frame.activity;
        if (control.dataset.activity !== frame.activity) control.dataset.activity = frame.activity;
        const quiet = frame.activity === "quiet" ? actor.quietIdle : "";
        if (control.dataset.quietIdle !== quiet) control.dataset.quietIdle = quiet;
        drawnLight = actor.art.lightAnchor(frame);
        drawnX = x;
        drawnY = y;
        if (lantern) {
          const { typing, held } = holds();
          lantern(drawnLight && drawnLight.kind !== "torch" ? {
            kind: drawnLight.kind, x: x + (drawnLight.x + 0.5) * SCALE, y: y + (drawnLight.y + 0.5) * SCALE,
          } : null, holdsLantern(frame, typing, held, world.mode() === "off"), `${frame.mood}:${frame.facing}`);
        }
        if (ctx === undefined) {
          ctx = board.getContext("2d");
          if (ctx) ctx.imageSmoothingEnabled = false;
        }
        if (!ctx) return;
        const key = actor.art.pixelKey(frame);
        if (painted?.x === x && painted.y === y && painted.key === key && painted.art === actor.art && painted.palette === palette) return;
        painted = { x, y, key, art: actor.art, palette };
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.rect(0, 0, spriteWidth, spriteHeight);
        // Reserve the badge's full CSS box, including its transparent corners.
        if (frame.mood === "waiting" && !scene) ctx.rect(spriteWidth - 16, 4, 13, 13);
        ctx.clip("evenodd");
        ctx.scale(SCALE, SCALE);
        actor.art.draw(ctx, frame, palette);
        ctx.restore();
      },
      lightAnchors() {
        if (!drawnLight) return [];
        const { left, top } = el.getBoundingClientRect();
        return [{
          kind: drawnLight.kind,
          x: window.scrollX + left + drawnX + (drawnLight.x + 0.5) * SCALE,
          y: window.scrollY + top + drawnY + (drawnLight.y + 0.5) * SCALE,
        }];
      },
      suspend(reason) {
        if (reason !== "still") lantern?.(null);
        if (reason === "hidden") return;
        actor.stop();
        motion.settle(cue => cue.el === control);
      },
    };
    const measure = () => {
      width = el.clientWidth;
      const reach = walkSpan(composer?.clientWidth ?? null, width, actor.art.width * SCALE);
      span = Math.floor(reach / SCALE) * SCALE;
      if (board.width !== width) { board.width = width; painted = null; }
      if (ctx) ctx.imageSmoothingEnabled = false;
    };
    measure();
    const handle = observeWorld(el, world);
    const onResize = () => {
      const oldWidth = width, oldSpan = span;
      measure();
      if (oldWidth !== width || oldSpan !== span) handle.invalidate();
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    resize?.observe(el);
    if (composer) resize?.observe(composer);
    if (!resize) window.addEventListener("resize", onResize);
    const theme = new MutationObserver(() => { palette = readPalette(control); handle.invalidate(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const cue = (kind: Cue, auto: boolean, onEnd?: () => void, reaction?: Reaction) => {
      if (!scheduler.isActive(world)) { onEnd?.(); return; }
      const rules = { mode: world.mode(), ...holds() };
      if (rules.held && !auto && !reaction) return;
      const { surface, region } = latest.current;
      let cancel: (() => void) | null = null;
      let ended = false;
      if (reaction) motion.settle(c => c.el === control && c.kind === "character reaction");
      const accepted = motion.cue(surface, control, reaction ? "character reaction" : "character cue", {
        key: `${actor.id}:${kind}:${++cueNumber}`, auto, ms: CUE_MS[kind], ...(region && !reaction ? { region } : {}),
        // The empty animation keeps the painted cue on the coordinator's pause and settle clock.
        run: el => typeof el.animate === "function" ? [el.animate([], { duration: CUE_MS[kind] })] : [],
        onDone: () => { ended = true; if (cancel) handle.invalidate(cancel); onEnd?.(); },
      });
      if (accepted && !ended) handle.invalidate(() => { cancel = reaction ? actor.react(reaction, rules, false) : actor.playCue(kind, auto, rules); });
    };
    runtime.current = {
      invalidate: handle.invalidate, cue,
      click() {
        const rules = { mode: world.mode(), ...holds() };
        const reaction = actor.nextReaction();
        if (rules.mode === "off" || motion.getReduced()) handle.invalidate(() => { actor.react(reaction, rules, true); });
        else cue(reaction, false, undefined, reaction);
        if (!latest.current.quiet && !rules.held && !isAttentionMood(actor.mood)) latest.current.onActorClick?.(actor.id);
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pulse = () => {
      const current = latest.current;
      if (scene && current.mode !== "off" && !current.quiet && !current.held && !isAttentionMood(actor.mood) && width > 0) {
        const box = el.getBoundingClientRect();
        if (box.bottom > 0 && box.top < innerHeight) motion.cue("page", control, scene.road ? "road step" : "hearth sprite", {
          key: actor.id, ambient: true, clearView: true, ms: SCENE_BURST,
          run: node => {
            if (typeof node.animate !== "function") return [];
            sceneMode = scene.road ? current.mode ?? "calm" : "calm";
            handle.invalidate();
            return [node.animate([], { duration: SCENE_BURST })];
          },
          onDone: () => { sceneMode = "off"; handle.invalidate(); },
        });
      }
      timer = setTimeout(pulse, SCENE_GAP);
    };
    const first = scene ? requestAnimationFrame(pulse) : null;
    return () => {
      if (first !== null) cancelAnimationFrame(first);
      clearTimeout(timer);
      runtime.current = null;
      handle.remove();
      lantern?.(null);
      theme.disconnect();
      resize?.disconnect();
      if (!resize) window.removeEventListener("resize", onResize);
    };
  }, [actor, scene?.road, props.region, ground, height]);

  const label = `${character.name}, ${classLabel}${keeper ? ", Keeper" : ""}, ${MOOD_WORD[mood]}`;
  const until = props.actorMenu?.quietUntil;
  const actorLabel = until ? `${label}. Quiet until ${clockTime(until)}.`
    : props.canClickSpeak && !props.held && !isAttentionMood(mood) ? `${label}. Click for a word.` : label;
  return <section ref={strip} className={`tavern twalk ${scene ? "twalk-page" : "twalk-thread"}`} style={{ height }} data-part="TavernWalk" data-light-held={props.held || undefined} data-page-scene-actor={scene ? scene.road ? "road" : "table" : undefined} aria-label={scene ? undefined : `${character.name} walking`}>
    {scene && <span className="twalk-ground" aria-hidden="true" />}
    <canvas ref={canvas} className="twalk-canvas" height={height} aria-hidden="true" />
    <button ref={button} type="button" className="tchar twalk-actor" data-actor={actor.id} data-mood={mood}
      data-pose={scene ? "still" : undefined}
      aria-controls={menuTrigger ? menuId : undefined}
      aria-keyshortcuts={props.actorMenu ? "ContextMenu Shift+F10" : undefined}
      aria-describedby={props.actorMenu ? `${menuId}-hint` : undefined}
      title={props.actorMenu ? `${until ? `Quiet until ${clockTime(until)}. ` : ""}${MENU_HINT}` : undefined}
      onContextMenu={props.actorMenu ? e => {
        e.preventDefault();
        e.stopPropagation();
        if (touchPress.current) {
          cancelPress();
          suppressTap.current = true;
        }
        setMenuTrigger(e.currentTarget);
      } : undefined}
      onPointerDown={props.actorMenu ? e => {
        if (!e.isPrimary) return;
        suppressTap.current = false;
        cancelPress();
        if (e.pointerType !== "touch") return;
        const trigger = e.currentTarget;
        const timer = setTimeout(() => {
          touchPress.current = null;
          suppressTap.current = true;
          setMenuTrigger(trigger);
        }, LONG_PRESS_MS);
        touchPress.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, timer };
      } : undefined}
      onPointerMove={props.actorMenu ? e => {
        const press = touchPress.current;
        if (press?.pointerId === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_TRAVEL_PX)
          cancelPress(e.pointerId);
      } : undefined}
      onPointerUp={props.actorMenu ? e => cancelPress(e.pointerId) : undefined}
      onPointerCancel={props.actorMenu ? e => cancelPress(e.pointerId) : undefined}
      onLostPointerCapture={props.actorMenu ? e => cancelPress(e.pointerId) : undefined}
      onKeyDown={props.actorMenu ? e => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        e.stopPropagation();
        setMenuTrigger(e.currentTarget);
      } : undefined}
      aria-label={scene ? `Open ${character.name}'s thread: ${MOOD_WORD[mood]}` : actorLabel}
      onPointerEnter={e => { if (!scene && !props.quiet && e.pointerType !== "touch") runtime.current?.cue("notice", false); }}
      onClick={e => {
        if (e.detail > 0 && suppressTap.current) {
          suppressTap.current = false;
          return;
        }
        if (scene) props.onActorClick?.(actor.id);
        else runtime.current?.click();
      }}>
    </button>
    {mood === "waiting" && !scene && <span ref={need} className="tchar-need twalk-need" data-tavern-still aria-hidden="true">!</span>}
    {props.actorMenu && <span id={`${menuId}-hint`} className="sr">{MENU_HINT}</span>}
    {menuTrigger && props.actorMenu && <CharacterMenu id={menuId} trigger={menuTrigger} name={character.name} close={closeMenu} {...props.actorMenu} />}
    {words && <span ref={bubble} className="twalk-speech" role="status" hidden><span className="twalk-speech-text">{words}</span></span>}
  </section>;
}
