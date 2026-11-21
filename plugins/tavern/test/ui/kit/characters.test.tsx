// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CHARACTER_GAG_MS, CHARACTER_PALETTE_FALLBACK, TavernCharacter, bodyWidth, characterLook, characterMode, characterPose,
  characterState, darkTheme, drawCharacter, fireFlicker, readPalette, CHARACTER_GRID, CHARGE_PIXELS,
  type CharacterPalette, type CharacterState,
} from "../../../src/ui/kit/characters";
import { characterDefSchema } from "../../../src/shared/schema";
import { motion } from "../../../src/ui/kit/motion";
import { PartyStrip } from "../../../src/ui/engine";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { clearThreadState } from "../../../src/ui/thread/state";
import { installAnimations, installMatchMedia } from "./motion-fakes";

const SHIPPED = ["ada", "bram", "fern", "juno", "lark", "moss", "otto", "pip", "rook", "tam", "vex", "wren"];
const wren = { id: "wren", name: "Wren", hue: "teal", charge: "chevron" } as const;
const cls = { shape: "shield", label: "Keeper" } as const;

/** A 2D context that records what was drawn, since jsdom has no canvas. Gradients are captured too, for the fire's glow. */
function recording() {
  const rects: { x: number; y: number; w: number; h: number; colour: string }[] = [];
  const gradients: { x1: number; y1: number; r1: number; stops: [number, string][] }[] = [];
  const ctx = {
    fillStyle: "" as unknown, imageSmoothingEnabled: true, globalCompositeOperation: "source-over",
    clearRect: () => {}, save: () => {}, restore: () => {}, translate: () => {}, scale: () => {},
    beginPath: () => {}, rect: () => {}, clip: () => {},
    fillRect(this: { fillStyle: unknown }, x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, colour: String(this.fillStyle) }); },
    createRadialGradient(_x0: number, _y0: number, _r0: number, x1: number, y1: number, r1: number) {
      const g = { x1, y1, r1, stops: [] as [number, string][], addColorStop(this: { stops: [number, string][] }, offset: number, colour: string) { this.stops.push([offset, colour]); } };
      gradients.push(g);
      return g;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, gradients };
}

describe("a character's look", () => {
  it("is seeded from the id alone: same id, same character, anywhere", () => {
    expect(characterLook({ id: "wren" })).toEqual(characterLook({ id: "wren" }));
    const looks = SHIPPED.map(id => characterLook({ id }));
    expect(new Set(looks.map(l => `${l.build}/${l.hair}/${l.hairColour}/${l.skin}/${l.hat}/${l.torso}/${l.head}`)).size).toBeGreaterThan(6);
  });

  it("keeps every body inside the drawn grid, whatever the seed", () => {
    for (const id of SHIPPED) {
      const look = characterLook({ id });
      expect(bodyWidth(look)).toBeGreaterThanOrEqual(8);
      expect(bodyWidth(look)).toBeLessThanOrEqual(10);
      expect(look.torso).toBeGreaterThanOrEqual(7);
      expect(look.torso).toBeLessThanOrEqual(9);
      expect(look.head).toBeGreaterThanOrEqual(6);
      expect(look.head).toBeLessThanOrEqual(7);
    }
  });

  it("lets a character file's look override any trait it names, and keeps the rest seeded", () => {
    const seeded = characterLook({ id: "wren" });
    const edited = characterLook({ id: "wren", look: { hair: "bald", hat: "none", build: "broad" } });
    expect(edited.hair).toBe("bald");
    expect(edited.hat).toBe("none");
    expect(edited.build).toBe("broad");
    expect(edited.hairColour).toBe(seeded.hairColour);
    expect(edited.skin).toBe(seeded.skin);
    expect(edited.torso).toBe(seeded.torso);
    expect(bodyWidth(edited)).toBe(10);
  });

  it("reads the shipped character files: an edited file changes the generated character", () => {
    const file = (id: string) => {
      const text = readFileSync(join(process.cwd(), "characters", `${id}.md`), "utf8");
      const [, frontmatter = ""] = /^---\n([\s\S]*?)\n---/.exec(text) ?? [];
      return characterDefSchema.parse({ ...(parse(frontmatter) as object), body: "", source: "test" });
    };
    const wren = file("wren");
    expect(wren.look).toEqual({ hat: "pointy", hair: "long", hairColour: "sand" });
    expect(characterLook(wren).hat).toBe("pointy");
    expect(characterLook(wren).hair).toBe("long");
    // The same id without the file's overrides: the file is what changed it, not the seed.
    expect(characterLook({ id: "wren" }).hat).not.toBe("pointy");
    // A file with no `look:` leaves the seed alone: the seed is the character.
    expect(file("ada").look).toBeUndefined();
    expect(characterLook(file("ada"))).toEqual(characterLook({ id: "ada" }));
    // Every shipped character file parses (the schema is strict, so a typo in a trait fails here), and an override moves the look.
    const parsed = SHIPPED.map(file);
    expect(parsed.filter(c => c.look).map(c => c.id)).toEqual(["bram", "moss", "pip", "rook", "vex", "wren"]);
    for (const c of parsed) if (c.look) expect(characterLook(c)).not.toEqual(characterLook({ id: c.id }));
  });

  it("changes the drawn body when a file overrides it", () => {
    const palette = CHARACTER_PALETTE_FALLBACK;
    const plain = recording(), broad = recording();
    const a = characterLook({ id: "wren", look: { build: "slim", hair: "flat" } });
    const b = characterLook({ id: "wren", look: { build: "broad", hair: "long" } });
    drawCharacter({ ctx: plain.ctx, hue: "teal", look: a, palette, pose: characterPose({ look: a, state: "idle", ts: 0, mode: "interval", keeper: false }) });
    drawCharacter({ ctx: broad.ctx, hue: "teal", look: b, palette, pose: characterPose({ look: b, state: "idle", ts: 0, mode: "interval", keeper: false }) });
    expect(broad.rects).not.toEqual(plain.rects);
  });
});

