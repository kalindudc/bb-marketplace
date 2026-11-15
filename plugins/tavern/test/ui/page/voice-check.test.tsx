import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract } from "../../../src/shared/contract";
import type { VoiceCheck, VoiceCheckView } from "../../../src/shared/voice-check";
import { detail, registry, room } from "../../../src/ui/page/fixtures";
import { registerPageSurfaces } from "../../../src/ui/page/register";

const slots: RenderedSlot[] = [];
afterEach(() => { for (const s of slots.splice(0)) s.lifecycle.unmount(); });
beforeEach(() => window.localStorage.clear());
type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

const wren = registry.characters.find((c) => c.id === "wren")!;
const NOW = Date.now();
const situation = (id: VoiceCheck["situations"][number]["id"], title: string, failures: VoiceCheck["situations"][number]["failures"] = []) => ({ id, title, pass: failures.length === 0, failures, answer: JSON.stringify({ outcome: `${title} answer` }, null, 2) });
const five = () => [situation("blocker", "A blocker"), situation("ask", "An ask with options"), situation("failed", "A failed check"), situation("report", "A report with evidence"), situation("wrap", "A wrap")];
const check = (over: Partial<VoiceCheck> = {}): VoiceCheck => ({ id: "vc_1", characterId: "wren", draft: { name: wren.name, style: wren.style }, state: "passed", startedAt: NOW - 30_000, finishedAt: NOW - 5_000,
  writer: { providerId: "pi", model: "gpt-5.1" }, judge: { providerId: "pi", model: "claude-haiku-4-5" }, tone: "judged", situations: five(), reason: null, cost: { usd: 0.024, tokens: 132_000 }, ...over });
const view = (history: VoiceCheck[] = [], over: Partial<VoiceCheckView> = {}): VoiceCheckView => ({ history, running: history.find((h) => h.state === "running") ?? null, cap: { used: history.length, max: 10, nextAt: null }, ...over });

