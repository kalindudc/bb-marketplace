// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const kit = readFileSync("src/ui/kit/tavern.css", "utf8");
const page = readFileSync("src/ui/page/page.css", "utf8");
const touchOrNarrow = "@media (pointer: coarse), (max-width: 560px)";
const uiFiles = readdirSync("src/ui", { recursive: true, withFileTypes: true })
  .filter((file) => file.isFile()).map((file) => join(file.parentPath, file.name));

function buttonClasses(markup: string[]) {
  const classes = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      for (const part of node.text.split(/\s+/)) if (/^[\w-]+$/.test(part)) classes.add(part);
    }
    node.forEachChild(collect);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const attr = (name: string) => node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name)?.initializer;
      const role = attr("role");
      const className = tag === "OverflowMenu" ? attr("triggerClassName")
        : /^(button|summary|IconButton)$/.test(tag) || (role && ts.isStringLiteral(role) && role.text === "button") ? attr("className") : undefined;
      if (className) collect(className);
    }
    node.forEachChild(visit);
  };
  for (const jsx of markup) visit(ts.createSourceFile("controls.tsx", jsx, ts.ScriptTarget.Latest, true));
  // These are shared surface and badge markers; a button using them has its own selector.
  classes.delete("tavern");
  classes.delete("tag");
  return classes;
}

function targetCompounds(selector: string) {
  const targets = [];
  let depth = 0, start = 0, last = "";
  for (let i = 0; i <= selector.length; i++) {
    const char = selector[i] ?? ",";
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (depth || !/[\s,>+~]/.test(char)) continue;
    last = selector.slice(start, i) || last;
    if (char === ",") { targets.push(last); last = ""; }
    start = i + 1;
  }
  return targets;
}

