import type { ClassDef } from "../shared/schema";

function normalize(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}
function roman(value: number) {
  let text = "";
  for (const [unit, symbol] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const) {
    while (value >= unit) {
      text += symbol;
      value -= unit;
    }
  }
  return text;
}
export function uniqueMemberName(base: string, used: string[]) {
  const names = new Set(used.map((name) => normalize(name).toLowerCase()));
  if (!names.has(normalize(base).toLowerCase())) return base;
  let number = 2;
  while (names.has(`${base} ${roman(number)}`.toLowerCase())) number++;
  return `${base} ${roman(number)}`;
}

export function memberTitle(
  name: string,
  title: string,
  classes: Pick<ClassDef, "id" | "label" | "plain">[],
) {
  const roleWords = new Set([
    "ranger",
    "scout",
    "smith",
    "builder",
    "warden",
    "checker",
    "wanderer",
    "keeper",
    ...classes
      .flatMap((role) => [role.id, role.label, role.plain])
      .map((word) => normalize(word).toLowerCase()),
  ]);
  let task = normalize(title);
  for (;;) {
    const colon = task.indexOf(":");
    if (colon < 0 || !roleWords.has(task.slice(0, colon).trim().toLowerCase())) break;
    task = task.slice(colon + 1).trim();
  }
  const full = `${normalize(name)} · ${task || "Untitled task"}`;
  const characters = Array.from(full);
  return characters.length <= 60 ? full : characters.slice(0, 59).join("").trimEnd() + "…";
}
