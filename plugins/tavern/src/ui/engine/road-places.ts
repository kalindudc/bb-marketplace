import type { RoadPlace, StripRoad } from "../../shared/strip-scene";
import type { CharacterPalette } from "../kit/characters";
import { ISLAND_BANDS, lanternIslands, roundToLightCell, sourceGlow } from "./light";
import { PROP_COLOURS as P } from "./sprites/palette";

const ART = {
  signpost: [
    "......oooo........", "......owWo........", ".oooooooooooooo...",
    ".ollllllllllllloo.", ".olmmlmmmlmlllllo.", ".owwwwwwwwwwwwwo..",
    ".oooooooooooooo...", "......owWo........", "...oooooooooooooo.",
    "..olllllllllllllo.", ".ollllmlmmlmmlllo.", "..owwwwwwwwwwwwwo.",
    "...oooooooooooooo.", "......owWo........", "......owWo........",
    "......owWo........", "......owWo........", "......owWo........",
    "......owWo........", "......owWo........", "......owWo........",
    "......owWo........", "....GgowWogG......", "...oSsooooosSo....",
  ],
  scroll: [
    "oooooooo", "opppppqo", "opmmpmqo",
    "oppmmmqo", "opmpmmqo", "opppppqo",
    "oooroooo",
  ],
  lectern: [
    ".ooooo...ooooo.", "opppppooopppppo", "opmmmpqrqpmmmpo",
    "opmmppqrqppmmpo", ".oooooooooooooo", "..oWWWWWWWWWWo.",
    "...owwwwwwwwo..", "......owo......", "......owo......",
    "......owo......", "......owo......", "......owo......",
    "......owo......", "......owo......", "......owo......",
    "......owo......", "......owo......", "....oooWooo....",
    "..owwwwwwwwwo..", ".ooooooooooooo.",
  ],
  lecternClosed: [
    "...............", "...............", "..ooooooooooo..",
    "..orrrrrrrrrro.", ".oooooooooooooo",
  ],
  forge: [
    "...oooo...................", "...oSso...................", "...oSso...................",
    ".oooooooooooooo...........", ".otTttTttTttTto...........", "osssSsssSsssssso..........",
    "osSsooooooossSso..........", "ossoEEEEEEEosssooooooooooo", "osoEfffffffEossotTTTTTTTto",
    "osoEfFFFFFfEossooSSSSSSSoo", "osoEfFFFFFfEoSso..oSSSo...", "osSoeeeeeeeossSo..oSSSo...",
    "osssssSsssssssso.oSSSSSo..", "oSsssssSssssssSo.ooooooo..", "osssSssssssSssso.oWwwwWo..",
    "ossssssssSsssSso.owWwwWo..", "oSsssSssssssssso.oWwwwWo..", "oooooooooooooooo.ooooooo..",
  ],
  gate: [
    "oooooooooooooooooooooooo", "oWWWWWWWWWWWWWWWWWWWWWWo", "oooooooooooooooooooooooo",
    "owWo.......oo.......owWo", "owWo......oFFo......owWo", "owWo.....oFffFo.....owWo",
    "owWo.....oFffFo.....owWo", "owWo......oooo......owWo", "owWo................owWo",
    "owWo................owWo", "owWo................owWo", "owWo................owWo",
    "owWo................owWo", "owWo................owWo", "owWo................owWo",
    "owWo................owWo", "owWo................owWo", "owWo................owWo",
    "owWo................owWo", "owWo................owWo", "owWo................owWo",
    "owWo................owWo", "owWo................owWo", "oooo................oooo",
  ],
  gateBar: [
    "oooooooooooooooo", "olllllllllllllll", "owwwwwwwwwwwwwww",
    "oooooooooooooooo",
  ],
  waystone: [
    "....oooooo....", "...otTTttso...", "..otTttttsso..",
    "..otttssssSo..", ".otttsssssSSo.", ".ottsoooosSSo.",
    ".otsssoossSSo.", ".otsssoossSSo.", ".ottsoooosSSo.",
    ".ottssoosssSo.", ".otsssoossSSo.", ".otsssssssSSo.",
    ".ottsssssssSo.", ".otssssssssSo.", ".otsssssssSSo.",
    ".ottssssssSSo.", ".otsssssssSSo.", ".otsssssssSSo.",
    ".ottssssssSSo.", ".otsssssssSSo.", ".otssssssssSo.",
    ".ottsssssssSo.", "GgoooooooooooG", "oSsoooooooooSo",
  ],
  noticepost: [
    "oooooooooooooooo", "oWWWWWWWWWWWWWWo", "oooooooooooooooo",
    ".owwwwwwwwwwwwo.", ".owlwwwwwwwwlwo.", ".owwwwwwwwwwwwo.",
    ".owwwwwwwwwwwwo.", ".owwwwwwwwwwwwo.", ".owwwwwwwwwwwwo.",
    ".owlwwwwwwwwlwo.", ".oooooooooooooo.", "..owo......owo..",
    "..owo......owo..", "..owo......owo..", "..owo......owo..",
    "..owo......owo..", "..owo......owo..", "..owo......owo..",
    "..owo......owo..", "..owo......owo..", "..owo......owo..",
    "..owo......owo..", ".GowoG....GowoG.", ".ooooo....ooooo.",
  ],
  letter: [
    "oooroooo", "opppppqo", "opmmmpqo",
    "opmmpmqo", "opppppqo", "oooooooo",
  ],
  ribbon: [
    "kk", "kk", "k.",
    "k.",
  ],
  ribbonStir: [
    "kk.", ".kk", ".k.",
    "k..",
  ],
  milestone: [
    ".ooo.", "otTso", "otsso",
    "oxxso", "otsSo", "ooooo",
  ],
};

