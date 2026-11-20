// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureJournal, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { JournalTab } from "../../../src/ui/thread/tabs";
import { journalSchema, type JournalEntry } from "../../../src/shared/schema";
import { Tally, tallyMarks } from "../../../src/ui/kit";

afterEach(() => { cleanup(); localStorage.clear(); });
const base = fixtureJournal.entries[0]!;
const entry = (id: string, order: number, over: Partial<JournalEntry> = {}): JournalEntry => ({ ...base, id, order, description: `Entry ${id}`, status: "todo", ...over });
const review = { actor: { kind: "agent" as const, threadId: "warden-1" }, at: 2000, evidence: [], reason: "The totals row counts the tests twice.", previousNote: null, memberEvidenceAt: null };
// The server picks s1 (a ready step) over its parent a2, which is first in list order: the UI must follow the server.
const entries = [
  entry("a1", 0, { status: "done" }),
  entry("a2", 1, { description: "Build the notebook" }),
  entry("s0", 0, { parentId: "a2", status: "done", description: "Write the brief" }),
  entry("s1", 1, { parentId: "a2", description: "Draw the tally" }),
  entry("a3", 2, { status: "blocked", description: "Ship it" }),
  entry("a4", 3, { status: "rejected", review, description: "Count the lines" }),
  entry("a5", 4, { description: "Tidy up" }),
];
const changes = [{ id: 1, threadId: "keeper-1", at: 1500, actor: { kind: "agent" as const, threadId: "keeper-1" }, action: "block", entryIds: ["a3"], text: `Agent blocked [a3] "Ship it". Reason: "Waiting for the freeze to lift".`, seen: true }];
const progress = { done: 2, total: 7, blocked: 1, current: { id: "s1", description: "Draw the tally", status: "todo" as const } };
const journal = journalSchema.parse({ ...fixtureJournal, entries, changes, progress });
const open = (data = journal, journalEdit = vi.fn(() => ({ ok: true, message: "Recorded" })), threadId = "keeper-1") =>
  ({ slot: renderSlot({ component: JournalTab }, { threadId, environment: null, params: null }, { rpc: { journal: () => ({ ...data, threadId }), journalEdit, decor: () => fixtureDecor, registry: () => fixtureRegistry } }), journalEdit });
const edits = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(c => (c[0] as { edit: unknown }).edit);

