import { CHARGE_PIXELS } from "../../kit/characters";
import type { LightAnchor } from "../art";
import { GROUND, Ink, PixelGrid } from "./pixels";
import type { SpritePose } from "./poses";
import type { SeedTraits } from "./traits";

const HAIRSTYLES: Record<SeedTraits["hair"], { back: readonly string[]; fringe: readonly string[] }> = {
  "fringe-crop": { back: ["..######..", ".########.", "##########"], fringe: ["##########", "###..##..#", "#........#"] },
  "tousled-crop": { back: ["...###....", ".#######..", ".########.", "##########"], fringe: ["##########", "#.#.###..#", ".....#...."] },
  bob: { back: ["..######..", ".########.", "##########", "##########", "##########", "##########", ".########.", "..######.."], fringe: ["##########", "########.#", "##...#...#"] },
  "shoulder-length": { back: ["..######..", ".########.", "###########", "###########", "###########", ".#########.", "##########", "##......##"], fringe: ["##########", "####..####", "##......##"] },
  "long-straight": { back: ["....######....", "...########...", "..##########..", ".############.", ".############.", ".###......###.", ".###......###.", ".###......###."], fringe: ["##########", "###....###", "##......##"] },
  braid: { back: ["..######..", ".########.", "##########", "##########", "###########", "###########", "..........##", ".........##."], fringe: ["##########", "####..####", "##.......#"] },
  "tied-tail": { back: ["..######..", ".########.", "############", "############", "###########.", "###########.", "........####", ".........###", "..........##"], fringe: ["##########", "#####.#..#", "###......#"] },
  bun: { back: [".......###", "..#########", ".##########", "##########", "##########"], fringe: ["##########", "###.#...##", "#........."] },
  curls: { back: ["..##.###..", ".########.", "##########", "###########", "##########", "###########", "###....###", ".##.....##"], fringe: ["##########", "##.###.###", "#..##....#"] },
};

const HAT_HEADROOM: Record<NonNullable<SeedTraits["hat"]>, number> = {
  "soft-cap": 4, coif: 3, kerchief: 2, "folded-hat": 4, "wide-brim": 5, "round-brim": 4, hood: 2, "tall-hood": 4, "warden-felt": 5,
};

function head(p: PixelGrid, x: number, top: number, chin: number, t: SeedTraits, pose: SpritePose) {
  const hair = HAIRSTYLES[t.hair];
  const hairY = top - (t.hair === "tousled-crop" || t.hair === "bun" ? 2 : 1);
  p.mask(x - (t.hair === "long-straight" ? 2 : 0), hairY, hair.back.slice(0, chin - hairY), Ink.Hair);
  if (t.ears === "pointed") p.mask(x - 2, top + 3, ["#............#", "###........###", ".####....####.", "..###....###.."], Ink.Skin);
  else p.mask(x - 1, top + 4, ["##........##", ".##......##."], Ink.Skin);
  p.mask(x, top, ["..######..", ".########."], Ink.Hair);
  p.mask(x, top + 2, ["##########", "##########", "##########", "##########", ".########.", t.face === "round" ? "..######.." : "...####...", "...####..."], Ink.Skin);
  p.mask(x, top + 2, [hair.fringe[1]!], Ink.Hair);
  if (hair.fringe[2]?.startsWith("#")) p.rect(x, top + 3, 1, 1, Ink.Hair);
  if (hair.fringe[2]?.endsWith("#")) p.rect(x + 9, top + 3, 1, 1, Ink.Hair);
  const eyes = top + 4 + pose.glance;
  const left = x + (t.eyes === "wide" ? 1 : 2);
  const right = x + 6;
  if (pose.face === "delighted") {
    p.mask(x + 1, eyes, [".#...#.", "#.#.#.#"], Ink.Outline);
  } else if (pose.blink || pose.seated) {
    p.rect(left, eyes + 1, 2, 1, Ink.Outline);
    p.rect(right, eyes + 1, 2, 1, Ink.Outline);
  } else {
    p.rect(left, eyes, 2, 2, Ink.Outline);
    p.rect(right, eyes, 2, 2, Ink.Outline);
    p.rect(left + 1, eyes, 1, 1, Ink.Glint);
    p.rect(right + 1, eyes, 1, 1, Ink.Glint);
  }
  const cheek = Math.min(top + 6, eyes + 2);
  p.rect(x + 1, cheek, 1, 1, Ink.Cheek);
  p.rect(x + 8, cheek, 1, 1, Ink.Cheek);
  if (pose.face === "delighted" || pose.face === "pleased") p.rect(x + 4, chin, 2, 1, Ink.Outline);
  if (pose.face === "frown") p.mask(x + 3, chin - 1, [".#.", "#.#"], Ink.Cheek);
  if (t.hair === "braid") p.mask(x + 9, top + 4, [".##", "..#", ".#."], Ink.Leather);
  if (t.hair === "tied-tail") p.rect(x + 10, top + 3, 1, 1, Ink.Secondary);
  hat(p, x, top, t.hat);
}

