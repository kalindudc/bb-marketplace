// The Map view's Export menu: Copy image, Download PNG and Download SVG. The picture is built from the map's own layout
// (map-export.ts) with the theme resolved from the page at the moment of export, then rasterized at 2x for the PNG.
import { useRef } from "react";
import { experimental_Icon as Icon, experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardCard } from "../contract";
import { plural } from "../format";
import { BUTTON } from "./common";
import type { MapPicture, PictureRef } from "./dep-map";
import { Menu, MenuItem } from "./kit";
import { buildMapSvg, parseColor, pngScale, type ExportHeader, type ExportTheme, type Ink, type InkName } from "./map-export";
import { MARK_ICONS } from "./marks";

/**
 * Each ink as the map paints it: Loom's tokens, and the mixes dep-map.tsx and theme.ts write inline (the edge and bundle
 * bar, a band's tint, the woven edges). Resolved on a probe inside the map, so the page's theme and dark class apply.
 */
const INKS: Record<InkName, string> = {
  background: "var(--loom-card)",
  ink: "var(--foreground)",
  muted: "var(--loom-muted)",
  link: "var(--loom-link)",
  node: "var(--loom-node)",
  line: "var(--loom-line)",
  edge: "color-mix(in oklab, var(--foreground) 72%, transparent)",
  band: "color-mix(in oklab, var(--foreground) 3%, transparent)",
  selvedge: "color-mix(in oklab, var(--foreground) 34%, transparent)",
  primary: "var(--primary)",
  primarySoft: "color-mix(in oklab, var(--primary) 30%, transparent)",
  attention: "var(--attention)",
  ok: "var(--loom-ok)",
  bad: "var(--loom-bad)",
};

const estimate = (text: string, px: number, weight: number, family: "mono" | "sans") => text.length * px * (family === "mono" ? 0.6 : 0.56) * (weight >= 600 ? 1.04 : 1);

/** The theme as the page computes it now, every value resolved: colours to sRGB, fonts to their lists, bb's glyphs. */
export function resolveTheme(host: HTMLElement, glyphs: HTMLElement | null): ExportTheme {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none";
  host.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    context = null;
  }
  // A colour the parser does not know is painted on a pixel and read back.
  const viaCanvas = (css: string): Ink => {
    if (context === null) return { r: 0, g: 0, b: 0, a: 1 };
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = css;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  };
  try {
    const inks = Object.fromEntries(
      (Object.keys(INKS) as InkName[]).map((name) => {
        probe.style.color = INKS[name];
        const css = getComputedStyle(probe).color;
        return [name, parseColor(css) ?? viaCanvas(css)];
      }),
    ) as Record<InkName, Ink>;
    probe.style.color = "";
    const family = (className: string) => {
      probe.className = className;
      return getComputedStyle(probe).fontFamily || "monospace";
    };
    const fonts = { mono: family("font-mono"), sans: family("font-sans") };
    // The radius each part of the map is drawn with: Loom's own sizes, unless the theme squares them.
    const radius = (className: string, pseudo?: string) => {
      probe.className = className;
      return parseFloat(getComputedStyle(probe, pseudo).borderTopLeftRadius) || 0;
    };
    const radii = { node: radius("rounded-[5px]"), edge: radius("loom-node-done", "::before"), band: radius("rounded-md"), chip: radius("rounded-[3px]"), bar: radius("rounded-[1px]") };
    probe.className = "";
    const em = (stack: string) => {
      if (context === null) return { ascent: 0.95, descent: 0.25 };
      context.font = `400 100px ${stack}`;
      const box = context.measureText("Hg");
      const ascent = box.fontBoundingBoxAscent;
      const descent = box.fontBoundingBoxDescent;
      return typeof ascent === "number" && ascent > 0 && typeof descent === "number" ? { ascent: ascent / 100, descent: descent / 100 } : { ascent: 0.95, descent: 0.25 };
    };
    const measure = (text: string, px: number, weight: number, which: "mono" | "sans") => {
      if (context === null) return estimate(text, px, weight, which);
      context.font = `${weight} ${px}px ${which === "mono" ? fonts.mono : fonts.sans}`;
      return context.measureText(text).width;
    };
    const icons: Record<string, string> = {};
    if (glyphs !== null && typeof XMLSerializer !== "undefined") {
      const serializer = new XMLSerializer();
      for (const svg of glyphs.querySelectorAll<SVGSVGElement>("svg[data-icon]")) icons[svg.dataset.icon!] ??= [...svg.children].map((child) => serializer.serializeToString(child).replace(/ xmlns="[^"]*"/g, "")).join("");
    }
    return { inks, fonts, fontFaces: "", radii, em: { mono: em(fonts.mono), sans: em(fonts.sans) }, measure, icons };
  } finally {
    probe.remove();
  }
}

