// What changed between two versions of a spec, part by part, for the page to show: a setting with its old and new value,
// list items added or removed, rewritten text word by word, and tickets added or removed. specChanges says which paths
// changed; this says how. Only types come from ./spec, so the page can import this file.
import type { Spec, TicketSpec } from "./spec";
import { isUnder } from "./spec-paths";

/** The page section a part of the spec belongs to. */
export type SpecSection = "settings" | "tickets" | "guardrails";

export interface ListStep {
  op: "same" | "added" | "removed";
  value: string;
  /** The item's index in the newer list, or in the older list for a removed item. */
  index: number;
}

export interface TextStep {
  op: "same" | "added" | "removed";
  text: string;
}

interface ChangeBase {
  /** The part's spec path, in the grammar of spec-paths. */
  path: string;
  section: SpecSection;
  /** The ticket the part belongs to; null outside the tickets. */
  ref: string | null;
}

export type SpecChange =
  | (ChangeBase & { kind: "value"; before: unknown; after: unknown })
  | (ChangeBase & { kind: "list"; steps: ListStep[]; added: number; removed: number })
  | (ChangeBase & { kind: "text"; before: string; after: string })
  /** `from`: the removed tickets whose scope it shares, which it most likely takes over from. */
  | (ChangeBase & { kind: "ticket-added"; ref: string; from: string[] })
  /** `into`: the added tickets that share its scope. */
  | (ChangeBase & { kind: "ticket-removed"; ref: string; into: string[] });

const GUARDRAILS = ["project.goal", "project.summary", "project.done_when", "project.non_goals", "project.open_questions", "project.name", "project.key", "project.slug", "review.rubric"];
// A string this long, or with a line break, reads better as a word diff than as an old and a new value.
const TEXT_LENGTH = 160;
// Word diffs past this many cells fall back to lines, so a rewritten 8000-character brief stays cheap.
const MAX_WORD_CELLS = 4_000_000;

export const sectionOf = (path: string): SpecSection =>
  path.startsWith("ticket[") ? "tickets" : GUARDRAILS.some((root) => path === root || isUnder(path, root)) ? "guardrails" : "settings";

/** True when the change is at `path`, under it or above it. */
export const touches = (change: Pick<SpecChange, "path">, path: string): boolean => change.path === path || isUnder(change.path, path) || isUnder(path, change.path);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isTextPath = (path: string) => path === "project.goal" || path === "project.summary" || /^ticket\[[^\]]+\]\.body$/.test(path);

/** The longest common subsequence of `a` and `b` as steps; on a tie a removal comes before the addition that replaces it. */
function lcs<T>(a: readonly T[], b: readonly T[]): Array<{ op: ListStep["op"]; value: T; index: number }> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const steps: Array<{ op: ListStep["op"]; value: T; index: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) steps.push({ op: "same", value: b[j]!, index: j++ }), i++;
    else if (i < a.length && (j >= b.length || table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)) steps.push({ op: "removed", value: a[i]!, index: i++ });
    else steps.push({ op: "added", value: b[j]!, index: j++ });
  }
  return steps;
}

export const listSteps = (before: readonly string[], after: readonly string[]): ListStep[] => lcs(before, after);

/** `before` rewritten as `after`, word by word (or line by line for very long texts), with neighbouring steps of one kind merged. */
export function textSteps(before: string, after: string): TextStep[] {
  const words = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let a = words(before);
  let b = words(after);
  if (a.length * b.length > MAX_WORD_CELLS) {
    a = lines(before);
    b = lines(after);
  }
  const steps: TextStep[] = [];
  for (const { op, value } of lcs(a, b)) {
    const last = steps.at(-1);
    if (last?.op === op) last.text += value;
    else steps.push({ op, text: value });
  }
  return steps;
}

function walk(out: SpecChange[], path: string, before: unknown, after: unknown, ref: string | null): void {
  if (same(before, after)) return;
  const at = { path, section: sectionOf(path), ref };
  if ((isStringList(before) || before === undefined) && (isStringList(after) || after === undefined)) {
    const steps = listSteps(before ?? [], after ?? []);
    out.push({ ...at, kind: "list", steps, added: steps.filter((step) => step.op === "added").length, removed: steps.filter((step) => step.op === "removed").length });
    return;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    for (let index = 0; index < Math.max(a.length, b.length); index++) walk(out, `${path}[${index}]`, a[index], b[index], ref);
    return;
  }
  if (isObject(before) || isObject(after)) {
    const a = isObject(before) ? before : {};
    const b = isObject(after) ? after : {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(out, path === "" ? key : `${path}.${key}`, a[key], b[key], ref);
    return;
  }
  const long = [before, after].some((text) => typeof text === "string" && (text.length > TEXT_LENGTH || text.includes("\n")));
  if ((typeof before === "string" || typeof after === "string") && (isTextPath(path) || long)) {
    out.push({ ...at, kind: "text", before: typeof before === "string" ? before : "", after: typeof after === "string" ? after : "" });
    return;
  }
  out.push({ ...at, kind: "value", before, after });
}

/** The tickets of `others` in the same repo as `ticket` that list one of its scope globs. */
const sharingScope = (ticket: TicketSpec, others: readonly TicketSpec[]) => others.filter((other) => (other.repo ?? null) === (ticket.repo ?? null) && other.scope.some((glob) => ticket.scope.includes(glob))).map((other) => other.ref);

/** Every part `after` changed from `before`: the settings first, then the tickets in `after`'s order, then the removed tickets. */
export function specDiff(before: Spec, after: Spec): SpecChange[] {
  const out: SpecChange[] = [];
  const { ticket: oldTickets, ...oldRest } = before;
  const { ticket: newTickets, ...newRest } = after;
  walk(out, "", oldRest, newRest, null);
  const oldByRef = new Map(oldTickets.map((ticket) => [ticket.ref, ticket]));
  const newRefs = new Set(newTickets.map((ticket) => ticket.ref));
  const added = newTickets.filter((ticket) => !oldByRef.has(ticket.ref));
  const removed = oldTickets.filter((ticket) => !newRefs.has(ticket.ref));
  for (const ticket of newTickets) {
    const old = oldByRef.get(ticket.ref);
    const path = `ticket[${ticket.ref}]`;
    if (old === undefined) out.push({ path, section: "tickets", ref: ticket.ref, kind: "ticket-added", from: sharingScope(ticket, removed) });
    else walk(out, path, old, ticket, ticket.ref);
  }
  for (const ticket of removed) out.push({ path: `ticket[${ticket.ref}]`, section: "tickets", ref: ticket.ref, kind: "ticket-removed", into: sharingScope(ticket, added) });
  const order: SpecSection[] = ["settings", "tickets", "guardrails"];
  return out.map((change, index) => ({ change, index })).sort((a, b) => order.indexOf(a.change.section) - order.indexOf(b.change.section) || a.index - b.index).map(({ change }) => change);
}
