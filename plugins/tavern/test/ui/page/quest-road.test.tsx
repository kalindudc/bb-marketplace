import { cleanup, render, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { Phase } from "../../../src/shared/schema";
import { SkPhaseStrip } from "../../../src/ui/kit";
import { PhaseStrip } from "../../../src/ui/page/common";
import { recordedStop } from "../../../src/ui/page/quest-road";
import { railDetail } from "./quest-rail-fixture";

afterEach(cleanup);
it.each(["scout", "greenlight", "build", "check", "wrap"] as Phase[])("marks %s current with earlier stops done and later ones not reached", phase => {
  const order = ["scout", "greenlight", "build", "check", "wrap"];
  const slot = render(<PhaseStrip phase={phase} />);
  const list = slot.getByRole("list", { name: /Quest road/ });
  const stops = within(list).getAllByRole("listitem");
  expect(stops).toHaveLength(5);
  stops.forEach((stop, i) => {
    expect(stop.getAttribute("aria-label")).toContain(i < order.indexOf(phase) ? "done" : i === order.indexOf(phase) ? "current" : "not reached");
    expect(stop.getAttribute("aria-current")).toBe(i === order.indexOf(phase) ? "step" : null);
  });
});
it.each(["build", "done", "stopped"] as Phase[])("prints each %s road label with only the parentheses supplied by anc", phase => {
  const slot = render(<PhaseStrip phase={phase} stoppedAt={phase === "stopped" ? "check" : null} />);
  const css = readFileSync("src/ui/kit/tavern.css", "utf8");
  expect(css).toContain('.anc::before { content: "("; }');
  expect(css).toContain('.anc::after { content: ")"; }');
  const labels = [...slot.container.querySelectorAll(".tv-phase-road-label")];
  const anchors = labels.flatMap(label => [...label.querySelectorAll(".anc")]);
  expect(anchors.map(anchor => anchor.textContent)).toEqual(["scout", "greenlight", "check", "wrap"]);
  for (const label of labels) {
    const anchor = label.querySelector(".anc");
    const paintedText = anchor ? label.textContent!.replace(anchor.textContent!, `(${anchor.textContent})`) : label.textContent!;
    expect(paintedText).not.toContain("((");
    expect(paintedText).not.toContain("))");
  }
});
it("marks all returned stops done and lights the last hearth", () => {
  const slot = render(<PhaseStrip phase="done" />);
  const stops = slot.getAllByRole("listitem");
  expect(stops.every(s => s.getAttribute("aria-label")!.endsWith(", done"))).toBe(true);
  expect(stops[4]!.classList.contains("current")).toBe(true);
  expect(stops[4]!.querySelector(".tv-g-road-hearth")).not.toBeNull();
});
it.each(["build", "check"] as Phase[])("puts the stopped barrier at the recorded %s stop", stoppedAt => {
  const slot = render(<PhaseStrip phase="stopped" stoppedAt={stoppedAt} />);
  const stop = slot.getByRole("listitem", { name: /stopped here/ });
  expect(stop.classList.contains("barrier")).toBe(true);
  expect(stop.getAttribute("aria-label")).toContain(stoppedAt === "build" ? "Build" : "Warden's trial");
  expect(stop.getAttribute("aria-current")).toBe("step");
});
it("keeps the position unknown when opening and phase receipts are absent", () => {
  const slot = render(<PhaseStrip phase="stopped" />);
  expect(slot.getByText("Stopped; the stop's position was not recorded")).toBeTruthy();
  expect(slot.container.querySelector(".barrier")).toBeNull();
  expect(slot.getAllByRole("listitem").every(s => s.getAttribute("aria-label")!.includes("not reached"))).toBe(true);
});
it.each(["scout", "greenlight", "build", "check", "wrap"] as const)("uses only data.phase for a recorded %s stop", phase => {
  const event = { id: 800, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "user" as const }, type: "quest.stopping", text: "Stop", data: { phase: { from: phase, to: "stopping" } } };
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const }, events: [event] };
  expect(recordedStop(detail)).toEqual({ position: phase, proven: phase });
});
it.each(["scout", "greenlight", "build", "check", "wrap"] as const)("does not infer an old %s phase from text, plans, asks or phaseBeforeStop", phase => {
  const event = { id: 800, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "user" as const }, type: "quest.stopping", text: `Board quest moved to ${phase}`, data: { phaseBeforeStop: phase } };
  expect(recordedStop({ ...railDetail, quest: { ...railDetail.quest, phase: "stopped", planVersion: phase === "scout" ? 0 : 1, greenlitVersion: 1 }, events: [event] })).toEqual({ position: null, proven: null });
});
it("uses receipt order, excluding unrelated and future receipts", () => {
  const event = { id: 800, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "user" as const }, type: "plan.proposed", text: "Plan", data: { phase: { from: "scout", to: "greenlight" } } };
  const events = [event, { ...event, id: 801, data: { phase: { from: "greenlight", to: "build" } } }, { ...event, id: 802, boardQuestId: "other", data: { phase: { from: "build", to: "closing" } } }, { ...event, id: 803, at: railDetail.quest.updatedAt + 1, data: { phase: { from: "build", to: "closing" } } }];
  expect(recordedStop({ ...railDetail, quest: { ...railDetail.quest, phase: "stopped", stoppingSince: railDetail.quest.updatedAt }, events })).toEqual({ position: "build", proven: "build" });
});
it("keeps only the current narrow label visible, with all five accessible and no motion", () => {
  const css = readFileSync("src/ui/page/page.css", "utf8");
  expect(css).toMatch(/@container tavern-page \(max-width: 560px\)\s*\{[^}]*\.tv-phase-road > li:not\(\.current\) \.tv-phase-road-label\s*\{ visibility: hidden;/);
  const roadRules = css.slice(css.indexOf(".tavern.tv-page .tv-phase-road {"));
  expect(roadRules).not.toMatch(/animation|transition/);
});
it("the road skeleton preserves five markers and label spaces without content or controls", () => {
  const slot = render(<SkPhaseStrip road />);
  expect(slot.container.querySelectorAll(".tv-phase-road-marker")).toHaveLength(5);
  expect(slot.container.querySelectorAll(".tv-phase-road-label")).toHaveLength(5);
  expect(slot.container.querySelector(".tv-phase-road")!.getAttribute("aria-hidden")).toBe("true");
  expect(slot.queryByRole("button")).toBeNull();
});