const faces = new Map<string, Promise<string>>();

/** A unicode-range as code point ranges; none means every character. */
function rangesOf(text: string): Array<[number, number]> {
  if (text.trim() === "") return [[0, 0x10ffff]];
  return text.split(",").map((part) => {
    const range = part.trim().replace(/^u\+/i, "");
    if (range.includes("?")) return [parseInt(range.replace(/\?/g, "0"), 16), parseInt(range.replace(/\?/g, "f"), 16)];
    const [from, to = from] = range.split("-");
    return [parseInt(from!, 16), parseInt(to!, 16)];
  });
}

/**
 * The @font-face rules of the fonts the page loads itself, with each file inlined, limited to the ranges the picture's
 * text uses: an SVG drawn as an image cannot fetch, and a downloaded one should look the same anywhere. A system font
 * (the user's JetBrains Mono) needs none; another machine falls back along the same list.
 */
export async function embedFonts(stacks: readonly string[], text: string): Promise<string> {
  const used = [...new Set([...text].map((char) => char.codePointAt(0)!))];
  const first = (stack: string) => stack.split(",")[0]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
  const wanted = new Set(stacks.map(first));
  const rules: Array<{ rule: CSSFontFaceRule; base: string }> = [];
  for (const sheet of document.styleSheets) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of list) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "").toLowerCase();
      const ranges = rangesOf(rule.style.getPropertyValue("unicode-range"));
      if (wanted.has(family) && used.some((point) => ranges.some(([from, to]) => point >= from && point <= to))) rules.push({ rule, base: sheet.href ?? location.href });
    }
  }
  const inlined = await Promise.all(
    rules.map(({ rule, base }) => {
      const src = rule.style.getPropertyValue("src");
      const url = /url\(["']?([^"')]+)["']?\)\s*format\(["']?woff2/.exec(src)?.[1] ?? /url\(["']?([^"')]+)["']?\)/.exec(src)?.[1];
      if (url === undefined) return Promise.resolve("");
      const href = new URL(url, base).href;
      let face = faces.get(href);
      if (face === undefined) {
        face = fetch(href)
          .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
          .then((blob) => new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }))
          .catch(() => "");
        faces.set(href, face);
      }
      return face.then((data) => {
        if (data === "") return "";
        const keep = ["font-family", "font-weight", "font-style", "font-stretch", "unicode-range"].map((name) => [name, rule.style.getPropertyValue(name)] as const).filter(([, value]) => value !== "");
        return `@font-face{${keep.map(([name, value]) => `${name}:${value}`).join(";")};src:url(${data})}`;
      });
    }),
  );
  return inlined.join("");
}

