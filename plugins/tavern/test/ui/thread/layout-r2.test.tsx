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
