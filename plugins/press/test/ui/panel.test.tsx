// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type ThreadStatusDto } from "../../src/contract";
import { PROVIDER_OFF, RUNNING_REFUSAL } from "../../src/ui/controls";
import { HISTORY_PAGE } from "../../src/ui/history";
import { PressPanel } from "../../src/ui/panel";
import { compaction, states, status, THREAD } from "./fixtures";

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const view of mounts.splice(0)) view.lifecycle.unmount();
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function handlers(current: { value: ThreadStatusDto }, overrides: Partial<Handlers> = {}): Handlers {
  return {
    status: async () => current.value,
    summary: async ({ compactionId }) => ({ markdown: `## Goal\n\nSummary for ${compactionId}.` }),
    compactNow: async () => ({ ok: true, message: "Compaction requested." }),
    setThreadMode: async ({ mode }) => { current.value = { ...current.value, mode }; return { mode }; },
    setThreadPoint: async ({ point, enabled }) => {
      current.value = { ...current.value, points: { ...current.value.points, [point]: enabled } };
      return { points: current.value.points };
    },
    resetThread: async () => ({ ok: true as const }),
    ...overrides,
  };
}

function mount(value: ThreadStatusDto | Handlers, options: { tabVisible?: boolean } = {}) {
  const current = { value: "threadId" in value ? value as ThreadStatusDto : states().healthy };
  const rpc = "threadId" in value ? handlers(current) : value as Handlers;
  const view = renderSlot({ component: PressPanel }, { threadId: THREAD, environment: null },
    { pluginId: "press", rpc, experimental_rpcContract: rpcContract, ...options });
  mounts.push(view);
  return Object.assign(view, { current });
}

const statusCalls = (view: ReturnType<typeof mount>) => view.inspection.rpcCalls.filter((call) => call.method === "status").length;

