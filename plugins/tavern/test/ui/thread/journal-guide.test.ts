import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom does no layout, so this reads the notebook's own numbers: the margin rule and every checkbox (a parent's, a step's, the done-steps fold) share one centre line.
const css = readFileSync("src/ui/thread/journal-notebook.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const phone = css.slice(css.indexOf("@media (pointer: coarse), (max-width: 560px) {"));
const desktop = css.slice(0, css.indexOf("@media (pointer: coarse), (max-width: 560px) {"));
const rule = (src: string, selector: string) => {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,{]`).exec(src);
  if (!m) return "";
  const open = src.indexOf("{", m.index);
  return src.slice(open + 1, src.indexOf("}", open));
};
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`))?.[1]?.trim() ?? null;
function vars(isPhone: boolean) {
  const out: Record<string, string> = {};
  for (const body of [rule(desktop, ".tavern.journal"), ...(isPhone ? [rule(phone, "  .tavern.journal")] : [])])
    for (const [, k, v] of body.matchAll(/(--jn-[\w-]+):\s*([^;]+)/g)) out[k!] = v!.trim();
  return out;
}
function px(value: string | null, v: Record<string, string>): number {
  if (!value) return 0;
  let s = value;
  for (let i = 0; i < 5 && s.includes("var("); i++) s = s.replace(/var\((--[\w-]+)\)/g, (_, k: string) => { if (!(k in v)) throw new Error(`unknown ${k}`); return v[k]!; });
  s = s.replace(/calc/g, "").replace(/px/g, "");
  if (!/^[\d\s.+\-*/()]+$/.test(s)) throw new Error(`not a length: ${value}`);
  return Function(`return (${s})`)() as number;
}
const paddingLeft = (body: string, v: Record<string, string>) => { const p = decl(body, "padding")!.split(/\s+(?![^(]*\))/); return px(p[3] ?? p[1] ?? p[0]!, v); };

describe("the journal's margin rule", () => {
  it.each([["desktop", false], ["phone", true]] as const)("runs through the centre of every checkbox on %s", (_, isPhone) => {
    const v = vars(isPhone);
    const hit = px("var(--jn-hit)", v);
    const line = px(decl(rule(desktop, ".tavern.journal > .journal-list::before"), "left"), v) + px(decl(rule(desktop, ".tavern.journal > .journal-list::before"), "width"), v) / 2;
    const row = paddingLeft(rule(desktop, ".tavern .journal-row"), v);
    const stepsIndent = px(decl(rule(desktop, ".tavern .journal-steps"), "margin-left"), v);
    const parent = row + hit / 2, step = stepsIndent + row + hit / 2;
    expect({ parent: parent - line, step: step - line }).toEqual({ parent: 0, step: 0 });
    // The done-steps fold draws its tick in a box as wide as a checkbox, so it sits on the line too.
    expect(decl(rule(desktop, ".tavern .journal-stepfold .tal"), "width")).toBe("var(--jn-hit)");
  });
  it("keeps steps indented by their text, so the outline still reads", () => {
    expect(px(decl(rule(desktop, ".tavern .journal-steps .journal-row .desc"), "margin-left"), vars(false))).toBeGreaterThanOrEqual(16);
  });
});

describe("the row's quick controls", () => {
  it("take no room while hidden and appear on hover, focus or the open entry", () => {
    expect(decl(rule(desktop, ".tavern .journal-ctl"), "display")).toBe("none");
    expect(desktop).toMatch(/\.tavern \.journal-row:is\(:hover, :focus-within\) \.journal-ctl, \.tavern \.journal-entry\.open > \.journal-row \.journal-ctl \{\s*display: inline-flex;/);
  });
  it("never change the row's height when they appear", () => {
    const v = vars(false);
    expect(px(decl(rule(desktop, ".tavern .journal-row"), "min-height"), v)).toBeGreaterThanOrEqual(px("var(--jn-hit)", v));
  });
  it("stay hidden on phones even on the open entry, whose detail carries them", () => {
    expect(phone).toMatch(/\.tavern \.journal-row \.journal-ctl, \.tavern \.journal-row:is\(:hover, :focus-within\) \.journal-ctl, \.tavern \.journal-entry\.open > \.journal-row \.journal-ctl \{ display: none; \}/);
  });
});