function hat(p: PixelGrid, x: number, y: number, part: SeedTraits["hat"]) {
  switch (part) {
    case "soft-cap":
      p.mask(x - 2, y - 4, ["...#####....", ".########...", "##########..", ".##########.", ".....######."], Ink.Secondary);
      p.mask(x - 1, y - 2, ["###", ".###"], Ink.DarkCloth);
      break;
    case "coif":
      p.mask(x - 1, y - 3, ["...######...", "..########..", ".##########.", ".##......##.", "##........##", "##........##", ".#........#.", ".#........#.", "..#......#..", "...#....#...", ".......#...."], Ink.Garment);
      p.rect(x + 6, y + 8, 2, 1, Ink.DarkCloth);
      break;
    case "kerchief":
      p.mask(x - 1, y - 2, ["...#######..", "..#########.", ".###########", ".#........##", "...........##", "............#"], Ink.Secondary);
      p.rect(x + 1, y, 8, 1, Ink.Garment);
      break;
    case "folded-hat":
      p.mask(x - 1, y - 4, ["......###...", ".....#####..", "...########.", "..#########.", ".###########"], Ink.Garment);
      p.rect(x + 3, y - 2, 6, 1, Ink.Secondary);
      break;
    case "wide-brim":
    case "round-brim":
      p.mask(x - 3, y - 5, part === "wide-brim"
        ? [".......##.......", "......####......", "......#####.....", ".....#######....", "....########....", "..############..", "###..........###"]
        : ["................", "......###.......", ".....######.....", ".....#######....", "....########....", "..############..", "###..........###"], Ink.Secondary);
      p.mask(x - 3, y + 1, ["...##########..."], Ink.DarkCloth);
      break;
    case "warden-felt":
      p.mask(x - 1, y - 5, [".......###..", "......#####.", ".....#####..", "...#######..", "..########..", ".##########.", "..#......#.."], Ink.Garment);
      p.mask(x + 7, y - 3, ["#", ".#", ".#", "..#", "..#", ".#"], Ink.Brass);
      break;
    case "hood":
    case "tall-hood":
      if (part === "tall-hood") p.mask(x + 1, y - 4, [".....#..", "...####.", "..######"], Ink.Garment);
      p.mask(x - 2, y - 2, ["....######....", "..##########..", ".###......###.", ".##........##.", "##..........##", "#............#", "#............#", ".#..........#."], Ink.Garment);
      p.mask(x - 1, y - 1, ["...######...", ".##......##.", ".#........#.", "#..........#"], Ink.DarkCloth);
      break;
  }
}

