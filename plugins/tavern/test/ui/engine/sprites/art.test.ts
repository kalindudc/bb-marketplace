// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../../../src/server/registry";
import { parseRegistryDefinition } from "../../../../src/server/registry-file";
import { CUES, MOODS, type ArtFrame, type ArtInput, type CharacterArt } from "../../../../src/ui/engine/art";
import { createArt, drawStillAvatar } from "../../../../src/ui/engine/sprites";
import { HAIR, KITS, PARTS, seedTraits } from "../../../../src/ui/engine/sprites/traits";
import { CHARACTER_PALETTE_FALLBACK as palette } from "../../../../src/ui/kit/characters";

const input: ArtInput = { seed: "wren", classId: "keeper", hue: "teal", charge: "chevron", keeper: false };
const rest: ArtFrame = { activity: "stand", cue: null, progress: 0, t: 0, mood: "idle", facing: 1, step: 0, swing: 0, flame: 1, still: true };
const files = new URL("../../../../characters/", import.meta.url);
const shipped = () => readdirSync(files).filter(file => file.endsWith(".md")).sort().map(file => parseRegistryDefinition("character", readFileSync(new URL(file, files), "utf8"), "builtin"));

function recorder(width = 24, height = 28) {
  const pixels = new Array<string>(width * height).fill("");
  let scale = 1;
  const ctx = {
    fillStyle: "",
    clearRect() { pixels.fill(""); },
    setTransform(a: number) { scale = a; },
    fillRect(x: number, y: number, w: number, h: number) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect((x + w) * scale).toBeLessThanOrEqual(width);
      expect((y + h) * scale).toBeLessThanOrEqual(height);
      for (let row = y * scale; row < (y + h) * scale; row++) {
        pixels.fill(this.fillStyle, row * width + x * scale, row * width + (x + w) * scale);
      }
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pixels };
}

function hash(art: CharacterArt, frame = rest) {
  const { ctx, pixels } = recorder();
  art.draw(ctx, frame, palette);
  return createHash("sha256").update(JSON.stringify(pixels)).digest("hex");
}