async function editor(rpc: Partial<Handlers> = {}, voice?: "full" | "light" | "off") {
  const plugin = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const slot = renderSlot(plugin.navPanels[0]!, { subPath: "character/wren" }, { pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: { room: () => structuredClone(room), registry: () => ({ ...structuredClone(registry), ...(voice ? { voice } : {}) }), boardQuest: () => structuredClone(detail), voiceCheck: () => view(), ...rpc } as Handlers });
  slots.push(slot);
  fireEvent.click(await slot.findByRole("button", { name: /Edit Wren's voice/ }));
  await slot.findByRole("form", { name: "Edit Wren's voice" });
  return slot;
}
const box = async (slot: RenderedSlot) => slot.findByRole("region", { name: "Voice check" });

describe("the voice check in the voice editor", () => {
  it("says the draft isn't checked yet, and no longer claims no check exists", async () => {
    const slot = await editor();
    const b = await box(slot);
    expect(b.textContent).toContain("Not checked yet. Run the check to try this voice on five situations.");
    expect(within(b).getByRole("button", { name: "Run check" })).toBeTruthy();
    expect(slot.container.textContent).not.toMatch(/No automatic voice check|not a passed voice check/);
  });

  it("runs the draft as edited, not as saved, and shows it running with Cancel", async () => {
    let state = view();
    const start = vi.fn((input: { characterId: string; draft: { name: string; style: string; quirks: string[] } }) => { state = view([check({ state: "running", finishedAt: null, judge: null, tone: null, situations: [], cost: null, draft: { name: input.draft.name, style: input.draft.style } })]); return state; });
    const cancel = vi.fn((_input: { characterId: string; runId: string }) => state);
    const slot = await editor({ voiceCheck: () => state, voiceCheckStart: start, voiceCheckCancel: cancel });
    fireEvent.change(slot.getByRole("textbox", { name: "Voice style" }), { target: { value: "Tides and bearings." } });
    fireEvent.click(within(await box(slot)).getByRole("button", { name: "Run check" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toEqual({ characterId: "wren", draft: { name: "Wren", style: "Tides and bearings.", quirks: wren.quirks } });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toMatch(/Checking 5 situations on gpt-5\.1…\u00a0\d+\u00a0s/));
    fireEvent.click(within(b).getByRole("button", { name: "Cancel check" }));
    await waitFor(() => expect(cancel.mock.calls[0]?.[0]).toEqual({ characterId: "wren", runId: "vc_1" }));
  });

  it("says a result was checked in full voice when the setting is Light or Off, and says nothing extra in Full", async () => {
    for (const [voice, word] of [["light", "Light"], ["off", "Off"]] as const) {
      const slot = await editor({ voiceCheck: () => view([check()]) }, voice);
      const b = await box(slot);
      await waitFor(() => expect(b.querySelector("[data-full-voice]")?.textContent).toBe(`Checked in full voice, the strictest case; your setting is ${word}.`), { timeout: 3000 });
      slot.lifecycle.unmount();
    }
    for (const voice of ["full", undefined] as const) {
      const slot = await editor({ voiceCheck: () => view([check()]) }, voice);
      const b = await box(slot);
      await waitFor(() => expect(b.textContent).toMatch(/passed|Passed/), { timeout: 3000 });
      expect(b.querySelector("[data-full-voice]")).toBeNull();
      slot.lifecycle.unmount();
    }
    // A check that couldn't run tested nothing, so it claims no voice.
    const failedRun = await editor({ voiceCheck: () => view([check({ state: "couldnt-run", reason: "provider", situations: [], judge: null, tone: null })]) }, "off");
    const fb = await box(failedRun);
    await waitFor(() => expect(fb.querySelector(".vc-line")).not.toBeNull(), { timeout: 3000 });
    expect(fb.querySelector("[data-full-voice]")).toBeNull();
  });

  it("shows a pass with the model, when, and what it cost", async () => {
    const slot = await editor({ voiceCheck: () => view([check()]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Voice check passed · 5 of 5 · gpt-5.1 · just now"));
    expect(b.textContent).toContain("Tone judged by claude-haiku-4-5.");
    expect(b.textContent).not.toContain("rules only");
    expect(b.textContent).toContain("Cost $0.024 · 132,000 tokens");
  });

  it("names the writer and the judge as bb's model picker does, with the raw ids in the title", async () => {
    const slot = await editor({ voiceCheck: () => view([check({ writer: { providerId: "pi", model: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" }, judge: { providerId: "pi", model: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" },
      judgeNote: "Judge Gemini 3.5 Flash-Lite (pi): a small model from another family (google) than the writer's (anthropic)." })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Voice check passed · 5 of 5 · Claude Opus 5.5 · just now"));
    expect(b.textContent).not.toContain("anthropic/claude-opus-5-5");
    expect(b.textContent).not.toContain("google/gemini-3.5-flash-lite");
    expect([...b.querySelectorAll(".vc-line > span")].find((x) => x.textContent!.startsWith("Voice check passed"))!.getAttribute("title")).toBe("Writer: anthropic/claude-opus-5-5 (pi)");
    expect([...b.querySelectorAll(".vc-note")].find((n) => n.textContent!.startsWith("Judge Gemini"))!.getAttribute("title")).toBe("Judge: google/gemini-3.5-flash-lite (pi)");
  });

  it("says a pass rests on rules only when no judge model was available", async () => {
    const slot = await editor({ voiceCheck: () => view([check({ judge: null, tone: "not-judged", judgeNote: "Tone not judged: no small model from another family than the writer's (openai) is offered.", cost: { usd: null, tokens: 66_000 } })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Voice check passed on rules only: tone not judged · 5 of 5 · gpt-5.1 · just now"));
    expect(b.textContent).toContain("Tone not judged: no small model from another family than the writer's (openai) is offered.");
    expect(b.textContent).toContain("66,000 tokens · cost not recorded");
  });

  it("lists each failed situation with the rule and the quoted words, opening the answer in place", async () => {
    const failed = five();
    failed[0] = situation("blocker", "A blocker", [{ rule: "style-word", field: "outcome", quote: "bearings" }]);
    failed[2] = situation("failed", "A failed check", [{ rule: "tone", field: "failed", quote: "alas, the tests have fallen" }]);
    const slot = await editor({ voiceCheck: () => view([check({ state: "failed", situations: failed })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Voice check failed · 3 of 5 passed"));
    const rows = [...b.querySelectorAll<HTMLButtonElement>(".vc-fail > button")];
    expect(rows.map((r) => r.textContent)).toEqual(["A blocker: the style's own words in outcome: “bearings”", "A failed check: not plain and calm: “alas, the tests have fallen”"]);
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rows[0]!);
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(b.querySelector(".vc-ans")!.textContent).toContain("A blocker answer");
  });

  it("draws a failed answer as labelled lines, marking the failed words and dimming what runs past the limit, with the raw JSON one fold away", async () => {
    const outcome = "npm ci exits 1 with E403 for @shop/vault-saturn. Our bearings are lost in the tides, and the registry token in ~/.npmrc has expired, so the dependencies cannot be installed until someone with registry access renews the token for us today.";
    const blocker = { ...situation("blocker", "A blocker", [{ rule: "style-word", field: "outcome", quote: "bearings" }, { rule: "too-long", field: "outcome", quote: `${outcome.length} of 225 characters` }]),
      answer: JSON.stringify({ status: "blocked", headline: "Blocked: npm ci fails with E403.", outcome, evidence: [{ kind: "command", ref: "npm ci", detail: "E403", exitCode: 1 }], artifacts: [], voice: null }, null, 2) };
    const slot = await editor({ voiceCheck: () => view([check({ state: "failed", situations: [blocker, ...five().slice(1)] })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.querySelector(".vc-fail > button")).not.toBeNull());
    fireEvent.click(b.querySelector<HTMLButtonElement>(".vc-fail > button")!);
    const answer = b.querySelector(".vc-ans")!;
    expect([...answer.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Status", "Headline", "Outcome", "Evidence"]);
    const out = [...answer.querySelectorAll("dt")].find((d) => d.textContent === "Outcome")!.nextElementSibling!;
    expect([...out.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["bearings"]);
    expect(out.querySelector(".vc-over")!.textContent).toBe(outcome.slice(225));
    expect(out.textContent).toBe(outcome);
    expect(answer.textContent).toContain("npm ci · E403 · exit 1");
    expect(answer.querySelector("pre")).toBeNull();
    const raw = within(answer as HTMLElement).getByRole("button", { name: "As sent" });
    expect(raw.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(raw);
    expect(answer.querySelector("pre")!.textContent).toContain('"status": "blocked"');
  });

  it("says why a check couldn't run and offers Try again", async () => {
    const slot = await editor({ voiceCheck: () => view([check({ state: "couldnt-run", reason: "Took longer than 90 seconds.", situations: [], judge: null, tone: null })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Couldn't run the check: Took longer than 90 seconds."));
    expect(within(b).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says plainly when the failure was Tavern's own, what it cost and that it counts, with the raw error one fold away", async () => {
    const slot = await editor({ voiceCheck: () => view([check({ state: "couldnt-run", fault: "tavern", detail: "HTTP 400: Thread event limit cannot exceed 100", situations: [], judge: null, tone: null,
      reason: "Tavern's check hit its own error. Nothing is wrong with Wren's voice or with the model.", cost: { usd: 0.26353485, tokens: 58_355 } })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Couldn't run the check: Tavern's check hit its own error. Nothing is wrong with Wren's voice or with the model."));
    expect(b.textContent).toContain("This run cost $0.26 and counts toward the hourly limit.");
    expect(b.textContent).not.toContain("HTTP 400");
    fireEvent.click(within(b).getByRole("button", { name: "Error details" }));
    expect(b.textContent).toContain("HTTP 400: Thread event limit cannot exceed 100");
    expect(within(b).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(b).getByRole("button", { name: "Run check" })).toBeTruthy();
  });

  it("says a run that cost nothing doesn't count toward the hourly limit", async () => {
    const slot = await editor({ voiceCheck: () => view([check({ state: "couldnt-run", fault: "model", situations: [], judge: null, tone: null, cost: null,
      reason: "The setup turn failed on gpt-5.1 (pi): Model not found. Check that this model is available to you, or change the character's class model in Tavern settings, then press Try again." })]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("This run cost nothing and doesn't count toward the hourly limit."));
    expect(within(b).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("greys a result for an earlier draft once the name or style changes", async () => {
    const slot = await editor({ voiceCheck: () => view([check()]) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Voice check passed"));
    expect(b.querySelector(".vc-stale")).toBeNull();
    fireEvent.change(slot.getByRole("textbox", { name: "Voice style" }), { target: { value: "Something new." } });
    await waitFor(() => expect(b.querySelector(".vc-stale")?.textContent).toContain("Checked an earlier draft"));
    // The temperament never reaches an agent, so changing it keeps the result current.
    fireEvent.change(slot.getByRole("textbox", { name: "Voice style" }), { target: { value: wren.style } });
    fireEvent.change(slot.getByRole("textbox", { name: "Temperament" }), { target: { value: "calm" } });
    await waitFor(() => expect(b.querySelector(".vc-stale")).toBeNull());
  });

  it("says when the hourly cap allows the next run", async () => {
    const nextAt = new Date(2026, 10, 15, 14, 20).getTime();
    const slot = await editor({ voiceCheck: () => view([check()], { cap: { used: 10, max: 10, nextAt } }) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("10 checks this hour; next at 14:20."));
    expect((within(b).getByRole("button", { name: "Run check" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("waits while another character's check runs", async () => {
    const slot = await editor({ voiceCheck: () => view([], { running: check({ characterId: "moss", draft: { name: "Moss", style: "" }, state: "running", finishedAt: null }) }) });
    const b = await box(slot);
    await waitFor(() => expect(b.textContent).toContain("Another voice check is running, for Moss."));
    expect((within(b).getByRole("button", { name: "Run check" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's refusal", async () => {
    const slot = await editor({ voiceCheckStart: () => { throw new Error("Another voice check is running. Try again when it finishes."); } });
    fireEvent.click(within(await box(slot)).getByRole("button", { name: "Run check" }));
    expect((await slot.findByRole("alert")).textContent).toContain("Another voice check is running. Try again when it finishes.");
  });

  it("never gates Save on the check", async () => {
    const save = vi.fn((input: { voice: Partial<typeof wren> }) => ({ ...wren, ...input.voice }));
    const slot = await editor({ voiceCheck: () => view([check({ state: "failed", situations: [situation("blocker", "A blocker", [{ rule: "exclamation", field: "outcome", quote: "down!" }]), ...five().slice(1)] })]), saveCharacterVoice: save });
    await waitFor(async () => expect((await box(slot)).textContent).toContain("Voice check failed"));
    const button = slot.getByRole("button", { name: "Save Wren" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await slot.findByText("Voice saved to your character override.");
  });

  it("keeps every result's age moving on its own minute clock, on the sheet and in the editor, with no refetch", async () => {
    // The character page is memoized, so nothing else re-renders these lines between fetches.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const T = new Date(2026, 10, 15, 10, 0, 30).getTime();
    vi.setSystemTime(T);
    try {
      const done = check({ finishedAt: T - 20_000, startedAt: T - 50_000 });
      const older = check({ id: "vc_0", state: "failed", situations: [situation("blocker", "A blocker", [{ rule: "exclamation", field: "outcome", quote: "down!" }]), ...five().slice(1)], finishedAt: T - 5 * 60_000, startedAt: T - 6 * 60_000 });
      const reads = vi.fn(() => view([done, older]));
      const slot = await editor({ voiceCheck: reads });
      const sheet = () => slot.container.querySelector(".vc-sum")!;
      await waitFor(() => expect(sheet().textContent).toContain("Voice check passed · 5 of 5 · gpt-5.1 · just now"));
      fireEvent.click(within(sheet() as HTMLElement).getByRole("button", { name: "All 2 checks" }));
      const b = await box(slot);
      await waitFor(() => expect(b.textContent).toContain("· just now"));
      const fetched = reads.mock.calls.length;
      act(() => { vi.advanceTimersByTime(2 * 60_000); });
      expect(sheet().querySelector(".vc-line")!.textContent).toContain("· 2m ago");
      expect(sheet().querySelector(".vc-hist")!.textContent).toContain("Voice check failed · 4 of 5 passed · gpt-5.1 · 7m ago");
      expect(b.textContent).toContain("· 2m ago");
      expect(reads.mock.calls.length).toBe(fetched);
    } finally { vi.useRealTimers(); }
  });
});
