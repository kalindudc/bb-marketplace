// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PhaseMark, PhaseStrip, QuestRow, characterName, isFinished, phaseWord, questMove } from "../../../src/ui/kit";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureLedger, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { registry, richRoom } from "../page/scenes";

afterEach(cleanup);
const keeper = { ...richRoom.keepers[0]!, archived: false };
const live = keeper.boardQuests.find(q => q.phase !== "done" && q.phase !== "stopped")!;
const names = { keeper: characterName(registry, keeper.member), member: (m: Parameters<typeof characterName>[1]) => characterName(registry, m) };

describe("a stopping quest", () => {
  it("says Stopping with how many stops are unconfirmed, ahead of any ask or next step", () => {
    const asks = richRoom.asks.map(a => ({ ...a, boardQuestId: live.id, state: "open" as const }));
    expect(questMove({ ...live, phase: "stopping", stopUnconfirmed: 2 }, asks, names)).toEqual({ tone: "bad", who: "Stopping", next: "2 not confirmed; Tavern retries" });
    expect(questMove({ ...live, phase: "stopping", stopUnconfirmed: 0 }, [], names).next).toBe("confirming");
    expect(questMove({ ...live, phase: "stopping" }, [], names, { keeperArchived: true }).who).toBe("Stopping");
    expect(isFinished("stopping")).toBe(false);
    expect(phaseWord("stopping")).toBe("Stopping");
  });

  it("strikes the phase marks and names no step", () => {
    const { container } = render(<><PhaseMark phase="stopping" tone="bad" /><PhaseStrip phase="stopping" /><PhaseStrip phase="stopped" /></>);
    const [mark, strip, stopped] = [...container.querySelectorAll("[role=img]")];
    expect([...mark!.querySelectorAll("i")].every(i => i.classList.contains("s"))).toBe(true);
    expect(mark!.getAttribute("aria-label")).toBe("Phase: Stopping");
    expect([...strip!.querySelectorAll("i")].every(i => i.classList.contains("s"))).toBe(true);
    expect(strip!.getAttribute("aria-label")).toBe("Phase: stopping");
    expect(stopped!.getAttribute("aria-label")).toBe("Phase: stopped");
  });

  it("stays a live row with the stopping words, no Cellar and no new-work mark", async () => {
    const quest = { ...live, phase: "stopping" as const, stopUnconfirmed: 1, updatedAt: Date.now() };
    const app = await loadPluginApp(definePluginApp(a => { a.slots.navPanel({ id: "probe", title: "Probe", path: "probe", icon: "list", component: () => <QuestRow quest={quest} room={{ asks: [] }} registry={registry} keeper={keeper} onArchive={() => {}} arrival={{ since: 0 }} /> } as never); }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {});
    await slot.findByRole("button", { name: quest.short });
    const row = slot.container.querySelector(".qrow")!;
    expect(row.getAttribute("data-variant")).toBe("stopping");
    expect(row.querySelector(".qrow-m")!.textContent).toBe("Stopping · 1 not confirmed; Tavern retries");
    expect(row.querySelector(".qrow-x")).toBeNull();
    expect(row.querySelector(".arrival-mark")).toBeNull();
  });

  it("reads Stopping in the Ledger, not the server's next step", async () => {
    const ledger = { ...fixtureLedger, boardQuests: [{ ...fixtureQuest, phase: "stopping" as const, stopUnconfirmed: 1 }] };
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: { ledger: () => ledger, decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    const line = await slot.findByText("1 not confirmed; Tavern retries");
    expect(line.closest(".lg-move")!.querySelector(".lbl")!.textContent).toBe("Stopping");
  });
});
