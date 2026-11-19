import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CharacterDef } from "../../shared/schema";
import { readPalette, type CharacterPalette, type CharacterState } from "../kit/characters";
import { motion, STUCK_IN_VIEW, type Surface } from "../kit/motion";
import { Actor } from "./actor";
import { CUE_MS, type Cue, type Mood } from "./art";
import { legacyArt } from "./legacy-art";
import type { MotionMode } from "./rules";
import { observeWorld, scheduler, type EngineWorld } from "./scheduler";
import "./engine.css";

const SCALE = 2;
const HEIGHT = 64;
const GROUND = 58;
const BUBBLE_GAP = 6;
const SPEECH_MS = 4500;

export const STRIP_MOOD: Record<CharacterState, Mood> = {
  idle: "idle", working: "working", "needs-you": "waiting", error: "error",
};
const MOOD_WORD: Record<Mood, string> = {
  idle: "idle", working: "at work", waiting: "needs you", reported: "just reported",
  verified: "verified", blocked: "blocked", resting: "resting", error: "stopped",
};

export function walkSpan(composerWidth: number | null, stripWidth: number, spriteWidth: number) {
  return Math.max(0, Math.min(composerWidth || stripWidth, stripWidth) - spriteWidth);
}

export type StripSpeech = { actorId: string; text: string };

type PartyStripProps = {
  character: Pick<CharacterDef, "id" | "name" | "hue" | "charge" | "look">;
  classId: string | null;
  classLabel: string;
  mood: Mood;
  keeper: boolean;
  surface: Surface;
  region?: "widget";
  mode?: MotionMode;
  held?: boolean;
  line?: string | undefined;
  speech?: StripSpeech | null;
  onActorClick?: (actorId: string) => void;
};

function attentionInView() {
  for (const el of document.querySelectorAll(STUCK_IN_VIEW)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) return true;
  }
  return false;
}

