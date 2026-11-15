// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { QuestRow, pathProgress, taleFigures, verifiedOf, verifiedWords } from "../../../src/ui/kit";
import { registry, richRoom } from "../page/scenes";

afterEach(cleanup);
const keeper = richRoom.keepers[0]!;
const live = keeper.boardQuests.find(q => q.phase !== "done" && q.phase !== "stopped" && q.waypoints.length > 0)!;
const w0 = live.waypoints[0]!;
type State = (typeof w0)["state"];
const withStates = (...states: State[]) => ({ ...live, phase: "done" as const, endedAt: Date.now() - 60_000, waypoints: states.map((state, i) => ({ ...w0, id: `w${i + 1}`, title: `Step ${i + 1}`, actor: "agent" as const, state })) });

async function mount(node: () => ReactElement) {
  const app = await loadPluginApp(definePluginApp(app => { app.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: node } as never); }));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {});
}

describe("verified counts only verified waypoints", () => {
  it("counts verified, skipped and every waypoint, and nothing without a map", () => {
    expect(verifiedOf(withStates("verified", "skipped"))).toEqual({ verified: 1, skipped: 1, total: 2 });
    expect(verifiedOf(withStates("skipped"))).toEqual({ verified: 0, skipped: 1, total: 1 });
    expect(verifiedOf(withStates())).toBeNull();
    // Progress is a different measure: a skipped waypoint is out of the way, so it counts as done there.
    expect(pathProgress(withStates("skipped"))).toEqual({ done: 1, total: 1 });
  });

  it("says verified for verified ones only, the skipped ones beside them, and only skipped when nothing was verified", () => {
    expect(verifiedWords({ verified: 2, skipped: 0, total: 3 })).toBe("2 of 3 verified");
    expect(verifiedWords({ verified: 1, skipped: 1, total: 2 })).toBe("1 of 2 verified\u00a0· 1 skipped");
    expect(verifiedWords({ verified: 0, skipped: 1, total: 3 })).toBe("0 of 3 verified\u00a0· 1 skipped");
    expect(verifiedWords({ verified: 1, skipped: 1, total: 2 }, "")).toBe("1 of 2\u00a0· 1 skipped");
  });

  it("says all of them when every waypoint was skipped, and one alone as one", () => {
    expect(verifiedWords({ verified: 0, skipped: 1, total: 1 })).toBe("1 skipped");
    expect(verifiedWords({ verified: 0, skipped: 2, total: 2 })).toBe("all 2 skipped");
    expect(verifiedWords({ verified: 0, skipped: 3, total: 3 }, "")).toBe("all 3 skipped");
  });

  it("puts a no-break space before each ·, so a wrapped line never starts with one", () => {
    for (const c of [{ verified: 1, skipped: 1, total: 2 }, { verified: 0, skipped: 2, total: 5 }, { verified: 3, skipped: 0, total: 3 }, { verified: 0, skipped: 4, total: 4 }]) {
      expect(verifiedWords(c)).not.toMatch(/ ·/);
      for (const at of [...verifiedWords(c).matchAll(/·/g)].map(m => m.index!)) expect(verifiedWords(c)[at - 1]).toBe("\u00a0");
    }
  });

  it("never calls a returned quest with its only waypoint skipped verified (smoke 6)", async () => {
    for (const [states, words] of [[["skipped"], "returned · 1 skipped"], [["verified", "skipped"], "returned · 1 of 2 verified\u00a0· 1 skipped"], [["skipped", "skipped", "skipped"], "returned · all 3 skipped"], [["verified", "verified"], "returned · 2 of 2 verified"]] as const) {
      const quest = withStates(...states);
      const slot = await mount(() => <QuestRow quest={quest} room={richRoom} registry={registry} keeper={keeper} />);
      await slot.findByRole("button", { name: quest.short });
      expect(slot.container.querySelector(".qrow-f")!.textContent).toBe(words);
      slot.lifecycle.unmount();
    }
  });

  it("gives the tale's path figure the same rule on the agents' waypoints", () => {
    const figure = (quest: ReturnType<typeof withStates>) => taleFigures({ quest: { ...quest, members: [] }, tale: null, memberCredits: [] }).find(f => f.label === "path verified")!.value;
    expect(figure(withStates("verified", "skipped"))).toBe("1 of 2\u00a0· 1 skipped");
    expect(figure(withStates("skipped", "skipped"))).toBe("all 2 skipped");
    expect(figure(withStates("skipped"))).toBe("1 skipped");
    expect(figure(withStates("verified", "reported"))).toBe("1 of 2");
  });
});
