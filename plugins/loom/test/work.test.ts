import { describe, expect, it } from "vitest";
import type { BoardCard, MergeOrderView } from "../src/contract";
import { answerNote } from "../src/ui/blocked-ask";
import { hopPicture, nodeWidth, phasePicture } from "../src/ui/dep-map";
import { depIndex } from "../src/ui/deps";
import { distinguishingEnd, groupOf, rowFacts, rowsShown } from "../src/ui/groups";
import { bundleEdges, bundleHeight, crossingsOf, layoutBands, layoutColumns, layoutPhase, type MapLayout } from "../src/ui/map-layout";
import { edgesAmong } from "../src/ui/deps";
import { consequenceText, mergeConsequences } from "../src/ui/readiness";
import { card } from "./fixtures";

type Kind = "work" | "merge" | "live";
const board = (rows: Array<[string, BoardCard["state"], Array<[string, Kind]>?, Partial<BoardCard>?]>) =>
  rows.map(([key, state, prereqs = [], over = {}]) => card({ key, title: `${key} title`, state, deps: prereqs.filter(([, kind]) => kind === "work").map(([dep]) => dep), prereqs: prereqs.map(([dep, kind]) => ({ key: dep, kind })), phase: "large", ...over }));

// Phase 2 of the CSV project in the mock: three tickets that each need the same three, and the rest around them.
const csv = board([
  ["CSV-3", "done", [], { phase: "p1" }],
  ["CSV-6", "done", [["CSV-3", "work"]]],
  ["CSV-7", "done", [["CSV-3", "work"]]],
  ["CSV-8", "done", [["CSV-3", "work"]]],
  ["CSV-9", "working", [["CSV-6", "work"], ["CSV-7", "work"], ["CSV-8", "work"]]],
  ["CSV-10", "review", [["CSV-6", "work"], ["CSV-7", "work"], ["CSV-8", "work"]]],
  ["CSV-11", "blocked", [["CSV-6", "work"], ["CSV-7", "work"], ["CSV-8", "work"]]],
  ["CSV-12", "pr_open", [["CSV-7", "work"]]],
  ["CSV-13", "queued", [["CSV-10", "work"]]],
  ["CSV-14", "done", [["CSV-8", "work"]]],
  ["CSV-15", "pr_open", [["CSV-8", "work"], ["CSV-12", "merge"]]],
  ["CSV-16", "queued", [["CSV-11", "work"], ["CSV-13", "work"]]],
  ["CSV-17", "queued", [["CSV-9", "work"], ["CSV-11", "work"], ["CSV-12", "live"]]],
]);
const phases = [
  { ref: "p1", title: "A usable download" },
  { ref: "large", title: "Large exports" },
];

const near = (a: number, b: number) => Math.abs(a - b) < 0.6;

/** Every edge starts on its source's right border and ends on its target's left border, level, and runs at right angles. */
/** The edges that run through a node's box other than their own ends, and the nodes they cut: none, in a readable map. */
function throughNodes(layout: MapLayout): string[] {
  const hits: string[] = [];
  for (const edge of layout.edges)
    for (const node of layout.nodes) {
      if (node.id === edge.from || node.id === edge.to) continue;
      const [left, right, top, bottom] = [node.x + 1, node.x + node.width - 1, node.y + 1, node.y + node.height - 1];
      for (let at = 1; at < edge.points.length; at++) {
        const [x1, y1] = edge.points[at - 1]!;
        const [x2, y2] = edge.points[at]!;
        const crossesX = Math.max(x1, x2) > left && Math.min(x1, x2) < right;
        const crossesY = Math.max(y1, y2) > top && Math.min(y1, y2) < bottom;
        if (crossesX && crossesY) hits.push(`${edge.id} through ${node.id}`);
      }
    }
  return [...new Set(hits)];
}

