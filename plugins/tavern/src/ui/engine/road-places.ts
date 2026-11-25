import type { KeeperRoad, QuestSignpost, RoadPlace, StripRoad } from "../../shared/strip-scene";
import type { CharacterPalette } from "../kit/characters";
import { plural } from "../kit/primitives";
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
  questPost: [
    "..oooo........", "..owWo........", "oooooooooooo..", "ollllllllllloo", "olmmlmmmlllllo", "owwwwwwwwwwwoo", "oooooooooooo..",
    "..owWo........", "..owWo........", "..owWo........", "..owWo........", "..owWo........", "..owWo........", "..owWo........",
    "..owWo........", "..owWo........", "..owWo........", "..owWo........", "..owWo........", "..owWo........", ".GgowWogG.....", ".oSsooooSo....",
  ],
  brazier: ["..F..F..", ".FfFFfF.", ".fFffFf.", "oEEEEEEo", ".oeeeeo.", "..oWWo.."],
  lanternMark: ["..oo..", ".oooo.", "oFffFo", "ofFFfo", "oFffFo", ".oooo.", "..oo.."],
  pennant: ["oo......", "orrrro..", "orrrrrro", "orrrro..", "oo......", "oo......"],
  sealMark: [".oooo.", "orrrro", "orFrro", "orrrro", ".oooo."],
  hearth: [
    "......o.......", ".....oFo......", "....oFfFo.o...", "...oFfFfFoFo..", "...oFfFFfFfo..", "..oEfFFFFfEo..",
    ".oWWoEEEEoWWo.", "oSsoWWWWWWoSso", "oSsSooooooSsSo",
  ],
  barrel: [".oooooo.", "owlwwwwo", "oSSSSSSo", "owlwwwwo", "owlwwwwo", "oSSSSSSo", "owlwwwwo", ".oooooo."],
  catSleep: [".o.o........", "owowoooooo..", "owowwlWlwwo.", "owwwwwwwwwwo", ".oWwlWwlWwwo", "..ooooooooo."],
  catFlick: [".o.o......o.", "owowoooooowo", "owowwlWlwwo.", "owwwwwwwwwwo", ".oWwlWwlWwwo", "..ooooooooo."],
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
  plan: "signpost", read: "lectern", make: "forge", review: "gate", seal: "waystone", report: "noticepost", milestones: "milestone", quest: "questPost",
} as const;

export const PLACE_TARGET = 44;
const SLOT = 96;
const INSET = 8;
export const ROAD_BEAT = 160;
export const ROAD_RISE = 600;

type Milestones = { id: "milestones"; kind: "milestones"; state: "done"; count: number; quests?: QuestSignpost[] };
export type RoadItem = { place: RoadPlace | QuestSignpost | Milestones; x: number; target: number };
type CampProp = { kind: "hearth" | "cat" | "barrels" | "board"; x: number; width: number };
export type RoadLayout = { items: RoadItem[]; home: number; camp?: { home: number; props: CampProp[] } };
type RoadSpace = { left: number; right: number };

export function roadSpan(width: number, actorWidth: number) {
  return Math.max(0, Math.floor(width * 0.75) - actorWidth);
}

function clearKeeperSpace(items: RoadItem[], road: KeeperRoad, zone: number, space: RoadSpace) {
  const overlaps = (x: number) => x < space.right && x + PLACE_TARGET > space.left;
  if (!items.some(item => overlaps(item.target))) return items;
  const clear: RoadItem[] = [];
  let next = INSET;
  for (const item of items) {
    const x = Math.max(item.target, next);
    const target = overlaps(x) ? space.right : x;
    if (target + PLACE_TARGET > zone) break;
    clear.push({ ...item, target, x: item.x + target - item.target });
    next = target + PLACE_TARGET;
  }
  if (clear.length === items.length) return clear;

  let fold = clear.findIndex(item => item.place.kind === "milestones");
  if (fold < 0) fold = Math.max(0, clear.findIndex(item => item.place.id !== road.current));
  const target = clear[fold]?.target ?? (overlaps(INSET) ? space.right : INSET);
  if (target + PLACE_TARGET > zone) return clear;
  const visible = new Set(clear.filter((_, i) => i !== fold).map(item => item.place.id));
  const quests = road.places.filter(quest => !visible.has(quest.id));
  clear[fold] = { place: { id: "milestones", kind: "milestones", state: "done", count: quests.length, quests }, target, x: target };
  return clear;
}