const GEAR = {
  W: P[0], w: P[8], l: P[10], S: P[2], s: P[52], t: P[51], T: P[23],
  p: P[3], q: P[38], m: P[5], e: P[50], E: P[47], f: P[48], F: P[44],
  r: P[19], g: P[26], G: P[27], x: P[21],
} as Record<string, string>;

const PLACE_ART = {
  plan: "signpost", read: "lectern", make: "forge", review: "gate", seal: "waystone", report: "noticepost", milestones: "milestone",
} as const;

export const PLACE_TARGET = 44;
const SLOT = 96;
const INSET = 8;
export const ROAD_BEAT = 160;
export const ROAD_RISE = 600;

type Milestones = { id: "milestones"; kind: "milestones"; state: "done"; count: number };
export type RoadItem = { place: RoadPlace | Milestones; x: number; target: number };
export type RoadLayout = { items: RoadItem[]; home: number; askX: number | null };

export function layoutRoad(road: StripRoad, width: number, actorWidth: number, ask: boolean): RoadLayout {
  const available = width - INSET - PLACE_TARGET;
  const capacity = Math.floor(available / SLOT);
  if (capacity < 1) return { items: [], home: 0, askX: null };
  const folded = road.places.length > capacity && available >= SLOT + PLACE_TARGET;
  const visible = folded ? Math.floor((available - PLACE_TARGET) / SLOT) : capacity;
  const places = road.places.slice(-visible);
  const count = folded ? road.places.length - places.length : 0;
  const offset = INSET + (count ? PLACE_TARGET : 0);
  const items: RoadItem[] = places.map((place, i) => ({ place, x: offset + i * SLOT + 6, target: offset + i * SLOT }));
  if (count) items.unshift({ place: { id: "milestones", kind: "milestones", state: "done", count }, x: INSET, target: INSET });
  const active = items.find(item => item.place.id === road.current);
  const home = Math.min(Math.max(0, available + INSET - actorWidth), (active?.target ?? items.at(-1)?.target ?? 0) + PLACE_TARGET);
  return { items, home, askX: ask ? home + actorWidth : null };
}

const PLACE_NAMES = {
  plan: "The signpost", read: "The lectern", make: "The forge", review: "The gate",
  seal: "The waystone", report: "The notice post",
} as const;
const PLACE_ACTION = {
  plan: ["is planning the route", "planned the route"],
  read: ["is reading the notes", "finished reading the notes"],
  make: ["is making this part", "finished making this part"],
  review: ["is checking the work", "checked the work"],
  seal: ["has reached the end of the road", "reached the end of the road"],
  report: ["has left a report for the Keeper", "left a report for the Keeper"],
} as const;

export function placeWords(place: RoadItem["place"], member: string, hasAsk: boolean, title?: string) {
  if (place.kind === "milestones") return { name: "Milestones", detail: `${place.count} earlier places behind ${member} on this road.` };
  const [active, done] = PLACE_ACTION[place.kind];
  const quest = title ? ` (quest: ${title})` : "";
  const waypoint = place.waypoint ? `, at ${place.waypoint}` : "";
  const action = place.state === "held" ? (hasAsk ? "is waiting on you" : "has stopped") : place.state === "done" ? done : active;
  return { name: PLACE_NAMES[place.kind], detail: `${member} ${action} here${waypoint}${quest}.` };
}

type Paint = (name: keyof typeof ART, dx?: number, dy?: number, swaps?: Record<string, string>) => void;

function sprite(ctx: CanvasRenderingContext2D, name: keyof typeof ART, x: number, foot: number, ink: string, ribbon: string, swaps?: Record<string, string>) {
  const rows = ART[name], top = foot - rows.length * 2;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let i = 0; i < row.length; i++) {
      const key = row[i]!;
      if (key === ".") continue;
      ctx.fillStyle = swaps?.[key] ?? (key === "o" ? ink : key === "k" ? ribbon : GEAR[key]!);
      ctx.fillRect(x + 2 * i, top + 2 * y, 2, 2);
    }
  }
}