function expectAttached(layout: MapLayout) {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  for (const edge of layout.edges) {
    const from = byId.get(edge.from)!;
    const to = byId.get(edge.to)!;
    const [sx, sy] = edge.points[0]!;
    const [tx, ty] = edge.points.at(-1)!;
    expect(near(sx, from.x + from.width), edge.id).toBe(true);
    expect(sy > from.y + 3 && sy < from.y + from.height - 3, `${edge.id} leaves ${from.id} away from its corners`).toBe(true);
    expect(near(tx, to.x), edge.id).toBe(true);
    expect(ty > to.y + 3 && ty < to.y + to.height - 3, `${edge.id} enters ${to.id} away from its corners`).toBe(true);
    // It leaves and enters perpendicular: its first and last runs are horizontal.
    expect(near(edge.points[1]![1], sy), edge.id).toBe(true);
    expect(near(edge.points.at(-2)![1], ty), edge.id).toBe(true);
    for (let at = 1; at < edge.points.length; at++) {
      const [x1, y1] = edge.points[at - 1]!;
      const [x2, y2] = edge.points[at]!;
      expect(near(x1, x2) || near(y1, y2), `${edge.id} turns at a right angle`).toBe(true);
    }
  }
}

describe("Work's groups", () => {
  it("puts each ticket in the group of whose move it is", () => {
    const [blocked, retry, ready, working, waiting, paused, done] = [
      card({ state: "blocked" }),
      card({ state: "merging", retry: { step: "merge", failures: 1, since: 0, until: 1, message: "x", kind: "temporary" } }),
      card({ state: "pr_open", mergeConfirm: { prUrl: "https://x/1", sha: "a".repeat(40), ready: true, waiting: null, confirmed: false, requested: null } }),
      card({ state: "review" }),
      card({ state: "queued" }),
      card({ state: "queued" }),
      card({ state: "cancelled" }),
    ];
    expect([groupOf(blocked, "running"), groupOf(retry, "running"), groupOf(ready, "running"), groupOf(working, "running"), groupOf(waiting, "running"), groupOf(paused, "paused"), groupOf(done, "running")]).toEqual(["need", "failed", "ready", "working", "waiting", "paused", "done"]);
  });

  it("keeps a ticket whose only problem is one read retry in its own group with its own state word, and fails it when the read persists or needs the person", () => {
    const read = (failures: number, kind: "temporary" | "lasting" | "unknown" = "unknown") =>
      card({ state: "pr_open", prUrl: "https://github.com/a/b/pull/418", retry: { step: "read", failures, since: 0, until: Date.UTC(2026, 0, 10, 3, 31), message: "host plugin loom generation 7 is retired", kind } });
    const once = read(1);
    expect(groupOf(once, "running")).toBe("waiting");
    const row = rowFacts(once, "waiting");
    expect(row.word).toBe("PR open");
    expect(row.facts).toHaveLength(3);
    expect(row.facts.slice(0, 2)).toEqual(["#418", "in review"]);
    expect(row.facts[2]).toMatch(/^PR read retry /u);
    expect(groupOf(read(2), "running")).toBe("waiting");
    expect(groupOf(read(3), "running")).toBe("failed");
    expect(rowFacts(read(3), "failed").word).toBe("Failed");
    expect(rowFacts(read(3), "failed").facts[0]).toMatch(/^PR read failed · retry /u);
    expect(groupOf(read(1, "lasting"), "running")).toBe("failed");
    // Any other step that failed is a failed ticket at once, as before.
    expect(groupOf(card({ state: "merging", retry: { step: "merge", failures: 1, since: 0, until: 1, message: "x", kind: "unknown" } }), "running")).toBe("failed");
  });

  it("gives each row its state word and three facts at most, none of them the state again", () => {
    const row = rowFacts(card({ state: "pr_open", prUrl: "https://github.com/a/b/pull/418", ci: { failed: 2, pending: 0 }, stackedOn: ["CSV-3"] }), "waiting");
    expect(row.word).toBe("PR open");
    expect(row.facts).toEqual(["#418", "in review", "2 failing"]);
    expect(rowFacts(card({ state: "blocked", attempt: 2, ask: { question: null, options: 3 } }), "need")).toEqual({ word: "blocked", facts: ["asks · 3 options", "attempt 2"] });
  });

  it("fits every heading on the first screen: one row each first, then one more each in turn, headings only when room runs out", () => {
    // LANE-like: Needs you 1, Failed 2, Working 5, Waiting 3, Paused 9, and Done's heading; 30 px headings, 45 px rows.
    const fit = (room: number) => ({ room, fixed: 6 * 30, row: 45, fold: 32 });
    expect(rowsShown([1, 2, 5, 3, 9], fit(500))).toEqual([1, 2, 1, 1, 0]);
    expect(rowsShown([1, 2, 5, 3, 9], fit(150))).toEqual([0, 0, 0, 0, 0]);
    // Less room never shows more rows.
    let before = Infinity;
    for (const room of [900, 700, 500, 400, 300, 200, 100]) {
      const total = rowsShown([1, 2, 5, 3, 9], fit(room)).reduce((sum, n) => sum + n, 0);
      expect(total).toBeLessThanOrEqual(before);
      before = total;
    }
    expect(rowsShown([30, 30], fit(4000))).toEqual([8, 8]);
    expect(rowsShown([12, 3], null)).toEqual([8, 3]);
  });

  it("keeps the end that tells near-identical titles apart", () => {
    const titles = ["Core: lane header in request specs for shard 1", "Core: lane header in request specs for shard 13", "Envoy: count every lane request"];
    expect(distinguishingEnd(titles[0]!, titles)).toBe("shard 1");
    expect(distinguishingEnd(titles[1]!, titles)).toBe("shard 13");
    expect(distinguishingEnd(titles[2]!, titles)).toBeNull();
  });
});