function keeperLayout(road: KeeperRoad, width: number, actorWidth: number, space?: RoadSpace): RoadLayout {
  const end = roadSpan(width, actorWidth);
  const room = end - INSET;
  if (room < PLACE_TARGET || !road.places.length) return { items: [], home: 0 };
  const slot = PLACE_TARGET + actorWidth;
  const capacity = 1 + Math.floor((room - PLACE_TARGET) / slot);
  const folding = road.places.length > capacity;
  const visible = folding ? 1 + Math.floor((room - 2 * PLACE_TARGET) / slot) : capacity;
  const firstRecent = road.places.length - Math.max(0, visible);
  const current = road.places.findIndex(quest => quest.id === road.current);
  const keepCurrent = visible > 0 && current >= 0 && current < firstRecent;
  const folded: QuestSignpost[] = [];
  let items: RoadItem[] = [];
  const offset = INSET + (folding ? PLACE_TARGET : 0);
  for (const [i, place] of road.places.entries()) {
    if (keepCurrent && i === current || i >= firstRecent + Number(keepCurrent)) {
      const target = offset + items.length * slot;
      items.push({ place, x: target + 8, target });
    } else folded.push(place);
  }
  if (folded.length) items.unshift({ place: { id: "milestones", kind: "milestones", state: "done", count: folded.length, quests: folded }, x: INSET, target: INSET });

  const zone = end + actorWidth;
  if (space) items = clearKeeperSpace(items, road, zone, space);
  if (!items.length) return { items, home: 0 };
  const last = items.at(-1)!.target + PLACE_TARGET;
  const active = items.find(item => item.place.id === road.current);
  const home = active ? active.target + PLACE_TARGET : last;
  const camp: NonNullable<RoadLayout["camp"]> = { home: last, props: [] };
  const rest = last + 2 * Math.floor(Math.min(76, (end - last - 32) / 3) / 2);
  if (rest < last + 16) return { items, home, camp };
  camp.home = rest;
  let x = rest + actorWidth + 4;
  for (const [kind, size] of [["hearth", 28], ["cat", 24], ["barrels", 32], ["board", 32]] as const) {
    if (x + size > zone) break;
    camp.props.push({ kind, x, width: size });
    x += size + (kind === "hearth" ? 4 : 12);
  }
  return { items, home, camp };
}

