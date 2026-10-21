import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec";
import { changedAt, dependencyChain, specChanges, wavesOf } from "../src/spec-paths";
import { specToml, type Doc } from "./helpers";

const spec = (edit?: (doc: Doc) => void) => parseSpec(specToml(edit)).spec!;
const base = spec();

describe("specChanges", () => {
  it("finds no change between equal specs", () => {
    expect(specChanges(base, spec())).toEqual({ changed: [], removed: [] });
  });

  it("names one changed setting", () => {
    expect(specChanges(base, spec((doc) => (doc.agents.worker.model = "opus")))).toEqual({ changed: ["agents.worker.model"], removed: [] });
  });

  it("names an edited criterion by its ticket's ref and its index", () => {
    const after = spec((doc) => (doc.ticket[1].acceptance[1] = "WHEN there are no orders THE SYSTEM SHALL return an empty file"));
    expect(specChanges(base, after).changed).toEqual(["ticket[csv-export].acceptance[1]"]);
  });

  it("names the list when it got shorter", () => {
    const after = spec((doc) => (doc.ticket[1].acceptance = [doc.ticket[1].acceptance[0]]));
    expect(specChanges(base, after).changed).toEqual(["ticket[csv-export].acceptance"]);
  });

  it("names every part of a new ticket", () => {
    const after = spec((doc) => doc.ticket.push({ ref: "csv-docs", title: "Docs", body: "Write the docs.", acceptance: ["WHEN read THE DOCS SHALL explain the export"], scope: ["docs/**"] }));
    const { changed, removed } = specChanges(base, after);
    expect(removed).toEqual([]);
    expect(changed).toEqual(["ticket[csv-docs].ref", "ticket[csv-docs].title", "ticket[csv-docs].body", "ticket[csv-docs].acceptance[0]", "ticket[csv-docs].verify", "ticket[csv-docs].scope[0]", "ticket[csv-docs].depends_on", "ticket[csv-docs].priority"]);
  });

  it("lists a removed ticket by its ref and changes nothing else", () => {
    expect(specChanges(base, spec((doc) => doc.ticket.pop()))).toEqual({ changed: [], removed: ["csv-export"] });
  });

  it("treats a reorder of the tickets alone as no change", () => {
    const after = spec((doc) => doc.ticket.reverse());
    expect(specChanges(base, after)).toEqual({ changed: [], removed: [] });
  });
});

describe("changedAt", () => {
  const changes = { changed: ["ticket[csv-export].acceptance[1]", "checks.commands"], removed: ["csv-docs"] };

  it("is true at, under and above a changed path", () => {
    expect(changedAt(changes, ["ticket[csv-export].acceptance[1]"])).toBe(true);
    expect(changedAt(changes, ["ticket[csv-export]"])).toBe(true);
    expect(changedAt(changes, ["ticket[csv-export].acceptance"])).toBe(true);
    expect(changedAt(changes, ["checks.commands[0]"])).toBe(true);
  });

  it("is false elsewhere", () => {
    expect(changedAt(changes, ["ticket[csv-export].acceptance[0]"])).toBe(false);
    expect(changedAt(changes, ["ticket[csv-model]"])).toBe(false);
    expect(changedAt(changes, ["checks.after_merge[0]"])).toBe(false);
    expect(changedAt({ changed: ["ticket[csv].title"], removed: [] }, ["ticket[csv-export]"])).toBe(false);
  });

  it("is true when any one of several paths changed", () => {
    expect(changedAt(changes, ["review.approvals", "checks.commands[0]"])).toBe(true);
    expect(changedAt(changes, ["review.approvals", "agents.reviewer"])).toBe(false);
  });

  it("is true for a part of a removed ticket", () => {
    expect(changedAt(changes, ["ticket[csv-docs].title"])).toBe(true);
    expect(changedAt(changes, ["ticket[csv-docs]"])).toBe(true);
  });
});

describe("wavesOf", () => {
  it("puts a ticket one wave after its latest dependency", () => {
    expect(wavesOf(base.ticket)).toEqual({ "csv-model": 0, "csv-export": 1 });
    expect(wavesOf([{ ref: "a", depends_on: [] }, { ref: "b", depends_on: ["a"] }, { ref: "c", depends_on: ["a", "b", "gone"] }, { ref: "d", depends_on: ["gone"] }])).toEqual({ a: 0, b: 1, c: 2, d: 0 });
  });
});

describe("dependencyChain", () => {
  const tickets = [
    { ref: "e", depends_on: ["c"] },
    { ref: "a", depends_on: [] },
    { ref: "b", depends_on: ["a", "gone"] },
    { ref: "c", depends_on: ["b", "a"] },
    { ref: "d", depends_on: [] },
  ];

  it("lists every ticket a ticket waits for and every one it unblocks, all the way, by wave then spec order", () => {
    expect(dependencyChain(tickets, "c")).toEqual({ up: ["a", "b"], down: ["e"] });
    expect(dependencyChain(tickets, "a")).toEqual({ up: [], down: ["b", "c", "e"] });
    expect(dependencyChain(tickets, "e")).toEqual({ up: ["a", "b", "c"], down: [] });
    expect(dependencyChain(tickets, "d")).toEqual({ up: [], down: [] });
  });
});
