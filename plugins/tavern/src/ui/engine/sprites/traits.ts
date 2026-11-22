import { LOOK_HAIR_COLOURS, LOOK_SKINS, type LookFields } from "../../../shared/look";
import type { ArtInput, LightAnchor, Mood, Signature } from "../art";
import type { DayProp } from "./props";

export const HAIR = ["fringe-crop", "tousled-crop", "bob", "shoulder-length", "long-straight", "braid", "tied-tail", "bun", "curls"] as const;
const MATERIALS = ["linen", "undyed-wool", "moss", "wine", "slate", "ochre"] as const;

export const PARTS = {
  hair: HAIR,
  ears: ["rounded", "pointed"],
  hat: ["soft-cap", "coif", "kerchief", "folded-hat", "wide-brim", "round-brim", "hood", "tall-hood", "warden-felt"],
  outfit: ["long-coat", "tabard", "travel-cloak", "short-cape", "leather-apron", "robe", "tunic"],
  tool: ["ledger-quill", "staff-lantern", "spyglass", "hammer", "crystal-staff"],
  accessory: ["satchel", "sealed-scroll", "map", "hearth-lamp", "torch"],
  materials: MATERIALS,
} as const;

type Part<K extends keyof typeof PARTS> = (typeof PARTS)[K][number];

export const HANDWORK = {
  ledger: "writes in the ledger",
  lantern: "tends the lantern",
  satchel: "checks the satchel",
  map: "reads a map",
  spyglass: "checks the spyglass",
  hammer: "leans on the hammer",
  apron: "smooths the apron",
  scroll: "reads a scroll",
  staff: "rests on the staff",
  hands: "folds their hands",
} as const;
export type Handwork = keyof typeof HANDWORK;

type Kit = {
  outfits: readonly Part<"outfit">[];
  hats: readonly (Part<"hat"> | null)[];
  tool: Part<"tool"> | null;
  light: LightAnchor["kind"] | null;
  day: DayProp | null;
  idle: Handwork;
  quiet: Partial<Record<Mood, Handwork>>;
  signature: Signature;
};

export const KITS = {
  keeper: { outfits: ["long-coat", "tabard"], hats: ["soft-cap", "coif", null], tool: "ledger-quill", light: "runewood", day: "teacup", idle: "ledger", signature: "quill", quiet: { resting: "hands" } },
  wanderer: { outfits: ["travel-cloak"], hats: ["wide-brim", "round-brim"], tool: "staff-lantern", light: "lantern", day: "flask", idle: "satchel", signature: "lantern", quiet: { working: "lantern", waiting: "lantern", resting: "lantern" } },
  ranger: { outfits: ["short-cape"], hats: ["hood", "tall-hood"], tool: "spyglass", light: "shutter", day: "compass", idle: "spyglass", signature: "spyglass", quiet: { working: "map", resting: "hands" } },
  smith: { outfits: ["leather-apron"], hats: ["kerchief"], tool: "hammer", light: "ember", day: "whetstone", idle: "apron", signature: "hammer", quiet: { waiting: "hammer", resting: "hammer" } },
  warden: { outfits: ["robe"], hats: ["warden-felt", null], tool: "crystal-staff", light: "crystal", day: "herbs", idle: "scroll", signature: "staff", quiet: { waiting: "staff", resting: "staff" } },
  none: { outfits: ["tunic"], hats: [null], tool: null, light: null, day: null, idle: "hands", signature: "nod", quiet: {} },
} as const satisfies Record<string, Kit>;

type Traits = {
  shoulders: number;
  hips: number;
  hem: number;
  height: number;
  ears: Part<"ears">;
  face: "round" | "soft-oval";
  eyes: "bright" | "gentle" | "wide";
  hair: Part<"hair">;
  hairColour: number;
  skin: number;
  secondary: Part<"materials">;
  hat: Part<"hat"> | null;
  outfit: Part<"outfit">;
  tool: Part<"tool"> | null;
  light: LightAnchor["kind"] | null;
  day: DayProp | null;
  blinkOffset: number;
};

export type SeedTraits = Readonly<Traits>;

const HAIR_PIN: Record<NonNullable<LookFields["hair"]>, Part<"hair">> = {
  flat: "fringe-crop", spiky: "tousled-crop", long: "long-straight", bald: "fringe-crop",
};
const HAT_PIN: Record<NonNullable<LookFields["hat"]>, Part<"hat"> | null> = {
  none: null, cap: "soft-cap", pointy: "folded-hat",
};
const BODY_WIDTH = 9;

export function classKit(classId: string | null): Kit {
  return classId && Object.hasOwn(KITS, classId) ? KITS[classId as keyof typeof KITS] : KITS.none;
}

export function seedTraits({ seed, classId, look }: Pick<ArtInput, "seed" | "classId" | "look">): SeedTraits {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  const roll = (range: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return Math.floor(((n ^ (n >>> 14)) >>> 0) / 0x100000000 * range);
  };
  const pick = <T>(values: readonly T[]) => values[roll(values.length)]!;
  const kit = classKit(classId);
  const height = 19 + roll(3);
  const ears = roll(4) === 0 ? "pointed" : "rounded";
  const face = pick(["round", "soft-oval"] as const);
  const eyes = pick(["bright", "gentle", "wide"] as const);
  const hair = pick(HAIR);
  const hairColour = roll(LOOK_HAIR_COLOURS.length);
  const skin = roll(LOOK_SKINS.length);
  const secondary = pick(MATERIALS);
  const blinkOffset = roll(5200);
  const hat = pick(kit.hats);
  const requestedLight = look?.light;
  const light = kit.tool === "staff-lantern" ? kit.light : requestedLight === "none" ? null : requestedLight ?? kit.light;
  return {
    shoulders: BODY_WIDTH, hips: BODY_WIDTH, hem: look?.build === "broad" ? 13 : 11,
    height, ears, face, eyes, hair: look?.hair ? HAIR_PIN[look.hair] : hair,
    hairColour: look?.hairColour ? LOOK_HAIR_COLOURS.indexOf(look.hairColour) : hairColour,
    skin: look?.skin ? LOOK_SKINS.indexOf(look.skin) : skin,
    secondary, blinkOffset,
    hat: look?.hair === "bald" ? "kerchief" : look?.hat ? HAT_PIN[look.hat] : hat,
    outfit: pick(kit.outfits), tool: kit.tool, light, day: kit.day,
  };
}
