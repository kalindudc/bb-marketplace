// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EntryStatus, Journal } from "../../../src/shared/schema";
import { Tally, diffJournal, journalSnapshot, useJournalCues } from "../../../src/ui/kit";
import { TYPING_HOLD_MS, motion } from "../../../src/ui/kit/motion";
import { fixtureJournal } from "../../../src/ui/thread/fixtures";
import { flush, installAnimations } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
let t = 0;
/** Where rows and the panel sit on screen, by entry id ("root" for the panel); anything not placed has no box, as jsdom draws it. */
const rects = new Map<string, Partial<DOMRect>>();
const place = (key: string, top: number, height = 28) => rects.set(key, { top, bottom: top + height, left: 0, right: 300, width: 300, height });
const realRect = HTMLElement.prototype.getBoundingClientRect;
let observers = 0;
beforeEach(() => {
  motion.reset(); t = 1_000_000; motion.now = () => t;
  fx = installAnimations({ "mo-chalk": 180, "mo-slash": 180, "mo-verified": 260 });
  rects.clear(); observers = 0;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const key = this.classList.contains("notebook") ? "root" : this.classList.contains("journal-row") ? this.parentElement?.dataset.entry : undefined;
    return { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...(key ? rects.get(key) : undefined) } as DOMRect;
  };
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class { constructor() { observers++; } observe() {} disconnect() {} };
});
afterEach(() => {
  cleanup(); fx.uninstall(); motion.reset(); delete document.documentElement.dataset.motion;
  for (const c of document.querySelectorAll("[data-test-composer]")) c.remove();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

type Entry = Journal["entries"][number];
type Change = Journal["changes"][number];
const base = fixtureJournal.entries[0]!;
const entry = (id: string, status: EntryStatus): Entry => ({ ...base, id, status, description: `Entry ${id}` });
let changeId = 1;
const change = (ids: string[], who: "user" | "agent", action = "done"): Change => ({ id: changeId++, threadId: "t1", at: 0, actor: who === "user" ? { kind: "user" } : { kind: "agent", threadId: "t1" }, action, entryIds: ids, text: "", seen: true });
function journal(statuses: Record<string, EntryStatus>, changes: Change[] = [], current: string | null = null) {
  const entries = Object.entries(statuses).map(([id, s]) => entry(id, s));
  const cur = current ? entries.find(e => e.id === current)! : null;
  const done = entries.filter(e => e.status === "done" || e.status === "verified").length;
  return { entries, changes, progress: { ...fixtureJournal.progress, done, total: entries.length, current: cur ? { id: cur.id, description: cur.description, status: cur.status } : null } } as Pick<Journal, "entries" | "changes" | "progress">;
}
const open = (n: number, prefix = "e") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, "todo" as EntryStatus]));
const doneN = (n: number, total: number) => Object.fromEntries(Array.from({ length: total }, (_, i) => [`e${i + 1}`, (i < n ? "done" : "todo") as EntryStatus]));

let renders = 0;
/**
 * A journal panel as journal.tsx draws it, reduced to what the hook reads: the header tally, rows with marks, and the ribbon. `rows`
 * stands for a filter or a fold: it changes which rows are drawn without a new journal result.
 */
function Panel({ data, fetching = false, rows, scrolls }: { data: ReturnType<typeof journal>; fetching?: boolean; rows?: (e: Entry) => boolean; scrolls?: boolean }) {
  renders++;
  const root = useRef<HTMLDivElement>(null);
  useJournalCues("t1", data, root, { fetching });
  const done = data.entries.filter(e => e.status === "done" || e.status === "verified").length;
  const verified = data.entries.filter(e => e.status === "verified").length;
  return <div ref={root} className="tavern journal notebook" style={scrolls ? { overflowY: "auto" } : undefined}>
    <Tally done={done} total={data.entries.length} verified={verified} maxWidth={400} />
    {data.entries.filter(rows ?? (() => true)).map(e => <div key={e.id} className="journal-entry" data-entry={e.id} data-entry-state={e.status}>
      <div className="journal-row">{data.progress.current?.id === e.id && <span className="ribbon row" />}<svg className={`smark s-${e.status}`} /></div>
    </div>)}
    <input aria-label="Add a journal entry" />
  </div>;
}
const cues = () => fx.all.map(a => a.className ?? "animate");
const refusals = () => motion.log.map(l => `${l.kind}:${l.reason}`);