describe("dependencies", () => {
  it("counts what a ticket unblocks among open tickets, directly and in all, and the longest chain of open work", () => {
    const index = depIndex(csv);
    expect(index.direct("CSV-10")).toEqual(["CSV-13"]);
    expect(index.inAll("CSV-10")).toEqual(["CSV-13", "CSV-16"]);
    // CSV-12 is a merge and live prerequisite only, so it unblocks no work.
    expect(index.inAll("CSV-12")).toEqual([]);
    expect(index.dependents("CSV-12")).toEqual([
      { key: "CSV-15", kind: "merge" },
      { key: "CSV-17", kind: "live" },
    ]);
    expect(index.longest).toEqual(["CSV-10", "CSV-13", "CSV-16"]);
  });
});

describe("the phase map's layout", () => {
  const picture = () => {
    const index = depIndex(csv);
    const scope = csv.filter((one) => one.phase === "large");
    const drawn = phasePicture(index, scope, phases);
    const bundled = bundleEdges(drawn.edges);
    const nodes = [...drawn.nodes, ...bundled.bundles.map((bundle) => ({ id: bundle.id, kind: "bundle" as const, width: 4, height: bundleHeight(bundle, 28, 12) }))];
    return { drawn, bundled, layout: layoutPhase(nodes, bundled.edges, bundled.bundles) };
  };

  it("draws earlier phases as one stub and every ticket once", () => {
    const { drawn } = picture();
    expect(drawn.nodes.filter((node) => node.kind === "stub").map((node) => node.label)).toEqual(["Phase 1"]);
    expect(drawn.nodes.filter((node) => node.kind === "ticket")).toHaveLength(12);
    expect(new Set(drawn.nodes.map((node) => node.id)).size).toBe(drawn.nodes.length);
  });

  it("turns the three tickets that each need the same three into one bundle of six edges", () => {
    const { bundled } = picture();
    expect(bundled.bundles).toEqual([{ id: "bundle:CSV-6,CSV-7,CSV-8", kind: "work", sources: ["CSV-6", "CSV-7", "CSV-8"], targets: ["CSV-9", "CSV-10", "CSV-11"] }]);
    expect(bundled.edges.filter((edge) => edge.from.startsWith("bundle:") || edge.to.startsWith("bundle:"))).toHaveLength(6);
  });

  it("attaches every edge to its ports, perpendicular and away from corners, the bundle bar included", () => {
    const { layout } = picture();
    expectAttached(layout);
    // Two kinds into one ticket enter at two ports.
    const into15 = layout.edges.filter((edge) => edge.to === "CSV-15").map((edge) => edge.points.at(-1)![1]);
    expect(new Set(into15).size).toBe(2);
  });

  it("keeps a bundle's targets together in their column, so nothing cuts through the bar's fan", () => {
    const { layout } = picture();
    const column = layout.nodes.filter((node) => node.rank === layout.nodes.find((one) => one.id === "CSV-9")!.rank).sort((a, b) => a.y - b.y).map((node) => node.id);
    const at = ["CSV-9", "CSV-10", "CSV-11"].map((id) => column.indexOf(id)).sort((a, b) => a - b);
    expect(at[2]! - at[0]!).toBe(2);
    expect(layout.crossings).toBe(crossingsOf(layout.edges));
  });

  it("draws the whole typed phase with at most the 6 crossings it has now, and no edge through a node", () => {
    // A bound, not zero: the large phase's typed edges cannot all be drawn apart. A change to ranks, order or routing
    // that adds a crossing, or runs an edge through a ticket after the bundles move, fails here.
    const { layout } = picture();
    expect(layout.crossings).toBeLessThanOrEqual(6);
    expect(throughNodes(layout)).toEqual([]);
  });

  it("finds an edge that runs through a node", () => {
    const node = (id: string, x: number, y: number) => ({ id, kind: "ticket" as const, width: 60, height: 28, x, y, rank: 0 });
    const layout = { nodes: [node("A", 0, 0), node("B", 100, 0), node("C", 200, 0)], edges: [{ id: "A>C", from: "A", to: "C", kind: "work" as const, points: [[60, 14], [200, 14]] as Array<[number, number]> }] } as unknown as MapLayout;
    expect(throughNodes(layout)).toEqual(["A>C through B"]);
  });

  it("makes a node wide enough for its mark, key and state word", () => {
    expect(nodeWidth("LANE-33", "PR open")).toBeGreaterThan(nodeWidth("LANE-33", null) + 6 * 7 - 1);
  });
});

