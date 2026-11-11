// @vitest-environment jsdom
// The map's export: one standalone SVG drawn from the map's own layout, with its header, the legend and resolved inks.
import { describe, expect, it } from "vitest";
import type { BoardCard } from "../src/contract";
import { UNSCALED, hopLayout, phaseLayout, projectPicture, type MapPicture } from "../src/ui/dep-map";
import { depIndex } from "../src/ui/deps";
import { CANVAS_AREA, CANVAS_SIDE, buildMapSvg, esc, mapFileName, parseColor, pngScale, scopeText, whenText, type ExportTheme, type Ink, type InkName } from "../src/ui/map-export";
import { card } from "./fixtures";

type Kind = "work" | "merge" | "live";
const mk = (key: string, state: BoardCard["state"], prereqs: Array<[string, Kind]> = [], phase: string | null = null, title = `${key} title`) => card({ key, title, state, phase, deps: prereqs.filter(([, kind]) => kind === "work").map(([dep]) => dep), prereqs: prereqs.map(([dep, kind]) => ({ key: dep, kind })) });

const hex = (value: string): Ink => parseColor(value)!;
const theme = (over: Partial<ExportTheme> = {}): ExportTheme => ({
  inks: { background: hex("#ece8df"), ink: hex("#282828"), muted: hex("#453f3b"), link: hex("#922d00"), node: { ...hex("#282828"), a: 0.42 }, line: { ...hex("#282828"), a: 0.11 }, edge: { ...hex("#282828"), a: 0.72 }, band: { ...hex("#282828"), a: 0.03 }, selvedge: { ...hex("#282828"), a: 0.34 }, primary: hex("#af3a03"), primarySoft: { ...hex("#af3a03"), a: 0.3 }, attention: hex("#b57614"), ok: hex("#235939"), bad: hex("#9d0006") } satisfies Record<InkName, Ink>,
  fonts: { mono: '"JetBrains Mono", monospace', sans: '"Inter Variable", sans-serif' },
  fontFaces: "",
  radii: { node: 0, edge: 0, band: 0, chip: 0, bar: 0 },
  em: { mono: { ascent: 1.02, descent: 0.3 }, sans: { ascent: 0.97, descent: 0.24 } },
  measure: (text, px) => text.length * px * 0.6,
  icons: { Circle: '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>', CircleCheck: '<path d="M8 12l3 3 5-6" stroke="currentColor"/>' },
  ...over,
});
const header = { key: "CSV", name: "CSV export", scope: "Whole project · 5 tickets · 2 done", when: "Nov 11, 2026" };

const phases = [
  { ref: "p1", title: "A usable download", state: "done" as const },
  { ref: "large", title: "Large exports", state: "active" as const },
];
const board = [mk("CSV-3", "done", [], "p1"), mk("CSV-4", "cancelled", [], "p1"), mk("CSV-6", "done", [["CSV-3", "work"]], "large"), mk("CSV-7", "working", [["CSV-3", "work"]], "large"), mk("CSV-8", "queued", [["CSV-6", "work"], ["CSV-7", "merge"]], "large"), mk("CSV-9", "blocked", [["CSV-6", "work"], ["CSV-7", "work"]], "large"), mk("CSV-10", "queued", [["CSV-6", "work"], ["CSV-7", "work"], ["CSV-9", "live"]], "large")];
const index = depIndex(board);

const whole = (): MapPicture => {
  const { layout, nodes, bands, kinds } = projectPicture(index, board, phases);
  return { layout, nodes, bands, kinds, closed: true, small: false, metrics: UNSCALED };
};
const phase = (): MapPicture => {
  const scope = board.filter((one) => one.phase === "large");
  const { layout, nodes, kinds } = phaseLayout(index, scope, phases, false, "large", null);
  return { layout, nodes, bands: [], kinds, closed: false, small: false, metrics: UNSCALED };
};
const hops = (): MapPicture => {
  const { layout, nodes, kinds } = hopLayout(index, "CSV-7", 2);
  return { layout, nodes, bands: [], kinds, closed: false, small: false, metrics: UNSCALED };
};
const count = (svg: string, attribute: string) => (svg.match(new RegExp(` ${attribute}="`, "g")) ?? []).length;
const parse = (svg: string) => {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
};

