import { afterEach, describe, expect, it, vi } from "vitest";
import { connectStripLantern, lanternAlpha, lanternIslands, lightMap, subscribeStripLantern, type LightSpan } from "../../../src/ui/engine/light";
import { collectLanternSurfaces, watchLantern } from "../../../src/ui/engine/light-overlay";

const box = (x: number, y: number, width: number, height: number) => new DOMRect(x, y, width, height);
const source = { kind: "lantern", x: 48, y: 16 } as const;
const options = { lanternLight: true, lanternStrength: "medium", lanternLightBb: true } as const;

function fixture() {
  document.body.innerHTML = `<main data-split-pane-id="current">
    <div data-page-scroll-viewport><div data-timeline-row-list="top-level">
      <div data-message-column><div class="ml-auto"><div><div id="bubble" class="rounded-xl border-border-seam bg-surface-recessed">I saw it.</div></div></div></div>
    </div></div>
    <div data-app-composer><div class="tavern-thread-stack">
      <section id="strip" data-part="TavernWalk"><span id="need" data-tavern-still>!</span></section>
      <section id="widget" data-part="TavernWidget"><span id="ask" data-ask>Needs you</span></section>
    </div><div data-composer-box><form id="composer" data-promptbox><div id="editor" contenteditable="true">Draft</div></form></div></div>
  </main><aside data-split-pane-id="other"><div data-timeline-row-list="top-level"><div data-message-column><div class="ml-auto"><div><div id="other" class="rounded-xl border-border-seam bg-surface-recessed">Other pane</div></div></div></div></div></aside>`;
  const mockBox = (id: string, rect: DOMRect) => {
    const el = document.querySelector<HTMLElement>(`#${id}`)!;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect);
    return el;
  };
  vi.spyOn(document.querySelector("main")!, "getBoundingClientRect").mockReturnValue(box(0, 0, 280, 280));
  vi.spyOn(document.querySelector("[data-page-scroll-viewport]")!, "getBoundingClientRect").mockReturnValue(box(0, 0, 280, 96));
  const strip = mockBox("strip", box(0, 96, 280, 64));
  const bubble = mockBox("bubble", box(20, 40, 140, 48));
  const widget = mockBox("widget", box(0, 160, 280, 34));
  const composer = mockBox("composer", box(0, 204, 280, 70));
  mockBox("other", box(176, 40, 140, 48));
  mockBox("ask", box(34, 158, 22, 26));
  mockBox("need", box(52, 148, 10, 12));
  mockBox("editor", box(104, 200, 32, 40));
  return { strip, bubble, composer, widget };
}