describe("diffJournal", () => {
  it("names entries seen open that are now done, and who did it from the newest change", () => {
    const prev = journalSnapshot(journal({ a: "todo", b: "doing", c: "done" }));
    const next = journalSnapshot(journal({ a: "done", b: "done", c: "done" }));
    const d = diffJournal(prev, next, [change(["a"], "agent"), change(["b"], "agent"), change(["b"], "user")]);
    expect(d.done).toEqual([{ id: "a", byUser: false }, { id: "b", byUser: true }]);
    expect(d.doneRose).toBe(true);
  });
  it("ignores ids the earlier result didn't have, as an Undo of Clear done brings them back", () => {
    const d = diffJournal(journalSnapshot(journal({ a: "todo" })), journalSnapshot(journal({ a: "todo", b: "done", c: "done" })), []);
    expect(d.done).toEqual([]);
    expect(d.doneRose).toBe(true);
  });
  it("counts done to verified as verified only, and the current entry when it moves", () => {
    const d = diffJournal(journalSnapshot(journal({ a: "done", b: "todo" }, [], "a")), journalSnapshot(journal({ a: "verified", b: "doing" }, [], "b")), [change(["a"], "agent", "verify")]);
    expect(d.done).toEqual([]);
    expect(d.verified).toEqual([{ id: "a", byUser: false }]);
    expect(d.current).toEqual({ from: "a", to: "b", byUser: false });
  });
});