describe("the map as an SVG", () => {
  it("draws every node, stub, bundle bar, band and edge of the layout, and nothing lit", () => {
    for (const picture of [whole(), phase(), hops()]) {
      const { svg, tickets } = buildMapSvg(picture, header, theme());
      const of = (kind: string) => picture.layout.nodes.filter((node) => node.kind === kind).length;
      expect(count(svg, "data-node"), "tickets").toBe(of("ticket"));
      expect(tickets).toBe(of("ticket"));
      expect(count(svg, "data-stub")).toBe(of("stub"));
      expect(count(svg, "data-more")).toBe(of("more"));
      expect(count(svg, "data-bundle")).toBe(of("bundle"));
      expect(count(svg, "data-band")).toBe(picture.bands.length);
      expect(count(svg, "data-edge")).toBe(picture.layout.edges.length);
      // Each edge is the layout's own route, drawn once and in the edge ink, with its kind's dashes.
      for (const edge of picture.layout.edges) expect(svg).toContain(`d="${edge.d}"`);
      expect(svg).not.toContain("#af3a03\" stroke-width=\"2.2");
      parse(svg);
    }
    // The cases have what each test needs: bands, a bundle, stubs and every kind of line.
    expect(whole().bands.map((band) => band.id)).toEqual(["p1", "large"]);
    expect(phase().layout.nodes.some((node) => node.kind === "stub")).toBe(true);
    expect(whole().layout.nodes.some((node) => node.kind === "bundle")).toBe(true);
    expect([...whole().kinds].sort()).toEqual(["live", "merge", "work"]);
  });

  it("draws done and cancelled tickets as Show done does, and blocked ones in the attention ink", () => {
    const { svg } = buildMapSvg(whole(), header, theme());
    const node = (key: string) => svg.slice(svg.indexOf(`data-node="${key}"`), svg.indexOf("</g>", svg.indexOf(`data-node="${key}"`)));
    expect(node("CSV-3")).toContain('clip-path="url(#');
    expect(node("CSV-3")).toContain('fill="#235939"');
    expect(node("CSV-4")).toContain('fill="#453f3b"');
    expect(node("CSV-7")).not.toContain("clip-path");
    expect(node("CSV-9")).toContain('stroke="#b57614"');
    // Without Show done, a done ticket has no woven edge: the phase map does not draw one.
    expect(buildMapSvg(phase(), header, theme()).svg.slice(0, 20_000)).not.toMatch(/data-node="CSV-6"[^]*?clip-path[^]*?<\/g>/);
    // The legend counts each state the map draws.
    const legend = parse(svg).querySelector("[data-legend]")!;
    expect([...legend.querySelectorAll("[data-legend-state]")].map((item) => [item.getAttribute("data-legend-state"), item.textContent])).toEqual([
      ["blocked", "blocked1"],
      ["queued", "queued2"],
      ["working", "working1"],
      ["done", "done2"],
      ["cancelled", "cancelled1"],
    ]);
    expect([...legend.querySelectorAll("[data-legend-kind]")].map((line) => line.getAttribute("data-legend-kind"))).toEqual(["work", "merge", "live"]);
    expect(legend.textContent).toContain("needs all of");
  });

  it("uses only resolved inks and its own fonts: no CSS variable, no foreignObject", () => {
    for (const picture of [whole(), phase(), hops()]) {
      const { svg } = buildMapSvg(picture, header, theme({ fontFaces: '@font-face{font-family:"Inter Variable";src:url(data:font/woff2;base64,AAAA)}' }));
      expect(svg).not.toContain("var(");
      expect(svg).not.toContain("foreignObject");
      expect(svg).not.toContain("currentColor");
      expect(svg).toContain("<style>@font-face");
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    }
    // bb's own glyph for each mark, painted in its tone.
    expect(buildMapSvg(whole(), header, theme()).svg).toContain('<path d="M8 12l3 3 5-6" stroke="#235939"/>');
  });

  it("escapes the project's name, its key, phase titles and ticket keys", () => {
    const nasty = '<script>alert("x")</script> & \'quotes\'';
    const cards = [mk("A&B-1", "queued", [], "p1"), mk("A&B-2", "done", [["A&B-1", "work"]], "p1", nasty)];
    const picture = projectPicture(depIndex(cards), cards, [{ ref: "p1", title: `Phase <one> & "two"`, state: "active" }]);
    const { svg } = buildMapSvg({ ...picture, closed: true, small: false, metrics: UNSCALED }, { key: "A&B", name: nasty, scope: 'Whole <project> · "2" tickets', when: "as of Nov 11, 2026, 09:30" }, theme());
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;quotes&apos;");
    const doc = parse(svg);
    const texts = [...doc.querySelectorAll("text")].map((text) => text.textContent);
    expect(texts).toContain("A&B");
    expect(texts).toContain(nasty);
    expect(texts).toContain("A&B-1");
    expect(texts.some((text) => text?.startsWith("Phase <one> & "))).toBe(true);
    expect(doc.querySelector("title")!.textContent).toBe(`A&B ${nasty}: Whole <project> · "2" tickets, as of Nov 11, 2026, 09:30`);
    // Ticket titles are not in the picture: the map itself shows none.
    expect(svg).not.toContain("A&amp;B-1 title");
    expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });

  it("sizes the picture from the map and its header, and scales the root for the PNG without moving anything", () => {
    const one = buildMapSvg(whole(), header, theme());
    const two = buildMapSvg(whole(), header, theme(), 2);
    const map = whole().layout;
    expect(one.width).toBeGreaterThanOrEqual(map.width);
    expect(two.svg).toContain(`width="${one.width * 2}" height="${one.height * 2}" viewBox="0 0 ${one.width} ${one.height}"`);
    expect(two.svg.replace(/^<svg[^>]*>/, "")).toBe(one.svg.replace(/^<svg[^>]*>/, ""));
    // A long name wraps under itself rather than widen the picture past what the map needs.
    const long = buildMapSvg(hops(), { ...header, name: "One routing contract for every lane across every edge proxy and every page renderer in every region we serve" }, theme());
    expect(long.width).toBeLessThanOrEqual(36 + 880 + 32);
    expect(parse(long.svg).querySelectorAll("[data-header] text").length).toBeGreaterThan(4);
  });
});