describe("seeded character art", () => {
  it("has stable shipped ids and snapshots traits for their original seeds", () => {
    const characters = shipped();
    expect(characters.map(c => c.id)).toEqual(["ada", "bram", "fern", "juno", "lark", "moss", "otto", "pip", "rook", "tam", "vex", "wren"]);
    expect(Object.fromEntries(characters.map(c => [c.id, seedTraits({ seed: c.avatar ?? c.id, classId: c.classes[0] ?? null, look: c.look })]))).toMatchSnapshot();
  });

  it("accepts avatar in strict frontmatter without changing the character id", () => {
    const raw = readFileSync(new URL("wren.md", files), "utf8");
    const wren = parseRegistryDefinition("character", raw.replace("id: wren", "id: wren\navatar: another-roll"), "builtin");
    expect(wren).toMatchObject({ id: "wren", avatar: "another-roll" });
    expect(hash(createArt({ ...input, seed: wren.avatar ?? wren.id }))).not.toBe(hash(createArt(input)));
  });

  it("hashes the kept preview and the reloaded character to the same pixels", () => {
    const home = mkdtempSync(join(tmpdir(), "tavern-avatar-"));
    try {
      const root = fileURLToPath(new URL("../../../../", import.meta.url));
      const registry = new Registry(root, home);
      const character = registry.read().characters.find(c => c.id === "wren")!;
      const seed = "7gqda";
      const preview = hash(createArt({ ...input, hue: character.hue, charge: character.charge, look: character.look, seed }));
      registry.saveAvatar(character.id, seed);
      const loaded = new Registry(root, home).read().characters.find(c => c.id === character.id)!;
      expect(loaded.avatar).toBe(seed);
      expect(hash(createArt({ ...input, hue: loaded.hue, charge: loaded.charge, look: loaded.look, seed: loaded.avatar! }))).toBe(preview);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("hashes to the same pixels across calls, instances, and a fresh module", async () => {
    const art = createArt(input);
    expect([art.width, art.height, art.ground]).toEqual([24, 28, 26]);
    const expected = hash(art);
    expect(expected).toMatchSnapshot();
    expect(hash(art)).toBe(expected);
    expect(hash(createArt(input))).toBe(expected);
    vi.resetModules();
    const fresh = await import("../../../../src/ui/engine/sprites");
    expect(hash(fresh.createArt(input))).toBe(expected);
  });

  it("keeps a single equal-width build and reaches every hairstyle in every kit", () => {
    for (const [classId, kit] of Object.entries(KITS)) {
      const traits = Array.from({ length: 512 }, (_, i) => seedTraits({ seed: `roll-${i}`, classId }));
      expect(new Set(traits.map(t => t.hair))).toEqual(new Set(HAIR));
      expect(new Set(traits.map(t => t.tool))).toEqual(new Set([kit.tool]));
      expect(traits.every(t => t.shoulders === t.hips)).toBe(true);
      expect(new Set(traits.map(t => t.shoulders)).size).toBe(1);
      const pointed = traits.filter(t => t.ears === "pointed").length / traits.length;
      expect(pointed).toBeGreaterThan(0.18);
      expect(pointed).toBeLessThan(0.32);
    }
    expect(Object.values(KITS).map(k => k.tool)).toEqual(["ledger-quill", "staff-lantern", "spyglass", "hammer", "crystal-staff", null]);
    expect(Object.keys(PARTS)).not.toContain("facialHair");
    const deny = /beard|moustache|mustache|sideburn|stubble|baseball|hoodie|zipper|sneaker|trainer|eyeglasses|smartphone|logo/;
    for (const part of Object.values(PARTS).flat()) expect(part).not.toMatch(deny);
  });

  it("covers the top two face rows with hair or cloth across every seeded style and kit", () => {
    const seen = new Set<string>();
    const { ctx, pixels } = recorder();
    for (const classId of Object.keys(KITS)) {
      for (let i = 0; i < 40; i++) {
        const roll = { ...input, classId, seed: `roll-${i}` };
        const traits = seedTraits(roll);
        const art = createArt(roll);
        seen.add(traits.hair);
        art.draw(ctx, rest, palette);
        const crown = art.ground - traits.height;
        for (const y of [crown, crown + 1]) {
          const middle = pixels.slice(y * art.width + 9, y * art.width + 15);
          expect(middle, `${classId} ${roll.seed} ${traits.hair} at y=${y}`).not.toContain(palette.skin[traits.skin]);
          expect(middle).not.toContain("");
        }
      }
    }
    expect(seen).toEqual(new Set(HAIR));
  });

  it("keeps silver hair independent of style and varies Wanderer hat fabric", () => {
    const hills = Array.from({ length: 512 }, (_, i) => seedTraits({ seed: `roll-${i}`, classId: "wanderer" }));
    const silver = hills.filter(t => t.hairColour === 3);
    expect(new Set(silver.map(t => t.hair))).toEqual(new Set(HAIR));
    const long = silver.filter(t => ["shoulder-length", "long-straight", "braid", "tied-tail", "bun"].includes(t.hair));
    expect(long.length / silver.length).toBeGreaterThan(0.45);
    const { ctx, pixels } = recorder();
    const hats = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const art = createArt({ ...input, seed: `roll-${i}`, classId: "wanderer" });
      art.draw(ctx, rest, palette);
      hats.add(pixels[(art.ground - hills[i]!.height - 3) * art.width + 11]!);
    }
    expect(hats.size).toBeGreaterThanOrEqual(4);
  });

  it("holds the Smith's hammer visibly higher in the verified rest pose", () => {
    const art = createArt({ ...input, classId: "smith" });
    const { ctx, pixels } = recorder();
    const hammerTop = (mood: ArtFrame["mood"]) => {
      art.draw(ctx, { ...rest, mood }, palette);
      return Math.floor(pixels.findIndex((p, i) => i % art.width >= 18 && p === palette.metal) / art.width);
    };
    const idleTop = hammerTop("idle");
    const verifiedTop = hammerTop("verified");
    expect(verifiedTop).toBeGreaterThan(0);
    expect(idleTop - verifiedTop).toBeGreaterThanOrEqual(3);
  });

  it("maps legacy pins to period parts without changing shoulders", () => {
    expect(seedTraits({ seed: "roll", classId: "smith", look: { build: "broad", hair: "bald", hat: "cap", skin: "deep", hairColour: "rust" } }))
      .toMatchObject({ shoulders: 9, hips: 9, hem: 13, hair: "fringe-crop", hat: "kerchief", skin: 2, hairColour: 4 });
    expect(seedTraits({ seed: "roll", classId: null, look: { hat: "cap", hair: "spiky" } }))
      .toMatchObject({ hat: "soft-cap", hair: "tousled-crop" });
  });

  it("draws visibly different seeded silhouettes and never depends on draw order", () => {
    const hashes = Array.from({ length: 24 }, (_, i) => hash(createArt({ ...input, seed: `roll-${i}` })));
    expect(new Set(hashes).size).toBeGreaterThan(20);
    const art = createArt(input);
    const a = { ...rest, activity: "quiet", t: 2040, still: false, swing: 0.6, flame: 1.17 } as const;
    const first = hash(art, a);
    expect(hash(art, { ...a, facing: -1, mood: "blocked", swing: -0.8 })).not.toBe(first);
    expect(hash(art, a)).toBe(first);
    expect(hash(art, { ...a, still: true })).toBe(hash(art));
    expect(art.lightAnchor({ ...a, still: true })).toEqual(art.lightAnchor(rest));
    expect(art.lightAnchor({ ...a, facing: -1 })!.x + art.lightAnchor(a)!.x).toBe(23);
    expect(hash(art, { ...a, swing: -0.6 })).not.toBe(first);
  });

  it("draws distinct cue, walk and mood poses, with rain only on errors", () => {
    const art = createArt(input);
    const pose = { ...rest, still: false, t: 500 };
    const cues = CUES.map(cue => hash(art, { ...pose, activity: "cue", cue, progress: 0.5 }));
    expect(new Set(cues).size).toBe(CUES.length);
    expect(new Set([0, 1, 2, 3].map(step => hash(art, { ...pose, activity: "walk", step }))).size).toBe(4);
    const { ctx, pixels } = recorder();
    for (const mood of MOODS) {
      art.draw(ctx, { ...rest, mood }, palette);
      expect(pixels.includes(palette.drop)).toBe(mood === "error");
    }
    expect(hash(art, { ...pose, mood: "resting", t: 3300 })).toBe(hash(art, { ...pose, mood: "resting" }));
    expect(hash(art, { ...pose, mood: "resting" })).not.toBe(hash(art, pose));
    expect(createArt({ ...input, classId: "smith" }).quietIdle("waiting")).toBe("leans on the hammer");
    expect(createArt({ ...input, classId: "ranger" }).quietIdle("working")).toBe("reads a map");
    expect(createArt({ ...input, classId: "wanderer" }).quietIdle("resting")).toBe("tends the lantern");
  });

  it("draws a still avatar at a whole scale", () => {
    const { ctx, pixels } = recorder(72, 84);
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    drawStillAvatar(canvas, input, "waiting", 3, palette);
    expect([canvas.width, canvas.height]).toEqual([72, 84]);
    expect(pixels).toContain(palette.hue.teal);
  });
});