const intersects = ({ left, right, top, bottom }: LightSpan, rect: Omit<LightSpan, "band">) =>
  left < rect.right && right > rect.left && top < rect.bottom && bottom > rect.top;

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("lantern surfaces", () => {
  it("finds optional bb surfaces independently, in the carrier's pane only", () => {
    const { strip, bubble, composer, widget } = fixture();
    widget.querySelector("[data-ask]")!.remove();
    const view = () => collectLanternSurfaces(strip, true).surfaces.map(surface => surface.rect.top);
    expect(view()).toEqual(expect.arrayContaining([40, 160, 204]));
    expect(view().filter(y => y === 40)).toHaveLength(1);
    bubble.remove(); expect(view()).toEqual(expect.arrayContaining([160, 204]));
    expect(view()).not.toContain(40);
    composer.remove(); expect(view()).toContain(160);
    expect(view()).not.toContain(204);
    widget.remove(); expect(view()).toHaveLength(0);
  });

  it("lights only Tavern's surfaces when bb light is disabled, even if bb moves the strip out of its composer", () => {
    const { strip, widget } = fixture();
    widget.querySelector("[data-ask]")!.remove();
    const tavern = () => collectLanternSurfaces(strip, false).surfaces.map(surface => surface.rect.top);
    expect(tavern()).toEqual([160]);
    document.body.append(strip.parentElement!);
    expect(tavern()).toEqual([160]);
  });

  it("clips the composer rim to the pane and drops the widget rim while it holds an ask", () => {
    const { strip, composer } = fixture();
    vi.mocked(composer.getBoundingClientRect).mockReturnValue(box(260, 204, 100, 70));
    const { surfaces, exclusions } = collectLanternSurfaces(strip, true);
    expect(surfaces.map(s => s.rect.top)).not.toContain(160);
    const spans = lightMap({ ...source, x: 260, y: 130 }, surfaces, exclusions);
    expect(spans.some(s => s.top >= 204)).toBe(true);
    expect(spans.every(s => s.right <= 280)).toBe(true);
  });

  it("illuminates facing edges, never excluded elements or a text rect in the rim", () => {
    const { strip } = fixture();
    const scene = collectLanternSurfaces(strip, true);
    const text = box(70, 85, 38, 8);
    const exclusions = [...scene.exclusions, text];
    const spans = lightMap({ ...source, y: 112 }, scene.surfaces, exclusions);
    expect(spans.some(span => intersects(span, box(24, 84, 45, 4)))).toBe(true);
    expect(spans.some(span => intersects(span, box(24, 47, 130, 33)))).toBe(false);
    expect(spans.some(span => intersects(span, box(14, 204, 80, 4)))).toBe(true);
    expect(spans.every(span => exclusions.every(rect => !intersects(span, rect)))).toBe(true);
  });

  it("does not turn a scroll clip into a new bubble edge", () => {
    const spans = lightMap(source, [{ rect: box(0, 10, 100, 80), rim: [0, 0, 0, 0], clip: box(0, 34, 100, 50) }], []);
    expect(spans).toEqual([]);
  });

  it("has three visible rim bands and nothing beyond the radius", () => {
    const spans = lightMap(source, [{ rect: box(0, 0, 400, 400) }], []);
    expect([...new Set(spans.map(span => span.band))].sort()).toEqual([1, 2, 3]);
    expect(spans.some(span => intersects(span, box(0, 192, 400, 192)))).toBe(false);
  });
});