describe("Press panel states", () => {
  it("healthy: answers 'is it safe' first, quietly", async () => {
    const view = mount(states().healthy);
    expect(await view.findByText("Safe")).toBeTruthy();
    const meter = view.getByRole("meter", { name: "Context used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("22");
    expect(meter.getAttribute("aria-valuetext")).toBe(`22% used, ${(88_000).toLocaleString()} of ${(400_000).toLocaleString()} tokens`);
    expect(view.getByText(`${(132_000).toLocaleString()} tokens until compact at`)).toBeTruthy();
    expect(view.container.querySelector(".pp-next")!.className).toContain("tone-none");
    expect(within(view.getByRole("list", { name: "Thresholds" })).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["150kfloor", "55%compact at", "80%force at"]);
    expect(view.getByText("closed until 55%")).toBeTruthy();
    expect(view.getByText("No compactions yet")).toBeTruthy();
    expect(view.getByText("5 of 6 on")).toBeTruthy();
    expect(view.getByRole("button", { name: "Compact now" }).hasAttribute("aria-disabled")).toBe(false);
  });

  it("held: says the next message is held, for how long, against the estimate", async () => {
    const view = mount(states().held);
    expect(await view.findByText("Holding your next message")).toBeTruthy();
    expect(view.container.querySelector(".pp-next")!.className).toContain("tone-attn");
    expect(view.container.querySelector(".pp-next-elapsed")!.textContent).toMatch(/^0:2\d$/);
    expect(view.getByRole("progressbar").getAttribute("aria-valuetext")).toMatch(/^0:2\d of about 2:27$/);
    expect(view.container.querySelector(".pp-fill")!.className).toContain("is-pressing");
    const button = view.getByRole("button", { name: "Compacting…" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(view.getByText("compacting now")).toBeTruthy();
  });

  it("compacting: names the point that fired", async () => {
    const view = mount(states().compacting);
    expect(await view.findByText("Compacting · phase")).toBeTruthy();
    expect(view.container.querySelector('[data-gate="points"]')!.textContent).toMatch(/phase fired \d\d:\d\d/);
  });

  it("blocked past force at: the cooldown holds it, the other veto is struck through", async () => {
    const view = mount(states().blocked);
    expect(await view.findByText("Backstop due")).toBeTruthy();
    expect(view.getByText(/^Compacts in [34]:\d\d$/)).toBeTruthy();
    const vetoes = view.container.querySelector('[data-gate="vetoes"]')!;
    expect(vetoes.querySelector("s")!.textContent).toBe("min turns · 1 turn left");
    expect(within(vetoes as HTMLElement).getByText("overridden by force at").tagName).toBe("EM");
    expect(within(vetoes as HTMLElement).getByText(/^cooldown · [34]:\d\d left$/).tagName).toBe("EM");
  });

  it("history-rich: totals, the drop chart, rows that open to the summary by id", async () => {
    const view = mount(states().history);
    expect(await view.findByText("5 compactions · 964k freed · 1:40 average")).toBeTruthy();
    expect(view.getByRole("img").getAttribute("aria-label")).toMatch(/^5 compactions from/);
    expect(view.container.querySelectorAll(".pp-drop")).toHaveLength(5);
    const rows = view.container.querySelectorAll(".pp-hist");
    expect(rows).toHaveLength(6);
    const failed = rows[3] as HTMLDetailsElement;
    expect(failed.className).toContain("is-failed");
    expect(within(failed).getByText("provider refused: context too large")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("No summary was kept for this compaction.")).toBeTruthy();

    const first = rows[0] as HTMLDetailsElement;
    first.open = true;
    fireEvent(first, new Event("toggle"));
    const summary = await view.findByRole("region", { name: /^Summary from \d\d:\d\d$/ });
    // The harness's Markdown stub prints the source as text.
    expect(await within(summary).findByText(/Summary for cmp-phase-86\./)).toBeTruthy();
    expect(view.inspection.rpcCalls).toContainEqual({ method: "summary", input: { threadId: THREAD, compactionId: "cmp-phase-86" } });
    expect(summary.className).toContain("is-clamped");
    const showAll = within(first).getByRole("button", { name: "Show all" });
    fireEvent.click(showAll);
    expect(showAll.getAttribute("aria-expanded")).toBe("true");
    expect(summary.className).not.toContain("is-clamped");

    expect(view.getByText("4 of 6 on · this thread")).toBeTruthy();
    expect(view.getByText("Mode and 1 point set for this thread")).toBeTruthy();
    expect(view.getAllByText("this thread")).toHaveLength(1);
  });

  it("pages a long history behind Show all", async () => {
    const now = Date.now();
    const many = Array.from({ length: HISTORY_PAGE + 4 }, (_, index) => compaction(now, 30 * (index + 1), "phase", 240_000, 60_000, 90_000));
    const view = mount(status({ percent: 30, tokens: 120_000, history: many }));
    await view.findByText(`Show all ${many.length}`);
    expect(view.container.querySelectorAll(".pp-hist")).toHaveLength(HISTORY_PAGE);
    fireEvent.click(view.getByText(`Show all ${many.length}`));
    expect(view.container.querySelectorAll(".pp-hist")).toHaveLength(many.length);
  });

  it("no usage: says Press is waiting, with no meter value", async () => {
    const view = mount(states().noUsage);
    expect(await view.findByText("No usage yet")).toBeTruthy();
    expect(view.getByText("Waiting for the first usage report")).toBeTruthy();
    expect(view.queryByRole("meter")).toBeNull();
    expect(view.getByText("usage not reported")).toBeTruthy();
  });

  it("loading: a named skeleton until the status arrives", async () => {
    const view = mount(handlers({ value: states().healthy }, { status: () => new Promise<never>(() => undefined) }));
    expect(view.getByRole("status", { name: "Loading Press" })).toBeTruthy();
  });

  it("error: an alert with the reason and a Retry that reads again", async () => {
    let fail = true;
    const view = mount(handlers({ value: states().healthy }, {
      status: async () => { if (fail) throw new Error("press server is down"); return states().healthy; },
    }));
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("Could not load Press status");
    expect(alert.textContent).toContain("press server is down");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await view.findByText("Safe")).toBeTruthy();
  });

  it("does not read the status while the tab is hidden", async () => {
    const view = mount(states().healthy, { tabVisible: false });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(statusCalls(view)).toBe(0);
  });
});

describe("Press panel mutations keep focus (F39) and announce results (F44)", () => {
  it("mode: the focused radio stays focused and enabled while the write is pending", async () => {
    const write = deferred<{ mode: "advisor" }>();
    const view = mount(handlers({ value: states().healthy }, { setThreadMode: () => write.promise }));
    const advisor = await view.findByRole("radio", { name: "advisor" });
    advisor.focus();
    fireEvent.click(advisor);
    expect((advisor as HTMLInputElement).checked).toBe(true);
    expect(document.activeElement).toBe(advisor);
    expect(advisor.hasAttribute("disabled")).toBe(false);
    expect(advisor.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(view.getByRole("radio", { name: "observe" }));
    expect((advisor as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(view.inspection.rpcCalls.filter((call) => call.method === "setThreadMode")).toHaveLength(1));
    expect(view.inspection.rpcCalls.find((call) => call.method === "setThreadMode")!.input).toEqual({ threadId: THREAD, mode: "advisor" });
    await act(async () => write.resolve({ mode: "advisor" }));
    await waitFor(() => expect(advisor.hasAttribute("aria-disabled")).toBe(false));
    expect(document.activeElement).toBe(advisor);
  });

  it("points: only the pending switch is guarded, and it keeps focus", async () => {
    const write = deferred<{ points: ThreadStatusDto["points"] }>();
    const view = mount(handlers({ value: states().healthy }, { setThreadPoint: () => write.promise }));
    const thrash = await view.findByRole("switch", { name: "Thrash point" });
    thrash.focus();
    fireEvent.click(thrash);
    expect((thrash as HTMLInputElement).checked).toBe(false);
    expect(document.activeElement).toBe(thrash);
    expect(thrash.getAttribute("aria-disabled")).toBe("true");
    expect(thrash.hasAttribute("disabled")).toBe(false);
    expect(view.getByRole("switch", { name: "Idle point" }).hasAttribute("aria-disabled")).toBe(false);
    expect(view.getByText("this thread")).toBeTruthy();
    await act(async () => write.resolve({ points: { ...states().healthy.points, thrash: false } }));
  });

  it("Compact now: focus stays, the button is aria-disabled while pending, the result lands in a live region already mounted", async () => {
    const write = deferred<{ ok: boolean; message: string }>();
    const view = mount(handlers({ value: states().healthy }, { compactNow: () => write.promise }));
    const button = await view.findByRole("button", { name: "Compact now" });
    const region = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");
    button.focus();
    fireEvent.click(button);
    expect(button.textContent).toBe("Requesting…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(view.inspection.rpcCalls.filter((call) => call.method === "compactNow")).toHaveLength(1));
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(view.inspection.rpcCalls.filter((call) => call.method === "compactNow")).toHaveLength(1);
    await act(async () => write.resolve({ ok: true, message: "Compaction requested." }));
    expect(region.textContent).toBe("Compaction requested.");
    expect(document.activeElement).toBe(button);
  });

  it("Compact now during a turn says why it waits, without asking the server", async () => {
    const view = mount(states().backstopRunning);
    const button = await view.findByRole("button", { name: "Compact now" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)!.textContent).toBe(RUNNING_REFUSAL);
    expect(view.inspection.rpcCalls.some((call) => call.method === "compactNow")).toBe(false);
    expect(view.getByText("Compacts when this turn ends")).toBeTruthy();
  });

  it("a refused write shows the server's message", async () => {
    const view = mount(handlers({ value: states().healthy }, { setThreadMode: async () => { throw new Error("Mode is locked by policy."); } }));
    fireEvent.click(await view.findByRole("radio", { name: "observe" }));
    expect(await view.findByText("Mode is locked by policy.")).toBeTruthy();
  });

  it("Reset to settings moves focus to the fold header when its button leaves", async () => {
    const current = { value: states().history };
    const view = mount(handlers(current, {
      resetThread: async () => {
        current.value = status({ ...current.value, overrides: { mode: false, points: [] }, mode: "auto", points: { ...current.value.points, thrash: true } });
        return { ok: true as const };
      },
    }));
    const reset = await view.findByRole("button", { name: "Reset to settings" });
    reset.focus();
    fireEvent.click(reset);
    await waitFor(() => expect(document.activeElement?.tagName).toBe("SUMMARY"));
    // The server invalidates the status after a reset; the harness needs it said.
    await act(async () => { await view.behavior.experimental_invalidateRpc([`status:${THREAD}`]); });
    await waitFor(() => expect(view.queryByRole("button", { name: "Reset to settings" })).toBeNull());
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    expect(view.getByText("This thread follows the plugin settings again.")).toBeTruthy();
  });
});

describe("Press panel live updates", () => {
  it("closes a held compaction with what it freed when the status says it landed", async () => {
    const S = states();
    const current = { value: S.held };
    const view = mount(handlers(current));
    await view.findByText("Holding your next message");
    const row = compaction(Date.now(), 0, "window", 328_000, 76_000, 101_000, { id: "cmp-landed" });
    current.value = status({ ...S.held, percent: 19, tokens: 76_000, compacting: null, held: null, history: [row, ...S.held.history] });
    await act(async () => { await view.behavior.experimental_invalidateRpc([`status:${THREAD}`]); });
    expect(await view.findByText(`Compacted · freed ${(252_000).toLocaleString()} in 1:41`)).toBeTruthy();
    expect(view.getByText("82% to 19% · held message released")).toBeTruthy();
    const freed = view.container.querySelector<HTMLElement>(".pp-freed")!;
    expect([freed.style.left, freed.style.width]).toEqual(["19%", "63%"]);
    expect(view.getByRole("button", { name: "Compact now" }).hasAttribute("aria-disabled")).toBe(false);
  });

  it("reads the status again when a cooldown runs out, once", async () => {
    const S = states();
    const view = mount(status({ ...S.blocked, blockers: [{ veto: "cooldownSeconds", remainingSeconds: 1, remainingTurns: null }] }));
    await view.findByText("Backstop due");
    expect(statusCalls(view)).toBe(1);
    await waitFor(() => expect(statusCalls(view)).toBe(2), { timeout: 3_000 });
    await act(async () => { await new Promise((done) => setTimeout(done, 1_200)); });
    expect(statusCalls(view)).toBe(2);
  });
});

describe("Press panel, review round 2", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("keeps 'Last compaction' moving while nothing counts down (R24)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const now = Date.now();
    const view = mount(status({ percent: 30, tokens: 120_000, turnsSince: 3, history: [compaction(now, 15, "phase", 240_000, 60_000, 90_000)] }));
    expect(await view.findByText("Last compaction 15 min ago · 3 turns")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(60 * 60_000); });
    expect(view.getByText("Last compaction 1 h 15 min ago · 3 turns")).toBeTruthy();
  });

  it("reads the clock again when a new status arrives (R24)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const history = [compaction(now, 15, "phase", 240_000, 60_000, 90_000)];
    const current = { value: status({ percent: 30, tokens: 120_000, turnsSince: 3, history }) };
    const view = mount(handlers(current));
    expect(await view.findByText("Last compaction 15 min ago · 3 turns")).toBeTruthy();
    vi.setSystemTime(now + 40 * 60_000);
    current.value = status({ percent: 31, tokens: 124_000, turnsSince: 4, history });
    await act(async () => { await view.behavior.experimental_invalidateRpc([`status:${THREAD}`]); });
    expect(await view.findByText("Last compaction 55 min ago · 4 turns")).toBeTruthy();
  });

  it("keeps the stale-data status line mounted, and fills it when a refresh fails (R26)", async () => {
    let fail = false;
    const view = mount(handlers({ value: states().healthy }, {
      status: async () => { if (fail) throw new Error("press server is down"); return states().healthy; },
    }));
    await view.findByText("Safe");
    const line = view.container.querySelector(".pp-stale")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("");
    fail = true;
    await act(async () => { await view.behavior.experimental_invalidateRpc([`status:${THREAD}`]).catch(() => undefined); });
    await waitFor(() => expect(line.textContent).toContain("Could not refresh, showing the last status."));
    expect(view.container.querySelector(".pp-stale")).toBe(line);
    expect(within(line as HTMLElement).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a running compaction's row says its summary comes when it lands (R33)", async () => {
    const S = states();
    const running = compaction(Date.now(), 0, "phase", 312_000, null, null, { outcome: "pending", hasSummary: false, model: null });
    const view = mount(status({ ...S.compacting, history: [running, ...S.compacting.history] }));
    await view.findByText("Compacting · phase");
    const row = view.container.querySelector<HTMLElement>('.pp-hist[data-outcome="pending"]')!;
    expect(within(row).getByText("The summary arrives when this compaction lands.")).toBeTruthy();
    expect(within(row).queryByText("No summary was kept for this compaction.")).toBeNull();
  });

  it("says Press is off for the provider, and Compact now says why without asking the server (R1)", async () => {
    const view = mount(status({ ...states().blocked, providerEnabled: false }));
    expect(await view.findByText("Press is off for this provider")).toBeTruthy();
    expect(view.getByText("Off")).toBeTruthy();
    const button = view.getByRole("button", { name: "Compact now" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(PROVIDER_OFF);
    fireEvent.click(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)!.textContent).toBe(PROVIDER_OFF);
    expect(view.inspection.rpcCalls.some((call) => call.method === "compactNow")).toBe(false);
  });
});
