// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadDecor } from "../../../src/shared/contract";
import { CUE_MS } from "../../../src/ui/engine/art";
import { BUBBLE_MS } from "../../../src/ui/engine/speech";
import * as engine from "../../../src/ui/engine/scheduler";
import { fakeEngineClock } from "./fake-clock";
import { motion } from "../../../src/ui/kit/motion";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { EvidenceList } from "../../../src/ui/kit";
import { ReportCard } from "../../../src/ui/thread/cards";
import { fixtureBoard, fixtureDecor, fixtureMember, fixtureRegistry, fixtureReport } from "../../../src/ui/thread/fixtures";
import { installAnimations } from "../kit/motion-fakes";

type Request = { kind: "click" | "ambient"; at: number };
const socket = vi.hoisted(() => ({ send: vi.fn<(request: Request) => void>(), onLine: undefined as undefined | ((line: { revision: string; text: string; receivedAt: number; request?: Request }) => void) }));
vi.mock("../../../src/ui/engine/dialogue-socket", () => ({
  DialogueSocket: ({ onLine, request }: { onLine: NonNullable<typeof socket.onLine>; request?: Request }) => {
    socket.onLine = onLine;
    if (request) socket.send(request);
    return null;
  },
}));

let fx: ReturnType<typeof installAnimations>;
const rect = new DOMRect(8, 8, 360, 64);
beforeEach(() => {
  motion.reset();
  socket.send.mockClear();
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
const shortQuest = { ...fixtureBoard, short: "Stone Gate" };
const says = { working: ["Lantern high.", "Good footing."], verified: ["{checker} set a seal for {waypoint} in {quest}."], wrap: ["{quest} ends by the hearth."], greet: ["The lantern is ready."], reported: ["Road clear."] };

async function widget(patch: Partial<ThreadDecor> = {}, activeThread = "keeper-1") {
  let data: ThreadDecor = {
    ...fixtureDecor,
    member: { ...fixtureMember, role: "member", state: "working", waypointId: "w1" },
    keeperView: null, boardQuest: shortQuest, voice: "full", moodSignals: signals, ...patch,
  };
  const registry = { ...fixtureRegistry, characters: [{ ...fixtureRegistry.characters[0]!, says }] };
  const slot = renderSlot({ component: ThreadWidget }, { threadId: "keeper-1" }, { context: { projectId: "project", threadId: activeThread }, rpc: { decor: () => data, registry: () => registry } });
  const actor = () => slot.container.querySelector<HTMLButtonElement>("[data-actor]");
  const speech = () => slot.container.querySelector<HTMLElement>(".twalk-speech:not([hidden])")?.textContent ?? null;
  await waitFor(() => expect(actor()).not.toBeNull());
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

const oldViolation = { threadId: "keeper-1", providerId: "pi", at: 1, eventId: "past-refusal", seq: 1,
  ruleId: "example-rule", reason: "An earlier command was refused", stopped: true, latencyMs: 1, mode: "enforce" as const };

it("keeps a working member moving with an old scope violation", async () => {
  const w = await widget({ ambientMotion: "lively", violations: [oldViolation] });
  expect(screen.getByRole("button", { name: /^Member, 1 scope alert:/ }).textContent).toContain("1 alert");
  expect(w.actor()?.dataset.mood).toBe("working");
  expect(w.actor()?.closest("section")?.hasAttribute("data-light-held")).toBe(false);
  expect(w.actor()?.dataset.activity).toBe("walk");
});

it.each([
  ["idle member", "member", "idle", null],
  ["idle Keeper", "keeper", "idle", null],
  ["idle Keeper in Quiet", "keeper", "idle", 1000],
  ["Keeper in Quiet during an active turn", "keeper", "working", 1000],
] as const)("%s stands in Lively", async (_label, role, state, quietSince) => {
  const keeperView = role === "keeper" ? { ...fixtureDecor.keeperView!, quietSince, openAsks: [], boardQuests: [] } : null;
  const w = await widget({ ambientMotion: "lively", keeperView, member: { ...fixtureMember, role, state } });
  expect(w.actor()?.dataset.activity).toBe("stand");
  expect(w.actor()?.dataset.mood).toBe("idle");
});

it("holds a working member for an open scope blocker and releases it after the answer", async () => {
  const hold = { openScopeAsk: true };
  const w = await widget({ ambientMotion: "lively", ...hold });
  expect(w.actor()?.dataset.activity).toBe("stand");
  expect(w.actor()?.closest("section")?.dataset.lightHeld).toBe("true");
  const answered = { openScopeAsk: false, violations: [oldViolation] };
  await w.update(answered);
  expect(w.actor()?.dataset.activity).toBe("walk");
  expect(w.actor()?.closest("section")?.hasAttribute("data-light-held")).toBe(false);
});

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
    expect(w.speech()).toBe("Vex set a seal for Stone Bridge in Stone Gate.");
    await tick(BUBBLE_MS);
    expect(w.speech()).toBeNull();
  });

  it("uses one decorative canned fallback for a watched contextual event and never replays it", async () => {
    const scene = { revision: "first", at: Date.now() - 10, role: "smith", stage: "work", activity: "unknown", moment: "assignment", posture: "clear" } as const;
    const w = await widget({ contextualSpeech: true, stripScene: scene });
    vi.useFakeTimers();
    await tick(30_000);
    expect(w.speech()).toBeNull();
    await w.update({ stripScene: { ...scene, revision: "second", at: Date.now() } });
    await tick(1_498);
    expect(w.speech()).toBeNull();
    await tick(1);
    expect(says.working).toContain(w.speech());
    expect(w.actor()?.closest("section")?.querySelector(".twalk-speech")?.getAttribute("aria-hidden")).toBe("true");
    await tick(8_000);
    expect(says.working).toContain(w.speech());
    await act(async () => socket.onLine?.({ revision: "second", text: "The anvil awaits.", receivedAt: Date.now() }));
    expect(w.speech()).toBe("The anvil awaits.");
    await tick(BUBBLE_MS - 1);
    expect(w.speech()).toBe("The anvil awaits.");
    await tick(1);
    expect(w.speech()).toBeNull();
    await act(async () => socket.onLine?.({ revision: "second", text: "The road is clear.", receivedAt: Date.now() }));
    await w.update({ pendingEvents: 3 });
    expect(w.speech()).toBeNull();
    w.click();
    await tick(1_500);
    expect(says.working).toContain(w.speech());
    expect(w.actor()?.closest("section")?.querySelector(".twalk-speech")?.getAttribute("role")).toBe("status");
  });

  it("closes a pending fallback by ten seconds and drops a late reply", async () => {
    const scene = { revision: "first", at: Date.now() - 10, role: "smith", stage: "work", activity: "unknown", moment: "assignment", posture: "clear" } as const;
    const w = await widget({ contextualSpeech: true, stripScene: scene });
    vi.useFakeTimers();
    await w.update({ stripScene: { ...scene, revision: "second", at: Date.now() } });
    await tick(9_998);
    expect(w.speech()).not.toBeNull();
    await tick(2);
    expect(w.speech()).toBeNull();
    await act(async () => socket.onLine?.({ revision: "second", text: "The anvil awaits.", receivedAt: Date.now() }));
    expect(w.speech()).toBeNull();
  });

  it("gives a canned revisit remark its full time from the first visible draw", async () => {
    const clock = fakeEngineClock();
    vi.spyOn(engine, "observeWorld").mockImplementation((_, candidate) => {
      const handle = clock.scheduler.register(candidate);
      handle.setVisible(true);
      return handle;
    });
    const w = await widget({ ambientMotion: "lively", repeatSeconds: 120, stripScene: {
      revision: "work", at: null, role: "smith", stage: "work", activity: "make", moment: "none", posture: "clear",
      road: { key: "quest-a", current: "forge", places: [
        { id: "plan", kind: "plan", state: "done" }, { id: "forge", kind: "make", state: "active" },
      ] },
    } });
    vi.useFakeTimers();
    await w.update({ speechGapMinutes: 1 });
    for (let elapsed = 0; elapsed < 85_000 && w.actor()?.dataset.activity !== "walk"; elapsed += 100) await tick(100);
    expect(w.actor()?.dataset.activity).toBe("walk");
    expect(w.speech()).toBeNull();
    await tick(3_600);
    act(() => clock.advance(216));
    expect(w.actor()?.style.transform).toMatch(/^translate\(52px,/);
    expect(says.working).toContain(w.speech());
    await tick(BUBBLE_MS - 1);
    expect(says.working).toContain(w.speech());
    await tick(1);
    expect(w.speech()).toBeNull();
  });

  it.each([false, true])("uses the ambient cadence when contextual speech is %s", async contextualSpeech => {
    const w = await widget({ contextualSpeech, ambientMotion: "off",
      stripScene: { revision: "neutral", at: null, role: "smith", stage: "neutral", activity: "unknown", moment: "none", posture: "clear" } });
    vi.useFakeTimers();
    await w.update({ speechGapMinutes: 1 });
    await tick(35_000);
    expect(w.speech()).toBeNull();
    // The longest ambient gap is 84 seconds, plus up to 1.5 seconds for the contextual fallback.
    for (let elapsed = 35_000; elapsed < 86_000 && !w.speech(); elapsed += 500) await tick(500);
    expect(says.working).toContain(w.speech());
    if (contextualSpeech) {
      const request = socket.send.mock.lastCall?.[0];
      expect(request).toEqual({ kind: "ambient", at: expect.any(Number) });
      await tick(5_000);
      await act(async () => socket.onLine?.({ revision: "neutral", text: "The anvil awaits.", receivedAt: Date.now(), request }));
      expect(w.speech()).toBe("The anvil awaits.");
    } else {
      expect(socket.send).not.toHaveBeenCalled();
      await tick(BUBBLE_MS);
      expect(w.speech()).toBeNull();
    }
  });

  it.each(["hidden window", "another thread"] as const)("does not request Pi for %s", async situation => {
    const w = await widget({ contextualSpeech: true, ambientMotion: "off", stripScene: {
      revision: "neutral", at: null, role: "smith", stage: "neutral", activity: "unknown", moment: "none", posture: "clear",
    } }, situation === "another thread" ? "other-thread" : "keeper-1");
    vi.useFakeTimers();
    if (situation === "hidden window") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    w.click();
    expect(socket.send).not.toHaveBeenCalled();
    if (situation === "another thread") expect(says.working).toContain(w.speech());
    await tick(BUBBLE_MS);
    expect(w.speech()).toBeNull();
    await w.update({ speechGapMinutes: 1 });
    for (let elapsed = 0; elapsed < 84_000 && !w.speech(); elapsed += 500) await tick(500);
    if (situation === "another thread") expect(says.working).toContain(w.speech());
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("shows a fast reply directly instead of exposing or announcing the canned line", async () => {
    const w = await widget({ contextualSpeech: true, stripScene: {
      revision: "neutral", at: null, role: "smith", stage: "neutral", activity: "unknown", moment: "none", posture: "clear",
    } });
    vi.useFakeTimers();
    w.click();
    const request = socket.send.mock.lastCall?.[0];
    expect(request).toEqual({ kind: "click", at: expect.any(Number) });
    expect(w.speech()).toBeNull();
    await tick(1_499);
    expect(w.speech()).toBeNull();
    await act(async () => socket.onLine?.({ revision: "neutral", text: "The anvil awaits.", receivedAt: Date.now(), request }));
    expect(w.speech()).toBe("The anvil awaits.");
    await tick(1);
    expect(w.speech()).toBe("The anvil awaits.");
  });

  it("replaces the latest clicked bubble with Pi's reply and keeps its status announcement", async () => {
    const w = await widget({ contextualSpeech: true, stripScene: {
      revision: "neutral", at: null, role: "smith", stage: "neutral", activity: "unknown", moment: "none", posture: "clear",
    } });
    vi.useFakeTimers();
    w.click();
    expect(w.speech()).toBeNull();
    const first = socket.send.mock.lastCall?.[0];
    expect(first).toEqual({ kind: "click", at: expect.any(Number) });
    await tick(1_000);
    w.click();
    const request = socket.send.mock.lastCall?.[0];
    expect(request).toEqual({ kind: "click", at: expect.any(Number) });
    expect(request).not.toEqual(first);
    await tick(5_000);
    await act(async () => socket.onLine?.({ revision: "neutral", text: "This reply was for the first click.", receivedAt: Date.now(), request: first }));
    expect(says.working).toContain(w.speech());
    await act(async () => socket.onLine?.({ revision: "neutral", text: "The anvil awaits.", receivedAt: Date.now(), request }));
    expect(w.speech()).toBe("The anvil awaits.");
    expect(w.actor()?.closest("section")?.querySelector(".twalk-speech")?.getAttribute("role")).toBe("status");
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
    const mountReading = () => {
      if (kind === "evidence") return render(<EvidenceList evidence={fixtureReport.evidence} />).unmount;
      const slot = renderSlot({ component: () => <ReportCard report={{ ...fixtureReport, createdAt: Date.now() - 120_000 }} /> }, {}, {});
      return () => slot.lifecycle.unmount();
    };
    const unmountReading = mountReading();
    vi.useFakeTimers();
    await w.verify();
    await act(async () => { fx.all.at(-1)?.finish(); });
    await tick(1_000);
    expect(w.speech()).toBeNull();
    w.click();
    expect(w.speech()).toBe("Vex set a seal for Stone Bridge in Stone Gate.");
    unmountReading();
    await tick(BUBBLE_MS);
    await w.update({ boardQuest: { ...shortQuest, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Stone Gate ends by the hearth.");
    const unmountNextReading = mountReading();
    await act(async () => {});
    expect(w.speech()).toBeNull();
    unmountNextReading();
  });

  it("uses report delivery time for the one-minute hold even offscreen", async () => {
    const w = await widget({ voice: "light" });
    vi.useFakeTimers();
    const now = Date.now();
    const reading = renderSlot({ component: () => <div data-tavern-report-thread="keeper-1"><ReportCard report={{ ...fixtureReport, createdAt: now - 120_000, deliveredAt: now }} /></div> }, {}, {});
    const card = reading.container.querySelector("article")!;
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -280, 360, 64));
    await w.verify();
    await act(async () => { fx.all.at(-1)?.finish(); });
    await tick(1_000);
    expect(w.speech()).toBeNull();
    await tick(60_000 - (Date.now() - now));
    await w.update({ boardQuest: { ...shortQuest, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Stone Gate ends by the hearth.");
    reading.lifecycle.unmount();
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
    await w.update({ boardQuest: { ...shortQuest, phase: "done", endedAt: Date.now() } });
    await tick(1);
    expect(w.speech()).toBe("Stone Gate ends by the hearth.");
  });
});