describe("useJournalCues", () => {
  it("records the first result, whatever it holds, and cues nothing", () => {
    render(<Panel data={journal(doneN(3, 6))} />);
    expect(cues()).toEqual([]);
  });

  it("sets down only the new stroke when an agent finishes an entry", () => {
    const view = render(<Panel data={journal(doneN(2, 6))} />);
    view.rerender(<Panel data={journal(doneN(3, 6), [change(["e3"], "agent")])} />);
    expect(cues()).toEqual(["mo-chalk"]);
    const lines = view.container.querySelectorAll('[data-tally="head"] line');
    expect(fx.all[0]!.target).toBe(lines[lines.length - 1]);
  });

  it("plays one stroke for a batch, and the slash when the batch closes a gate", () => {
    const view = render(<Panel data={journal(doneN(2, 9))} />);
    view.rerender(<Panel data={journal(doneN(5, 9), [change(["e3", "e4", "e5"], "agent")])} />);
    expect(cues()).toEqual(["mo-slash"]);
  });

  it("draws nothing when the new stroke folded into +N, and the next one after the fold", () => {
    const view = render(<Panel data={journal(doneN(44, 50))} />);
    view.rerender(<Panel data={journal(doneN(45, 50), [change(["e45"], "agent")])} />);
    expect(cues()).toEqual([]);
    t += 60_000;
    view.rerender(<Panel data={journal(doneN(46, 50), [change(["e46"], "agent")])} />);
    expect(cues()).toEqual(["mo-chalk"]);
  });

  it("never cues an Undo of Clear done", () => {
    const view = render(<Panel data={journal(open(3))} />);
    view.rerender(<Panel data={journal({ ...open(3), d1: "done", d2: "done" }, [change(["d1", "d2"], "user", "undo")])} />);
    expect(cues()).toEqual([]);
  });

  it("treats a cached journal and the refetch that follows it as the baseline, and cues what comes after", () => {
    const view = render(<Panel data={journal(doneN(2, 6))} fetching />);
    view.rerender(<Panel data={journal(doneN(3, 6), [change(["e3"], "agent")])} />);
    expect(cues()).toEqual([]);
    view.rerender(<Panel data={journal(doneN(3, 6), [change(["e3"], "agent")])} fetching />);
    view.rerender(<Panel data={journal(doneN(4, 6), [change(["e4"], "agent")])} />);
    expect(cues()).toEqual(["mo-chalk"]);
  });

  it("holds an agent's stroke while a blocked or rejected entry is on screen, and still plays the user's own", () => {
    place("x", 40);
    const view = render(<Panel data={journal({ ...doneN(1, 4), x: "blocked" })} />);
    view.rerender(<Panel data={journal({ ...doneN(2, 4), x: "blocked" }, [change(["e2"], "agent")])} />);
    expect(cues()).toEqual([]);
    expect(refusals()).toContain("tally stroke:held");
    view.rerender(<Panel data={journal({ ...doneN(3, 4), x: "blocked" }, [change(["e3"], "user")])} />);
    expect(cues()).toEqual(["mo-chalk"]);
  });

  it("plays an agent's stroke when the blocked entry is scrolled out of the panel", () => {
    place("root", 0, 200); place("x", 400);
    const view = render(<Panel data={journal({ ...doneN(1, 4), x: "rejected" })} scrolls />);
    view.rerender(<Panel data={journal({ ...doneN(2, 4), x: "rejected" }, [change(["e2"], "agent")])} scrolls />);
    expect(cues()).toEqual(["mo-chalk"]);
  });

  it("holds after a filter switch draws a blocked row, with no new result between", () => {
    place("x", 40);
    const notStuck = (e: Entry) => e.status !== "blocked";
    const view = render(<Panel data={journal({ ...doneN(1, 4), x: "blocked" })} rows={notStuck} />);
    view.rerender(<Panel data={journal({ ...doneN(1, 4), x: "blocked" })} />);
    view.rerender(<Panel data={journal({ ...doneN(2, 4), x: "blocked" }, [change(["e2"], "agent")])} />);
    expect(cues()).toEqual([]);
    expect(refusals()).toContain("tally stroke:held");
  });

  it("holds in the result that blocks one entry and finishes another, with no observer to wait for", () => {
    place("x", 40);
    const view = render(<Panel data={journal({ ...doneN(1, 4), x: "doing" })} />);
    view.rerender(<Panel data={journal({ ...doneN(2, 4), x: "blocked" }, [change(["e2"], "agent"), change(["x"], "agent", "block")])} />);
    expect(cues()).toEqual([]);
    expect(refusals()).toContain("tally stroke:held");
    expect(observers).toBe(0);
  });

  it("doesn't re-render the journal when the window loses or regains focus", () => {
    const view = render(<Panel data={journal(doneN(1, 4))} />);
    view.rerender(<Panel data={journal(doneN(2, 4), [change(["e2"], "agent")])} />);
    const before = renders;
    act(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    expect(renders).toBe(before);
  });

  describe("the typing hold", () => {
    /** bb's composer, outside the panel: a contenteditable, focused when a thread opens, with any restored draft in it. */
    const composer = (draft = "") => {
      const c = document.createElement("div");
      c.setAttribute("contenteditable", "true"); c.tabIndex = 0; c.dataset.testComposer = ""; c.textContent = draft;
      document.body.appendChild(c);
      return c;
    };
    const fire = (el: Element, type: string, init: KeyboardEventInit = {}) =>
      act(() => { el.dispatchEvent(type.startsWith("key") ? new KeyboardEvent(type, { bubbles: true, ...init }) : new Event(type, { bubbles: true })); });
    const step = (view: ReturnType<typeof render>, n: number) => view.rerender(<Panel data={journal(doneN(n, 6), [change([`e${n}`], "agent")])} />);
    const strokes = (view: ReturnType<typeof render>) => view.container.querySelectorAll('[data-tally="head"] line').length;

    it("plays with an empty composer focused, as bb leaves it when a thread opens, and with a restored draft in a focused field", async () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      act(() => c.focus());
      step(view, 2);
      expect(document.activeElement).toBe(c);
      expect(cues()).toEqual(["mo-chalk"]);
      fx.tick(1000); await act(flush); t += 60_000;
      const field = view.getByRole("textbox") as HTMLInputElement;
      field.value = "a draft bb restored";
      act(() => field.focus());
      step(view, 3);
      expect(cues()).toEqual(["mo-chalk", "mo-chalk"]);
    });

    it("holds for 2 s after the last input in any text field, draws the mark still, and never plays it later", () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      fire(c, "input");
      t += TYPING_HOLD_MS - 1;
      step(view, 2);
      expect(cues()).toEqual([]);
      expect(refusals()).toContain("tally stroke:held");
      expect(strokes(view)).toBe(2);
      t += 1;
      view.rerender(<Panel data={journal(doneN(2, 6), [change(["e2"], "agent")])} />);
      expect(cues()).toEqual([]);
      step(view, 3);
      expect(cues()).toEqual(["mo-chalk"]);
    });

    it("counts a printing key in a text field, but not a modifier, an arrow, Tab, a shortcut or a key outside a field", async () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      for (const init of [{ key: "Shift" }, { key: "ArrowDown" }, { key: "Tab" }, { key: "c", metaKey: true }, { key: "v", ctrlKey: true }]) fire(c, "keydown", init);
      fire(document.body, "keydown", { key: "j" });
      step(view, 2);
      expect(cues()).toEqual(["mo-chalk"]);
      fx.tick(1000); await act(flush); t += 60_000;
      fire(c, "keydown", { key: "a" });
      step(view, 3);
      expect(cues()).toEqual(["mo-chalk"]);
      expect(refusals()).toContain("tally stroke:held");
    });

    it("holds for the whole of an IME composition, then for 2 s after it ends", () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      fire(c, "compositionstart");
      t += 10_000; step(view, 2);
      fire(c, "compositionupdate");
      t += 10_000; step(view, 3);
      expect(cues()).toEqual([]);
      fire(c, "compositionend");
      t += TYPING_HOLD_MS - 1; step(view, 4);
      expect(cues()).toEqual([]);
      t += 1; step(view, 5);
      expect(cues()).toEqual(["mo-slash"]);
    });

    it("ends a composition when its field loses focus, so a lost compositionend can't hold cues for ever", () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      fire(c, "compositionstart");
      fire(c, "focusout");
      t += TYPING_HOLD_MS; step(view, 2);
      expect(cues()).toEqual(["mo-chalk"]);
    });

    it("lets a cue already playing finish when the user starts typing", async () => {
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      step(view, 2);
      const stroke = fx.all[0]!;
      fire(composer(), "input");
      expect(stroke.playState).toBe("running");
      fx.tick(1000); await act(flush);
      expect(stroke.playState).toBe("finished");
    });

    it("listens passively and never re-renders the journal while the user types", () => {
      motion.reset();
      const add = vi.spyOn(document, "addEventListener");
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      const typing = ["input", "keydown", "compositionstart", "compositionupdate", "compositionend", "focusout"];
      for (const type of typing) expect(add.mock.calls.find(([t]) => t === type)?.[2]).toEqual({ capture: true, passive: true });
      add.mockRestore();
      const before = renders;
      for (let i = 0; i < 50; i++) { fire(c, "keydown", { key: "a" }); fire(c, "input"); t += 200; }
      fire(c, "compositionstart"); fire(c, "compositionupdate"); fire(c, "compositionend"); fire(c, "focusout");
      expect(renders).toBe(before);
      expect(view.container.querySelector(".notebook")).not.toBeNull();
    });

    it("leaves the user's own tick alone while they type", () => {
      const c = composer();
      const view = render(<Panel data={journal(doneN(1, 6))} />);
      fire(c, "input");
      view.rerender(<Panel data={journal(doneN(2, 6), [change(["e2"], "user")])} />);
      expect(cues()).toEqual(["mo-chalk"]);
    });
  });

  it("settles the verified mark once, and lets one automatic cue at a time share the panel's slot", () => {
    const view = render(<Panel data={journal({ a: "done", b: "done", c: "todo" })} />);
    view.rerender(<Panel data={journal({ a: "verified", b: "verified", c: "todo" }, [change(["a", "b"], "agent", "verify")])} />);
    expect(cues()).toEqual(["mo-verified"]);
    expect(refusals()).toContain("seal:slot");
    expect(view.container.querySelector('[data-entry="a"] .smark')!.classList.contains("mo-verified")).toBe(true);
  });

  it("slides the ribbon when the move is short, and fades it in where it lands when it is long", async () => {
    const tops: Record<string, number> = { a: 0, b: 28, c: 400 };
    const rows = () => [...document.querySelectorAll<HTMLElement>("[data-entry] > .journal-row")];
    const place = () => rows().forEach(r => { r.getBoundingClientRect = () => ({ top: tops[r.parentElement!.dataset.entry!]! } as DOMRect); });
    const view = render(<Panel data={journal(open(0), [], null)} />);
    view.rerender(<Panel data={journal({ a: "doing", b: "todo", c: "todo" }, [], "a")} />);
    place();
    // Each cue ends before the next change, as in a browser, so it gives the panel's slot back.
    fx.tick(1000); await act(flush);
    t += 60_000;
    view.rerender(<Panel data={journal({ a: "doing", b: "doing", c: "todo" }, [change(["b"], "agent", "start")], "b")} />);
    const slide = fx.all.filter(a => a.target.classList.contains("ribbon")).at(-1);
    expect(slide?.keyframes[0]).toEqual({ transform: "translateY(-28px)" });
    place();
    fx.tick(1000); await act(flush);
    t += 60_000;
    view.rerender(<Panel data={journal({ a: "doing", b: "doing", c: "doing" }, [change(["c"], "agent", "start")], "c")} />);
    const fade = fx.all.filter(a => a.target.classList.contains("ribbon")).at(-1);
    expect(fade?.keyframes[0]).toEqual({ opacity: 0, transform: "translateY(8px)" });
  });

  it("gives the slot to the stroke when an agent finishes one entry and starts the next in one result; the ribbon lands still", () => {
    const view = render(<Panel data={journal({ a: "doing", b: "todo" }, [], "a")} />);
    view.rerender(<Panel data={journal({ a: "done", b: "doing" }, [change(["a"], "agent"), change(["b"], "agent", "start")], "b")} />);
    expect(cues()).toEqual(["mo-chalk"]);
    expect(refusals()).toEqual(["ribbon:slot"]);
    expect(view.container.querySelector('[data-entry="b"] .ribbon')).not.toBeNull();
  });

  it("leaves every mark in place under reduced motion, for the user's own tick as well as an agent's", () => {
    document.documentElement.dataset.motion = "reduced";
    const view = render(<Panel data={journal(doneN(2, 6))} />);
    view.rerender(<Panel data={journal(doneN(3, 6), [change(["e3"], "user")])} />);
    expect(cues()).toEqual([]);
    expect(refusals()).toContain("tally stroke:reduced");
    expect(view.container.querySelectorAll('[data-tally="head"] line')).toHaveLength(3);
    t += 60_000;
    view.rerender(<Panel data={journal(doneN(4, 6), [change(["e4"], "agent")])} />);
    expect(cues()).toEqual([]);
    expect(view.container.querySelectorAll('[data-tally="head"] line')).toHaveLength(4);
  });
});