function garment(p: PixelGrid, t: SeedTraits, pose: SpritePose, top: number, bottom: number, charge: string | null) {
  const x = 12 - (t.shoulders >> 1);
  const length = bottom - top;
  const hem = t.hem + (pose.seated ? 2 : 0);
  if (t.outfit === "travel-cloak" || t.outfit === "short-cape" || t.outfit === "long-coat") {
    const short = t.outfit === "short-cape";
    p.rect(x - 1, top + 1, 11, short ? 4 : length, Ink.Secondary);
    p.rect(x - 2, top + 3, 12, short ? 3 : length - 2, Ink.Secondary);
    if (short) {
      p.mask(x - 2, top + 5, ["#####.....##", "###........."], Ink.Secondary);
    } else {
      p.rect(x - 3, top + 5, 3, length - 4, Ink.Secondary);
      p.rect(x - 3, bottom, 2, 1, Ink.DarkCloth);
    }
  }
  p.rect(x, top, t.shoulders, 2, Ink.Garment);
  p.rect(x, top + 2, t.hips, length - 2, Ink.Garment);
  const edge = 12 - (hem >> 1);
  p.rect(edge, bottom - 2, hem, t.hem > 11 ? 3 : 2, Ink.Garment);
  p.rect(edge + 1, bottom - 1 + Number(t.hem > 11), hem - 2, 1, Ink.Secondary);
  p.mask(x, top + 2, ["#.", "##", ".#"], Ink.DarkCloth);
  if (t.outfit === "leather-apron") {
    p.rect(x + 2, top + 1, 5, length - 1, Ink.Leather);
    p.rect(x + 2, top + 1, 1, length - 1, Ink.Wood);
    p.rect(x + 2, bottom - 1, 5, 1, Ink.Wood);
  } else if (t.outfit === "robe") {
    p.mask(x + 6, bottom - 3, ["..#", ".##", "###"], Ink.DarkCloth);
    p.rect(x + 8, bottom - 2, 2, 1, Ink.Brass);
  }
  if (t.outfit === "tunic" || t.outfit === "travel-cloak" || t.outfit === "long-coat") p.rect(x + 1, bottom - 3, 7, 1, Ink.Leather);
  if (t.outfit === "long-coat" || t.outfit === "tabard") p.mask(x + 1, bottom - 4, ["##.", "..#", ".##"], Ink.DarkCloth);
  const emblem = charge && Object.hasOwn(CHARGE_PIXELS, charge) ? CHARGE_PIXELS[charge as keyof typeof CHARGE_PIXELS] : null;
  if (emblem) p.mask(x + 2, top + 1, emblem, pose.glow ? Ink.ChargeGlint : Ink.Charge);
  if (pose.glow) {
    p.mask(x + 7, top + 1, [".#.", "###", ".#."], Ink.Brass);
    p.rect(x + 8, top + 2, 1, 1, Ink.ChargeGlint);
  }
}

function folio(p: PixelGrid, x: number, y: number, kind: "map" | "scroll" | "ledger", turn: boolean) {
  p.rect(x, y, 8, 4, kind === "ledger" ? Ink.Leather : Ink.Wood);
  p.rect(x + 1, y, 6, 3, Ink.Paper);
  if (kind === "scroll") p.rect(x + 5, y + 2, 1, 2, Ink.Seal);
  else if (kind === "map") p.mask(x + 1, y, turn ? [".....#", "..###.", "##...."] : ["..##..", ".#..##", "#....."], Ink.Wood);
  else {
    p.rect(x + 4, y + 1, 3, 2, Ink.PaperShade);
    p.rect(x + 4, y, 1, 3, Ink.Wood);
    p.mask(x + 5, y - 2, turn ? [".#", "##"] : ["..#", ".#.", "#.."], Ink.Glint);
  }
}