describe("the map's header", () => {
  const cards = (states: Array<BoardCard["state"]>) => states.map((state, at) => mk(`LANE-${at + 1}`, state));
  it("says what the map covers", () => {
    expect(scopeText({ kind: "phase", number: 2, of: 3, title: "Directions" }, cards(["done", "done", "working", "queued"]))).toBe("Phase 2 of 3 · Directions · 4 tickets · 2 done");
    expect(scopeText({ kind: "whole" }, cards([...Array(31).fill("done"), ...Array(10).fill("cancelled"), "queued"]))).toBe("Whole project · 42 tickets · 31 done · 10 cancelled");
    expect(scopeText({ kind: "hops", focus: "LANE-16", hops: 2, total: 42 }, cards(["queued", "blocked", "done"]))).toBe("Around LANE-16 · 2 hops either way · 3 of 42 tickets");
    expect(scopeText({ kind: "hops", focus: "LANE-16", hops: 1, total: 42 }, cards(["queued"]))).toBe("Around LANE-16 · 1 hop either way · 1 of 42 tickets");
  });

  it("says a draft's tickets are proposed, with the draft's version", () => {
    expect(scopeText({ kind: "whole" }, cards(["queued", "queued"]), { version: 3 })).toBe("Draft v3 · Whole project · 2 proposed tickets");
    expect(scopeText({ kind: "phase", number: 1, of: 3, title: "Measure" }, cards(["queued"]), { version: 1 })).toBe("Draft v1 · Phase 1 of 3 · Measure · 1 proposed ticket");
  });

  it("dates a live map by its day and a rewound one by its moment", () => {
    const at = new Date(2026, 10, 9, 14, 5).getTime();
    expect(whenText(at, false, "en-US")).toBe("Nov 9, 2026");
    expect(whenText(at, true, "en-US")).toBe("as of Nov 9, 2026, 02:05 PM");
    expect(whenText(at, true, "en-GB")).toBe("as of 9 Nov 2026, 14:05");
  });
});