describe("the hop map", () => {
  // LANE-33 needs LANE-4 for work and live, and LANE-27 for work and merge: four relations, two tickets.
  const lane = board([
    ["LANE-4", "pr_open"],
    ["LANE-27", "review"],
    ["LANE-2", "done"],
    ["LANE-3", "done"],
    ["LANE-33", "queued", [["LANE-4", "work"], ["LANE-4", "live"], ["LANE-27", "work"], ["LANE-27", "merge"], ["LANE-2", "work"], ["LANE-3", "work"]]],
    ["LANE-40", "queued", [["LANE-33", "work"]]],
  ]);

  // The final gate's 200% text and spacing runs: keys and state words grew and the boxes stayed, 20 labels outside them.
  it("sizes every node, stub and more from the text as it renders, so enlarged or spaced text stays inside", () => {
    const index = depIndex(lane);
    const enlarged = { key: 2, smallKey: 1.12, word: 1.5, line: 23 };
    const normal = hopPicture(index, "LANE-33", 1);
    const big = hopPicture(index, "LANE-33", 1, 1, new Set(), true, enlarged);
    for (const node of big.columns.flat()) {
      expect(node.height).toBe(37);
      // The label at twice the width per character the default assumes, plus the node's padding and mark.
      expect(node.width, node.label).toBeGreaterThanOrEqual(Math.ceil(node.label.length * 7.3 * 2));
    }
    const width = (picture: typeof normal, label: string) => picture.columns.flat().find((node) => node.label === label)!.width;
    expect(width(big, "LANE-33")).toBeGreaterThan(width(normal, "LANE-33") + 7 * 7.3 - 1);
    expect(width(big, "2 done")).toBeGreaterThan(width(normal, "2 done"));
    expect(big.columns.flat().some((node) => node.kind === "more")).toBe(true);
    expectAttached(layoutColumns(big.columns, big.edges));
    // The default never shrinks: metrics under 1 are not a thing the page measures.
    expect(normal.columns.flat().every((node) => node.height === 28)).toBe(true);
    const phase = phasePicture(index, lane.filter((card) => card.state !== "done"), null, true, null, null, enlarged);
    expect(phase.nodes.every((node) => node.height === 33)).toBe(true);
  });

  it("draws each ticket once, with one edge per kind on its own port, and folds done prerequisites to one stub", () => {
    const index = depIndex(lane);
    const { columns, edges } = hopPicture(index, "LANE-33", 1);
    const ids = columns.flat().map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(columns.map((column) => column.map((node) => node.label))).toEqual([["LANE-4", "LANE-27", "2 done"], ["LANE-33"], ["LANE-40"]]);
    expect(edges.filter((edge) => edge.from === "LANE-4").map((edge) => edge.kind)).toEqual(["work", "live"]);
    const layout = layoutColumns(columns, edges);
    expectAttached(layout);
    const ends = layout.edges.filter((edge) => edge.from === "LANE-4").map((edge) => edge.points[0]![1]);
    expect(new Set(ends).size).toBe(2);
    // The merge edge enters between work edges that come from above and from below, so one crossing is left, and counted.
    expect(layout.crossings).toBe(1);
  });

  it("bundles a second hop that every first-hop ticket needs, beside its sources, and draws the rest one by one", () => {
    // Like LANE-33: each ticket it waits on needs the same three tickets live, and one more of its own for work.
    const two = board([
      ["S-1", "pr_open"],
      ["S-2", "blocked"],
      ["S-3", "pr_open"],
      ["W-1", "pr_open"],
      ["W-2", "pr_open"],
      ["W-3", "pr_open"],
      ...["1", "2", "3"].map((n) => [`H-${n}`, "pr_open", [["S-1", "live"], ["S-2", "live"], ["S-3", "live"], [`W-${n}`, "work"]]] as [string, BoardCard["state"], Array<[string, Kind]>]),
      ["F", "queued", [["H-1", "work"], ["H-2", "work"], ["H-3", "work"]]],
    ]);
    const picture = hopPicture(depIndex(two), "F", 2);
    const unbundled = layoutColumns(picture.columns, picture.edges);
    const bundled = bundleEdges(picture.edges);
    const layout = layoutColumns(picture.columns, bundled.edges, bundled.bundles);
    expect(layout.bundles.map((bundle) => [bundle.kind, bundle.sources, bundle.targets])).toEqual([["live", ["S-1", "S-2", "S-3"], ["H-1", "H-2", "H-3"]]]);
    expectAttached(layout);
    // The bar spans only its sources, which sit together, and stands right of their column.
    const bar = layout.nodes.find((node) => node.kind === "bundle")!;
    const sources = layout.nodes.filter((node) => node.id.startsWith("S-")).sort((a, b) => a.y - b.y);
    expect(bar.y).toBeLessThan(sources[0]!.y + sources[0]!.height / 2);
    expect(bar.y + bar.height).toBeGreaterThan(sources[2]!.y + sources[2]!.height / 2);
    expect(layout.nodes.some((node) => !node.id.startsWith("S-") && node.rank === sources[0]!.rank && node.y + node.height / 2 > bar.y && node.y + node.height / 2 < bar.y + bar.height)).toBe(false);
    expect(bar.x).toBeGreaterThan(Math.max(...sources.map((node) => node.x + node.width)));
    expect(layout.crossings).toBeLessThan(unbundled.crossings);
    expect(layout.crossings).toBeLessThanOrEqual(1);
    expect(throughNodes(layout)).toEqual([]);
  });

  it("draws a bundle's edges one by one when a source also leads elsewhere", () => {
    const edges = [
      ...["A", "B"].flatMap((source) => ["X", "Y"].map((target) => ({ from: source, to: target, kind: "work" as const }))),
      { from: "A", to: "Z", kind: "work" as const },
    ];
    const node = (id: string) => ({ id, kind: "ticket" as const, width: 80, height: 28 });
    const bundled = bundleEdges(edges);
    expect(bundled.bundles).toHaveLength(1);
    const layout = layoutColumns([[node("A"), node("B")], [node("X"), node("Y"), node("Z")]], bundled.edges, bundled.bundles);
    expect(layout.bundles).toEqual([]);
    expect(layout.edges.map((edge) => edge.id).sort()).toEqual(["A>X>work", "A>Y>work", "A>Z>work", "B>X>work", "B>Y>work"]);
  });

  it("shows seven a side at most, with the rest as one node that expands in place", () => {
    const wide = board([["F-0", "queued"], ...Array.from({ length: 10 }, (_, at) => [`F-${at + 1}`, "queued", [["F-0", "work"]]] as [string, BoardCard["state"], Array<[string, Kind]>])]);
    const index = depIndex(wide);
    expect(hopPicture(index, "F-0", 1).columns.at(-1)!.map((node) => node.label).at(-1)).toBe("and 3 more");
    expect(hopPicture(index, "F-0", 1, 7, new Set(["dep1"])).columns.at(-1)).toHaveLength(10);
  });
});

