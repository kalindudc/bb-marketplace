// Loom's theme layer: new property names mixed from bb's theme tokens, never a host token redefined in terms of itself
// (that is a cycle, and the token turns invalid in the subtree). Every rule is scoped to [data-loom-root], which the
// page, the sidebar, the title bar's controls and every portalled overlay carry, and every keyframe is prefixed.
import { useInsertionEffect } from "react";

const CSS = `
[data-loom-root] {
  --loom-muted: var(--muted-foreground);
  /* bb's success, accent and warning text measure 2.9 to 4.4:1 on Loom's cards and tinted pills in gruve light, so the
     ticket's marks and verdicts mix in the foreground, which darkens them on light themes and lifts them on dark ones. */
  --loom-ok: color-mix(in oklab, var(--success-foreground) 56%, var(--foreground));
  --loom-run: color-mix(in oklab, var(--timeline-accent) 76%, var(--foreground));
  --loom-warn: color-mix(in oklab, var(--warning-text) 80%, var(--foreground));
  --loom-bad: var(--destructive-text);
  --loom-card: color-mix(in oklab, var(--card) 78%, var(--background));
  --loom-line: color-mix(in oklab, var(--foreground) 11%, transparent);
  --loom-ink: var(--foreground);
  --loom-shadow: 0 1px 0 color-mix(in oklab, var(--foreground) 6%, transparent), 0 12px 28px -18px color-mix(in oklab, black 55%, transparent), 0 2px 5px -3px color-mix(in oklab, black 22%, transparent);
  --loom-weft: repeating-linear-gradient(0deg, color-mix(in oklab, var(--foreground) 4.5%, transparent) 0 1px, transparent 1px 4px);
  --loom-warp: repeating-linear-gradient(90deg, color-mix(in oklab, var(--foreground) 2.5%, transparent) 0 1px, transparent 1px 4px);
  --loom-selvedge: repeating-linear-gradient(180deg, color-mix(in oklab, var(--foreground) 34%, transparent) 0 2px, transparent 2px 4px);
  --loom-selvedge-on: repeating-linear-gradient(180deg, var(--primary) 0 2px, color-mix(in oklab, var(--primary) 30%, transparent) 2px 4px);
  --loom-selvedge-att: repeating-linear-gradient(180deg, var(--attention) 0 2px, color-mix(in oklab, var(--attention) 35%, transparent) 2px 4px);
  --loom-lum-sel: 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent), 0 0 20px -4px color-mix(in oklab, var(--primary) 62%, transparent);
  --loom-lum-att: 0 0 0 1px color-mix(in oklab, var(--attention) 78%, transparent), 0 0 20px -4px color-mix(in oklab, var(--attention) 66%, transparent);
  --loom-lum-row: linear-gradient(90deg, color-mix(in oklab, var(--primary) 14%, transparent), transparent 70%);
  --loom-att-tint: color-mix(in oklab, var(--attention) 12%, transparent);
  --loom-ease: cubic-bezier(.2, .7, .2, 1);
  --loom-sel: var(--surface-selected);
  --loom-on: var(--primary);
  /* Links and the primary ink as text: bb's primary measures 3.5 to 4.3:1 on cards, selected and hover rows in the dark
     themes, so they are lifted there; in gruve light it measures 4.87:1 or more as it is. */
  --loom-link: var(--primary);
  /* An input's boundary, 3:1 or more on every surface Loom puts a field on (bb's seam is 1.3 to 2.2:1): the foreground at
     60% measures 3.41, 3.57 and 3.65:1 at the least in gruve light, gruve dark and gruvbox dark. */
  --loom-field-line: color-mix(in oklab, var(--foreground) 60%, transparent);
  /* Marks that carry meaning (a bar's waiting part, a quiet or held step) at 3:1 or more on cards, the page and a bar's
     track in all three themes (WCAG 1.4.11): bb's red falls to 2.77:1 on a track in gruvbox dark, a faded neutral to 1.3:1. */
  --loom-mark-quiet: color-mix(in oklab, var(--foreground) 55%, transparent);
  --loom-mark-bad: color-mix(in oklab, var(--destructive) 80%, var(--foreground));
  --loom-edge: color-mix(in oklab, var(--foreground) 58%, transparent);
  --loom-node: color-mix(in oklab, var(--foreground) 42%, transparent);
}
/* Dark themes: muted text measures under 4.5:1 on cards, tinted rows and the selected sidebar row (gruvbox dark 3.04 to
   4.47:1), so Loom's muted text is lifted toward the foreground on every surface it draws. */
.dark [data-loom-root], [data-loom-root].dark {
  /* Each ink is mixed far enough toward the foreground to keep 4.5:1 on the most demanding surface Loom puts text on in
     gruvbox dark: a 15% tint over bb's card, such as an added line in Spec (bb's own inks measure 2.8 to 4.4:1 there). */
  --loom-muted: color-mix(in oklab, var(--muted-foreground) 55%, var(--foreground));
  --loom-card: color-mix(in oklab, var(--card) 70%, var(--background));
  --loom-run: color-mix(in oklab, var(--timeline-accent) 52%, var(--foreground));
  --loom-warn: color-mix(in oklab, var(--warning-text) 57%, var(--foreground));
  --loom-bad: color-mix(in oklab, var(--destructive-text) 39%, var(--foreground));
  --loom-link: color-mix(in oklab, var(--primary) 52%, var(--foreground));
}
/* bb's DetailRow paints its label muted, which sits on a card surface in Loom's popovers (gruvbox dark 4.47:1). */
.dark [data-loom-root] [data-state-card] dt, .dark [data-loom-root] [data-state-card] dt * { color: var(--loom-muted); }
[data-loom-root] .loom-cloth { background-color: var(--background); background-image: var(--loom-weft), var(--loom-warp); }
[data-loom-root] .loom-card { position: relative; background: var(--loom-card); border: 1px solid var(--loom-line); box-shadow: var(--loom-shadow); }
[data-loom-root] .loom-selvedge::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--loom-selvedge); pointer-events: none; }
[data-loom-root] .loom-selvedge[data-on="true"]::before { background: var(--loom-selvedge-on); }
[data-loom-root] .loom-selvedge[data-att="true"]::before { background: var(--loom-selvedge-att); }
[data-loom-root] .loom-lead { box-shadow: var(--loom-lum-att); }
[data-loom-root] .loom-lit { box-shadow: var(--loom-shadow), var(--loom-lum-sel); }
[data-loom-root] .loom-mark { animation: loom-pop-in 160ms var(--loom-ease) both; }
[data-loom-root] .loom-pop { animation: loom-pop-in 150ms var(--loom-ease) both; }
[data-loom-root] :focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
[data-loom-root] .loom-num { font-variant-numeric: tabular-nums; }
/* A cut block on a ticket bar: hatched, so cancelled tickets read apart from done ones without colour. */
/* A shipping block: success stripes, so it reads apart from a done block (solid) without colour, at full strength. */
[data-loom-root] .loom-ship { background: repeating-linear-gradient(90deg, var(--success) 0 2px, transparent 2px 4px); box-shadow: inset 0 0 0 1px var(--success); }
/* A closed ticket on the whole project's map: done is finished cloth, a woven edge in the done ink (the rail's selvedge);
   cancelled is cut, a hatched edge. Both edges are at full ink strength, so each reads at 3:1 or more without its colour. */
[data-loom-root] .loom-node-done::before, [data-loom-root] .loom-node-cut::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; border-radius: 4px 0 0 4px; pointer-events: none; }
[data-loom-root] .loom-node-done::before { background: repeating-linear-gradient(180deg, var(--loom-ok) 0 2px, transparent 2px 3px); }
[data-loom-root] .loom-node-cut::before { width: 5px; background: repeating-linear-gradient(135deg, var(--loom-muted) 0 1.5px, transparent 1.5px 3.5px); }
[data-loom-root] .loom-cut { background: repeating-linear-gradient(135deg, var(--loom-muted) 0 1.5px, transparent 1.5px 4px); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--loom-muted) 70%, transparent); }
/* bb's code blocks (its Markdown, with sugar-high's tokens) inside Loom, a scoped fallback until bb fixes them: its class
   and string colours measure 3.75 and 4.26:1 on its recessed surface in gruve light, and Wrap lines and Copy code are 20 px
   with centres 22 px apart. Each token keeps its hue mixed toward the text colour (sugar-high writes the colour inline,
   hence !important), and the two buttons get 24 px, or 44 px on a phone or a touch screen. Nothing outside Loom's root changes. */
[data-loom-root] .bb-code-highlight { --loom-code-mix: 62%; }
[data-loom-root] .bb-code-highlight .sh__token--class { color: color-mix(in oklab, var(--sh-class) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--string { color: color-mix(in oklab, var(--sh-string) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--keyword { color: color-mix(in oklab, var(--sh-keyword) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--property { color: color-mix(in oklab, var(--sh-property) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--entity { color: color-mix(in oklab, var(--sh-entity) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--jsxliterals { color: color-mix(in oklab, var(--sh-jsxliterals) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--sign { color: color-mix(in oklab, var(--sh-sign) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] .bb-code-highlight .sh__token--comment { color: color-mix(in oklab, var(--sh-comment) var(--loom-code-mix), var(--foreground)) !important; }
[data-loom-root] :has(> pre.bb-code-highlight) > [data-clipboard-ignore] button { width: 24px; height: 24px; }
@container loom (width < 36rem) { [data-loom-root] :has(> pre.bb-code-highlight) > [data-clipboard-ignore] button { width: 44px; height: 44px; } }
@media (max-width: 576px), (pointer: coarse) { [data-loom-root] :has(> pre.bb-code-highlight) > [data-clipboard-ignore] button { width: 44px; height: 44px; } }
/* bb's ThreadChat embedded in a ticket's Threads tab, a scoped fallback until bb fixes it: it fades past tool rows with
   opacity-40 on the row and opacity-70 on the command, which measures 1.72:1 in gruve light and 2.10:1 in gruvbox dark,
   and its row buttons are 20 to 23 px tall. Inside Loom's embedded chat only, the rows keep their place in the hierarchy
   by colour (Loom's muted text) instead of opacity, and on a phone or a touch screen every button there takes 44 px. It
   relies on bb's [data-timeline-row-id] rows and its opacity-40, opacity-70, text-subtle-foreground and
   text-muted-foreground class names; if bb renames them the fallback stops silently, so the final gate rechecks it. */
[data-loom-root] [data-thread-chat] [data-timeline-row-id] .opacity-40, [data-loom-root] [data-thread-chat] [data-timeline-row-id] .opacity-70 { opacity: 1 !important; }
[data-loom-root] [data-thread-chat] [data-timeline-row-id] .text-subtle-foreground, [data-loom-root] [data-thread-chat] [data-timeline-row-id] .text-muted-foreground { color: var(--loom-muted) !important; }
@container loom (width < 36rem) { [data-loom-root] [data-thread-chat] button { min-height: 44px; min-width: 44px; } }
@media (max-width: 576px), (pointer: coarse) { [data-loom-root] [data-thread-chat] button { min-height: 44px; min-width: 44px; } }
/* bb's NewThreadComposer on New project, a scoped fallback until bb fixes it: the selected effort ("Medium") in its
   action row measures 4.29:1 in gruvbox dark. Inside Loom's root, in dark themes only, those labels take Loom's muted
   ink. It relies on bb's data-promptbox-action-row and data-promptbox-hide-compact attributes; if bb renames them the
   fallback stops silently, so the final gate rechecks it. */
.dark [data-loom-root] [data-promptbox-action-row] [data-promptbox-hide-compact] { color: var(--loom-muted); }
/* A link that is a table cell's whole content, in Markdown an agent wrote (bb auto-links addresses there), is a target
   of its own rather than a word in a sentence: on a phone or a touch screen it gets the 44 px box Loom's controls have. */
@container loom (width < 36rem) { [data-loom-root] [data-content] td > a:only-child { display: inline-flex; align-items: center; min-height: 44px; } }
@media (max-width: 576px), (pointer: coarse) { [data-loom-root] [data-content] td > a:only-child { display: inline-flex; align-items: center; min-height: 44px; } }
/* A table in Markdown an agent wrote (a file-by-file summary, a CI matrix) scrolls sideways inside its own box instead of
   widening the card or the side panel it sits in: a table is two-dimensional, so its own scrolling is allowed (1.4.10). */
[data-loom-root] [data-markdown-preview] table, [data-loom-root] [data-content] table { display: block; max-width: 100%; overflow-x: auto; }
/* A list in that Markdown indents each level by its rem padding, which enlarged text doubles while a side panel stays
   328 px: three levels deep at 200% text left a 12 px column. Each level gives at most 6% of Loom's container instead. */
[data-loom-root] [data-markdown-preview] ul, [data-loom-root] [data-markdown-preview] ol, [data-loom-root] [data-content] ul, [data-loom-root] [data-content] ol { padding-left: min(1.25rem, 6cqi); }
/* A disclosure in Markdown an agent or a CI bot wrote (details and summary in a pull request comment) is a control, not a
   word: 24 px tall, and 44 px on a phone or a touch screen. It keeps its disclosure triangle (display stays list-item). */
[data-loom-root] [data-markdown-preview] details > summary, [data-loom-root] [data-content] details > summary { min-height: 24px; padding-block: 2px; cursor: pointer; }
@container loom (width < 36rem) { [data-loom-root] [data-markdown-preview] details > summary, [data-loom-root] [data-content] details > summary { min-height: 44px; padding-block: 10px; } }
@media (max-width: 576px), (pointer: coarse) { [data-loom-root] [data-markdown-preview] details > summary, [data-loom-root] [data-content] details > summary { min-height: 44px; padding-block: 10px; } }
@keyframes loom-pop-in { from { opacity: 0; transform: translateY(2px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes loom-fade-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  [data-loom-root] *, [data-loom-root] { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }
}
`;

/** The layer as it goes in the page, for the tests that measure its tokens against the themes. */
export const LOOM_THEME_CSS = CSS;

const STYLE_ID = "loom-theme";

/** Puts Loom's theme layer in the document once; a reloaded plugin replaces it. */
export function useLoomTheme(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined") return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (style === null) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }, []);
}
