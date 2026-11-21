import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KeeperNoteRows } from "../../../src/ui/kit/memory";
import { keeperNoteSchema } from "../../../src/shared/schema";

const css = readFileSync("src/ui/kit/components.css", "utf8");
afterEach(cleanup);

it("keeps the content-sized desktop bar label column", () => {
  const rule = css.match(/\.tavern \.tchart-bars\s*\{([^}]+)\}/)![1];
  expect(rule).toContain("grid-template-columns: minmax(0, max-content) minmax(40px, 1fr) max-content");
});

it.each([false, true])("gives truncated note tags and plain metadata full tooltips (condition: %s)", conditional => {
  const note = keeperNoteSchema.parse({ id: "n1", keeperThreadId: "keeper", boardQuestId: "q1", kind: "commitment", text: "Check the release", dueAt: conditional ? null : Date.now() + 3600_000, condition: conditional ? "The release finishes" : null, createdAt: Date.now(), updatedAt: Date.now(), validUntil: null, sourceMessageId: null, routeId: null, state: "open", doneAt: null, dueNotifiedAt: null });
  const short = "Monitor Edge infrastructure operations";
  const view = render(<KeeperNoteRows notes={[note]} short={() => short} label="Promises" />);
  expect(view.container.querySelector(".lg-q")?.getAttribute("title")).toBe(short);
  const meta = view.container.querySelector(".mem-meta > span")!;
  expect(meta.getAttribute("title")).toContain(meta.textContent);
  if (conditional) {
    expect(meta.textContent).toBe("no deadline");
    expect(meta.getAttribute("title")).toContain(note.condition);
  }
});

it("keeps progress and decision counts whole instead of ellipsizing their nouns", () => {
  for (const selector of ["qrow-path", "krow-dec"]) {
    const rule = css.match(new RegExp(`\\.tavern \\.${selector}\\s*\\{([^}]+)\\}`))![1];
    expect(rule).toContain("flex: none");
    expect(rule).not.toContain("text-overflow: ellipsis");
  }
  expect(css.match(/\.tavern :is\(\.krow-s[^)]+\)/)?.[0]).not.toContain(".krow-dec");
});

it("retains member clipping and limits the new gap rule to Keepers", () => {
  const clip = css.match(/\.tavern\.v-member \.tw-row > \.tw-id\s*\{([^}]+)\}/)?.[1];
  expect(clip).toContain("overflow: clip");
  expect(clip).toContain("overflow-clip-margin: 4px");
  expect(css.match(/max-width: 520px\) \{ \.tavern\.twidget \.tw-row[^}]+/)?.[0]).toBeUndefined();
});

it.each([[576, ":only-child"], [645, ":nth-child(2)"], [715, ":nth-child(3)"]] as const)("uses the measured %i px boundary for %s", (width, count) => {
  const start = css.indexOf(`@container tavern-widget (max-width: ${width}px)`);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  expect(block).toContain(`.tw-row:has(.tw-quest${count}) .tw-quests { display: none; }`);
  expect(block).toContain(`.tw-row:has(.tw-quest${count}) .tw-quests-count { display: inline-flex; }`);
  expect(block).toContain(`.tw-row:has(.tw-quest${count}) :is(.tw-free, .tw-ledger > span, .tw-ledger > svg:last-child) { display: none; }`);
});

it.each([[611, ".tw-quest:only-child"], [810, ".tw-quests:has(.tw-quest:nth-child(3)) .tw-quest"]] as const)("keeps phase strips out of the measured transition gap at %i px", (width, selector) => {
  const start = css.indexOf(`@container tavern-widget (max-width: ${width}px)`);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  expect(block).toContain(`${selector} .tw-ph { display: none; }`);
  expect(block).toContain(`${selector} { min-width: calc(6ch + 26px); }`);
});

it("does not introduce an unconditional quest collapse above 520 or phase-word drop at 900", () => {
  const extra = [...css.matchAll(/@container tavern-widget \(max-width: (\d+)px\)\s*\{\s*\.tavern \.tw-quests\s*\{ display: none/g)].map(m => Number(m[1]));
  expect(extra.filter(w => w > 520)).toEqual([]);
  expect(css.match(/max-width: 900px\) \{ \.tavern \.tw-quest \.tw-pw[^}]+/)?.[0]).toBeUndefined();
});
