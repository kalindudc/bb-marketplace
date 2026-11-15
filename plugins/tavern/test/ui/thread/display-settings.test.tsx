// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registerThreadSurfaces } from "../../../src/ui/thread/register";

afterEach(cleanup);
const thread = async () => (await loadPluginApp(definePluginApp(registerThreadSurfaces))).composerCustomizations.find(c => c.id === "tavern-thread")!;
const options = (widgetRow: boolean | undefined) => ({ composer: { scope: { kind: "thread" as const, threadId: "keeper-1" } }, rpc: { decor: () => ({ ...fixtureDecor, hidden: false, ...(widgetRow === undefined ? {} : { widgetRow }) }), registry: () => fixtureRegistry } });
const composer = { scope: { kind: "thread", threadId: "keeper-1" } } as never;

describe("the Widget row setting", () => {
  it("draws no widget row and no crest toggle when it is off, and the + menu can't offer to show the row", async () => {
    const t = await thread();
    const row = renderSlot(t.banners![0]!, {}, options(false));
    await waitFor(() => expect(row.inspection.rpcCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(row.container.querySelector("[data-part]") ?? row.container.firstChild).toBeNull());
    expect(row.queryByLabelText("Tavern widget")).toBeNull();
    const toggle = renderSlot(t.actions![0]!, {}, options(false));
    await waitFor(() => expect(toggle.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(toggle.queryByRole("button")).toBeNull();
    const show = t.plusMenu!.find(m => m.id === "show")!;
    expect(typeof show.disabled === "function" && show.disabled(composer)).toBe(true);
    row.lifecycle.unmount(); toggle.lifecycle.unmount();
  });

  it("draws the row and the toggle as before when it is on, or absent from an older server", async () => {
    for (const widgetRow of [true, undefined]) {
      const t = await thread();
      const row = renderSlot(t.banners![0]!, {}, options(widgetRow));
      await row.findByLabelText("Tavern widget");
      const show = t.plusMenu!.find(m => m.id === "show")!;
      expect(typeof show.disabled === "function" && show.disabled(composer)).toBe(false);
      row.lifecycle.unmount();
      const toggle = renderSlot(t.actions![0]!, {}, options(widgetRow));
      await toggle.findByRole("button", { name: /Hide Tavern/ });
      toggle.lifecycle.unmount();
    }
  });
});
