import { blockCount, parseBody } from "./blocks";

// Agents wrote every flare as prose, even with genui loaded, because another instruction keeps tool input plain text.
// A flare whose body is all text but carries what a view shows better gets one hint per turn in the tool's result.

/** Below this many characters a body is a quick note, and prose is right for it. */
export const PROSE_MIN = 200;
export const NUMBERS_MIN = 6;
export const ITEMS_MIN = 3;

export interface Drawable {
  numbers: number;
  items: number;
  files: string[];
}

// A number standing on its own: not part of a hash, a PR number, a version or a name such as lx7.
const NUMBER = /(?<![\w#.\/-])\d[\d,]*(?:\.\d+)?%?(?![\w\/-])/g;
const ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/gm;
const FILE = /(?:\$BB_THREAD_STORAGE|[~\w./-]*\/\.bb\/thread-storage)\/[^\s`'")\]]+/g;
const TABLE_RULE = /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const IMAGE = /!\[[^\]]*\]\([^)]+\)/;

/** What a body that is all text holds that a view would show better, or null when it has a view or nothing to draw. */
export function drawable(body: string): Drawable | null {
  const segments = parseBody(body);
  if (blockCount(segments) > 0) return null;
  const prose = segments.map((segment) => segment.text).join("\n\n");
  if (prose.length < PROSE_MIN || TABLE_RULE.test(prose) || IMAGE.test(prose)) return null;
  const found: Drawable = {
    numbers: prose.match(NUMBER)?.length ?? 0,
    items: prose.match(ITEM)?.length ?? 0,
    files: [...new Set((prose.match(FILE) ?? []).map((file) => file.replace(/[.,;:]+$/, "")))],
  };
  return found.files.length > 0 || found.numbers >= NUMBERS_MIN || found.items >= ITEMS_MIN ? found : null;
}

/** The note added to "Flare sent" for a body that is all text: why a view is allowed, and which views fit. */
export function drawHint(found: Drawable): string {
  const fits: string[] = [];
  if (found.files.length > 0) fits.push(`Load \`${found.files[0]}\` into its view instead of describing it, or show screenshots with Image or Gallery`);
  if (found.numbers >= NUMBERS_MIN) fits.push("put its numbers in a `ui` Metric row, a Chart or a Table");
  if (found.items >= ITEMS_MIN) fits.push(`turn its ${found.items} bullets into a Table, Steps or a mermaid diagram`);
  return [
    "This flare is all text.",
    "The Flares tab draws a body the way bb draws a reply, and the rule that only the message ending your turn may hold a block does not cover a flare.",
    `Next time, open with a sentence and show the evidence: ${fits.join("; ")}.`,
  ].join(" ");
}
