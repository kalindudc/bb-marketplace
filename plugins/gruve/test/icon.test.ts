// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mark = parse(readFileSync(join(root, "icons/gruve.svg"), "utf8"));
const colour = parse(readFileSync(join(root, "icons/gruve-color.svg"), "utf8"));
const entryPath = join(root, "../../entries/gruve.json");

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

const shapes = (doc: Document): Element[] => [...doc.documentElement.children];
const attribute = (doc: Document, name: string): (string | null)[] =>
  [...shapes(doc), ...shapes(doc).flatMap((shape) => [...shape.children])].map((shape) => shape.getAttribute(name));

describe("plugin icon", () => {
  it("is the file the manifest declares", () => {
    expect(manifest.bb.branding.icon).toBe("./icons/gruve.svg");
    expect(existsSync(join(root, manifest.bb.branding.icon))).toBe(true);
  });

  // bb draws a plugin icon by masking it in the theme's own colour, so any fill
  // turns the whole tile into a solid block: the mark has to be strokes only.
  it("paints no fill, so bb's mask shows a mark and not a block", () => {
    expect(mark.documentElement.getAttribute("fill")).toBe("none");
    expect(attribute(mark, "fill")).toEqual([null, null, null]);
    expect(shapes(mark).length).toBeGreaterThan(2);
  });

  it("draws in the theme's colour rather than a fixed one", () => {
    expect(mark.documentElement.getAttribute("stroke")).toBe("currentColor");
    // No shape pins its own colour, so the mask takes bb's text colour.
    expect([...attribute(mark, "stroke"), ...attribute(mark, "fill")].filter((value) => value !== null)).toEqual([]);
  });

  it("ships the same mark in gruvbox colours for listings", () => {
    expect(colour.documentElement.getAttribute("viewBox")).toBe(mark.documentElement.getAttribute("viewBox"));
    // The colour file adds a background tile and swaps the stroke colours.
    expect(shapes(colour).length).toBe(shapes(mark).length + 1);
    expect(shapes(colour).slice(1).map((shape) => shape.getAttribute("d") ?? shape.getAttribute("x"))).toEqual(
      shapes(mark).map((shape) => shape.getAttribute("d") ?? shape.getAttribute("x")),
    );
  });

  it("is the file the marketplace entry points at", () => {
    if (!existsSync(entryPath)) return;
    const { icon } = JSON.parse(readFileSync(entryPath, "utf8"));
    expect(icon.url).toBe("plugins/gruve/icons/gruve-color.svg");
    expect(existsSync(join(root, "../../", icon.url))).toBe(true);
  });
});
