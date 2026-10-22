import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_HIGHLIGHT, MATCH_HIGHLIGHT, findMatches, indexOfMatch, positionOf, publishHighlights,
} from "../src/search";

class FakeHighlight extends Set<Range> {}
const highlights = new Map<string, FakeHighlight>();
const painted = (name: string) => [...highlights.get(name) ?? []].map((range) => range.toString());

function rows(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

beforeEach(() => {
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights });
});
afterEach(() => {
  vi.unstubAllGlobals();
  highlights.clear();
  document.body.replaceChildren();
});

describe("findMatches", () => {
  it("finds every match in row order, case-insensitively, across element boundaries", () => {
    const root = rows(`
      <div data-entry-id="a"><span>Find the</span> <b>NEE</b><i>dle</i> and a needle</div>
      <div data-entry-id="b"><pre>no match</pre></div>
      <div data-entry-id="c"><code>needle</code></div>`);
    const matches = findMatches(root, "needle");
    expect(matches.map((match) => [match.entryId, match.range?.toString() ?? null])).toEqual([
      ["a", "NEEdle"], ["a", "needle"], ["b", null], ["c", "needle"],
    ]);
  });

  it("skips time, badges and actions, and keeps a row whose match is only in text it does not show", () => {
    const root = rows(`<div data-entry-id="a"><time data-sl-nosearch="">12:00</time><span>12 files</span>
      <div data-sl-nosearch=""><a>12 in chat</a></div></div>`);
    expect(findMatches(root, "12").map((match) => match.range?.toString())).toEqual(["12"]);
    expect(findMatches(root, "chat")).toEqual([{ entryId: "a", range: null }]);
    expect(findMatches(root, "")).toEqual([]);
  });

  it("keeps offsets right when lowercasing changes a character's length", () => {
    const root = rows(`<div data-entry-id="a"><span>İstanbul</span><span> needle</span></div>`);
    expect(findMatches(root, "needle")[0]!.range!.toString()).toBe("needle");
  });

  it("finds a match's index again by row and ordinal", () => {
    const matches = findMatches(rows(`
      <div data-entry-id="a">x x</div><div data-entry-id="b">x x x</div>`), "x");
    expect(positionOf(matches, 3)).toEqual({ entryId: "b", ordinal: 1 });
    expect(indexOfMatch(matches, { entryId: "b", ordinal: 1 })).toBe(3);
    expect(indexOfMatch(matches, { entryId: "b", ordinal: 3 })).toBeNull();
    expect(indexOfMatch(matches, null)).toBeNull();
  });
});

describe("publishHighlights", () => {
  it("paints each panel's matches and current match together, and withdraws one panel at a time", () => {
    const first = {};
    const second = {};
    const one = findMatches(rows(`<div data-entry-id="a">alpha beta alpha</div>`), "alpha");
    const two = findMatches(rows(`<div data-entry-id="b">alpha</div>`), "alpha");
    publishHighlights(first, one, one[1]!.range);
    publishHighlights(second, two, null);
    expect(painted(MATCH_HIGHLIGHT)).toHaveLength(2);
    expect(painted(CURRENT_HIGHLIGHT)).toEqual(["alpha"]);
    expect([...highlights.get(MATCH_HIGHLIGHT)!]).not.toContain(one[1]!.range);
    publishHighlights(first, [], null);
    expect(painted(MATCH_HIGHLIGHT)).toEqual(["alpha"]);
    expect(highlights.has(CURRENT_HIGHLIGHT)).toBe(false);
    publishHighlights(second, [], null);
    expect(highlights.size).toBe(0);
  });

  it("does nothing where the browser has no highlight registry", () => {
    vi.stubGlobal("CSS", undefined);
    const owner = {};
    const matches = findMatches(rows(`<div data-entry-id="a">alpha</div>`), "alpha");
    expect(() => publishHighlights(owner, matches, matches[0]!.range)).not.toThrow();
    publishHighlights(owner, [], null);
  });
});
