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
it("uses plan version zero to establish a scouting stop", () => {
  const event = { id: 499, at: railDetail.quest.updatedAt - 100, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.opened", text: "Quest opened", data: {} };
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const, planVersion: 0, greenlitVersion: null }, events: [event] };
  const stop = recordedStop(detail);
  expect(stop).toEqual({ position: "scout", proven: "scout" });
  const slot = render(<PhaseStrip phase="stopped" stoppedAt={stop.position} proven={stop.proven} />);
  expect(slot.getAllByRole("listitem")[0]!.getAttribute("aria-label")).toBe("Rangers out, stopped here");
  expect(slot.queryByText(/position was not recorded/)).toBeNull();
});
it("uses the newest recorded phase belonging to the quest, not an unrelated phase", () => {
  const event = { id: 501, at: railDetail.quest.updatedAt - 100, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.phase", text: "Board quest moved to check", data: {} };
  expect(recordedStop({ ...railDetail, events: [{ ...event, id: 502, boardQuestId: "other", at: event.at + 10, text: "Board quest moved to wrap" }, event] })).toEqual({ position: "check", proven: "check" });
  expect(recordedStop({ ...railDetail, events: [] })).toEqual({ position: null, proven: null });
});
it("uses receipt order when two phase moves share a timestamp", () => {
  const event = { id: 600, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.phase", text: "Board quest moved to build", data: { phase: "build" } };
  expect(recordedStop({ ...railDetail, events: [event, { ...event, id: 601, text: "Board quest moved to check", data: { phase: "check" } }] })).toEqual({ position: "check", proven: "check" });
});
it("does not treat an unscoped phase event or a phase recorded after stopping as proof", () => {
  const event = { id: 601, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: null, actor: { kind: "tavern" as const }, type: "quest.phase", text: "Board quest moved to check", data: {} };
  expect(recordedStop({ ...railDetail, events: [event] })).toEqual({ position: null, proven: null });
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const, endedAt: railDetail.quest.updatedAt }, events: [{ ...event, boardQuestId: railDetail.quest.id, at: railDetail.quest.updatedAt + 10 }] };
  expect(recordedStop(detail)).toEqual({ position: null, proven: null });
});
it.each([["scout", 0, null], ["greenlight", 1, null], ["build", 1, 1], ["check", 1, 1]] as const)("derives a legacy %s stop from the record and eligible phase receipts without an opening", (phase, planVersion, greenlitVersion) => {
  const event = { id: 700, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.phase", text: "Board quest moved to check", data: {} };
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const, planVersion, greenlitVersion }, events: phase === "check" ? [event] : [], asks: phase === "greenlight" ? [{ ...railDetail.asks[0]!, kind: "greenlight" as const, state: "open" as const, planVersion, createdAt: event.at }] : [] };
  const stop = recordedStop(detail);
  expect(stop).toEqual({ position: phase, proven: phase });
  const slot = render(<PhaseStrip phase="stopped" stoppedAt={stop.position} proven={stop.proven} />);
  expect(slot.getByRole("listitem", { name: /stopped here/ }).getAttribute("aria-label")).toContain(phase === "scout" ? "Rangers out" : phase === "greenlight" ? "Form the party" : phase === "build" ? "Build" : "Warden's trial");
});
it.each(["scout", "greenlight", "build", "check"] as const)("uses the recorded %s phase before stopping rather than stale phase or plan evidence", phase => {
  const event = { id: 800, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.phase", text: "Board quest moved to wrap", data: {} };
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const }, events: [event, { ...event, id: 801, type: "quest.stopping", data: { phaseBeforeStop: phase } }] };
  expect(recordedStop(detail)).toEqual({ position: phase, proven: phase });
});
it.each([null, 1])("does not guess greenlight or build from approval version %s for a newer plan", greenlitVersion => {
  expect(recordedStop({ ...railDetail, quest: { ...railDetail.quest, phase: "stopped", planVersion: 3, greenlitVersion }, events: [], asks: [] })).toEqual({ position: null, proven: null });
});
it.each(["open", "withdrawn"] as const)("uses a current-plan greenlight ask that was %s at the stop", state => {
  const detail = { ...railDetail, quest: { ...railDetail.quest, phase: "stopped" as const, planVersion: 2, greenlitVersion: 1 }, events: [], asks: [{ ...railDetail.asks[0]!, kind: "greenlight" as const, state, planVersion: 2, createdAt: railDetail.quest.updatedAt - 10, withdrawnCause: "quest-stopped" as const }] };
  expect(recordedStop(detail)).toEqual({ position: "greenlight", proven: "greenlight" });
});
it.each(["older-plan", "answered", "superseded", "future", "missing-version"] as const)("rejects a %s greenlight ask as stop evidence", invalid => {
  const ask = { ...railDetail.asks[0]!, kind: "greenlight" as const, state: "open" as "open" | "answered" | "withdrawn", planVersion: invalid === "older-plan" ? 1 : invalid === "missing-version" ? undefined : 2, createdAt: railDetail.quest.updatedAt - 10, withdrawnCause: "plan-superseded" as const };
  if (invalid === "answered") ask.state = "answered";
  if (invalid === "superseded") ask.state = "withdrawn";
  if (invalid === "future") ask.createdAt = railDetail.quest.updatedAt + 10;
  expect(recordedStop({ ...railDetail, quest: { ...railDetail.quest, phase: "stopped", planVersion: 2, greenlitVersion: null }, events: [], asks: [ask] })).toEqual({ position: null, proven: null });
});
it.each(["check", "wrap"] as const)("uses an eligible %s receipt even when the approval does not match", phase => {
  const event = { id: 900, at: railDetail.quest.updatedAt - 10, keeperThreadId: railDetail.quest.keeperThreadId, boardQuestId: railDetail.quest.id, actor: { kind: "tavern" as const }, type: "quest.phase", text: `Board quest moved to ${phase}`, data: { phase } };
  expect(recordedStop({ ...railDetail, quest: { ...railDetail.quest, phase: "stopped", planVersion: 2, greenlitVersion: null }, events: [event], asks: [] })).toEqual({ position: phase, proven: phase });
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
