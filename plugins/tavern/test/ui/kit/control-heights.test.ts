// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const kit = readFileSync("src/ui/kit/tavern.css", "utf8");
const components = readFileSync("src/ui/kit/components.css", "utf8");
const page = readFileSync("src/ui/page/page.css", "utf8");

it.each([
  ["widget footer", components, /^\.tavern \.tw-section-actions\b[^{}]*\{[^{}]*min-height:\s*44px\b/m],
  ["quest rename", page, /^\.tavern\.tv-page \.tv-rename\b[^{}]*\{[^{}]*min-height:\s*44px\b/m],
  ["alert test", page, /^\.tavern\.tv-page \.tv-alert-actions\b[^{}]*\{[^{}]*min-height:\s*44px\b/m],
] as const)("%s controls don't force 44 px on desktop", (_name, css, oversized) => {
  expect(oversized.test(css)).toBe(false);
});

it("keeps small buttons at 24 px on desktop and all buttons at 44 px on touch or narrow windows", () => {
  expect(kit).toMatch(/\.tavern \.btn\.sm\s*\{\s*min-height:\s*24px;/);
  expect(kit).toMatch(/@media \(pointer: coarse\), \(max-width: 560px\)\s*\{(?:\s*[^{}]+\{[^{}]*\})*?\s*\.tavern \.btn, \.tavern \.btn\.sm\s*\{\s*min-height:\s*44px;/);
});

it("keeps the more specific quest rename input at 44 px on touch or narrow windows", () => {
  expect(page).toMatch(/@media \(max-width: 560px\), \(pointer: coarse\)\s*\{\s*\.tavern\.tv-page \.tv-rename \.tv-text\s*\{[^{}]*min-height:\s*44px;/);
});
