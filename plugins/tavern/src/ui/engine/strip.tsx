import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { CharacterDef } from "../../shared/schema";
import type { StripRoad } from "../../shared/strip-scene";
import { RoadControls } from "./road-controls";
import { drawRoad, layoutRoad, ROAD_BEAT, ROAD_RISE, type RoadLayout } from "./road-places";
import { clockTime } from "../../shared/time";
import { readPalette, type CharacterPalette } from "../kit/characters";
import { motion, stuckInView, type Surface } from "../kit/motion";
import { Actor, type Reaction } from "./actor";
import { CUE_MS, type Cue, type LightAnchor, type Mood } from "./art";
import { CharacterMenu } from "./character-menu";
import { connectStripLantern, daylightGlint, drawDaylight, lightBreath } from "./light";
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

export type StripSpeech = { actorId: string; text: string; contextual?: boolean; announce?: boolean };
export type AskDisclosure = { panelId: string; expanded: boolean; open: (button: HTMLButtonElement) => void };

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
  road?: StripRoad;
  canClickSpeak?: boolean;
  askDisclosure?: AskDisclosure;
  onActorClick?: (actorId: string) => void;
  onMoodCueEnd?: () => void;
  onSpeechVisible?: (visible: boolean) => void;
  actorMenu?: Pick<ComponentProps<typeof CharacterMenu>, "mode" | "voice" | "voiceBeforeOff" | "quietUntil" | "change" | "openSheet">;
};