describe("states and modes", () => {
  it("reads a thread's state as the character's own", () => {
    expect(characterState("working")).toBe("working");
    expect(characterState("busy")).toBe("working");
    expect(characterState("idle")).toBe("idle");
    expect(characterState("waiting")).toBe("idle");
    expect(characterState("failed")).toBe("error");
    expect(characterState("stopped")).toBe("error");
    expect(characterState("idle", true)).toBe("needs-you");
    expect(characterState(null)).toBe("idle");
  });

  it("takes its mode from the Motion setting unless a caller pins one", () => {
    expect(characterMode("calm")).toBe("interval");
    expect(characterMode("off")).toBe("interval");
    expect(characterMode("lively")).toBe("continuous");
    expect(characterMode("calm", "continuous")).toBe("continuous");
    expect(characterMode("lively", "interval")).toBe("interval");
  });
});

describe("the pose", () => {
  const look = characterLook({ id: "wren" });
  const poseOf = (state: CharacterState, ts: number, mode: "interval" | "continuous", keeper = false, gag: { kind: "hop"; progress: number } | null = null) =>
    characterPose({ look, state, ts, mode, keeper, gag });

  it("holds still in interval mode, at any instant", () => {
    for (const ts of [0, 137, 5000]) expect(poseOf("idle", ts, "interval")).toEqual(poseOf("idle", 0, "interval"));
    expect(poseOf("working", 900, "interval").arm).toBe(0);
  });

  it("loops in continuous mode: a breath at rest, a strike at work, rain when it failed", () => {
    expect(poseOf("idle", 0, "continuous").bob).toBe(0);
    expect(poseOf("idle", 600, "continuous").bob).toBe(1);
    const arms = [0, 200, 500, 700, 900].map(ts => poseOf("working", ts, "continuous").arm);
    expect(arms.some(a => a !== 0)).toBe(true);
    expect(poseOf("error", 600, "continuous").err).toBe(true);
    expect(poseOf("error", 600, "continuous").rain).toBeGreaterThan(0);
  });

  it("looks up when it needs you, and never moves a still pose under reduced motion", () => {
    expect(poseOf("needs-you", 0, "interval").lookUp).toBe(true);
    expect(poseOf("needs-you", 600, "continuous", false, null).bob).toBeGreaterThanOrEqual(0);
  });

  it("gives the Keeper an ember nobody else has, and only in continuous mode", () => {
    const risen = [0, 4400, 4700, 5000].map(ts => poseOf("idle", ts, "continuous", true).ember);
    expect(risen.some(e => e > 0)).toBe(true);
    expect([0, 4400, 4700, 5000].map(ts => poseOf("idle", ts, "continuous", false).ember).every(e => e === 0)).toBe(true);
    expect([0, 4400, 4700].map(ts => poseOf("idle", ts, "interval", true).ember).every(e => e === 0)).toBe(true);
  });

  it("draws every gag it is told to, from its own progress", () => {
    expect(poseOf("idle", 0, "interval", false, { kind: "hop", progress: 0.1 }).jump).toBe(3);
  });
});