function targetsButton(selector: string, classes: Set<string>): boolean {
  return targetCompounds(selector).some((target) => {
    const groups = /:(is|where|not|has)\(((?:[^()]|\([^()]*\))*)\)/g;
    const own = target.replace(groups, "");
    if (own.includes("::")) return false;
    return /^(button|summary)(?![\w-])|\[role\^?=["']?(button|option|menuitem)/.test(own)
      || Array.from(own.matchAll(/\.([\w-]+)/g)).some(([, name]) => classes.has(name!) || /(?:^|-)btn$|^(?:ibtn|menu-trigger)$/.test(name!))
      || Array.from(target.matchAll(groups)).some(([, kind, inner]) => (kind === "is" || kind === "where") && targetsButton(inner!, classes));
  });
}

const widgetButtons = ".tavern.twidget.v-member .tw-row > button, .tavern.twidget.v-keeper .tw-row > button";
const preservedSizes = new Map<string, string>([
  // The composer row, actor and invisible road target follow their host geometry.
  [".tavern .tw-member-id: min-height 24px", ""],
  [".tavern .crest-toggle: height 32px", ""],
  [`${widgetButtons}: height 24px`, ""],
  [`${widgetButtons}: height 28px`, "@media (max-width: 767px) and (pointer: coarse)"],
  [".tavern button.twalk-actor: height 56px", ""],
  [".tavern.twalk .twalk-ask-button: height 44px", ""],
  // The hearth and compound quest and Keeper cards keep their own reviewed geometry.
  [".tavern.tv-page .tv-home-link: min-height 64px", ""],
  [".tavern.tv-page .tv-squest: min-height 48px", ""],
  [".tavern.tv-page .tv-sactive: min-height 65px", ""],
  [".tavern.tv-page .tv-skeeper: min-height 44px", ""],
  // The plain header uses its own height; summary.tv-need-group-head overrides it.
  [".tavern.tv-page .tv-need-group-head: min-height 32px", ""],
  // Keep the Journal's margin rule centred on the notebook rows and their checkmarks.
  [".tavern .journal-row: min-height var(--jn-row)", ""],
  [".tavern .journal-row .tick: height var(--jn-hit)", ""],
  [".tavern .journal-row .desc: min-height var(--jn-hit)", ""],
  [".tavern .journal-dacts .lnk, .tavern .journal-note .lnk: min-height var(--jn-hit)", ""],
]);

function offScale(css: string, classes = new Set<string>()) {
  const blocks: string[] = [];
  const outliers: string[] = [];
  for (const [, text, brace] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      blocks.push(text.trim());
      continue;
    }
    const selector = blocks.pop();
    if (!selector || selector.startsWith("@") || !targetsButton(selector, classes)) continue;
    const large = blocks.some((block) => block.startsWith("@media ") && block.split(",").every((query) => {
      const width = query.match(/\(max-width:\s*(\d+)px\)/);
      return !/\bnot\b/.test(query) && (query.includes("(pointer: coarse)") || (width !== null && Number(width[1]) <= 560));
    }));
    const rule = selector.replace(/\s+/g, " ");
    for (const [, property, raw] of text.matchAll(/(?:^|;)\s*((?:(?:min|max)-)?(?:height|block-size))\s*:\s*([^;]+)/g)) {
      const value = raw!.replace(/\s*!important\s*$/, "").trim();
      if (/^(?:auto|none|min-content|max-content|fit-content|\d+(?:\.\d+)?%|var\(--tavern-control-(?:compact|standard)\))$/.test(value) || (value === "44px" && large)) continue;
      const declaration = `${rule}: ${property} ${value}`;
      if (preservedSizes.get(declaration) !== blocks.join(" ")) outliers.push(declaration);
    }
  }
  return outliers;
}

it.each([
  ["touch and narrow", `${touchOrNarrow} { .btn { min-height: 44px; } }`, 0],
  ["desktop", ".btn { height: 44px; }", 1],
  ["a thin panel in a wide window", "@container (max-width: 390px) { .btn { height: 44px; } }", 1],
  ["an arbitrary height inside a media query", "@media (pointer: coarse) { button.new { min-block-size: 38px; } }", 1],
  ["a rule outside the query", "@media (pointer: coarse) { .btn { height: 44px; } } .btn { height: 44px; }", 1],
  ["a decorative glyph", ".btn > svg { height: 16px; }", 0],
  ["a panel around a button", ".panel:has(button) { height: 36px; }", 0],
  ["a desktop branch grouped with touch", "@media (pointer: coarse), (hover: hover) { .btn { height: 44px; } }", 1],
  ["the desktop composer exception", `${widgetButtons} { height: 24px; }`, 0],
  ["the composer exception in the wrong query", `@media (min-width: 560px) { ${widgetButtons} { height: 28px; } }`, 1],
] as const)("checks fixed button sizes at %s", (_name, css, count) => {
  expect(offScale(css)).toHaveLength(count);
});

it.each([
  ["a new class on a button", ".tavern .quest-go { height: 36px; }", '<button className="quest-go" />'],
  ["a new class in a template string", ".tavern :where(.quest-go) { min-block-size: 2rem; }", '<button className={`quest-go ${active ? "on" : ""}`} />'],
  ["a permanently compact button", ".tavern .new-btn { min-height: 24px; }", ""],
  ["a permanently standard button", ".tavern .btn { min-height: 30px; }", ""],
  ["an override that stays compact on touch", "@media (pointer: coarse) { .btn { height: 24px; } }", ""],
])("rejects %s", (_name, css, markup) => {
  expect(offScale(css, buttonClasses([markup]))).toHaveLength(1);
});

it("keeps fixed button heights on the scale in every UI stylesheet", () => {
  const classes = buttonClasses(uiFiles.filter((file) => file.endsWith(".tsx")).map((file) => readFileSync(file, "utf8")));
  expect(uiFiles.filter((file) => file.endsWith(".css")).flatMap((file) =>
    offScale(readFileSync(file, "utf8"), classes).map((outlier) => `${file}: ${outlier}`),
  )).toEqual([]);
});

it("uses compact and standard controls on desktop and lifts both to 44 px on touch or narrow windows", () => {
  const tokens = /--tavern-control-(?:compact|standard)\s*:/g;
  expect(uiFiles.filter((file) => file.endsWith(".css")).flatMap((file) => readFileSync(file, "utf8").match(tokens) ?? [])).toHaveLength(4);
  expect(kit).toMatch(/\.tavern\s*\{[^{}]*--tavern-control-compact:\s*24px;[^{}]*--tavern-control-standard:\s*30px;/);
  expect(kit).toContain(`${touchOrNarrow} {\n  .tavern { --tavern-control-compact: 44px; --tavern-control-standard: 44px; }`);
  expect(kit).toMatch(/\.tavern \.btn\s*\{[^{}]*min-height:\s*var\(--tavern-control-standard\);/);
  expect(kit).toMatch(/\.tavern \.btn\.sm\s*\{[^{}]*min-height:\s*var\(--tavern-control-compact\);/);
});

it("keeps the preserved Journal sizes responsive", () => {
  const journal = readFileSync("src/ui/thread/journal-notebook.css", "utf8");
  expect(journal).toContain(`${touchOrNarrow} {\n  .tavern.journal { --jn-row: 44px; --jn-hit: 44px; }`);
});

it("gives the wax-coloured Seal a keyline that Send does not have", () => {
  const components = readFileSync("src/ui/kit/components.css", "utf8");
  expect(components).toMatch(/\.btn\.seal\s*\{[^{}]*background: var\(--tavern-wax\);[^{}]*border: 3px double var\(--primary-foreground\);/);
  expect(kit).not.toMatch(/\.btn\.pri\s*\{[^{}]*border[^;]*double/);
});

it("keeps the more specific quest rename input at 44 px on touch or narrow windows", () => {
  expect(page).toMatch(/@media \(max-width: 560px\), \(pointer: coarse\)\s*\{\s*\.tavern\.tv-page \.tv-rename \.tv-text\s*\{[^{}]*min-height:\s*44px;/);
});
