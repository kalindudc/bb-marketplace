// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract } from "../../src/contract";
import { FEEDBACK_MS } from "../../src/ui/live";
import { PressManualCommand } from "../../src/ui/manual-command-banner";
import { THREAD } from "./fixtures";

const mounts: Array<ReturnType<typeof renderSlot>> = [];
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => {
  for (const view of mounts.splice(0)) view.lifecycle.unmount();
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** The follow-up composer as bb draws it, with Press's banner inside. */
function Composer() {
  return <div data-split-pane-id="pane-1">
    <div data-follow-up-composer>
      <div contentEditable suppressContentEditableWarning role="textbox" enterKeyHint="send" data-testid="editor">/compact</div>
      <button type="button" data-promptbox-submit-action>Send</button>
      <button type="button">Attach</button>
      <PressManualCommand />
    </div>
  </div>;
}

function mount(options: { text?: string; blocked?: string; result?: { ok: boolean; message: string } } = {}) {
  const unused = async () => { throw new Error("not used"); };
  const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
    status: unused, summary: unused, setThreadMode: unused, setThreadPoint: unused, resetThread: unused,
    compactNow: async () => options.result ?? { ok: true, message: "Compaction requested." },
  };
  const view = renderSlot({ component: Composer }, {}, {
    pluginId: "press", rpc, experimental_rpcContract: rpcContract,
    composer: { text: options.text ?? "/compact", scope: { kind: "thread", threadId: THREAD },
      ...(options.blocked === undefined ? {} : { submittingBlockedReason: options.blocked }) },
  });
  mounts.push(view);
  return view;
}

const enter = (view: ReturnType<typeof mount>, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(within(view.container).getByTestId("editor"), { key: "Enter", ...init });
const calls = (view: ReturnType<typeof mount>) => view.inspection.rpcCalls.filter((call) => call.method === "compactNow").length;
const region = (view: ReturnType<typeof mount>) => view.container.querySelector<HTMLElement>("[data-press-manual-command]")!;

describe("/compact in the composer", () => {
  it("keeps its live region mounted and empty before any result (F44)", () => {
    const view = mount();
    expect(region(view).getAttribute("role")).toBe("status");
    expect(region(view).hasAttribute("hidden")).toBe(false);
    expect(region(view).textContent).toBe("");
  });

  it("turns Enter on exactly /compact into Compact now and clears the draft", async () => {
    const view = mount();
    expect(enter(view)).toBe(false);
    await waitFor(() => expect(region(view).textContent).toBe("Compaction requested."));
    expect(calls(view)).toBe(1);
    expect(view.inspection.composer.text).toBe("");
  });

  it("lets other drafts, Shift+Enter and other buttons through", async () => {
    const other = mount({ text: "/compact focus on tests" });
    expect(enter(other)).toBe(true);
    const view = mount();
    expect(enter(view, { shiftKey: true })).toBe(true);
    expect(fireEvent.click(within(view.container).getByRole("button", { name: "Attach" }))).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(calls(other) + calls(view)).toBe(0);
  });

  it("intercepts a click on Send", async () => {
    const view = mount();
    expect(fireEvent.click(view.getByRole("button", { name: "Send" }))).toBe(false);
    await waitFor(() => expect(calls(view)).toBe(1));
  });

  it("leaves Enter to bb when the composer API says sending is blocked (F43)", async () => {
    const view = mount({ blocked: "Wait for the upload to finish." });
    expect(enter(view)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(calls(view)).toBe(0);
  });

  it("clears its result after a few seconds (F38)", async () => {
    const view = mount({ result: { ok: false, message: "Wait until the thread is idle before compacting." } });
    enter(view);
    await waitFor(() => expect(region(view).textContent).toBe("Wait until the thread is idle before compacting."));
    expect(view.inspection.composer.text).toBe("/compact");
    await act(async () => { await vi.advanceTimersByTimeAsync(FEEDBACK_MS - 100); });
    expect(region(view).textContent).not.toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(region(view).textContent).toBe("");
  });

  it("clears its result as soon as the person types something else (F38)", async () => {
    const view = mount({ result: { ok: false, message: "Wait until the thread is idle before compacting." } });
    enter(view);
    await waitFor(() => expect(region(view).textContent).not.toBe(""));
    await view.behavior.setComposerText("/compact");
    expect(region(view).textContent).not.toBe("");
    await view.behavior.setComposerText("run the tests again");
    expect(region(view).textContent).toBe("");
  });
});