describe("the narrow scale exception", () => {
  it("lets only the two moments and the journal's stroke and slash scale or rotate, and draws the stroke at a constant width", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : []);
    const css = files(join(process.cwd(), "src/ui")).map(f => readFileSync(f, "utf8")).join("\n");
    const scaling = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].filter(m => /scale|rotate/.test(m[2]!)).map(m => m[1]);
    expect(scaling.sort()).toEqual(["tavern-card", "tavern-chalk", "tavern-deal", "tavern-slash", "tavern-stamp"]);
    expect(css).toMatch(/\.tavern \.tally line \{ vector-effect: non-scaling-stroke; \}/);
    expect(css).toMatch(/@keyframes tavern-chalk \{ from \{ opacity: 0; transform: scaleY\(0\); \} 33% \{ opacity: 1; \}/);
  });
});

describe("Tally", () => {
  it("draws Warden-verified strokes in wax first, and says how many", () => {
    const view = render(<Tally done={4} total={6} verified={2} maxWidth={400} />);
    const lines = [...view.container.querySelectorAll("line")];
    expect(lines.map(l => l.classList.contains("v"))).toEqual([true, true, false, false]);
    expect(view.container.querySelector("[role=img]")!.getAttribute("aria-label")).toBe("Tally: 4 of 6 done, 2 verified by a Warden");
  });
  it("counts wax only among strokes still drawn after a fold", () => {
    const view = render(<Tally done={47} total={50} verified={44} maxWidth={400} />);
    expect([...view.container.querySelectorAll("[data-tally] line")].map(l => l.classList.contains("v"))).toEqual([false, false]);
    cleanup();
    const more = render(<Tally done={47} total={50} verified={46} maxWidth={400} />);
    expect([...more.container.querySelectorAll("[data-tally] line")].map(l => l.classList.contains("v"))).toEqual([true, false]);
  });
});