export function layoutRoad(road: StripRoad, width: number, actorWidth: number, space?: RoadSpace): RoadLayout {
  if (road.kind === "keeper") return keeperLayout(road, width, actorWidth, space);
  const available = roadSpan(width, actorWidth) - INSET - PLACE_TARGET;
  if (available < 0 || !road.places.length) return { items: [], home: 0 };
  const capacity = 1 + Math.floor(available / SLOT);
  const folded = road.places.length > capacity && available >= PLACE_TARGET;
  const visible = folded ? 1 + Math.floor((available - PLACE_TARGET) / SLOT) : capacity;
  const places = road.places.slice(-visible);
  const count = folded ? road.places.length - places.length : 0;
  const offset = INSET + (count ? PLACE_TARGET : 0);
  const items: RoadItem[] = places.map((place, i) => ({ place, x: offset + i * SLOT + 6, target: offset + i * SLOT }));
  if (count) items.unshift({ place: { id: "milestones", kind: "milestones", state: "done", count }, x: INSET, target: INSET });
  const active = items.find(item => item.place.id === road.current);
  return { items, home: (active ?? items[items.length - 1]!).target + PLACE_TARGET };
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
  if (place.kind === "milestones") return { name: "Milestones", detail: place.quests
    ? plural(place.count, "folded quest") : `${plural(place.count, "earlier place")} behind ${member} on this road.` };
  if (place.kind === "quest") return { name: place.name, detail: place.total ? `${place.state}, ${place.done} of ${place.total} steps done` : place.state };
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
    case "quest": {
      paint("questPost");
      const marks = {
        planning: ["scroll", 0, -28], building: ["brazier", 0, -30], checking: ["lanternMark", 2, -29],
        held: ["pennant", 2, -34], sealed: ["sealMark", 10, -27],
      } as const satisfies Record<QuestSignpost["state"], [keyof typeof ART, number, number]>;
      const [mark, dx, dy] = marks[place.state];
      const redMark = mark === "pennant" || mark === "sealMark";
      paint(mark, dx, dy, redMark && palette.dark ? { r: palette.bad } : undefined);
      if (place.state === "sealed") paint("ribbon", 6, -17);
      return;
    }
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
    : place.kind === "seal" ? { kind: "hearth" as const, dx: 14, dy: -28 }
    : place.kind === "quest" && place.state === "building" ? { kind: "ember" as const, dx: 8, dy: -36 }
    : place.kind === "quest" && place.state === "checking" ? { kind: "lantern" as const, dx: 8, dy: -36 } : null;
  if (source) roadLight(ctx, source.kind, x + source.dx, foot + source.dy, foot, palette, place.state === "held" ? 0.13 : 0.24);
}

function roadLight(ctx: CanvasRenderingContext2D, kind: "ember" | "lantern" | "hearth", x: number, y: number, foot: number, palette: CharacterPalette, intensity: number) {
  const { halo, pool } = lanternIslands(roundToLightCell(x), roundToLightCell(y), foot);
  const glow = sourceGlow(kind, palette.hearth, intensity);
  ctx.fillStyle = glow.colour;
  for (const span of [...halo, ...pool]) {
    ctx.globalAlpha = glow.alpha * ISLAND_BANDS[span.band - 1]!;
    ctx.fillRect(span.left, span.top, span.right - span.left, span.bottom - span.top);
  }
  ctx.globalAlpha = 1;
}

export function catTail(time: number) {
  const period = 12_000;
  const phase = (time + 1e-6) % period;
  const flick = time + 1e-6 >= period && phase < 180;
  return { flick, next: (flick ? 180 : period) - phase };
}

export function drawRoad(ctx: CanvasRenderingContext2D, layout: RoadLayout, width: number, foot: number, palette: CharacterPalette, ribbon: string, hover: string | null, beat: number, rise: number, spark: boolean, flick = false) {
  const { items, home, camp } = layout;
  const trail = camp ? Math.max(camp.home, (items.at(-1)?.target ?? 0) + PLACE_TARGET) : home;
  ctx.fillStyle = palette.dark ? palette.muted : palette.ink;
  ctx.globalAlpha = palette.dark ? 0.36 : 0.22;
  ctx.fillRect(0, foot, trail, 2);
  for (let x = trail; x < width; x += 12) ctx.fillRect(x, foot, 6, 2);
  ctx.globalAlpha = 1;
  for (const prop of camp?.props ?? []) {
    if (prop.kind === "hearth" && palette.dark) roadLight(ctx, "hearth", prop.x + 14, foot - 8, foot, palette, 0.32);
    else if (!palette.dark && prop.kind !== "cat") {
      ctx.fillStyle = palette.ink;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(prop.x + 4, foot + 2, prop.width, 2);
      ctx.globalAlpha = 1;
    }
    const paint: Paint = (name, dx = 0, dy = 0) => sprite(ctx, name, prop.x + dx, foot + dy, palette.ink, ribbon);
    switch (prop.kind) {
      case "hearth": paint("hearth"); break;
      case "cat": paint(flick ? "catFlick" : "catSleep"); break;
      case "barrels": paint("barrel"); paint("barrel", 16); paint("barrel", 8, -14); break;
      case "board": paint("noticepost"); paint("letter", 8, -30); break;
    }
  }
  for (const item of items) {
    const past = !!camp || item.place.state === "done";
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