describe("journal tally", () => {
  // The user: "shouldn't tallies draw one tally at a time to show progress?" A tally records only what has been counted.
  it("draws one stroke per done entry, and none for open, blocked or rejected entries", () => {
    for (const done of [0, 1, 4, 5, 6, 24, 40]) {
      const marks = tallyMarks({ done, total: 60, blocked: 3, rejected: 2 }, 400);
      expect(marks.strokes).toHaveLength(done);
      expect(marks.folded).toBe(0);
    }
    expect(tallyMarks({ done: 3, total: 8 }, 400).strokes.every(s => s.y1 === 2 || s.y2 === 2)).toBe(true);
  });
  it("grows by one stroke each time an entry is finished, with every fifth the gate's slash", () => {
    const four = tallyMarks({ done: 4, total: 10 }, 400).strokes;
    const five = tallyMarks({ done: 5, total: 10 }, 400).strokes;
    expect(five.slice(0, 4)).toEqual(four);
    expect(five[4]!.x1).toBeLessThan(five[4]!.x2);
    expect(five[4]!.y1).not.toBe(five[4]!.y2);
  });
  it("shows no strokes with nothing done, only the words", () => {
    const r = render(<Tally done={0} total={12} maxWidth={300} />);
    expect(r.getByRole("img", { name: "Tally: 0 of 12 done" }).querySelector("svg")).toBeNull();
  });
  it("keeps strokes at least 4 px apart", () => {
    const tight = tallyMarks({ done: 40, total: 60 }, 60).strokes.filter(s => s.x1 === s.x2).map(s => s.x1);
    expect(Math.min(...tight.slice(1).map((x, i) => x - tight[i]!))).toBeGreaterThanOrEqual(4);
  });
  it("folds whole done gates into +N once more than 40 are done, and says the counts in its label", () => {
    expect(tallyMarks({ done: 40, total: 100 }, 300).folded).toBe(0);
    expect(tallyMarks({ done: 70, total: 100 }, 300)).toMatchObject({ folded: 70, strokes: [] });
    expect(tallyMarks({ done: 73, total: 100 }, 300)).toMatchObject({ folded: 70 });
    expect(tallyMarks({ done: 73, total: 100 }, 300).strokes).toHaveLength(3);
    const r = render(<><Tally done={73} total={100} blocked={1} rejected={2} maxWidth={300} /><Tally done={4} total={4} variant="mini" maxWidth={90} /></>);
    expect(r.getByRole("img", { name: "Tally: 73 of 100 done, 1 blocked, 2 rejected" }).textContent).toContain("+70");
    expect(r.getAllByRole("img")).toHaveLength(1);
  });
  it("folds the Done fold's mini tally the same way: 47 done draw +45 and 2 strokes within 90 px", () => {
    const marks = tallyMarks({ done: 47, total: 47 }, 90, true);
    expect(marks.folded).toBe(45);
    expect(marks.strokes).toHaveLength(2);
    expect(marks.width).toBeLessThanOrEqual(90);
    const r = render(<Tally done={47} total={47} variant="mini" maxWidth={90} />);
    expect(r.container.querySelector(".tally-fold")?.textContent).toBe("+45");
    expect(r.container.querySelectorAll("line.tl")).toHaveLength(2);
  });
});