describe("the map's files", () => {
  const day = new Date(2026, 10, 11, 23, 59).getTime();
  it("are named for the project, what the map covers and the day it shows", () => {
    expect(mapFileName("LANE", { kind: "whole" }, day, "png")).toBe("LANE-map-whole-2026-11-11.png");
    expect(mapFileName("EDGE", { kind: "phase", number: 2 }, day, "svg")).toBe("EDGE-map-phase-2-2026-11-11.svg");
    expect(mapFileName("LANE", { kind: "hops", focus: "LANE-16" }, day, "png")).toBe("LANE-map-LANE-16-2026-11-11.png");
    expect(mapFileName("LANE", { kind: "whole" }, new Date(2026, 9, 2).getTime(), "png", true)).toBe("LANE-map-draft-whole-2026-10-02.png");
    // Nothing a file system would refuse.
    expect(mapFileName("A/B C", { kind: "hops", focus: "A/B C:1" }, day, "svg")).toBe("A-B-C-map-A-B-C-1-2026-11-11.svg");
  });
});

describe("the PNG's scale", () => {
  it("is 2x within the canvas limits", () => {
    expect(pngScale(1291, 1322)).toEqual({ scale: 2, reduced: false });
    expect(pngScale(8192, 100)).toEqual({ scale: 2, reduced: false });
  });

  it("scales a larger map down to fit, never past a side or the area", () => {
    for (const [width, height] of [
      [9000, 600],
      [600, 20_000],
      [9000, 9000],
      [40_000, 40_000],
    ] as const) {
      const { scale, reduced } = pngScale(width, height);
      expect(reduced).toBe(true);
      expect(scale).toBeLessThan(2);
      expect(Math.round(width * scale)).toBeLessThanOrEqual(CANVAS_SIDE);
      expect(Math.round(height * scale)).toBeLessThanOrEqual(CANVAS_SIDE);
      expect(Math.round(width * scale) * Math.round(height * scale)).toBeLessThanOrEqual(CANVAS_AREA);
    }
    expect(pngScale(9000, 600).scale).toBe(1.82);
    expect(pngScale(9000, 9000).scale).toBe(1.21);
  });
});

describe("colours as the page computes them", () => {
  it("reads hex, rgb, oklab, oklch and color(srgb) into sRGB", () => {
    expect(parseColor("#ece8df")).toEqual({ r: 236, g: 232, b: 223, a: 1 });
    expect(parseColor("#28282880")).toMatchObject({ r: 40, g: 40, b: 40 });
    expect(parseColor("rgb(69, 63, 59)")).toEqual({ r: 69, g: 63, b: 59, a: 1 });
    expect(parseColor("rgba(69, 63, 59, 0.5)")).toEqual({ r: 69, g: 63, b: 59, a: 0.5 });
    expect(parseColor("color(srgb 1 0.5 0 / 0.25)")).toEqual({ r: 255, g: 127.5, b: 0, a: 0.25 });
    // Chrome's form for a colour mixed with transparent in oklab: gruve light's --loom-node.
    const node = parseColor("oklab(0.276846 0.0000126138 0.00000554323 / 0.42)")!;
    expect([Math.round(node.r), Math.round(node.g), Math.round(node.b), node.a]).toEqual([40, 40, 40, 0.42]);
    const white = parseColor("oklch(1 0 0)")!;
    expect([Math.round(white.r), Math.round(white.g), Math.round(white.b)]).toEqual([255, 255, 255]);
    expect(parseColor("lab(50 0 0)")).toBeNull();
  });
});
