import { blockCount, parseBody } from "./blocks";

// A table is usually drawn evidence already; measured timing comparisons are the narrow exception.
// Both hints share the same budget so presentation advice never interrupts a turn.

/** Below this many characters a body is a quick note, and prose is right for it. */
export const PROSE_MIN = 200;
export const NUMBERS_MIN = 6;
export const ITEMS_MIN = 3;

export interface Drawable {
  numbers: number;
  items: number;
  files: string[];
  timingRows?: number;
}

// A number standing on its own: not part of a hash, a PR number, a version or a name such as lx7.
const NUMBER = /(?<![\w#.\/-])\d[\d,]*(?:\.\d+)?%?(?![\w\/-])/g;
const ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s+\S/gm;
const FILE = /(?:\$BB_THREAD_STORAGE|[~\w./-]*\/\.bb\/thread-storage)\/[^\s`'")\]]+/g;
const TABLE_RULE = /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const IMAGE = /!\[[^\]]*\]\([^)]+\)/;
const TIMING_COLUMN = /\b(?:timings?|time|latency|durations?|elapsed|runtime|p(?:50|90|95|99))\b/i;
const CONFIG_COLUMN = /\b(?:slo|targets?|budgets?|limits?|ttl|timeouts?|max(?:imum)?)\b/i;
const TIME_UNIT = "(?:ns|µs|us|ms|s|secs?|seconds?|milliseconds?|m|mins?|minutes?|h|hrs?|hours?)";
const DELTA = "(?:\\s*\\([+\\-−]?\\d+(?:\\.\\d+)?%\\))?";
const HEADER_UNIT = new RegExp(`(?:^|[\\s(])${TIME_UNIT}(?:$|[\\s)])`, "i");
const MEASUREMENT = new RegExp(`^[~≈]?\\s*(?:\\d[\\d,]*(?:\\.\\d+)?\\s*${TIME_UNIT}\\s*)+${DELTA}$`, "i");
const NUMBER_CELL = new RegExp(`^[~≈]?\\s*\\d[\\d,]*(?:\\.\\d+)?${DELTA}$`);

function tableCells(line: string): string[] {
  const text = line.trim();
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && index + 1 < text.length) {
      cell += char + text[++index];
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

function timingComparisonRows(body: string): number | null {
  const lines = body.split("\n");
  for (let index = 1; index < lines.length; index++) {
    if (!TABLE_RULE.test(lines[index]!)) continue;
    const headers = tableCells(lines[index - 1]!);
    const columns = headers.flatMap((header, column) =>
      TIMING_COLUMN.test(header) && !CONFIG_COLUMN.test(header) ? [{ column, unit: HEADER_UNIT.test(header) }] : [],
    );
    if (columns.length === 0) continue;
    let measurements = 0;
    for (let row = index + 1; row < lines.length; row++) {
      const cells = tableCells(lines[row]!);
      if (cells.length !== headers.length || TABLE_RULE.test(lines[row]!)) break;
      if (columns.some(({ column, unit }) => {
        const value = cells[column]!.replace(/[`*_]/g, "").trim();
        return MEASUREMENT.test(value) || (unit && NUMBER_CELL.test(value));
      })) measurements++;
    }
    if (measurements >= 2) return measurements;
  }
  return null;
}

/** Evidence that deserves presentation advice, or null when it is already drawn or a quick status. */
export function drawable(body: string): Drawable | null {
  const segments = parseBody(body);
  if (blockCount(segments) > 0) return null;
  const prose = segments.map((segment) => segment.text).join("\n\n");
  if (prose.length < PROSE_MIN || IMAGE.test(prose)) return null;
  if (TABLE_RULE.test(prose)) {
    const timingRows = timingComparisonRows(prose);
    return timingRows === null ? null : { numbers: 0, items: 0, files: [], timingRows };
  }
  const found: Drawable = {
    numbers: prose.match(NUMBER)?.length ?? 0,
    items: prose.match(ITEM)?.length ?? 0,
    files: [...new Set((prose.match(FILE) ?? []).map((file) => file.replace(/[.,;:]+$/, "")))],
  };
  return found.files.length > 0 || found.numbers >= NUMBERS_MIN || found.items >= ITEMS_MIN ? found : null;
}

/** The note added to "Flare sent" for a body that is all text: why a view is allowed, and which views fit. */
export function drawHint(found: Drawable): string {
  if (found.timingRows !== undefined) {
    return [
      `This flare compares ${found.timingRows} measured timings in a Markdown table.`,
      "If genui is available, show the next timing comparison as a Chart using the compact flare reference; use Markdown if it is unavailable.",
      "The flare is already saved. Keep working; do not resend it or build a separate report for this hint.",
    ].join(" ");
  }
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
