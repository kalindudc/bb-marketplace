// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type ThreadStatusDto } from "../../src/contract";
import { PressContextRow, PressContextSegment } from "../../src/ui/context-row";
import { PressFooterChip } from "../../src/ui/footer-chip";
import { PRESS_TAB } from "../../src/ui/model";
import { states, THREAD } from "./fixtures";

const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const view of mounts.splice(0)) view.lifecycle.unmount();
  document.body.replaceChildren();
});

function rpc(value: ThreadStatusDto): PluginRpcTestHandlers<typeof rpcContract> {
  const unused = async () => { throw new Error("not used"); };
  return { status: async () => value, summary: unused, compactNow: unused, setThreadMode: unused, setThreadPoint: unused, resetThread: unused };
}

function render<P extends object>(component: ComponentType<P>, props: P, value: ThreadStatusDto) {
  const view = renderSlot({ component }, props, { pluginId: "press", rpc: rpc(value), experimental_rpcContract: rpcContract });
  mounts.push(view);
  return view;
}

/** bb's composer footer as Press finds it: the last group holds the native "Context window" circle. */
function Pane({ threadId, withSegment = false }: { threadId: string; withSegment?: boolean }) {
  return <div data-split-pane-id="pane-1">
    <div data-follow-up-composer-footer>
      <div />
      <div data-testid="footer-group"><button type="button" aria-label="Context window: 82% used">ctx</button></div>
    </div>
    <PressFooterChip threadId={threadId} />
    {withSegment && <PressContextSegment threadId={threadId} />}
  </div>;
}

const opened = (view: ReturnType<typeof renderSlot>) => view.inspection.experimental_panelCalls
  .some((call) => call.method === "openTab" && call.options.tab.id === PRESS_TAB.id && call.options.tab.availability === "action");

describe("Press chips", () => {
  it("context segment: the ring and the percent only, with the full status in its tooltip and name", async () => {
    const view = render(PressContextSegment, { threadId: THREAD }, states().blocked);
    const chip = await view.findByRole("button", { name: /^Press: 83% of the context window/ });
    expect(chip.textContent).toBe("83%");
    expect(chip.querySelector("svg.press-ring")?.getAttribute("aria-hidden")).toBe("true");
    expect(chip.getAttribute("data-tone")).toBe("over");
    expect(chip.hasAttribute("data-busy")).toBe(false);
    expect(chip.getAttribute("title")!.split("\n")).toEqual([
      `83% of the context window (332k of 400k tokens)`,
      "Auto: compacts on its own, from 55%, forced at 80%",
      "Next point: force at 80%",
      expect.stringMatching(/^Last compacted at .+: 316k to 88k$/),
    ]);
    fireEvent.click(chip);
    expect(opened(view)).toBe(true);
  });

  it("keeps the ring and the percent when Press is off for the provider, and says so in the tooltip (R1)", async () => {
    const view = render(PressContextSegment, { threadId: THREAD }, { ...states().blocked, providerEnabled: false });
    const chip = await view.findByRole("button", { name: /^Press: 83% of the context window/ });
    expect(chip.textContent).toBe("83%");
    expect(chip.getAttribute("title")!.split("\n")).toEqual([
      `83% of the context window (332k of 400k tokens)`,
      "Press is off for this provider",
      expect.stringMatching(/^Last compacted at .+: 316k to 88k$/),
    ]);
  });

  it("spins while Press holds the next message", async () => {
    const view = render(PressContextRow, { threadId: THREAD, projectId: "proj_press", environment: null }, states().held);
    const chip = await view.findByRole("button", { name: /^Press: 82%/ });
    expect(chip.textContent).toBe("82%");
    expect(chip.hasAttribute("data-busy")).toBe(true);
    expect(chip.getAttribute("title")).toMatch(/\nHolding the next message since .+, until the compaction lands\n/);
  });

  it("draws nothing until usage is reported", async () => {
    const view = render(PressContextSegment, { threadId: THREAD }, states().noUsage);
    await waitFor(() => expect(view.inspection.rpcCalls.some((call) => call.method === "status")).toBe(true));
    expect(view.queryByRole("button")).toBeNull();
  });

  it("footer: sits before bb's circle, hides it, shows ring and percent, opens Press and cleans up", async () => {
    const view = render(Pane, { threadId: THREAD, withSegment: true }, states().compacting);
    const chip = await view.findByRole("button", { name: /^Press: 78%/ });
    const group = view.getByTestId("footer-group");
    expect(chip.closest("[data-press-chip]")?.parentElement).toBe(group);
    expect(chip.closest("[data-press-chip]")?.nextElementSibling?.getAttribute("aria-label")).toBe("Context window: 82% used");
    expect(chip.className).toContain("press-footer-chip");
    expect(chip.textContent).toBe("78%");
    expect(chip.hasAttribute("data-busy")).toBe(true);
    // The supported surfaces step aside while the footer chip is mounted in the same pane.
    expect(view.container.querySelectorAll("button.press-chip")).toHaveLength(1);
    fireEvent.click(chip);
    expect(opened(view)).toBe(true);
    view.lifecycle.unmount();
    mounts.splice(mounts.indexOf(view), 1);
    expect(document.querySelector("[data-press-chip]")).toBeNull();
  });
});