describe("what a merge changes", () => {
  const entry = (key: string, over: Partial<MergeOrderView["entries"][number]>): MergeOrderView["entries"][number] => ({ key, title: key, repo: null, state: "pr_open", base: "main", prUrl: `https://x/${key}`, prNumber: "1", prOpen: true, elsewhere: null, step: 2, stackedOn: null, waitsOn: [], unblocks: [], checks: null, draft: false, draftHold: null, publishWait: null, review: "APPROVED", reviewRead: true, conflicts: false, behind: null, refreshBehind: null, verdict: "after", holds: [], prHolds: [], trap: false, mergedInto: null, mergedIntoState: null, blockedReason: null, ...over });
  const order: MergeOrderView = {
    repos: [null],
    steps: 2,
    counts: { open: 3, first: 1, ready: 1, wrong: 0 },
    entries: [
      entry("CSV-12", { step: 1, verdict: "ready" }),
      entry("CSV-15", { waitsOn: [{ key: "CSV-12", why: "merge_after", repo: null, prNumber: "418" }], prHolds: [{ code: "failing", count: 1 }, { code: "pending", count: 1 }] }),
      entry("CSV-18", { waitsOn: [{ key: "CSV-12", why: "stacked", repo: null, prNumber: "418" }, { key: "CSV-9", why: "depends", repo: null, prNumber: null }] }),
      entry("CSV-19", { waitsOn: [{ key: "CSV-12", why: "merge_after", repo: null, prNumber: "418" }] }),
    ],
  };

  it("names the wait it removes and every hold that remains, from Ship's own merge order", () => {
    const consequences = mergeConsequences("CSV-12", order, csv);
    expect(consequences.map((one) => [one.key, one.free, one.holds])).toEqual([
      ["CSV-15", false, ["1 check failing", "1 check pending"]],
      ["CSV-17", false, ["needs CSV-12 live"]],
      ["CSV-18", false, ["waits on CSV-9"]],
      ["CSV-19", true, []],
    ]);
    expect(consequenceText("CSV-12", consequences)).toBe(
      "CSV-15 stops waiting on CSV-12, but 1 check failing and 1 check pending still hold it · CSV-17 still needs CSV-12 live · CSV-18 stops waiting on CSV-12, but waits on CSV-9 still holds it · CSV-19 stops waiting on CSV-12 and can merge",
    );
    expect(consequenceText("CSV-15", mergeConsequences("CSV-15", order, csv))).toBeNull();
  });
});