describe("contrast next to the brightest rim", () => {
  it("gives the dark themes one opacity scale", () => {
    expect(["low", "medium", "high"].map(s => lanternAlpha(s as "low" | "medium" | "high", true))).toEqual([0.12, 0.21, 0.3]);
  });

  it("makes three-bin halo and pool islands, not a full-width band", () => {
    const { halo, pool } = lanternIslands(102, 30, 56);
    for (const part of [halo, pool]) expect([...new Set(part.map(s => s.band))].sort()).toEqual([1, 2, 3]);
    expect(halo.every(s => s.left >= 78 && s.right <= 126 && s.top >= 6 && s.bottom <= 54)).toBe(true);
    expect(pool.every(s => s.left >= 42 && s.right <= 162 && s.top >= 48 && s.bottom <= 64)).toBe(true);
  });
  const luminance = ([r, g, b]: readonly number[]) => [r!, g!, b!].map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i]!, 0);

  // Resolved bb theme tokens: composer background, recessed/sent bubble and Tavern paper; the text pair uses the muted token on each.
  it.each([
    { name: "gruve light", dark: false, tint: [217, 126, 57], tintAlpha: 1, fg: [58, 54, 51], pairs: [
      [[235, 232, 225], [93, 88, 82]], [[241, 225, 209], [93, 88, 82]], [[232, 227, 219], [85, 80, 75]],
    ] },
    { name: "gruve dark", dark: true, tint: [231, 138, 78], tintAlpha: 0.13, fg: [233, 227, 216], pairs: [
      [[36, 34, 31], [169, 159, 147]], [[61, 43, 31], [169, 159, 147]], [[41, 37, 33], [183, 174, 162]],
    ] },
    { name: "gruvbox dark", dark: true, tint: [250, 189, 47], tintAlpha: 0.13, fg: [235, 219, 178], pairs: [
      [[40, 40, 40], [171, 160, 133]], [[36, 37, 38], [171, 160, 133]], [[46, 43, 41], [185, 173, 143]],
    ] },
  ])("keeps text at 4.5:1 or more in $name", ({ dark, tint, tintAlpha, fg, pairs }) => {
    const textRect = box(50, 50, 100, 12);
    const spans = lightMap({ ...source, x: 100 }, [{ rect: box(40, 43, 120, 40), rim: [0, 0, 0, 0] }], [textRect]);
    expect(spans.some(s => s.bottom >= textRect.top - 8)).toBe(true);
    expect(spans.some(s => intersects(s, textRect))).toBe(false);
    for (const [base, muted] of pairs) {
      const lit = luminance(base!);
      for (const text of [fg, muted!]) {
        const ink = luminance(text);
        expect((Math.max(ink, lit) + 0.05) / (Math.min(ink, lit) + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("strip-driven light", () => {
  it("repaints source tint and strength even when the new source is in the same cell", () => {
    const { strip } = fixture();
    const paint = vi.fn();
    const observer = watchLantern(document.createElement("canvas"), options, paint);
    try {
      observer.draw(strip, { ...source, kind: "crystal" });
      const crystal = paint.mock.lastCall!;
      expect(crystal[0].length).toBeGreaterThan(0);
      expect(crystal[1]).toBe("#abacff");
      observer.draw(strip, { ...source, kind: "ember" });
      expect(paint).toHaveBeenCalledTimes(2);
      const ember = paint.mock.lastCall!;
      expect(ember[0]).toEqual(crystal[0]);
      expect(ember[1]).toBe("#ff713b");
      expect(ember[2]).toBeGreaterThan(crystal[2]);
      observer.draw(strip, { ...source, kind: "ember", x: 72 });
      expect(paint.mock.lastCall?.[0]).not.toEqual(ember[0]);
    } finally { observer.dispose(); }
  });

  it("tracks a deliberate still pose change but ignores small movement in the same pose", () => {
    const { strip } = fixture();
    const moves = vi.fn();
    const stop = subscribeStripLantern(moves);
    const publish = connectStripLantern(strip);
    try {
      publish(source, true, "idle:1");
      publish({ ...source, x: 50 }, true, "idle:1");
      expect(moves).toHaveBeenCalledTimes(1);
      publish({ ...source, x: 51 }, true, "idle:-1");
      publish({ ...source, y: 29 }, true, "resting:-1");
      expect(moves).toHaveBeenCalledTimes(3);
    } finally { stop(); publish(null); }
  });

  it("coalesces local invalidations and ignores streaming changes below timeline rows", async () => {
    const { strip, composer } = fixture();
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const decorator = watchLantern(document.createElement("canvas"), options, vi.fn());
    try {
      decorator.draw(strip, source);
      const timeline = document.querySelector('[data-timeline-row-list]')!;
      const reply = document.createElement("div");
      timeline.append(reply);
      await Promise.resolve();
      const first = request.mock.calls.at(-1)![0];
      first(1);
      request.mockClear();
      for (let i = 0; i < 20; i++) reply.append(" streamed");
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
      for (let i = 0; i < 20; i++) composer.append(" typing");
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);
    } finally { decorator.dispose(); }
  });
  it("does no work with Lantern light off", () => {
    const paint = vi.fn(), canvas = document.createElement("canvas");
    const { strip } = fixture();
    const observer = watchLantern(canvas, { ...options, lanternLight: false }, paint);
    observer.draw(strip, source);
    expect(paint).not.toHaveBeenCalled();
    expect(strip.getBoundingClientRect).not.toHaveBeenCalled();
    observer.dispose();
  });

  it("paints only new quantised maps, never requests a frame, and clears when the strip is gone", () => {
    const { strip } = fixture();
    const canvas = document.createElement("canvas"), paint = vi.fn();
    const request = vi.spyOn(window, "requestAnimationFrame");
    const observer = watchLantern(canvas, options, paint);
    observer.draw(strip, source);
    expect(paint).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 800; i++) observer.draw(strip, { ...source, x: source.x + (i % 2) });
    expect(paint).toHaveBeenCalledTimes(1);
    expect(strip.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    observer.draw(strip, { ...source, x: 72 });
    expect(paint).toHaveBeenCalledTimes(2);
    observer.draw(strip, null);
    expect(paint).toHaveBeenCalledTimes(3);
    expect(paint.mock.lastCall?.[0]).toEqual([]);
    observer.dispose();
  });
});
