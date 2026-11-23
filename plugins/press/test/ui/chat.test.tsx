// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { rpcContract, type ThreadStatusDto } from "../../src/contract";
import { PressMessageMetadata } from "../../src/ui/chat";
import { compaction, status, THREAD } from "./fixtures";

const mounts: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => {
  for (const view of mounts.splice(0)) view.lifecycle.unmount();
  document.body.replaceChildren();
});

const message = { id: "msg_after", threadId: THREAD, createdAt: 1_764_000_000_000, turnId: null, role: "user" as const, initiator: "user" as const };

function render(value: ThreadStatusDto) {
  const unused = async () => { throw new Error("not used"); };
  const rpc: PluginRpcTestHandlers<typeof rpcContract> = {
    status: async () => value,
    summary: async ({ compactionId }) => ({ markdown: `Summary of ${compactionId}` }),
    compactNow: unused, setThreadMode: unused, setThreadPoint: unused, resetThread: unused,
  };
  const view = renderSlot({ component: PressMessageMetadata }, { message }, { pluginId: "press", rpc, experimental_rpcContract: rpcContract });
  mounts.push(view);
  return view;
}

function anchored(hasSummary: boolean): ThreadStatusDto {
  const row = compaction(Date.now(), 3, "window", 328_000, 76_000, 101_000,
    { id: "cmp-42", hasSummary, boundaryAt: message.createdAt, boundaryMessageId: message.id });
  return status({ percent: 19, tokens: 76_000, history: [row], boundaries: { [`message:${message.id}`]: 0 } });
}

describe("Pressed line in chat", () => {
  it("marks the boundary and opens the summary by compaction id", async () => {
    const view = render(anchored(true));
    expect(await view.findByText("Pressed · 328k to 76k · 101s · window")).toBeTruthy();
    const toggle = view.getByRole("button", { name: "Show summary" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = await view.findByRole("region", { name: /^Press summary from \d\d:\d\d$/ });
    expect(await view.findByText("Summary of cmp-42")).toBeTruthy();
    expect(region.hasAttribute("data-content")).toBe(true);
    expect(view.inspection.rpcCalls).toContainEqual({ method: "summary", input: { threadId: THREAD, compactionId: "cmp-42" } });
  });

  it("offers no summary button when the composer kept none", async () => {
    const view = render(anchored(false));
    await view.findByText("Pressed · 328k to 76k · 101s · window");
    expect(view.queryByRole("button")).toBeNull();
  });

  it("stays silent on messages that are not a boundary", async () => {
    const view = render(status({ history: anchored(true).history }));
    await new Promise((done) => setTimeout(done, 20));
    expect(view.container.textContent).toBe("");
  });
});