describe("the drawing", () => {
  const palette: CharacterPalette = CHARACTER_PALETTE_FALLBACK;
  const look = characterLook({ id: "wren" });
  const pose = characterPose({ look, state: "idle", ts: 0, mode: "interval", keeper: false });

  it("draws the character in its own hue, and a Keeper as more than anyone else", () => {
    const plain = recording(), keeper = recording();
    drawCharacter({ ctx: plain.ctx, hue: "teal", look, palette, pose, cls: "smith" });
    drawCharacter({ ctx: keeper.ctx, hue: "teal", look, palette, pose, cls: "keeper", keeper: true });
    expect(plain.rects.some(r => r.colour === palette.hue.teal)).toBe(true);
    // The cloak, the two belt lights and the ember: a Keeper's silhouette is its own.
    expect(keeper.rects.length).toBeGreaterThan(plain.rects.length + 2);
    expect(keeper.rects.some(r => r.colour === palette.cloak)).toBe(true);
    expect([...keeper.rects, ...plain.rects].every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= 24 && r.y + r.h <= 26)).toBe(true);
  });

  it("carries a different tool by class, so a Smith and a Guardian never hold the same thing", () => {
    const smith = recording(), warden = recording();
    drawCharacter({ ctx: smith.ctx, hue: "violet", look, palette, pose, cls: "smith" });
    drawCharacter({ ctx: warden.ctx, hue: "plum", look, palette, pose, cls: "warden" });
    expect(smith.rects).not.toEqual(warden.rects);
  });

  it("wears its heraldic charge on its chest, in pixels, and none without one", () => {
    const look = characterLook({ id: "ada" });
    const pose = characterPose({ look, state: "idle", ts: 0, mode: "interval", keeper: false });
    const pixels = (charge: keyof typeof CHARGE_PIXELS) => CHARGE_PIXELS[charge].join("").split("#").length - 1;
    const bare = recording();
    drawCharacter({ ctx: bare.ctx, hue: "teal", look, palette, pose });
    expect(bare.rects.some(r => r.colour === palette.card)).toBe(false);
    for (const charge of Object.keys(CHARGE_PIXELS) as (keyof typeof CHARGE_PIXELS)[]) {
      const rec = recording();
      drawCharacter({ ctx: rec.ctx, hue: "teal", look, palette, pose, charge });
      const chest = rec.rects.filter(r => r.colour === palette.card);
      expect(chest).toHaveLength(pixels(charge));
      // On the torso, inside the grid: never over the belt, the legs or the arms.
      expect(chest.every(r => r.x >= 10 && r.x <= 14 && r.y >= 0 && r.y + r.h <= 26)).toBe(true);
    }
  });

  it("paints a chunky pixel pool on the road in the dark, never a smooth ball", () => {
    const look = characterLook({ id: "ada", look: { light: "lantern" } });
    const pose = characterPose({ look, state: "idle", ts: 0, mode: "interval", keeper: false });
    const lit = recording();
    drawCharacter({ ctx: lit.ctx, hue: "teal", look, palette: { ...palette, dark: true }, pose, flame: 1 });
    // No gradients at all: the glow is painted one pixel at a time.
    expect(lit.gradients).toHaveLength(0);
    const pool = lit.rects.filter(r => r.colour === palette.hearth && r.w === 1 && r.h === 1);
    expect(pool.length).toBeGreaterThan(20);
    const xs = pool.map(r => r.x), ys = pool.map(r => r.y);
    // A flat pool, not a ball: much wider than it is deep, sitting on the ground line.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan((Math.max(...ys) - Math.min(...ys)) * 2);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(CHARACTER_GRID.ground);
    // The light theme paints no pool.
    const off = recording();
    drawCharacter({ ctx: off.ctx, hue: "teal", look, palette, pose, flame: 1 });
    expect(off.rects.filter(r => r.colour === palette.hearth)).toHaveLength(0);
  });

  it("leans the road pool toward the way the walker travels", () => {
    const look = characterLook({ id: "ada", look: { light: "lantern" } });
    const pose = characterPose({ look, state: "idle", ts: 0, mode: "interval", keeper: false });
    const centroid = (dir: number) => {
      const rec = recording();
      drawCharacter({ ctx: rec.ctx, hue: "teal", look, palette: { ...palette, dark: true }, pose, flame: 1, dir });
      const pool = rec.rects.filter(r => r.colour === palette.hearth && r.w === 1 && r.h === 1);
      return pool.reduce((n, r) => n + r.x, 0) / pool.length;
    };
    expect(centroid(1)).toBeGreaterThan(centroid(-1));
  });

  it("flickers the fire on its own detuned beat, never a metronome", () => {
    const vals = [0, 40, 90, 200, 350, 610].map(t => fireFlicker(t, 7));
    expect(new Set(vals.map(v => v.toFixed(3))).size).toBeGreaterThan(3);
    expect(vals.every(v => v > 0.6 && v < 1.2)).toBe(true);
  });

  it("carries a lantern or a torch only in the dark, its glass or flame lit", () => {
    const look = characterLook({ id: "wren", look: { light: "lantern" } });
    const pose = characterPose({ look, state: "idle", ts: 0, mode: "interval", keeper: false });
    const lit = recording();
    drawCharacter({ ctx: lit.ctx, hue: "teal", look, palette: { ...palette, dark: true }, pose });
    const unlit = recording();
    drawCharacter({ ctx: unlit.ctx, hue: "teal", look, palette, pose });
    // Light theme: no lantern at all, whatever the look says.
    expect(unlit.rects.some(r => r.colour === palette.metal)).toBe(false);
    // Dark theme: the lantern's metal frame and base, and its lit glass.
    expect(lit.rects.some(r => r.colour === palette.metal)).toBe(true);
    expect(lit.rects.some(r => r.colour === palette.hearth)).toBe(true);
    expect(lit.rects.some(r => r.colour === palette.wood)).toBe(false);
    // A torch uses a wooden handle, not the lantern's metal frame.
    const torch = characterLook({ id: "wren", look: { light: "torch" } });
    const t = recording();
    drawCharacter({ ctx: t.ctx, hue: "teal", look: torch, palette: { ...palette, dark: true }, pose });
    expect(t.rects.some(r => r.colour === palette.wood)).toBe(true);
    expect(t.rects.some(r => r.colour === palette.hearth)).toBe(true);
  });

  it("paints the rain cloud only when it failed", () => {
    const calm = recording(), failed = recording();
    drawCharacter({ ctx: calm.ctx, hue: "teal", look: characterLook({ id: "wren" }), palette, pose, cls: "keeper" });
    drawCharacter({ ctx: failed.ctx, hue: "teal", look: characterLook({ id: "wren" }), palette, pose: characterPose({ look, state: "error", ts: 0, mode: "interval", keeper: false }), cls: "keeper" });
    expect(calm.rects.some(r => r.colour === palette.cloud)).toBe(false);
    expect(failed.rects.some(r => r.colour === palette.cloud)).toBe(true);
    expect(failed.rects.some(r => r.colour === palette.drop)).toBe(true);
  });
});

