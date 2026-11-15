// @vitest-environment jsdom
import { render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { TaleResults } from "../../../src/ui/kit/tale-results";
const results = { figures: [{ label: "Cost", value: "$1,532.97", note: "Recorded usage" }], chart: { title: "Cost by model", type: "bars" as const, unit: "USD", labels: ["Opus 5.5", "Fast"], series: [{ name: "Recorded cost", values: [1532.967591, 30.8] }] } };
it("formats displayed values with thousands separators and at most two decimals", () => {
  const view = render(<TaleResults results={results} />);
  expect(view.getByText("1,532.97 USD")).toBeTruthy();
  expect(view.getByText("30.80 USD")).toBeTruthy();
  view.unmount();
});
it("labels a single-series bar with only its category, retaining names for multiple series", () => {
  const view = render(<TaleResults results={results} />);
  expect(view.container.querySelector(".tchart-bars .l")?.textContent).toBe("Opus 5.5");
  view.rerender(<TaleResults results={{...results, chart: {...results.chart, series: [...results.chart.series, {name: "Forecast", values: [1600, 3]}]}}} />);
  expect(view.container.querySelector(".tchart-bars .l")?.textContent).toBe("Opus 5.5: Recorded cost");
  view.unmount();
});
it("keeps each note beneath its own figure rather than in a separate list", () => {
  const view = render(<TaleResults results={results} />);
  const figure = view.getByText("Cost", {selector:"dt"}).parentElement!;
  expect(within(figure).getByText("Recorded usage").className).toBe("tfig-note");
  expect(view.container.querySelector(".tale-result-notes")).toBeNull();
  view.unmount();
});
it("bounds the chart and delivery and spaces the page's own wrappers", () => {
  const kit = readFileSync("src/ui/kit/components.css", "utf8");
  const page = readFileSync("src/ui/page/page.css", "utf8");
  expect(kit).toMatch(/\.tale-results > section\s*\{[^}]*max-width: 720px/);
  expect(kit).toMatch(/\.tfig-note\s*\{[^}]*color: var\(--tavern-muted\)/);
  expect(kit).toMatch(/\.tfig-note\s*\{[^}]*white-space: normal/);
  expect(kit).toMatch(/\.tfig-note\s*\{[^}]*max-width: 36ch/);
  expect(page.match(/\.tale-files h4\s*\{/g)).toHaveLength(1);
  expect(page).toMatch(/\.tv-tale-next ol\s*\{[^}]*list-style: decimal/);
  expect(page).toMatch(/\.tale-delivery-text ol\s*\{[^}]*list-style: decimal/);
  expect(page).toMatch(/\.tale-delivery-text ul\s*\{[^}]*list-style: disc/);
  expect(page).toMatch(/\.tale-delivery-text\s*\{[^}]*max-width: 80ch/);
  expect(page).toMatch(/\.tv-tale-delivery\s*\{[^}]*gap: 24px/);
  expect(page).toMatch(/\.tale-delivery-markdown :where\(p, ul, ol\) \+ :where\(p, ul, ol\)\s*\{[^}]*margin-top: 1em/);
});