function handTool(p: PixelGrid, t: SeedTraits, hand: number, pose: SpritePose) {
  const active = pose.gesture === "work" && pose.beat;
  switch (t.tool) {
    case "ledger-quill":
      p.mask(17, hand - 2, ["##..##", "######", "######", ".####.", "..##.."], Ink.Leather);
      p.mask(17, hand - 2, ["##....", "###...", ".##..."], Ink.Paper);
      p.mask(17, hand - 2, ["....##", "...###", "...##."], Ink.PaperShade);
      p.mask(19, hand - 4, ["..#", ".##", "#.."], Ink.Glint);
      break;
    case "staff-lantern":
      p.mask(15, hand, [".###", "#####", "#####", "####."], Ink.Leather);
      p.rect(17, hand + 1, 2, 1, Ink.Flame);
      break;
    case "spyglass":
      p.mask(17, hand - 4, ["...##.", "..####", "..####", ".####.", "###...", "##...."], Ink.Brass);
      p.mask(18, hand - 3, ["..##.", "##..."], Ink.Wood);
      p.mask(21, hand - 4, ["#.", "##"], Ink.Lens);
      break;
    case "hammer": {
      const strike = pose.gesture === "work" && !pose.beat;
      const y = hand - (strike ? 5 : 3);
      p.rect(19, y, 1, pose.gesture === "hammer" ? GROUND - y : 7, Ink.Wood);
      p.mask(17, y, [".####", "#####", ".####"], Ink.Metal);
      p.rect(18, y + 2, 3, 1, Ink.Outline);
      if (active) p.mask(20, y + 4, [".#", "..", "#."], Ink.Flame);
      break;
    }
    case "crystal-staff": {
      const y = Math.max(1, hand - 10);
      p.rect(20, y + 5, 1, GROUND - y - 6, Ink.Wood);
      p.mask(18, y, ["...#", "..##", ".####", ".####", ".###", "..#"], Ink.Crystal);
      p.mask(20, y + 2, ["..#", ".##", ".#", "#"], Ink.Facet);
      p.rect(20, y + 2, 1, 1, pose.glow || active ? Ink.ChargeGlint : Ink.Lens);
      p.rect(15, hand + 2, 4, 2, Ink.Paper);
      p.rect(17, hand + 3, 1, 1, Ink.Seal);
      break;
    }
  }
}

