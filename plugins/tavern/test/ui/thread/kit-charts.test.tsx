// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Chart, Kpi, formatValue } from "../../../src/ui/kit";
afterEach(cleanup);

const days = (ys: (number | null)[]) => ys.map((y, i) => ({ x: `2026-11-${String(i + 1).padStart(2, "0")}`, y }));

describe("Kit charts", () => {
  it.each([100,1])("separates three trend endpoints near %i", value => {
    const view=render(<Chart type="trend" series={[0,1,2].map(i=>({id:String(i),label:`Model ${i}`,unit:"count",points:days([100,value+i*0.01])}))}/>);
    const ys=[...view.container.querySelectorAll("svg text.val")].map(n=>Number(n.getAttribute("y"))).sort((a,b)=>a-b);
    expect(ys).toHaveLength(3);
    expect(ys[1]!-ys[0]!).toBeGreaterThanOrEqual(13);
    expect(ys[2]!-ys[1]!).toBeGreaterThanOrEqual(13);
    expect(ys[0]).toBeGreaterThanOrEqual(12);
    expect(ys[2]).toBeLessThanOrEqual(112);
  });
  it("labels each named trend with its final value", () => {
    const view = render(<Chart type="trend" series={[{id:"a",label:"Fast",unit:"USD",points:days([1,2])},{id:"b",label:"Large",unit:"USD",points:days([3,4])}]} format={(n,u)=>`${n} ${u}`} />);
    const labels = [...view.container.querySelectorAll("svg text")].map(label=>label.textContent);
    expect(labels).toContain("Fast: 2 USD");
    expect(labels).toContain("Large: 4 USD");
  });
  it("formats each unit in words people read", () => {
    expect(formatValue(0.82, "ratio")).toBe("82%");
    expect(formatValue(1320, "s")).toBe("22 min");
    expect(formatValue(11_500, "bytes")).toBe("11.5 KB");
    expect(formatValue(4.9, "usd")).toBe("$4.90");
    expect(formatValue(null, "s")).toBe("no data");
    expect(formatValue(840, "tokens")).toBe("840 tokens");
    expect(formatValue(3400, "tokens")).toBe("3.4k tokens");
    expect(formatValue(6_214_000, "tokens")).toBe("6.2M tokens");
    expect(formatValue(14_200_000, "tokens")).toBe("14M tokens");
    expect(formatValue(999_600, "tokens")).toBe("1M tokens");
    expect(formatValue(6_214_000, "count")).toBe("6,214,000");
  });

  it("says better or worse in words, not only by tint", () => {
    const view = render(<div className="tavern"><Kpi label="Median ask wait" value="22 min" warn delta={{ value: 1320, previous: 840, unit: "s", lowerIsBetter: true }} /></div>);
    const delta = view.container.querySelector(".tkpi-d")!;
    expect(delta.className).toContain("bad");
    expect(delta.textContent).toContain("worse");
    expect(delta.textContent).toContain("from 14 min");
  });

  it("writes each bar's value at its end and names a missing one", () => {
    const view = render(<div className="tavern"><Chart type="bars" series={{ id: "s", label: "How asks ended", unit: "count", points: [{ x: "You answered", y: 96 }, { x: "Expired", y: null }] }} /></div>);
    expect(view.getByText("96")).toBeTruthy();
    expect(view.getByText("no data")).toBeTruthy();
  });

  it("draws a trend at 1:1, labels its range and breaks the line at a missing day", () => {
    const view = render(<div className="tavern"><Chart type="trend" series={{ id: "t", label: "Asks per day", unit: "count", points: days([5, 7, null, 1, 5]) }} /></div>);
    const svg = view.getByRole("img");
    expect(svg.getAttribute("width")).toBe(svg.getAttribute("viewBox")!.split(" ")[2]);
    expect(svg.getAttribute("aria-label")).toContain("lowest 1, highest 7; 1 days without data");
    expect(view.container.querySelectorAll("polyline")).toHaveLength(2);
    expect(view.container.querySelectorAll("circle.dot").length).toBeGreaterThanOrEqual(4);
  });

  it("says so when there are too few days to draw", () => {
    const view = render(<div className="tavern"><Chart type="trend" series={{ id: "t", label: "Asks per day", unit: "count", points: days([5]) }} /></div>);
    expect(view.getByText("Not enough days yet.")).toBeTruthy();
  });
});
