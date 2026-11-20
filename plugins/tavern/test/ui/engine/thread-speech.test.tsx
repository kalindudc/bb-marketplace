// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDecor } from "../../../src/shared/contract";
import { CUE_MS } from "../../../src/ui/engine/art";
import { BUBBLE_MS } from "../../../src/ui/engine/speech";
import { motion } from "../../../src/ui/kit/motion";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { EvidenceList } from "../../../src/ui/kit";
import { ReportCard } from "../../../src/ui/thread/cards";
import { fixtureBoard, fixtureDecor, fixtureMember, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { installAnimations } from "../kit/motion-fakes";

let fx: ReturnType<typeof installAnimations>;
const rect = new DOMRect(8, 8, 360, 64);
beforeEach(() => {
  motion.reset();
  fx = installAnimations({});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-speech-test]").forEach(el => el.remove());
  motion.reset();
  fx.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const signals = { archived: false, released: false, handBack: false, report: null, verdict: null };
const says = { working: ["Lantern high.", "Good footing."], verified: ["{checker} set a seal for {waypoint} in {quest}."], wrap: ["{quest} ends by the hearth."], greet: ["The lantern is ready."], reported: ["Road clear."] };

async function widget(patch: Partial<ThreadDecor> = {}) {
  let data: ThreadDecor = {
    ...fixtureDecor,
    member: { ...fixtureMember, role: "member", state: "working", waypointId: "w1" },
    keeperView: null, boardQuest: fixtureBoard, voice: "full", moodSignals: signals, ...patch,
  };
  const registry = { ...fixtureRegistry, characters: [{ ...fixtureRegistry.characters[0]!, says }] };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { rpc: { decor: () => data, registry: () => registry } });
  const actor = () => slot.container.querySelector<HTMLButtonElement>("[data-actor]");
  const speech = () => slot.container.querySelector<HTMLElement>(".twalk-speech:not([hidden])")?.textContent ?? null;
  await waitFor(() => expect(slot.container.querySelector(".tw-member-class")).not.toBeNull());
  const update = async (next: Partial<ThreadDecor>) => {
    data = { ...data, ...next };
    await act(async () => {
      await slot.experimental_invalidateRpc(["tavern:thread:keeper-1"]);
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
      else await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  const mood = (state: NonNullable<ThreadDecor["member"]>["state"] | "stopped") => update({ member: { ...data.member!, state: state === "stopped" ? "idle" : state, engagement: state === "stopped" ? "stopped" : "active" } });
  const verify = () => update({ moodSignals: { ...signals, verdict: { status: "verified", at: Date.now(), checkerName: "Vex", waypointTitle: "Stone Bridge" } } });
  const click = () => { fireEvent.click(actor()!); };
  return { actor, speech, update, mood, verify, click };
}

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const external = (tag: string) => {
  const el = document.createElement(tag);
  el.dataset.speechTest = "";
  document.body.append(el);
  return el;
};

describe("thread strip speech", () => {
  it("uses failed activity for error, but sends stopped and released actors off the strip", async () => {
    const w = await widget();
    await w.mood("failed");
    expect(w.actor()?.dataset.mood).toBe("error");
    await w.mood("stopped");
    expect(w.actor()).toBeNull();
    await w.mood("failed");
    await w.update({ moodSignals: { ...signals, released: true } });
    expect(w.actor()).toBeNull();
  });

  it("shows one state-filled verified line 1 second after the real cue ends", async () => {
    const w = await widget({ voice: "light" });
    vi.useFakeTimers();
    await w.verify();
    await tick(0);
    expect(w.actor()?.dataset.mood).toBe("verified");
    const cue = fx.all.at(-1)!;
    expect(cue.duration).toBe(CUE_MS.flourish);
    await tick(CUE_MS.flourish + 1_000);
    expect(w.speech()).toBeNull();
    await act(async () => { cue.finish(); });
    await tick(999);
    expect(w.speech()).toBeNull();
    await tick(1);
    expect(w.speech()).toBe("Vex set a seal for Stone Bridge in Vault cutover.");
    await tick(BUBBLE_MS);
    expect(w.speech()).toBeNull();
  });

  it("speaks on click without repeating after an unrelated widget update", async () => {
    const w = await widget();
    w.click();
    const first = w.speech();
    expect(says.working).toContain(first);
    await w.update({ pendingEvents: 1 });
    w.click();
    expect(says.working.filter(line => line !== first)).toContain(w.speech());
    await w.update({ voice: "off" });
    expect(w.speech()).toBeNull();
    w.click();
    expect(w.speech()).toBeNull();
  });

  it("cuts an existing bubble on typing and on a visible ask without resurfacing it", async () => {
    const w = await widget();
    const field = external("textarea");
    w.click();
    expect(w.speech()).not.toBeNull();
    fireEvent.input(field);
    expect(w.speech()).toBeNull();
    w.click();
    expect(w.speech()).toBeNull();
    vi.spyOn(motion, "getHolds").mockReturnValue({ typing: false, held: false });
    w.click();
    expect(w.speech()).not.toBeNull();
    const ask = external("div");
    ask.dataset.ask = "";
    await waitFor(() => expect(w.speech()).toBeNull());
    w.click();
    expect(w.speech()).toBeNull();
    ask.remove();
    expect(w.speech()).toBeNull();
  });

  it("holds the row and forbids speech in waiting, blocked and error", async () => {
    const w = await widget();
    w.click();
    expect(w.speech()).not.toBeNull();
    const scope = { threadId: "keeper-1", scope: null, error: "Scope alert", armed: false, pendingAskId: null };
    await w.update({ scope });
    expect(w.actor()?.dataset.mood).toBe("working");
    expect(w.speech()).toBeNull();
    w.click();
    expect(w.speech()).toBeNull();
    await w.update({ scope: null, moodSignals: { ...signals, handBack: true } });
    expect(w.actor()?.dataset.mood).toBe("waiting");
    w.click();
    expect(w.speech()).toBeNull();
    await w.update({ moodSignals: { ...signals, report: { status: "blocked", createdAt: Date.now() } } });
    expect(w.actor()?.dataset.mood).toBe("blocked");
    w.click();
    expect(w.speech()).toBeNull();
    await w.mood("failed");
    expect(w.actor()?.dataset.mood).toBe("error");
    w.click();
    expect(w.speech()).toBeNull();
  });

  it("greets a newly arrived member under full voice", async () => {
    const w = await widget();
    vi.useFakeTimers();
    await w.update({ member: { ...fixtureMember, role: "member", state: "working", createdAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("The lantern is ready.");
    await tick(BUBBLE_MS);
    expect(w.speech()).toBeNull();
  });

  it.each(["report", "evidence"] as const)("suppresses and clears automatic speech beside visible %s, but lets a click speak", async kind => {
    const w = await widget({ voice: "light" });
    const mountReading = () => kind === "report"
      ? render(<ReportCard report={{ ...fixtureReport, createdAt: Date.now() - 120_000 }} />)
      : render(<EvidenceList evidence={fixtureReport.evidence} />);
    const reading = mountReading();
    vi.useFakeTimers();
    await w.verify();
    await act(async () => { fx.all.at(-1)?.finish(); });
    await tick(1_000);
    expect(w.speech()).toBeNull();
    w.click();
    expect(w.speech()).toBe("Vex set a seal for Stone Bridge in Vault cutover.");
    reading.unmount();
    await tick(BUBBLE_MS);
    await w.update({ boardQuest: { ...fixtureBoard, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Vault cutover ends by the hearth.");
    mountReading();
    await act(async () => {});
    expect(w.speech()).toBeNull();
  });

  it("uses report delivery time for the one-minute hold even offscreen", async () => {
    const w = await widget({ voice: "light" });
    vi.useFakeTimers();
    const now = Date.now();
    const reading = render(<div data-tavern-report-thread="keeper-1"><ReportCard report={{ ...fixtureReport, createdAt: now - 120_000, deliveredAt: now }} /></div>);
    const card = reading.container.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -280, 360, 64));
    await w.verify();
    await act(async () => { fx.all.at(-1)?.finish(); });
    await tick(1_000);
    expect(w.speech()).toBeNull();
    await tick(60_000 - (Date.now() - now));
    await w.update({ boardQuest: { ...fixtureBoard, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Vault cutover ends by the hearth.");
  });

  it("allows light to speak on click and wrap, not on arrival or a report", async () => {
    const w = await widget({ voice: "light" });
    vi.useFakeTimers();
    await w.update({ member: { ...fixtureMember, role: "member", state: "working", createdAt: Date.now() } });
    await tick(0);
    expect(w.speech()).toBeNull();
    w.click();
    expect(says.working).toContain(w.speech());
    await w.update({ moodSignals: { ...signals, report: { status: "done", createdAt: Date.now() } } });
    await tick(0);
    await act(async () => { fx.all.at(-1)?.finish(); });
    await tick(1_000);
    expect(w.actor()?.dataset.mood).toBe("reported");
    expect(w.speech()).toBeNull();
    await tick(60_000);
    await w.update({ boardQuest: { ...fixtureBoard, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Vault cutover ends by the hearth.");
  });
});
