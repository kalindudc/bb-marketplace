import { useLayoutEffect, useMemo, useRef } from "react";
import type { CharacterDef } from "../../shared/schema";
import { readPalette, type CharacterPalette } from "../kit/characters";
import { motion } from "../kit/motion";
import { Actor } from "./actor";
import { CUE_MS, type Cue } from "./art";
import type { MotionMode } from "./rules";
import { observeWorld, scheduler, type EngineWorld } from "./scheduler";
import { createArt } from "./sprites";
import "./engine.css";

const SCALE = 4;
const CUE_GAP = 32;

export function CharacterAvatar({ character, seed = character.avatar ?? character.id, mode = "calm" }: {
  character: CharacterDef;
  seed?: string;
  mode?: MotionMode;
}) {
  const { id, name, hue, charge, look } = character;
  const classId = character.classes[0] ?? null;
  const art = useMemo(() => createArt({ seed, classId, hue, charge, look, keeper: classId === "keeper" }), [seed, classId, hue, charge, look]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paletteHost = useRef<HTMLSpanElement>(null);
  const worldMode = useRef(mode);
  const invalidate = useRef<() => void>(null);
  const play = useRef<(kind: Cue, auto: boolean) => void>(null);
  useLayoutEffect(() => {
    worldMode.current = mode;
    invalidate.current?.();
  }, [mode]);

  useLayoutEffect(() => {
    const el = canvas.current!;
    let ctx: CanvasRenderingContext2D | null | undefined;
    let palette: CharacterPalette | undefined;
    const actor = new Actor(id, art, "idle");
    let untilCue = CUE_GAP;
    let painted: number | null = null;
    const rules = () => ({ mode: world.mode(), ...motion.getHolds("page") });
    const frameFor = (still: boolean) => {
      const frame = actor.frame(still);
      if (!still && frame.activity === "stand" && frame.t % 9600 >= 6400) frame.activity = "quiet";
      return frame;
    };
    const world: EngineWorld = {
      mode: () => worldMode.current === "off" ? "off" : "calm",
      refresh: () => actor.setRules(rules()),
      update(seconds, steps) {
        actor.update(seconds, 0, rules(), steps);
        untilCue -= seconds * steps;
        if (untilCue > 0) return;
        untilCue = CUE_GAP;
        play.current?.("notice", true);
      },
      nextDraw() {
        if (actor.nextDraw(0) === 0) return 0;
        const frame = frameFor(false);
        const phase = frame.t % 9600;
        return Math.min(art.nextChange(frame) ?? Infinity, (phase < 6400 ? 6400 : 9600) - phase, untilCue * 1000);
      },
      draw(still) {
        if (ctx === undefined) {
          ctx = el.getContext("2d");
          ctx?.setTransform(SCALE, 0, 0, SCALE, 0, 0);
          if (ctx) ctx.imageSmoothingEnabled = false;
        }
        if (!ctx) return;
        palette ??= readPalette(paletteHost.current);
        const frame = frameFor(still);
        const key = art.pixelKey(frame);
        if (painted !== key) { painted = key; art.draw(ctx, frame, palette); }
      },
      suspend(reason) {
        if (reason === "hidden") return;
        actor.stop();
        motion.settle(cue => cue.el === el);
      },
    };
    const handle = observeWorld(el, world);
    invalidate.current = handle.invalidate;
    play.current = (kind, auto) => {
      if (!scheduler.isActive(world)) return;
      let cancel: (() => void) | null = null;
      const ms = CUE_MS[kind];
      if (motion.cue("page", el, "avatar cue", {
        key: `${id}:${kind}:${auto ? "idle" : "greeting"}`, auto, ms, yields: auto,
        run: node => typeof node.animate === "function" ? [node.animate([], { duration: ms })] : [],
        onDone: () => { if (cancel) handle.invalidate(cancel); },
      })) handle.invalidate(() => { cancel = actor.playCue(kind, auto, rules()); });
    };
    const theme = new MutationObserver(() => {
      palette = undefined;
      painted = null;
      handle.invalidate();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => {
      invalidate.current = play.current = null;
      theme.disconnect();
      handle.remove();
    };
  }, [art, id]);

  return <span ref={paletteHost} className="tchar">
    <canvas ref={canvas} className="tv-avatar-art" role="img" aria-label={`${name}'s avatar`}
      width={art.width * SCALE} height={art.height * SCALE} data-avatar-seed={seed} />
    <button className="tv-avatar-greet" type="button" aria-label={`Wave to ${name}`}
      onPointerEnter={() => play.current?.("notice", false)} onClick={() => play.current?.("wave", false)} />
  </span>;
}
