// The vocabulary a character's `look:` frontmatter speaks, and the pixel renderer draws: words, not numbers, so a person editing a
// character file can see what they are choosing. Kept out of schema.ts so the UI can import it without pulling zod into the bundle, as
// heraldry.ts does for the crest.

export const LOOK_BUILDS = ["slim", "broad"] as const;
export const LOOK_HAIRS = ["flat", "spiky", "long", "bald"] as const;
export const LOOK_HAIR_COLOURS = ["brown", "black", "sand", "grey", "rust"] as const;
export const LOOK_SKINS = ["fair", "tan", "deep"] as const;
export const LOOK_HATS = ["none", "cap", "pointy"] as const;

export type LookFields = {
  build?: (typeof LOOK_BUILDS)[number];
  hair?: (typeof LOOK_HAIRS)[number];
  hairColour?: (typeof LOOK_HAIR_COLOURS)[number];
  skin?: (typeof LOOK_SKINS)[number];
  hat?: (typeof LOOK_HATS)[number];
};
