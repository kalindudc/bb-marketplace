// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { QuestRow } from "../../../src/ui/kit";
import { motion } from "../../../src/ui/kit/motion";
import { richRoom, registry } from "../page/scenes";
import { installAnimations } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); motion.now = () => 1_000_000; fx = installAnimations({ "mo-arrive": 300 }); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });
async function mount(node: () => ReactElement) {
  const app = await loadPluginApp(definePluginApp(app => { app.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: node } as never); }));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {});
}
const keeper = richRoom.keepers[0]!;
const live = keeper.boardQuests.find(q => q.phase !== "done" && q.phase !== "stopped")!;

describe("QuestRow arrival and ask marking", () => {
  it("marks a quest changed since the last look and fades the mark in once", async () => {
    const slot = await mount(() => <QuestRow quest={{ ...live, updatedAt: 2000 }} room={{ asks: [] }} registry={registry} keeper={keeper} arrival={{ since: 1000 }} />);
    const row = slot.container.querySelector<HTMLElement>(".qrow")!;
    expect(row.dataset.quest).toBe(live.id);
    expect(row.querySelector(".arrival-mark")?.textContent).toBe("new");
    expect([...motion.cues].map(c => c.kind)).toEqual(["arrival"]);
  });

  it("shows nothing for a quest older than the last look", async () => {
    const slot = await mount(() => <QuestRow quest={{ ...live, updatedAt: 500 }} room={{ asks: [] }} registry={registry} keeper={keeper} arrival={{ since: 1000 }} />);
    expect(slot.container.querySelector(".arrival-mark")).toBeNull();
  });

  it("marks a your-move row as an ask, and keeps its new mark still", async () => {
    const all = richRoom.keepers.flatMap(k => k.boardQuests.filter(q => q.phase !== "done" && q.phase !== "stopped").map(q => ({ k, q })));
    const slot = await mount(() => <>{all.map(({ k, q }) => <QuestRow key={q.id} quest={{ ...q, updatedAt: 2000 }} room={richRoom} registry={registry} keeper={k} arrival={{ since: 1000 }} />)}</>);
    const rows = [...slot.container.querySelectorAll<HTMLElement>(".qrow")];
    const yours = rows.filter(r => r.dataset.variant === "your-move");
    expect(yours.length).toBeGreaterThan(0);
    for (const r of yours) { expect(r.hasAttribute("data-ask")).toBe(true); expect(r.querySelector(".arrival-mark")).not.toBeNull(); }
    for (const r of rows.filter(r => r.dataset.variant !== "your-move")) expect(r.hasAttribute("data-ask")).toBe(false);
    const faded = [...motion.cues].map(c => (c.el.closest(".qrow") as HTMLElement).dataset.variant);
    expect(faded).not.toContain("your-move");
  });
});
