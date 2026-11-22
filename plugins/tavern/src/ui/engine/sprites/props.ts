import type { ClassLight } from "../art";
import { GROUND, Ink, type PixelGrid } from "./pixels";
import { PROP_COLOURS } from "./palette";
import type { SpritePose } from "./poses";

export type DayProp = "teacup" | "flask" | "compass" | "whetstone" | "herbs";

const indices = new Map(PROP_COLOURS.map((colour, i) => [colour, (Ink.Prop + i) as Ink]));

function stamp(p: PixelGrid, x: number, y: number, rows: readonly string[], ink: Record<string, string>) {
  for (const [dy, row] of rows.entries()) {
    for (let dx = 0; dx < row.length; dx++) {
      const colour = indices.get(ink[row[dx]!]!);
      if (colour !== undefined) p.rect(x + dx, y + dy, 1, 1, colour);
    }
  }
}

export function dayProp(p: PixelGrid, prop: DayProp, hand: number) {
  switch (prop) {
    case "teacup":
      stamp(p, 0, hand - 3, [".rrrr..", "BttttBB", "BpppBBp", ".pssB..", "..BBB.."],
        { r: "#6e4a32", t: "#bc885e", B: "#514c4f", p: "#f7edd4", s: "#6b9397" });
      break;
    case "flask":
      p.rect(3, hand - 8, 1, GROUND - hand + 8, indices.get("#77583a")!);
      stamp(p, 2, hand - 8, [".bh", ".bs", "..s"], { b: "#58412d", h: "#af9062", s: "#93734d" });
      stamp(p, 2, hand - 3, ["....O", "...OP", "..BBO", ".SHHS", "SHTHHS", "SLTTLS", ".SLTS.", "..SS.."],
        { O: "#704e2e", P: "#ba9560", B: "#a68c64", S: "#344b49", H: "#9abdb2", T: "#548880", L: "#795c42" });
      break;
    case "compass":
      stamp(p, 0, hand - 4, ["...BB..", "..BHHB.", ".BHPPHB", ".BHNRHB", ".BHRPHB", "..BHHB.", "...BB.."],
        { B: "#624728", H: "#bc9554", P: "#f2e1bb", R: "#9a443b", N: "#354e62" });
      break;
    case "whetstone":
      stamp(p, 0, hand - 3, [".OOOO..", "OHHLSO.", "OSSLBSO", ".OSLBSO", "..OOOO."],
        { O: "#3c3937", S: "#626e77", H: "#b1bbc0", L: "#8d704f", B: "#ba955e" });
      break;
    case "herbs":
      stamp(p, 0, hand - 7, ["..s..h.", ".hhs.hs", "s.shh.s", "hhshgs.", ".shgss.", "..sgs..", "...stt.", "....stt", ".....s.", "......s"],
        { s: "#475844", h: "#889f60", g: "#aeba81", t: "#b08656" });
      break;
  }
}

export function crystalTop(hand: number, pose: SpritePose) {
  return Math.max(2, hand - 10 - (pose.action === "staff" ? (pose.accent === "peak" ? 4 : 1) : 0));
}

export function nightProp(p: PixelGrid, kind: ClassLight, hand: number, right: number, pose: SpritePose) {
  switch (kind) {
    case "runewood": {
      const top = Math.max(0, hand - 13);
      p.rect(4, top + 6, 1, GROUND - top - 6, indices.get("#795b45")!);
      p.rect(5, top + 7, 1, Math.min(12, GROUND - top - 7), indices.get("#b89468")!);
      stamp(p, 0, top, [".w...w.", ".wo..w.", "..wooW.", "..wogW.", "...wGW.", "...wW..", "....Wa.", "....W..", "....W..", "....Wa.", "....Wa.", "....Wa.", "....Wa.", "....WA."],
        { w: "#654732", W: "#ab8158", o: "#88ae6d", g: "#c0eea6", G: "#ecffd0", a: "#5d503b", A: "#ceb180" });
      return { x: 4, y: top + 4 };
    }
    case "shutter":
      stamp(p, 0, hand - 2, ["....cc.", "...c..c", "...c..c", "..aacc.", ".ccccc.", "cssxcc.", "cyYxcc.", "cbbxcc.", "cyYxcc.", ".BBBB..", "..ss..."],
        { c: "#74634f", a: "#b28b58", x: "#403631", s: "#9a7950", y: "#ed9b41", Y: "#ffdf92", b: "#775234", B: "#56483e" });
      return { x: 2, y: hand + 4 };
    case "ember":
      stamp(p, 0, hand - 8, ["..cz...", ".fccz..", ".fYfz..", "..Efs..", "..sss..", "...Ms..", "....Ms.", ".....Ms", ".....sM", "......s"],
        { c: "#d6532e", f: "#ff8b46", Y: "#ffd5a0", E: "#a33d25", z: "#8d9ca6", s: "#666d72", M: "#bcc1bf" });
      return { x: 2, y: hand - 6 };
    case "crystal": {
      const y = crystalTop(right, pose);
      stamp(p, 18, y, ["...h.", "..hm.", ".hLLm", ".hLLm", ".hmv.", "..v.."],
        { h: "#bbc4fa", m: "#9c99ec", L: "#eef0ff", v: "#7562b0" });
      return { x: 20, y: y + 2 };
    }
  }
}