/** Draws the SVG at its own pixel size on a canvas and encodes it as a PNG. */
async function rasterize(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new Error("the canvas is too large");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** What the export reaches outside Loom, so tests can stand in for the browser. */
export const exportHost = {
  rasterize,
  save: (request: { fileName: string; blob: Blob }) => experimental_saveFile(request),
  clipboard: (): { write?: (items: ClipboardItem[]) => Promise<void> } | undefined => (typeof navigator === "undefined" ? undefined : navigator.clipboard),
  ClipboardItem: (): typeof ClipboardItem | undefined => (typeof ClipboardItem === "undefined" ? undefined : ClipboardItem),
};

export interface ExportDescription {
  header: ExportHeader;
  fileName(ext: "png" | "svg"): string;
}

interface Built {
  picture: MapPicture;
  theme: ExportTheme;
  header: ExportHeader;
  fileName(ext: "png" | "svg"): string;
  tickets: number;
}

/** The PNG, at 2x or the largest scale the canvas allows; a scale the browser still refuses is halved, down to 1x. */
async function pngOf(built: Built): Promise<{ blob: Blob; scale: number; reduced: boolean }> {
  const base = buildMapSvg(built.picture, built.header, built.theme);
  let { scale, reduced } = pngScale(base.width, base.height);
  for (;;) {
    const { svg, width, height } = buildMapSvg(built.picture, built.header, built.theme, scale);
    try {
      return { blob: await exportHost.rasterize(svg, width * scale, height * scale), scale, reduced };
    } catch (error) {
      if (scale <= 1) throw error;
      scale = Math.max(1, Math.floor((scale / 2) * 100) / 100);
      reduced = true;
    }
  }
}

const scaled = (scale: number) => `at ${scale}× to fit the browser's canvas limit`;

export function MapExport({ pictureRef, describe }: { pictureRef: PictureRef; describe(tickets: readonly BoardCard[]): ExportDescription }) {
  const glyphs = useRef<HTMLSpanElement>(null);

  // Synchronous up to the fonts, so Copy image can hand the clipboard its promise inside the click.
  const prepare = (): (Omit<Built, "theme"> & { theme: Promise<ExportTheme> }) | null => {
    const picture = pictureRef.current;
    const host = glyphs.current?.closest<HTMLElement>("[data-map-stage]") ?? glyphs.current?.parentElement ?? null;
    if (picture === null || host === null) {
      toast.error("The map is not drawn yet");
      return null;
    }
    const cards = picture.layout.nodes.flatMap((node) => (node.kind === "ticket" ? [picture.nodes.get(node.id)!.card!] : []));
    const { header, fileName } = describe(cards);
    const theme = resolveTheme(host, glyphs.current);
    const text = buildMapSvg(picture, header, theme).svg.replace(/<[^>]+>/g, " ");
    return { picture, header, fileName, tickets: cards.length, theme: embedFonts([theme.fonts.mono, theme.fonts.sans], text).then((fontFaces) => ({ ...theme, fontFaces }), () => theme) };
  };
  const ready = async (job: NonNullable<ReturnType<typeof prepare>>): Promise<Built> => ({ ...job, theme: await job.theme });

  const download = async (ext: "png" | "svg", job = prepare()) => {
    if (job === null) return;
    const name = job.fileName(ext);
    try {
      const built = await ready(job);
      const png = ext === "png" ? await pngOf(built) : null;
      const blob = png?.blob ?? new Blob([buildMapSvg(built.picture, built.header, built.theme).svg], { type: "image/svg+xml" });
      // bb shows its own toast when a download cannot start.
      if ((await exportHost.save({ fileName: name, blob })) === "started") toast.success(png?.reduced ? `Saved ${name} ${scaled(png.scale)}` : `Saved ${name}`);
    } catch (error) {
      toast.error(`Couldn't draw ${name}`, { description: error instanceof Error ? error.message : String(error), ...(ext === "png" ? { action: { label: "Download SVG", onClick: () => void download("svg") } } : {}) });
    }
  };

  const copy = () => {
    const job = prepare();
    if (job === null) return;
    const offer = { action: { label: "Download PNG", onClick: () => void download("png") } };
    const clipboard = exportHost.clipboard();
    const Item = exportHost.ClipboardItem();
    if (Item === undefined || typeof clipboard?.write !== "function") return void toast.error("Couldn't copy: this browser can't put an image on the clipboard", offer);
    let made: { scale: number; reduced: boolean } | null = null;
    let drawFailed = false;
    // The item takes the PNG as a promise, made inside the click, the form Safari also accepts.
    const blob = ready(job)
      .then(pngOf)
      .then(
        (png) => {
          made = png;
          return png.blob;
        },
        (error: unknown) => {
          drawFailed = true;
          throw error;
        },
      );
    let item: ClipboardItem;
    try {
      item = new Item({ "image/png": blob });
    } catch {
      return void toast.error("Couldn't copy: this browser can't put an image on the clipboard", offer);
    }
    clipboard.write([item]).then(
      () => {
        const png = made as { scale: number; reduced: boolean } | null;
        toast.success(`Copied the map of ${job.header.key}, ${plural(job.tickets, "ticket")}${png?.reduced ? `, ${scaled(png.scale)}` : ""}`);
      },
      (error: unknown) => {
        if (drawFailed) return void toast.error("Couldn't draw the image", { description: error instanceof Error ? error.message : String(error), action: { label: "Download SVG", onClick: () => void download("svg") } });
        const refused = error instanceof Error && error.name === "NotAllowedError";
        toast.error(refused ? "Couldn't copy: the clipboard refused the image" : `Couldn't copy the image: ${error instanceof Error ? error.message : String(error)}`, offer);
      },
    );
  };

  return (
    <>
      <span ref={glyphs} hidden data-map-export-glyphs>
        {MARK_ICONS.map((name) => (
          <Icon key={name} name={name} fallback="Circle" aria-hidden />
        ))}
      </span>
      <Menu
        label="Export the map"
        trigger={
          <button type="button" data-map-export className={`${BUTTON} @max-xl/loom:min-w-11 @max-xl/loom:justify-center`}>
            <Icon name="Download" aria-hidden className="size-3.5 text-[var(--loom-muted)]" />
            Export
          </button>
        }
      >
        <MenuItem icon="Copy" onSelect={copy}>
          Copy image
        </MenuItem>
        <MenuItem icon="Download" onSelect={() => void download("png")}>
          Download PNG
        </MenuItem>
        <MenuItem icon="Code" onSelect={() => void download("svg")}>
          Download SVG
        </MenuItem>
      </Menu>
    </>
  );
}
