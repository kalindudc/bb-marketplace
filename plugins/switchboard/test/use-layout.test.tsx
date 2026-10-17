import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RpcContract } from "../src/rpc";
import { useLayout } from "../src/use-layout";
import { layoutWriteFakes } from "./fixtures";

const empty = { sectionOrder: [], sectionHues: {}, collapsed: [], order: {}, sectionSort: {}, snoozes: {} };
function View() {
  const { layout, setCollapsed, setOrder, setSectionOrder, setSectionHue, setSectionSort, snooze, unsnooze, refetch } = useLayout();
  return <><output>{layout.collapsed.join(",")}</output><output data-testid="layout">{JSON.stringify(layout)}</output>
    <button onClick={() => setCollapsed("section:s", true)}>Collapse</button>
    <button onClick={() => setOrder("loose", ["b", "a"])}>Order</button>
    <button onClick={() => setSectionOrder(["s"])}>Section order</button>
    <button onClick={() => setSectionHue("s", "teal")}>Hue</button>
    <button onClick={() => setSectionSort("section:s", "recent")}>Sort</button>
    <button onClick={() => snooze(["a"], 123456)}>Snooze</button>
    <button onClick={() => unsnooze(["a"])}>Wake</button>
    <button onClick={refetch}>Refetch</button></>;
}
const registration = { component: View };
const cacheKey = "switchboard:layout:v1";
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("browser layout", () => {
  it("starts from a safe cache, fetches, and applies realtime patches", async () => {
    localStorage.setItem(cacheKey, JSON.stringify({ ...empty, collapsed: ["loose"] }));
    const slot = renderSlot<{}, RpcContract>(registration, {}, { pluginId: "switchboard", rpc: {
      ...layoutWriteFakes,
      getLayout: () => ({ ...empty, collapsed: ["pinned"] }), setCollapsed: () => ({ collapsed: [] }),
    } });
    expect(screen.getByText("loose")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("pinned")).toBeTruthy());
    await slot.behavior.emitRealtime("layout", { key: "collapsed", value: ["thread:t"] });
    expect(screen.getByText("thread:t")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(cacheKey)!)).toMatchObject({ collapsed: ["thread:t"] });
    slot.unmount();
  });

  it("optimistically writes order and hue, then refetches explicitly", async () => {
    let reads = 0;
    const slot = renderSlot<{}, RpcContract>(registration, {}, { pluginId: "switchboard", rpc: {
      ...layoutWriteFakes,
      setCollapsed: () => ({ collapsed: [] }),
      getLayout: () => ({ ...empty, collapsed: reads++ ? ["pinned"] : [] }),
      setOrder: () => ({ ids: ["b", "a"] }),
      setSectionOrder: () => ({ ids: ["s"] }),
      setSectionHue: () => ({ sectionHues: { s: "teal" } }),
    } });
    await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getLayout")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Order" }));
    fireEvent.click(screen.getByRole("button", { name: "Section order" }));
    fireEvent.click(screen.getByRole("button", { name: "Hue" }));
    expect(screen.getByTestId("layout").textContent).toContain('"loose":["b","a"]');
    expect(screen.getByTestId("layout").textContent).toContain('"sectionOrder":["s"]');
    expect(screen.getByTestId("layout").textContent).toContain('"s":"teal"');
    expect(slot.rpcCalls.map((call) => call.method)).toEqual([
      "getLayout", "setOrder", "setSectionOrder", "setSectionHue",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Refetch" }));
    await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getLayout")).toHaveLength(2));
    slot.unmount();
  });

  it("optimistically sorts, snoozes and wakes then applies layout patches", async () => {
    const slot = renderSlot<{}, RpcContract>(registration, {}, { pluginId: "switchboard", rpc: {
      ...layoutWriteFakes, getLayout: () => empty, setCollapsed: () => ({ collapsed: [] }),
      snooze: () => ({ snoozes: { a: { until: 123456, at: 42 } } }),
      unsnooze: () => ({ snoozes: {} }),
    } });
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "getLayout")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByTestId("layout").textContent).toContain('"section:s":"recent"');
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));
    expect(slot.rpcCalls).toContainEqual(expect.objectContaining({ method: "snooze", input: {
      threadIds: ["a"], until: 123456,
    } }));
    await waitFor(() => expect(screen.getByTestId("layout").textContent).toContain('"at":42'));
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("layout").textContent!).snoozes).toEqual({}));
    slot.unmount();
  });

  it("ignores a broken cache, refetches on reconnect and optimistically toggles", async () => {
    localStorage.setItem(cacheKey, "{bad");
    let reads = 0;
    const slot = renderSlot<{}, RpcContract>(registration, {}, { pluginId: "switchboard", rpc: {
      ...layoutWriteFakes,
      getLayout: () => ({ ...empty, collapsed: reads++ ? ["loose"] : [] }),
      setCollapsed: () => ({ collapsed: ["section:s"] }),
    } });
    await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getLayout")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByText("section:s")).toBeTruthy();
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getLayout")).toHaveLength(2));
    slot.unmount();
  });
});