describe("readPalette", () => {
  it("falls back when there is no element to read a theme from", () => {
    expect(readPalette(null)).toEqual(CHARACTER_PALETTE_FALLBACK);
  });

  it("reads dark from the page background's luminance", () => {
    expect(darkTheme("rgb(20, 20, 22)")).toBe(true);
    expect(darkTheme("rgb(243, 236, 220)")).toBe(false);
    expect(darkTheme("not-a-colour")).toBe(false);
  });

  it("keeps a walker's hover to a brightening, never a background square", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/kit/characters.css"), "utf8");
    // The sprite is a button with Tavern's `.act` marker, whose hover fill would show as a square behind the walker.
    expect(css).toMatch(/\.tchar\.act:hover:not\(:disabled\)\s*\{\s*background:\s*none/);
  });

  it("pins the eye ink to a dark literal, so the eyes never turn white in the dark", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/kit/characters.css"), "utf8");
    expect(css).toMatch(/--tchar-ink:\s*#3b342a/);
    expect(css).not.toMatch(/--tchar-ink:\s*var\(--tavern-ink\)/);
  });
});

describe("TavernCharacter", () => {
  let animations: ReturnType<typeof installAnimations>;
  let drawn: ReturnType<typeof recording>;
  let rect: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    motion.reset();
    drawn = recording();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawn.ctx);
    rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 10, bottom: 40, left: 0, right: 24, width: 24, height: 26 } as DOMRect);
    animations = installAnimations({ "mo-char-hop": CHARACTER_GAG_MS.hop, "mo-char-notice": CHARACTER_GAG_MS.notice, "mo-char-wave": CHARACTER_GAG_MS.wave, "mo-char-tap": CHARACTER_GAG_MS.tap, "mo-char-blink": CHARACTER_GAG_MS.blink, "mo-char-drop": CHARACTER_GAG_MS.drop });
  });
  afterEach(() => { cleanup(); animations.uninstall(); rect.mockRestore(); vi.restoreAllMocks(); motion.reset(); vi.useRealTimers(); clearThreadState(); });

  const sprite = (props: Partial<Parameters<typeof TavernCharacter>[0]> = {}) =>
    render(<div className="tavern"><TavernCharacter character={wren} cls={cls} surface="thread:t1" {...props} /></div>);
  const el = (container: HTMLElement) => container.querySelector("[data-part=TavernCharacter]")!;

  it("draws the character and names its state out loud", () => {
    const v = sprite({ state: "working" });
    expect(el(v.container).getAttribute("data-state")).toBe("working");
    expect(v.container.querySelector(".tchar-art")!.getAttribute("aria-label")).toBe("Wren, Keeper, at work");
    // The charge is drawn on the sprite's chest now, not laid over it: no separate crest node in the row.
    expect(v.container.querySelector(".tchar-badge")).toBeNull();
    expect(drawn.rects.length).toBeGreaterThan(0);
  });

  it("marks a character that needs you, and never marks the others", () => {
    expect(sprite({ state: "needs-you" }).container.querySelector(".tchar-need")).not.toBeNull();
    expect(sprite({ state: "idle" }).container.querySelector(".tchar-need")).toBeNull();
  });

  it("hops and says its line when clicked, and turns its head when hovered", () => {
    const spy = vi.spyOn(motion, "cue");
    const v = sprite({ line: "Clear morning. Rangers out." });
    const who = el(v.container);
    expect(who.tagName).toBe("BUTTON");
    act(() => { fireEvent.pointerOver(who); });
    expect(spy.mock.calls.filter(c => c[2] === "character gag" && c[3].className === "mo-char-notice")).toHaveLength(1);
    act(() => { fireEvent.click(who); });
    expect(spy.mock.calls.some(c => c[2] === "character gag" && c[3].className === "mo-char-hop")).toBe(true);
    expect(v.container.querySelector(".tchar-say")!.textContent).toBe("Clear morning. Rangers out.");
  });

  it("is a picture, not a control, inside another control", () => {
    const v = sprite({ interactive: false });
    expect(el(v.container).tagName).toBe("SPAN");
    expect(v.container.querySelector("button")).toBeNull();
  });

  it("keeps still when motion is off: no timer, no gag", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(motion, "cue");
    const v = sprite({ ambientMotion: "off", repeatSeconds: 3 });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(9000); });
    expect(spy).not.toHaveBeenCalled();
    expect(el(v.container).getAttribute("data-mode")).toBe("interval");
  });

  it("gags on its interval in interval mode, as an ambient cue its surface can hold", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(motion, "cue");
    const v = sprite({ ambientMotion: "calm", repeatSeconds: 3, region: "widget" });
    // The interval timer plus the sprite's own animation loop; motion-off leaves neither (below).
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    act(() => { vi.advanceTimersByTime(3000); });
    const gags = () => spy.mock.calls.filter(c => c[2] === "character gag");
    expect(gags()).toHaveLength(1);
    expect(gags()[0]![3].auto).toBe(true);
    expect(gags()[0]![3].region).toBe("widget");
    // The next interval brings another, so the sprite is alive for as long as it is on screen.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(gags().length).toBeGreaterThan(1);
    v.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("loops continuously in continuous mode, and only then", () => {
    vi.useFakeTimers();
    const continuous = sprite({ mode: "continuous" });
    drawn.rects.length = 0;
    act(() => { vi.advanceTimersByTime(400); });
    expect(drawn.rects.length).toBeGreaterThan(0);
    continuous.unmount();
    drawn.rects.length = 0;
    const interval = sprite({ mode: "interval" });
    const still = drawn.rects.length;
    expect(still).toBeGreaterThan(0); // the still frame on mount
    act(() => { vi.advanceTimersByTime(400); });
    expect(drawn.rects.length).toBe(still); // and nothing more at rest
    interval.unmount();
  });

  it("loops on the Motion setting alone: Lively is continuous, Calm is not", () => {
    const lively = sprite({ ambientMotion: "lively" });
    expect(el(lively.container).getAttribute("data-mode")).toBe("continuous");
    lively.unmount();
    expect(el(sprite({ ambientMotion: "calm" }).container).getAttribute("data-mode")).toBe("interval");
  });

  it("keeps still under reduced motion, and still says its line", async () => {
    const media = installMatchMedia();
    try {
      vi.useFakeTimers();
      const spy = vi.spyOn(motion, "cue");
      const v = sprite({ ambientMotion: "lively", line: "Fair skies." });
      act(() => { media.set(true); });
      expect(el(v.container).getAttribute("data-mode")).toBe("continuous");
      expect(vi.getTimerCount()).toBe(0);
      drawn.rects.length = 0;
      act(() => { fireEvent.pointerOver(el(v.container)); fireEvent.click(el(v.container)); });
      act(() => { vi.advanceTimersByTime(200); });
      expect(spy).not.toHaveBeenCalled();
      expect(drawn.rects.length).toBe(0);
      expect(v.container.querySelector(".tchar-say")!.textContent).toBe("Fair skies.");
      act(() => { vi.advanceTimersByTime(3000); });
      expect(v.container.querySelector(".tchar-say")).toBeNull();
    } finally { media.uninstall(); }
  });

  it("draws one canvas on its own strip, with a focusable actor and a separate class crest", async () => {
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { registry: () => fixtureRegistry, decor: () => fixtureDecor } });
    await waitFor(() => expect(slot.container.querySelector("[data-part=TavernWalk] button[data-actor]")).not.toBeNull());
    const who = slot.container.querySelector("[data-part=TavernWalk] button[data-actor]")!;
    expect(who.getAttribute("aria-label")).toContain("needs you");
    expect(slot.container.querySelector("[data-part=TavernWalk]")!.getAttribute("aria-label")).toMatch(/walking$/);
    expect(slot.container.querySelectorAll("[data-part=TavernWalk] canvas")).toHaveLength(1);
    // The row keeps the class crest where the sprite used to stand, and its busy dot.
    expect(slot.container.querySelector(".tw-crest [data-part=TavernCharacter]")).toBeNull();
    expect(slot.container.querySelector(".tw-crest .tavern-crest")).not.toBeNull();
    expect(slot.container.querySelector(".tw-id .tw-dot")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("draws no strip at all when the Characters setting is off, and keeps the class crest", async () => {
    const decor = { ...fixtureDecor, characters: false };
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { registry: () => fixtureRegistry, decor: () => decor } });
    await waitFor(() => expect(slot.container.querySelector(".tw-crest .tavern-crest")).not.toBeNull());
    // No strip, no sprite, no canvas: the row falls back to the crest alone.
    expect(slot.container.querySelector("[data-part=TavernWalk]")).toBeNull();
    expect(slot.container.querySelector("[data-part=TavernCharacter]")).toBeNull();
    expect(slot.container.querySelector("canvas")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps the member's row a single control: the walking sprite is never nested in its button", async () => {
    const decor = { ...fixtureDecor, member: { ...fixtureDecor.member!, role: "member" as const }, keeperView: null, boardQuest: fixtureDecor.keeperView!.boardQuests[0] };
    const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { registry: () => fixtureRegistry, decor: () => decor } });
    await waitFor(() => expect(slot.container.querySelector("[data-part=TavernWalk] button[data-actor]")).not.toBeNull());
    const who = slot.container.querySelector("[data-part=TavernWalk] button[data-actor]")!;
    expect(who.getAttribute("data-mood")).toBe("idle");
    // The member's row is a button holding only the crest; no button nests a button.
    expect(slot.container.querySelector(".tw-member-id")!.tagName).toBe("BUTTON");
    expect(slot.container.querySelector(".tw-member-id [data-part=TavernCharacter]")).toBeNull();
    expect(slot.container.querySelector(".tw-member-id .tavern-crest")).not.toBeNull();
    expect(slot.container.querySelectorAll("button[data-actor]")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("sends strip cues through the coordinator and keeps held clicks free of speech", () => {
    const cue = vi.spyOn(motion, "cue");
    const onActorClick = vi.fn();
    const props = { character: wren, classId: "keeper", classLabel: "Keeper", keeper: true, surface: "thread:t1", region: "widget", onActorClick } as const;
    const v = render(<PartyStrip {...props} mood="idle" />);
    const strip = v.container.querySelector<HTMLElement>(".twalk")!;
    Object.defineProperty(strip, "clientWidth", { value: 320 });
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(cue).not.toHaveBeenCalled();
    v.rerender(<PartyStrip {...props} mood="working" />);
    v.rerender(<PartyStrip {...props} mood="working" />);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue.mock.lastCall?.[3]).toMatchObject({ auto: true, key: "wren:tap:1", region: "widget" });

    const actor = strip.querySelector("button")!;
    act(() => { fireEvent.pointerOver(actor); fireEvent.click(actor); });
    expect(cue.mock.calls.slice(1).map(c => [c[3].key, c[3].auto])).toEqual([["wren:notice:2", false], ["wren:hop:3", false]]);
    expect(onActorClick).toHaveBeenCalledWith("wren");
    const speech = { actorId: "wren", text: "Clear skies." };
    v.rerender(<PartyStrip {...props} mood="working" speech={speech} />);
    expect(strip.querySelector('[role="status"]')).toHaveProperty("hidden", false);
    expect(strip.querySelector('[role="status"]')?.textContent).toBe("Clear skies.");
    v.rerender(<PartyStrip {...props} mood="working" speech={speech} held />);
    expect(strip.querySelector('[role="status"]')).toBeNull();
    act(() => { fireEvent.pointerOver(actor); });
    expect(cue).toHaveBeenCalledTimes(3);
    act(() => { fireEvent.click(actor); });
    expect(cue).toHaveBeenCalledTimes(4);
    expect(cue.mock.lastCall?.[2]).toBe("character reaction");
    expect(cue.mock.lastCall?.[3]).toMatchObject({ auto: false });
    expect(onActorClick).toHaveBeenCalledTimes(1);
  });

  it("keeps drawing while its surface is held, so a held sprite never reads dead", () => {
    vi.useFakeTimers();
    const v = sprite({ mode: "continuous" });
    act(() => { motion.setHeld("thread:t1", true); });
    drawn.rects.length = 0;
    act(() => { vi.advanceTimersByTime(400); });
    expect(drawn.rects.length).toBeGreaterThan(0);
    act(() => { motion.setHeld("thread:t1", false); });
    v.unmount();
  });
});