describe("notebook journal tab", () => {
  it("marks the server's current entry with the now line and the ribbon, not the first open one", async () => {
    const { slot } = open();
    const now = await slot.findByRole("button", { name: "Next: Draw the tally. Show it in the list" });
    expect(now.textContent).toContain("s1");
    expect(slot.container.querySelectorAll(".journal-row .ribbon")).toHaveLength(1);
    expect(slot.getByRole("button", { name: /^s1\s*Draw the tally, next$/ })).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Build the notebook, next/ })).toBeNull();
    expect(slot.getByRole("img", { name: "Tally: 2 of 7 done, 1 blocked, 1 rejected" })).toBeTruthy();
    expect(slot.getByText("1 blocked")).toBeTruthy();
    expect(slot.getByText("1 rejected")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("jumps to the current entry: back to All, the row focused", async () => {
    const { slot } = open();
    fireEvent.click(await slot.findByText("More"));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Done" }));
    await waitFor(() => expect(slot.queryByRole("button", { name: /Draw the tally, next/ })).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: /^Next: Draw the tally/ }));
    const row = await slot.findByRole("button", { name: /Draw the tally, next/ });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(within(slot.getByRole("group", { name: "Show" })).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("folds done steps under their parent into one row that opens in place", async () => {
    const { slot } = open();
    const fold = await slot.findByRole("button", { name: "1 done step" });
    expect(slot.queryByText("Write the brief")).toBeNull();
    fireEvent.click(fold);
    await slot.findByText("Write the brief");
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    slot.lifecycle.unmount();
  });

  it("offers Stuck only while something is stuck, with each reason on one line", async () => {
    const calm = journalSchema.parse({ ...journal, entries: entries.filter(e => e.id !== "a3" && e.id !== "a4"), progress: { ...progress, total: 5, blocked: 0 } });
    const first = open(calm, undefined, "calm-1");
    await first.slot.findByRole("group", { name: "Show" });
    expect(first.slot.queryByRole("button", { name: /^Stuck/ })).toBeNull();
    first.slot.lifecycle.unmount();
    cleanup();
    const { slot } = open(journal, undefined, "stuck-1");
    fireEvent.click(await slot.findByRole("button", { name: /^Stuck 2/ }));
    await slot.findByText("Waiting for the freeze to lift");
    expect(slot.getByText("The totals row counts the tests twice.")).toBeTruthy();
    expect(slot.queryByText("Tidy up")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps focus on the description when an entry opens", async () => {
    const { slot } = open();
    const desc = await slot.findByRole("button", { name: /^a5\s*Tidy up$/ });
    desc.focus();
    fireEvent.click(desc);
    await slot.findByRole("region", { name: "Details of Tidy up" });
    expect(document.activeElement).toBe(desc);
    slot.lifecycle.unmount();
  });

  it("cancels an edit with Escape and returns focus to the row", async () => {
    const { slot, journalEdit } = open();
    fireEvent.click(await slot.findByRole("button", { name: "More for “Tidy up”" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Edit description" }));
    const field = await slot.findByRole("textbox", { name: "Edit Tidy up" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    const desc = await slot.findByRole("button", { name: /^a5\s*Tidy up$/ });
    await waitFor(() => expect(document.activeElement).toBe(desc));
    expect(journalEdit).not.toHaveBeenCalled();
    slot.lifecycle.unmount();
  });

  // Pedro's live review: at 320 px the edit field took focus entirely behind the sticky header (input 187 to 231, header to 238).
  it("moves a focused edit form out from under the sticky header", async () => {
    const { slot } = open();
    const panel = (await slot.findByRole("button", { name: "More for “Tidy up”" })).closest<HTMLElement>(".tavern.journal")!;
    const scroller = panel.parentElement!;
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 796 });
    scroller.scrollTop = 145;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 320, width: 320, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const shift = 145 - scroller.scrollTop;
      if (this === scroller) return rect(48, 796);
      if (this.classList.contains("journal-head")) return rect(48, 189.84);
      if (this.classList.contains("journal-edit")) return rect(186.84 + shift, 44);
      if (this.tagName === "INPUT") return rect(186.84 + shift, 44);
      return original.call(this);
    };
    try {
      fireEvent.click(slot.getByRole("button", { name: "More for “Tidy up”" }));
      fireEvent.click(await slot.findByRole("menuitem", { name: "Edit description" }));
      const field = await slot.findByRole("textbox", { name: "Edit Tidy up" });
      expect(document.activeElement).toBe(field);
      await waitFor(() => expect(field.getBoundingClientRect().top).toBeGreaterThanOrEqual(237.84 + 8));
      expect(scroller.scrollTop).toBeCloseTo(145 - (237.84 + 8 - 186.84), 1);
    } finally { Element.prototype.getBoundingClientRect = original; }
    slot.lifecycle.unmount();
  });

  // Under load the menu trigger takes focus back a frame before the row becomes the edit form; with no box it must not scroll.
  it("leaves the scroll alone for a focused element that has no box", async () => {
    const { slot } = open();
    const trigger = await slot.findByRole("button", { name: "More for “Tidy up”" });
    const scroller = trigger.closest<HTMLElement>(".tavern.journal")!.parentElement!;
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 796 });
    scroller.scrollTop = 145;
    trigger.focus();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(scroller.scrollTop).toBe(145);
    slot.lifecycle.unmount();
  });

  it("confirms a delete on its own line with focus on Cancel", async () => {
    const { slot, journalEdit } = open();
    fireEvent.click(await slot.findByRole("button", { name: "More for “Build the notebook”" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Delete with 2 steps" }));
    const group = await slot.findByRole("group", { name: "Delete “Build the notebook”?" });
    expect(within(group).getByText("Delete with 2 steps?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(group).getByRole("button", { name: "Cancel" })));
    fireEvent.click(within(group).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(edits(journalEdit)).toContainEqual({ op: "delete", entryIds: ["a2"] }));
    slot.lifecycle.unmount();
  });

  it("gives an open entry at most one bordered action, chosen by its state", async () => {
    const withDoing = journalSchema.parse({ ...journal, entries: [...entries, entry("a6", 5, { status: "doing", description: "Doing work" }), entry("a7", 6, { status: "done", description: "Done work" })], progress: { ...progress, total: 9, done: 3 } });
    const { slot } = open(withDoing);
    const expected: [string, string[]][] = [["Tidy up", ["Start"]], ["Doing work", ["Done"]], ["Ship it", ["Unblock"]], ["Count the lines", ["Start"]]];
    for (const [name, buttons] of expected) {
      fireEvent.click(await slot.findByRole("button", { name: new RegExp(`^a\\d\\s*${name}(, (next|doing now))?$`) }));
      const region = await slot.findByRole("region", { name: `Details of ${name}` });
      const bordered = [...region.querySelectorAll(".journal-dacts .btn")].map(b => b.textContent);
      expect(bordered).toEqual(buttons);
    }
    fireEvent.click(slot.getByRole("button", { name: /Done · 2/ }));
    fireEvent.click(await slot.findByRole("button", { name: /^a7\s*Done work$/ }));
    const done = await slot.findByRole("region", { name: "Details of Done work" });
    expect(done.querySelectorAll(".journal-dacts .btn")).toHaveLength(0);
    expect(within(done).getByRole("button", { name: "Reopen" })).toBeTruthy();
    slot.lifecycle.unmount();
  }, 15000);

  it("shows the Warden's reason in full in an open rejected entry", async () => {
    const { slot } = open();
    fireEvent.click(await slot.findByRole("button", { name: /^a4\s*Count the lines$/ }));
    const region = await slot.findByRole("region", { name: "Details of Count the lines" });
    expect(within(region).getByText("The totals row counts the tests twice.")).toBeTruthy();
    expect(within(region).getByText("Rejected")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("clears done from the header menu and leaves a receipt with Undo", async () => {
    const { slot, journalEdit } = open();
    fireEvent.click(await slot.findByRole("button", { name: "Journal menu" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Clear done · 1" }));
    const receipt = await slot.findByText(/Cleared 1 done/);
    fireEvent.click(within(receipt).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(edits(journalEdit)).toEqual([{ op: "clear", all: false }, { op: "undo" }]));
    slot.lifecycle.unmount();
  });

  it("caps a long History fold and opens the rest with Show all N", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...changes[0]!, id: 100 + i, text: `Change ${i}` }));
    const { slot } = open(journalSchema.parse({ ...journal, changes: many }));
    const fold = await slot.findByText(/History · 25/);
    fold.closest("details")!.open = true;
    expect(slot.container.querySelectorAll(".journal-history li")).toHaveLength(20);
    fireEvent.click(slot.getByRole("button", { name: "Show all 25" }));
    await waitFor(() => expect(slot.container.querySelectorAll(".journal-history li")).toHaveLength(25));
    slot.lifecycle.unmount();
  });

  it("names actors mid-sentence and evidence without raw thread ids", async () => {
    const withEvidence = journalSchema.parse({ ...journal, entries: entries.map(e => e.id === "a4" ? { ...e, evidence: [{ kind: "note", ref: "count", detail: "Written by lark (thr_4d5aferz3e).", exitCode: null }, { kind: "command", ref: "npm test", detail: "8 passing", exitCode: 0 }] } : e) });
    const { slot } = open(withEvidence);
    fireEvent.click(await slot.findByRole("button", { name: /^a4\s*Count the lines$/ }));
    const region = await slot.findByRole("region", { name: "Details of Count the lines" });
    expect(region.textContent).toContain("Rejected by a thread");
    expect(region.textContent).not.toContain("thr_4d5aferz3e");
    const kinds = [...region.querySelectorAll(".evidence-list li")].map(li => li.textContent ?? "");
    expect(kinds.findIndex(t => t.includes("npm test"))).toBeLessThan(kinds.findIndex(t => t.includes("count")));
    slot.lifecycle.unmount();
  });
});