function drawPlace(ctx: CanvasRenderingContext2D, item: RoadItem, foot: number, palette: CharacterPalette, ribbon: string, beat: number, highlight: boolean, spark: boolean) {
  const { place, x } = item;
  const ink = highlight ? palette.hearth : palette.ink;
  const pulse = beat >= 0 && beat % 4 >= 2;
  const paint: Paint = (name, dx = 0, dy = 0, swaps) => sprite(ctx, name, x + dx, foot + dy, ink, ribbon, swaps);
  const pixel = (colour: string, dx: number, dy: number, w = 2, h = 2) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x + dx, foot + dy, w, h);
  };
  const done = place.state === "done";
  const banked = place.state === "held";
  switch (place.kind) {
    case "milestones":
      for (let i = 0; i < Math.min(3, place.count); i++) paint("milestone", i * 12);
      return;
    case "plan":
      paint("signpost");
      if (!done) paint("scroll", 6, pulse ? -14 : -12);
      break;
    case "read":
      paint("lectern");
      if (done) paint("lecternClosed", 0, -28);
      else if (pulse) pixel(GEAR.p!, 14, -42, 10);
      break;
    case "make":
      paint("forge", 0, 0, done ? { F: GEAR.x!, f: GEAR.x!, E: GEAR.S! }
        : banked ? { F: GEAR.f!, f: GEAR.E!, E: GEAR.e! } : undefined);
      if (beat >= 0 && !done && !banked) for (let i = 0; i < 3; i++) {
        const age = (beat + i * 3) % 9;
        pixel(age < 3 ? GEAR.F! : age < 6 ? GEAR.f! : GEAR.E!, 10 + 2 * ((i * 5 + age) % 6), -22 - 2 * age);
      }
      if (spark && !done && !banked) {
        pixel(GEAR.F!, 40, -26);
        pixel(GEAR.f!, 36, -30);
        pixel(GEAR.F!, 46, -30);
      }
      break;
    case "review": {
      paint("gate", 0, 0, done || pulse ? { F: GEAR.x!, f: GEAR.S! }
        : banked ? { F: GEAR.f!, f: GEAR.E! } : undefined);
      if (!done) paint("gateBar", 8, -22);
      if (pulse && !done) {
        const sway = beat % 8 < 4 ? 2 : -2;
        pixel(ink, 18 + sway, -38, 12, 6);
        pixel(banked ? GEAR.f! : GEAR.F!, 20 + sway, -38, 8, 4);
      }
      break;
    }
    case "seal": {
      paint("waystone");
      pixel(GEAR.r!, 8, -26, 12, 6);
      pixel(GEAR.F!, 12, -26, 4, 2);
      if (beat >= 0) pixel(GEAR.T!, 4, -42 + 4 * (beat % 9));
      break;
    }
    case "report":
      paint("noticepost");
      paint("letter", 8, pulse ? -34 : -30);
      break;
  }
  if (done || place.kind === "seal") {
    const art = ART[PLACE_ART[place.kind]];
    paint(pulse ? "ribbonStir" : "ribbon", 4, 12 - art.length * 2);
  }
}

function placeLight(ctx: CanvasRenderingContext2D, { x, place }: RoadItem, foot: number, palette: CharacterPalette) {
  if (place.state === "done") return;
  const source = place.kind === "make" ? { kind: "ember" as const, dx: 16, dy: -16 }
    : place.kind === "review" ? { kind: "lantern" as const, dx: 24, dy: -36 }
    : place.kind === "seal" ? { kind: "hearth" as const, dx: 14, dy: -28 } : null;
  if (!source) return;
  const { halo, pool } = lanternIslands(roundToLightCell(x + source.dx), roundToLightCell(foot + source.dy), foot);
  const glow = sourceGlow(source.kind, palette.hearth, place.state === "held" ? 0.13 : 0.24);
  ctx.fillStyle = glow.colour;
  for (const span of [...halo, ...pool]) {
    ctx.globalAlpha = glow.alpha * ISLAND_BANDS[span.band - 1]!;
    ctx.fillRect(span.left, span.top, span.right - span.left, span.bottom - span.top);
  }
  ctx.globalAlpha = 1;
}

export function drawRoad(ctx: CanvasRenderingContext2D, layout: RoadLayout, width: number, foot: number, palette: CharacterPalette, ribbon: string, hover: string | null, beat: number, rise: number, spark: boolean) {
  const { items, home } = layout;
  ctx.fillStyle = palette.dark ? palette.muted : palette.ink;
  ctx.globalAlpha = palette.dark ? 0.36 : 0.22;
  ctx.fillRect(0, foot, home, 2);
  for (let x = home; x < width; x += 12) ctx.fillRect(x, foot, 6, 2);
  ctx.globalAlpha = 1;
  for (const item of items) {
    const past = item.place.state === "done";
    if (!past && rise < 1) {
      const reveal = Math.ceil(rise * 28) * 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(item.x - 24, foot - reveal, 100, reveal + 8);
      ctx.clip();
    }
    if (palette.dark) placeLight(ctx, item, foot, palette);
    else {
      ctx.fillStyle = palette.ink;
      ctx.globalAlpha = 0.13;
      const span = ART[PLACE_ART[item.place.kind]][0]!.length * 2;
      ctx.fillRect(item.x + 4, foot + 2, span + 8, 2);
      ctx.globalAlpha = 1;
    }
    const isHovered = item.place.id === hover;
    drawPlace(ctx, item, foot, palette, ribbon, isHovered ? beat : -1, isHovered && beat < 0, spark);
    if (!past && rise < 1) ctx.restore();
  }
}