export function actor(t: SeedTraits, pose: SpritePose, charge: string | null) {
  const p = new PixelGrid();
  const bootTop = GROUND - 2 - pose.lift;
  const bottom = bootTop + (pose.seated ? 0 : t.outfit === "robe" ? 0 : -1);
  const top = GROUND - t.height + 8 + (pose.seated ? 3 : pose.slump ? 2 : 0) - pose.lift;
  const headroom = t.hat ? HAT_HEADROOM[t.hat] : 2;
  const headTop = Math.max(headroom, top - (pose.slump ? 6 : pose.glance === -1 ? 9 : 8));
  p.rect(7, GROUND, 12, 1, Ink.Shadow);
  const fast = pose.stride === 2;
  if (pose.seated) {
    p.rect(9, bootTop + 1, 5, 1, Ink.Boot);
    p.rect(15, bootTop, 5, 2, Ink.Boot);
  } else {
    p.rect(8 + (pose.stride === 1 ? -1 : fast ? 1 : 0), bootTop - Number(pose.stride === -1), 3, 2, Ink.Boot);
    p.rect(13 + (pose.stride === -1 ? 2 : fast ? 1 : 0), bootTop - Number(pose.stride === 1 || fast), 3, 2, Ink.Boot);
  }
  garment(p, t, pose, top, bottom, charge);
  if (pose.seated) p.mask(15, bottom - 3, ["##...", "####.", "#####"], Ink.Secondary);
  const lampLimit = t.light && t.tool !== "staff-lantern" ? GROUND - 8 : GROUND;
  const tendsLight = pose.gesture === "lantern" || (pose.gesture === "work" && t.tool === "staff-lantern");
  const liftLight = pose.raised && t.tool === "staff-lantern" ? 3 : Number(tendsLight && pose.beat);
  const leftHand = Math.min(bottom - 2, top + 4, lampLimit) - liftLight;
  p.rect(7, top + 2, 1, leftHand - top - 1, Ink.Garment);
  p.rect(6, leftHand, 2, 1, Ink.Skin);
  let rightHand = Math.min(bottom - 1, top + (pose.raised ? 1 : 5));
  if (pose.gesture === "wave") {
    p.rect(17, top + 1, 1, 3, Ink.Garment);
    p.rect(18, top + 1, pose.beat ? 2 : 1, 1, Ink.Garment);
    p.rect(pose.beat ? 20 : 18, top, 2, 2, Ink.Skin);
    handTool(p, t, rightHand, pose);
  } else {
    if (pose.gesture === "spyglass" || (pose.gesture === "work" && (t.tool === "spyglass" || t.tool === "hammer"))) rightHand -= pose.beat ? 2 : 1;
    if (pose.gesture === "hammer" || pose.gesture === "staff") rightHand--;
    p.rect(17, top + 2, 1, rightHand - top - 1, Ink.Garment);
    p.rect(17, rightHand, 2, 1, Ink.Skin);
    const gesture = pose.gesture;
    if (gesture === "map" || gesture === "scroll" || gesture === "ledger" || (gesture === "work" && t.tool === "ledger-quill")) {
      folio(p, t.tool === "crystal-staff" ? 10 : 9, top + 3, gesture === "map" || gesture === "scroll" ? gesture : "ledger", pose.beat);
      if (t.tool === "crystal-staff" || t.tool === "spyglass") handTool(p, t, rightHand, pose);
    } else if (gesture === "hands" || gesture === "apron" || (gesture === "work" && !t.tool)) {
      p.rect(pose.beat ? 13 : 12, bottom - 3, 3, 1, Ink.Skin);
      handTool(p, t, rightHand, pose);
    } else {
      handTool(p, t, rightHand, pose);
      if (gesture === "satchel") p.rect(17 + Number(pose.beat), rightHand - 1, 2, 1, Ink.Skin);
    }
  }
  const chin = headTop + 7;
  head(p, pose.slump ? 9 : 7, headTop, chin, t, pose);
  let anchor: LightAnchor | null = null;
  if (t.light === "lantern" && t.tool === "staff-lantern") {
    p.rect(3, leftHand - 5, 1, 9, Ink.Wood);
    p.rect(3, leftHand - 5, 3, 1, Ink.Wood);
    p.rect(4, leftHand, 2, 1, Ink.Wood);
    anchor = { x: 5, y: leftHand - 5, kind: t.light };
  } else if (t.light) {
    p.rect(5, leftHand, 1, 1, Ink.Wood);
    anchor = { x: 5, y: leftHand, kind: t.light };
  }
  p.outline();
  return { runs: p.runs(), anchor, chin };
}

export function lamp(kind: LightAnchor["kind"], shift: number, bright: boolean) {
  const p = new PixelGrid();
  const cx = 4;
  const x = cx + shift;
  const y = Math.abs(shift) === 2 ? 2 : 3;
  if (kind === "torch") {
    p.rect(cx, 5, 1, 3, Ink.Wood);
    p.rect(cx + Math.sign(shift), 4, 1, 2, Ink.Wood);
    p.mask(x - 1, 1, bright ? ["..#", ".##", "###", ".#."] : [".#.", "##.", "###", ".#."], Ink.Flame);
    p.rect(x, 3, 1, 1, Ink.Cream);
  } else {
    p.rect(cx, 0, 1, 1, Ink.Metal);
    p.rect(cx + Math.sign(shift), 1, 1, 1, Ink.Metal);
    p.rect(x, 2, 1, 1, Ink.Metal);
    p.rect(x - 1, y, 3, 4, Ink.Leather);
    p.rect(x - 1, y + 1, 3, 2, Ink.Flame);
    if (bright) p.rect(x, y + 1, 1, 2, Ink.Cream);
    else p.rect(x, y + 2, 1, 1, Ink.Cream);
    if (kind === "hearth") p.rect(x - 1, y, 3, 1, Ink.Metal);
  }
  p.outline();
  return p.runs();
}

export function rainCloud() {
  const p = new PixelGrid();
  p.mask(1, 1, ["..###...", ".#####..", "########", ".######."], Ink.Cloud);
  p.mask(2, 6, ["#...#", "..#..", "....#"], Ink.Rain);
  return p.runs();
}