export function PartyStrip(props: PartyStripProps) {
  const { character, classId, classLabel, keeper, mood, speech } = props;
  const scene = props.pageScene;
  const roadKey = props.road ? JSON.stringify(props.road) : "";
  const road = useMemo(() => props.road, [roadKey]);
  const [lane, setLane] = useState(0);
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
  const roadCanvas = useRef<HTMLCanvasElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const runtime = useRef<{ invalidate(change?: () => void): void; cue(kind: Cue, auto: boolean, onEnd?: () => void): void; click(): void; wander(): void; highlight(id: string | null): void }>(null);
  const latest = useRef({ ...props, road });
  const highlight = useCallback((id: string | null) => runtime.current?.highlight(id), []);
  const layout = useMemo(() => road && layoutRoad(road, lane, art.width * SCALE, !!props.askDisclosure), [road, lane, art.width, !!props.askDisclosure]);
  const words = !props.held && speech?.actorId === actor.id ? speech.text : null;

  useLayoutEffect(() => { latest.current = { ...props, road }; });
  useLayoutEffect(() => {
    const applyMood = () => {
      actor.art = art;
      if (road && props.mode === "lively" && actor.mood === "working" && mood === "idle") runtime.current?.wander();
      return actor.setMood(mood);
    };
    let cue: Cue | null = null;
    if (runtime.current) runtime.current.invalidate(() => { cue = applyMood(); });
    else cue = applyMood();
    if (scene && (props.held || props.quiet || isAttentionMood(mood) || props.mode === "off")) motion.settle(c => c.el === button.current);
    if (cue && !scene) {
      if (runtime.current) runtime.current.cue(cue, true, props.onMoodCueEnd);
      else props.onMoodCueEnd?.();
    }
  }, [actor, art, mood, props.mode, props.held, props.quiet, words, scene, !!props.askDisclosure, road]);

  useLayoutEffect(() => {
    const el = strip.current!, board = canvas.current!, control = button.current!;
    const lantern = props.region === "widget" && !scene ? connectStripLantern(el) : null;
    let ctx: CanvasRenderingContext2D | null | undefined;
    const composer = el.closest<HTMLElement>("[data-app-composer]");
    let palette: CharacterPalette = readPalette(control);
    actor.dark = document.documentElement.classList.contains("dark");
    let width = 0;
    let track = 0;
    let span = 0;
    let lastPosition = "";
    let cueNumber = 0;
    let sceneMode: MotionMode = "off";
    let drawnLight: LightAnchor | null = null;
    let drawnX = 0;
    let drawnY = 0;
    let inView = false;
    let roadTime = 0, hoverAt = 0, riseAt = -Infinity;
    let hovered: string | null = null;
    let roadInput: StripRoad | undefined, roadLayout: RoadLayout | null = null;
    let roadWidth = -1, roadAsk = false;
    let roadPaint: { layout: RoadLayout; palette: CharacterPalette; hovered: string | null; beat: number; rise: number; spark: boolean } | null = null;
    const syncRoad = () => {
      const input = latest.current.road;
      const ask = !!latest.current.askDisclosure;
      if (input === roadInput && track === roadWidth && ask === roadAsk) return false;
      const fresh = !!input && input.key !== roadInput?.key;
      if (!fresh && input && input.current !== roadInput?.current && mode() === "lively" && !holds().held) riseAt = roadTime;
      else if (fresh || ask || !input) riseAt = -Infinity;
      roadInput = input;
      roadWidth = track;
      roadAsk = ask;
      roadLayout = input ? layoutRoad(input, track, actor.art.width * SCALE, ask) : null;
      return fresh;
    };
    const speechVisibility = (visible: boolean) => {
      const { typing, held } = motion.getHolds(latest.current.surface);
      latest.current.onSpeechVisible?.(visible && !document.hidden && !typing && !held);
    };
    const holds = () => {
      const { surface, held } = latest.current;
      const current = motion.getHolds(surface);
      return { typing: current.typing || !!latest.current.road && control.matches(":focus-visible"),
        held: held ?? current.held };
    };
    const mode = () => latest.current.quiet ? "off" : scene ? sceneMode : latest.current.mode ?? "calm";
    let activeRules = { mode: mode(), ...holds() };
    let painted: { x: number; y: number; key: number; art: typeof art; palette: CharacterPalette; stride: number; glint: number } | null = null;
    const world: EngineWorld = {
      mode,
      refresh() {
        activeRules = { mode: mode(), ...holds() };
        if (latest.current.onSpeechVisible) speechVisibility(inView);
        const fresh = syncRoad();
        const anchored = actor.setRoadHome(roadLayout?.items.length ? roadLayout.home : null,
          fresh || activeRules.mode !== "lively" || activeRules.held || isAttentionMood(actor.mood));
        return actor.setRules(activeRules, span) || anchored;
      },
      update(seconds, steps) {
        if (scene && (!motion.mayLoop("page") || stuckInView())) motion.settle(cue => cue.el === control);
        roadTime += seconds * steps * 1_000;
        actor.update(seconds, span, activeRules, steps);
      },
      nextDraw() {
        const actorDue = actor.nextDraw(span);
        if (roadTime - riseAt < ROAD_RISE) return 0;
        if (!hovered) return actorDue;
        return Math.min(actorDue ?? Infinity, ROAD_BEAT - (roadTime - hoverAt + 1e-6) % ROAD_BEAT);
      },
      draw(still) {
        const spriteWidth = actor.art.width * SCALE;
        const spriteHeight = actor.art.height * SCALE;
        const ask = !!latest.current.askDisclosure;
        const roadHome = roadLayout?.items.length ? roadLayout.home : null;
        if (still && roadHome !== null) actor.setRoadHome(roadHome, true);
        const x = roadHome !== null && (still || ask) ? roadHome : ask ? 0
          : scene && (still || !scene.road) ? Math.max(0, Math.floor((width - spriteWidth) / 2)) : Math.round(actor.body.x / SCALE) * SCALE;
        const askControl = askButton.current;
        if (askControl) {
          const left = roadLayout?.askX == null ? "" : `${roadLayout.askX}px`;
          if (askControl.style.left !== left) askControl.style.left = left;
        }
        const restY = ground - actor.art.ground * SCALE;
        const y = Math.max(0, restY - (still || actor.small ? 0 : Math.round(actor.body.lift / SCALE) * SCALE));
        const lift = restY - y;
        const speechEl = bubble.current;
        if (speechEl) {
          const left = x - BUBBLE_GAP;
          const right = width - x - spriteWidth - BUBBLE_GAP;
          speechEl.hidden = Math.max(left, right) < (latest.current.speech?.contextual ? 176 : 48);
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
        if (lantern) {
          const held = !!frame.small || activeRules.typing;
          lantern(drawnLight && drawnLight.kind !== "torch" ? {
            kind: drawnLight.kind, x: x + (drawnLight.x + 0.5) * SCALE, y: y + (drawnLight.y + 0.5) * SCALE,
            ground: ground - SCALE,
            intensity: lightBreath(drawnLight.kind, frame, activeRules.mode, held),
            holdRim: held,
          } : null);
        }
        const places = roadCanvas.current;
        if (roadLayout?.items.length && places) {
          const beat = !still && hovered ? Math.floor((roadTime - hoverAt + 1e-6) / ROAD_BEAT) : -1;
          const rise = still || activeRules.held ? 1 : Math.min(1, Math.max(0, (roadTime - riseAt) / ROAD_RISE));
          const spark = actor.art.signature === "hammer" && (frame.cue === "signature" || frame.cue === "tap") &&
            frame.progress > 0.45 && frame.progress < 0.66;
          if (places.width !== width) { places.width = width; roadPaint = null; }
          if (roadPaint?.layout !== roadLayout || roadPaint.palette !== palette || roadPaint.hovered !== hovered ||
              roadPaint.beat !== beat || roadPaint.rise !== rise || roadPaint.spark !== spark) {
            const back = places.getContext("2d");
            if (back) {
              back.clearRect(0, 0, width, height);
              drawRoad(back, roadLayout, width, ground - SCALE, palette, palette.hue[latest.current.character.hue], hovered, beat, rise, spark);
              roadPaint = { layout: roadLayout, palette, hovered, beat, rise, spark };
            }
          }
        } else if (places && roadPaint) {
          places.getContext("2d")?.clearRect(0, 0, places.width, height);
          roadPaint = null;
        }
        if (ctx === undefined) {
          ctx = board.getContext("2d");
          if (ctx) ctx.imageSmoothingEnabled = false;
        }
        if (!ctx) return;
        const key = actor.art.pixelKey(frame);
        const stride = !frame.dark && frame.activity === "walk" ? 2 + Number(frame.step % 4 >= 2) : 0;
        const glint = frame.dark ? 0 : daylightGlint(frame, activeRules.typing);
        if (painted?.x === x && painted.y === y && painted.key === key && painted.art === actor.art && painted.palette === palette &&
          painted.stride === stride && painted.glint === glint) return;
        painted = { x, y, key, art: actor.art, palette, stride, glint };
        ctx.clearRect(0, 0, width, height);
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.rect(0, 0, spriteWidth, spriteHeight);
        ctx.clip("evenodd");
        ctx.scale(SCALE, SCALE);
        actor.art.draw(ctx, frame, palette, frame.dark ? undefined : { sunGlint: glint });
        ctx.restore();
        if (!frame.dark) drawDaylight(ctx, palette.ink, x + spriteWidth / 2, ground, width, SCALE, lift, stride);
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
      track = Math.min(width, composer?.clientWidth || width);
      setLane(track);
      const reach = walkSpan(track, width, actor.art.width * SCALE);
      span = Math.floor(reach / SCALE) * SCALE;
      if (board.width !== width) { board.width = width; painted = null; }
      if (ctx) ctx.imageSmoothingEnabled = false;
    };
    measure();
    const handle = observeWorld(el, world, props.onSpeechVisible ? visible => {
      inView = visible;
      speechVisibility(visible);
    } : undefined);
    const onResize = () => {
      const oldWidth = width, oldTrack = track;
      measure();
      if (oldWidth !== width || oldTrack !== track) handle.invalidate();
    };
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    resize?.observe(el);
    if (composer) resize?.observe(composer);
    if (!resize) window.addEventListener("resize", onResize);
    const theme = new MutationObserver(() => {
      palette = readPalette(control);
      actor.dark = document.documentElement.classList.contains("dark");
      handle.invalidate();
    });
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
      wander: () => actor.wander(span),
      highlight(id) {
        if (hovered !== id) handle.invalidate(() => { hovered = id; hoverAt = roadTime; });
      },
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
  }, [actor, scene?.road, props.region, ground, height, !!props.onSpeechVisible]);

  const status = mood === "waiting" && !props.askDisclosure && !scene ? "waiting" : MOOD_WORD[mood];
  const label = `${character.name}, ${classLabel}${keeper ? ", Keeper" : ""}, ${status}`;
  const until = props.actorMenu?.quietUntil;
  const actorLabel = until ? `${label}. Quiet until ${clockTime(until)}.`
    : props.canClickSpeak && !props.held && !isAttentionMood(mood) ? `${label}. Click for a word.` : label;
  return <section ref={strip} className={`tavern twalk ${scene ? "twalk-page" : "twalk-thread"}`} style={{ height }} data-part="TavernWalk" data-light-held={props.held || undefined} data-page-scene-actor={scene ? scene.road ? "road" : "table" : undefined} aria-label={scene ? undefined : `${character.name} walking`}>
    {scene && <span className="twalk-ground" aria-hidden="true" />}
    {road && <canvas ref={roadCanvas} className="twalk-canvas twalk-road" height={height} aria-hidden="true" />}
    <canvas ref={canvas} className="twalk-canvas twalk-sprite" height={height} aria-hidden="true" />
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
      onFocus={() => { if (!scene && road && props.mode === "lively") runtime.current?.invalidate(); }}
      onBlur={() => { if (!scene && road && props.mode === "lively") runtime.current?.invalidate(); }}
      onPointerEnter={e => { if (!scene && !props.quiet && e.pointerType !== "touch") runtime.current?.cue("notice", false); }}
      onClick={e => {
        if (e.detail > 0 && suppressTap.current) {
          suppressTap.current = false;
          return;
        }
        if (scene) props.onActorClick?.(actor.id);
        else runtime.current?.click();
      }} />
    {props.askDisclosure && <button ref={askButton} type="button" className="twalk-ask-button"
      aria-label={`Open asks for ${character.name}`} aria-expanded={props.askDisclosure.expanded} aria-controls={props.askDisclosure.panelId}
      onClick={event => props.askDisclosure!.open(event.currentTarget)}>
      <span className="tchar-need twalk-need" data-tavern-still aria-hidden="true">!</span>
    </button>}
    {!!layout?.items.length && <RoadControls key={road?.key} items={layout.items} member={character.name} hasAsk={!!props.askDisclosure} title={road?.title} highlight={highlight} />}
    {props.actorMenu && <span id={`${menuId}-hint`} className="sr">{MENU_HINT}</span>}
    {menuTrigger && props.actorMenu && <CharacterMenu id={menuId} trigger={menuTrigger} name={character.name} close={closeMenu} {...props.actorMenu} />}
    {words && <span ref={bubble} className="twalk-speech" data-contextual={speech?.contextual || undefined}
      role={speech?.announce === false ? undefined : "status"} aria-hidden={speech?.announce === false || undefined} hidden><span className="twalk-speech-text">{words}</span></span>}
  </section>;
}