export function PartyStrip(props: PartyStripProps) {
  const { character, classId, classLabel, keeper, mood, line } = props;
  const art = useMemo(() => legacyArt({
    seed: character.id, classId, hue: character.hue, charge: character.charge, look: character.look, keeper,
  }), [character.id, classId, character.hue, character.charge, character.look, keeper]);
  const actor = useMemo(() => new Actor(character.id, art, mood), [character.id]);
  const strip = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const runtime = useRef<{ invalidate(): void; cue(kind: Cue, auto: boolean): void }>(null);
  const latest = useRef(props);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [localSpeech, setLocalSpeech] = useState<StripSpeech | null>(null);
  const speech = props.speech === undefined ? localSpeech : props.speech;
  const words = speech?.actorId === actor.id ? speech.text : null;

  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => {
    actor.art = art;
    const cue = actor.setMood(mood);
    runtime.current?.invalidate();
    if (cue) runtime.current?.cue(cue, true);
  }, [actor, art, mood, props.mode, props.held, words]);

  useLayoutEffect(() => {
    const el = strip.current!, board = canvas.current!, control = button.current!;
    const ctx = board.getContext("2d");
    const composer = el.closest<HTMLElement>("[data-app-composer]");
    let palette: CharacterPalette = readPalette(control);
    let width = 0;
    let span = 0;
    let lastPosition = "";
    let cueNumber = 0;
    const holds = () => {
      const { surface, held } = latest.current;
      const current = motion.getHolds(surface);
      return { typing: current.typing, held: !!held || current.held };
    };
    const world: EngineWorld = {
      mode: () => latest.current.mode ?? "calm",
      update: seconds => actor.update(seconds, span, { mode: world.mode(), ...holds() }),
      draw(still) {
        const spriteWidth = actor.art.width * SCALE;
        const spriteHeight = actor.art.height * SCALE;
        const x = Math.round(Math.min(span, actor.body.x) / SCALE) * SCALE;
        const y = GROUND - actor.art.ground * SCALE - (still ? 0 : Math.round(actor.body.lift / SCALE) * SCALE);
        const speechEl = bubble.current;
        if (speechEl) {
          const { typing, held } = holds();
          const left = x - BUBBLE_GAP;
          const right = width - x - spriteWidth - BUBBLE_GAP;
          speechEl.hidden = typing || held || attentionInView() || Math.max(left, right) < 48;
          const onRight = right >= left;
          speechEl.style.setProperty("--speech-origin", `${onRight ? x + spriteWidth + BUBBLE_GAP : left}px`);
          speechEl.style.setProperty("--speech-room", `${Math.max(left, right)}px`);
          speechEl.dataset.side = onRight ? "right" : "left";
        }
        const position = `translate(${x}px, ${y}px)`;
        if (lastPosition !== position) {
          control.style.transform = position;
          lastPosition = position;
        }
        const frame = actor.frame(still);
        if (control.dataset.activity !== frame.activity) control.dataset.activity = frame.activity;
        const quiet = frame.activity === "quiet" ? actor.quietIdle : "";
        if (control.dataset.quietIdle !== quiet) control.dataset.quietIdle = quiet;
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
      suspend(reason) {
        if (reason === "hidden") return;
        actor.stop();
        motion.settle(cue => cue.el === control && cue.kind === "character cue");
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
      cue(kind, auto) {
        if (!scheduler.isActive(world)) return;
        const rules = { mode: world.mode(), ...holds() };
        if (rules.held && !auto) return;
        const { surface, region } = latest.current;
        let cancel: (() => void) | null = null;
        const accepted = motion.cue(surface, control, "character cue", {
          key: `${actor.id}:${kind}:${++cueNumber}`, auto, ms: CUE_MS[kind], ...(region ? { region } : {}),
          // Canvas owns the pixels; the empty animation keeps the cue in the coordinator's slots until it ends.
          run: el => typeof el.animate === "function" ? [el.animate([], { duration: CUE_MS[kind] })] : [],
          onDone: () => cancel?.(),
        });
        if (accepted) cancel = actor.playCue(kind, auto, rules);
      },
    };
    return () => {
      runtime.current = null;
      handle.remove();
      theme.disconnect();
      resize?.disconnect();
      if (!resize) window.removeEventListener("resize", onResize);
    };
  }, [actor]);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!words) return;
    const hide = () => { if (bubble.current && motion.getHolds(props.surface).typing) bubble.current.hidden = true; };
    const events = ["input", "keydown", "compositionstart"];
    for (const event of events) document.addEventListener(event, hide);
    return () => { for (const event of events) document.removeEventListener(event, hide); };
  }, [words, props.surface]);

  const canSpeak = mood !== "waiting" && mood !== "blocked" && mood !== "error";
  const label = `${character.name}, ${classLabel}${keeper ? ", Keeper" : ""}, ${MOOD_WORD[mood]}`;
  return <section ref={strip} className="tavern twalk" data-part="TavernWalk" aria-label={`${character.name} walking`}>
    <span className="twalk-ground" aria-hidden="true" />
    <canvas ref={canvas} className="twalk-canvas" height={HEIGHT} aria-hidden="true" />
    <button ref={button} type="button" className="tchar twalk-actor" data-actor={actor.id} data-mood={mood}
      aria-label={line && canSpeak ? `${label}. Click for a word.` : label}
      onPointerEnter={() => runtime.current?.cue("notice", false)}
      onClick={() => {
        runtime.current?.cue("hop", false);
        const { typing, held } = motion.getHolds(props.surface);
        if (!canSpeak || typing || held || props.held || attentionInView()) return;
        props.onActorClick?.(actor.id);
        if (!line || props.speech !== undefined) return;
        setLocalSpeech({ actorId: actor.id, text: line });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setLocalSpeech(null), SPEECH_MS);
      }}>
      {mood === "waiting" && <span className="tchar-need" aria-hidden="true">!</span>}
    </button>
    {canSpeak && words && <span ref={bubble} className="twalk-speech" role="status" hidden>{words}</span>}
  </section>;
}