describe("the answer's note", () => {
  const ask = { question: "How?", options: [{ label: "Nightly runner", consequence: null }], recommended: 0 };
  it("sends the option chosen, then the person's words", () => {
    expect(answerNote(ask, 0, "")).toBe("Nightly runner");
    expect(answerNote(ask, 0, " And log it. ")).toBe("Nightly runner\n\nAnd log it.");
    expect(answerNote(ask, null, "Something else")).toBe("Something else");
    expect(answerNote(null, null, "")).toBe("");
  });
});

describe("the whole project's map", () => {
  it("gives each phase its own columns, in order, as a band wide enough for its label, and routes every edge at right angles", () => {
    const index = depIndex(csv);
    const nodes = csv.map((one) => ({ id: one.key, kind: "ticket" as const, width: nodeWidth(one.key, null), height: 28 }));
    const bundled = bundleEdges(edgesAmong(index, new Set(csv.map((one) => one.key))));
    const all = [...nodes, ...bundled.bundles.map((bundle) => ({ id: bundle.id, kind: "bundle" as const, width: 4, height: bundleHeight(bundle, 28, 12) }))];
    const groups = [
      { id: "p1", members: csv.filter((one) => one.phase === "p1").map((one) => one.key) },
      { id: "large", members: csv.filter((one) => one.phase !== "p1").map((one) => one.key) },
    ];
    const { layout, bands } = layoutBands(all, bundled.edges, bundled.bundles, groups, { nodesep: 12, ranksep: 44, minWidth: 196, top: 50 });
    expect(bands.map((band) => band.id)).toEqual(["p1", "large"]);
    // Phase 1 is one ticket, CSV-3: its band widens to the label's width, with CSV-3 in its middle.
    expect(bands[0]!.width).toBeGreaterThanOrEqual(196);
    const csv3 = layout.nodes.find((node) => node.id === "CSV-3")!;
    expect(Math.abs(csv3.x + csv3.width / 2 - (bands[0]!.x + bands[0]!.width / 2))).toBeLessThan(2);
    for (const [at, group] of groups.entries())
      for (const id of group.members) {
        const node = layout.nodes.find((one) => one.id === id)!;
        expect(node.x, id).toBeGreaterThanOrEqual(bands[at]!.x);
        expect(node.x + node.width, id).toBeLessThanOrEqual(bands[at]!.x + bands[at]!.width);
        expect(node.y, `${id} sits under its band's label`).toBeGreaterThanOrEqual(50);
      }
    expect(bands[0]!.x + bands[0]!.width).toBeLessThan(bands[1]!.x);
    expect(layout.width).toBeGreaterThanOrEqual(bands[1]!.x + bands[1]!.width);
    expectAttached(layout);
    expect(throughNodes(layout)).toEqual([]);
  });
});
