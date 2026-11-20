import { useLayoutEffect, useMemo, useRef } from "react";
import type { CharacterDef } from "../../shared/schema";
import { readPalette, type CharacterPalette } from "../kit/characters";
import { motion, stuckInView, type Surface } from "../kit/motion";
import { Actor } from "./actor";
import { CUE_MS, type Cue, type LightAnchor, type Mood } from "./art";
import { isStillMood, type MotionMode } from "./rules";
import { observeWorld, scheduler, type EngineWorld } from "./scheduler";
import { createArt } from "./sprites";
import "./engine.css";

const SCALE = 2;
const HEIGHT = 64;
const GROUND = 58;
const BUBBLE_GAP = 8;
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
  surface: Surface;
  region?: "widget";
  pageScene?: { threadId: string; road?: boolean };
  mode?: MotionMode;
  held?: boolean;
  speech?: StripSpeech | null;
  canClickSpeak?: boolean;
  onActorClick?: (actorId: string) => void;
  onMoodCueEnd?: () => void;
};

export function PartyStrip(props: PartyStripProps) {
  const { character, classId, classLabel, keeper, mood, speech } = props;
  const scene = props.pageScene;
  const actorId = scene?.threadId ?? character.id;
  const seed = character.avatar ?? character.id;
  const art = useMemo(() => createArt({
    seed, classId, hue: character.hue, charge: character.charge, look: character.look, keeper,
  }), [seed, classId, character.hue, character.charge, character.look, keeper]);
  const actor = useMemo(() => new Actor(actorId, art, mood), [actorId]);
  const strip = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const runtime = useRef<{ invalidate(): void; cue(kind: Cue, auto: boolean, onEnd?: () => void): void }>(null);
  const latest = useRef(props);
  const words = !props.held && speech?.actorId === actor.id ? speech.text : null;

  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => {
    actor.art = art;
    const cue = actor.setMood(mood);
    runtime.current?.invalidate();
    if (scene && (props.held || isStillMood(mood) || props.mode === "off")) motion.settle(c => c.el === button.current);
    if (cue && !scene) {
      if (runtime.current) runtime.current.cue(cue, true, props.onMoodCueEnd);
      else props.onMoodCueEnd?.();
    }
  }, [actor, art, mood, props.mode, props.held, words, scene]);

  useLayoutEffect(() => {
    const el = strip.current!, board = canvas.current!, control = button.current!;
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
      return { typing: current.typing, held: !!held || current.held };
    };
    const world: EngineWorld = {
      mode: () => scene ? sceneMode : latest.current.mode ?? "calm",
      update(seconds) {
        if (scene && (!motion.mayLoop("page") || stuckInView())) motion.settle(cue => cue.el === control);
        actor.update(seconds, span, { mode: world.mode(), ...holds() });
      },
      draw(still) {
        const spriteWidth = actor.art.width * SCALE;
        const spriteHeight = actor.art.height * SCALE;
        const x = scene && (still || !scene.road) ? Math.max(0, Math.floor((width - spriteWidth) / 2)) : Math.round(Math.min(span, actor.body.x) / SCALE) * SCALE;
        const y = Math.max(0, GROUND - actor.art.ground * SCALE - (still ? 0 : Math.round(actor.body.lift / SCALE) * SCALE));
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
        const frame = actor.frame(still);
        if (scene) control.dataset.pose = frame.still ? "still" : frame.activity;
        if (control.dataset.activity !== frame.activity) control.dataset.activity = frame.activity;
        const quiet = frame.activity === "quiet" ? actor.quietIdle : "";
        if (control.dataset.quietIdle !== quiet) control.dataset.quietIdle = quiet;
        drawnLight = actor.art.lightAnchor(frame);
        drawnX = x;
        drawnY = y;
        if (ctx === undefined) {
          ctx = board.getContext("2d");
          if (ctx) ctx.imageSmoothingEnabled = false;
        }
        if (!ctx) return;
        ctx.clearRect(0, 0, width, HEIGHT);
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.rect(0, 0, spriteWidth, spriteHeight);
        ctx.clip();
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
        if (reason === "hidden") return;
        actor.stop();
        motion.settle(cue => cue.el === control);
      },
    };
    const measure = () => {
      width = el.clientWidth;
      const reach = walkSpan(composer?.clientWidth ?? null, width, actor.art.width * SCALE);
      span = Math.floor(reach / SCALE) * SCALE;
      if (board.width !== width) board.width = width;
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
    runtime.current = {
      invalidate: handle.invalidate,
      cue(kind, auto, onEnd) {
        if (!scheduler.isActive(world)) { onEnd?.(); return; }
        const rules = { mode: world.mode(), ...holds() };
        if (rules.held && !auto) return;
        const { surface, region } = latest.current;
        let cancel: (() => void) | null = null;
        let ended = false;
        const accepted = motion.cue(surface, control, "character cue", {
          key: `${actor.id}:${kind}:${++cueNumber}`, auto, ms: CUE_MS[kind], ...(region ? { region } : {}),
          // Canvas owns the pixels; the empty animation keeps the cue in the coordinator's slots until it ends.
          run: el => typeof el.animate === "function" ? [el.animate([], { duration: CUE_MS[kind] })] : [],
          onDone: () => { ended = true; cancel?.(); onEnd?.(); },
        });
        if (accepted && !ended) cancel = actor.playCue(kind, auto, rules);
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pulse = () => {
      const current = latest.current;
      if (scene && current.mode !== "off" && !current.held && !isStillMood(actor.mood) && width > 0) {
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
      theme.disconnect();
      resize?.disconnect();
      if (!resize) window.removeEventListener("resize", onResize);
    };
  }, [actor, scene?.road]);

  const label = `${character.name}, ${classLabel}${keeper ? ", Keeper" : ""}, ${MOOD_WORD[mood]}`;
  return <section ref={strip} className={`tavern twalk${scene ? " twalk-page" : ""}`} data-part="TavernWalk" data-page-scene-actor={scene ? scene.road ? "road" : "table" : undefined} aria-label={scene ? undefined : `${character.name} walking`}>
    <span className="twalk-ground" aria-hidden="true" />
    <canvas ref={canvas} className="twalk-canvas" height={HEIGHT} aria-hidden="true" />
    <button ref={button} type="button" className="tchar twalk-actor" data-actor={actor.id} data-mood={mood}
      data-pose={scene ? "still" : undefined}
      aria-label={scene ? `Open ${character.name}'s thread: ${MOOD_WORD[mood]}` : props.canClickSpeak ? `${label}. Click for a word.` : label}
      onPointerEnter={() => { if (!scene) runtime.current?.cue("notice", false); }}
      onClick={() => {
        if (!scene) runtime.current?.cue("hop", false);
        props.onActorClick?.(actor.id);
      }}>
      {mood === "waiting" && !scene && <span className="tchar-need" aria-hidden="true">!</span>}
    </button>
    {words && <span ref={bubble} className="twalk-speech" role="status" hidden><span className="twalk-speech-text">{words}</span></span>}
  </section>;
}
