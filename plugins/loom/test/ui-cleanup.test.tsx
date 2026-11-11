// @vitest-environment jsdom
import { afterAll, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { QueryClient } from "@tanstack/react-query";
import { useLoom, useLoomWrite } from "../src/ui/common";
import { queryClients } from "./ui-setup";

const mounted: Array<{ client: QueryClient; container: HTMLElement }> = [];

it("owns a real SDK RPC cache until the case ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const Probe = () => <output>{useLoom("badge", null).data?.needsYou}</output>;
  const slot = renderSlot({ component: Probe }, {}, { pluginId: "loom", rpc: { badge: () => ({ needsYou: 3, blocked: false, threadIds: [] }) } });
  const container = slot.container;
  await waitFor(() => expect(container.textContent).toBe("3"));
  expect(queryClients().size).toBe(1);
  const client = [...queryClients()][0]!;
  mounted.push({ client, container });
  expect(client.getQueryCache().getAll()).toHaveLength(1);
  expect(client.getQueryCache().getAll()[0]!.gcTime).toBe(5 * 60_000);
  slot.lifecycle.unmount();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
});

it("owns a mutation-only SDK cache until the case ends", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const Probe = () => {
    const remove = useLoomWrite("deleteForgeProfile");
    return <button onClick={() => void remove({ id: "sample", confirm: true })}>Delete</button>;
  };
  const slot = renderSlot({ component: Probe }, {}, { pluginId: "loom", rpc: { deleteForgeProfile: () => [] } });
  fireEvent.click(slot.getByRole("button", { name: "Delete" }));
  expect(queryClients().size).toBe(1);
  const client = [...queryClients()][0]!;
  mounted.push({ client, container: slot.container });
  await waitFor(() => expect(client.getMutationCache().getAll()[0]!.state.status).toBe("success"));
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(client.getMutationCache().getAll()).toHaveLength(1);
  expect(client.getMutationCache().getAll()[0]!.gcTime).toBe(5 * 60_000);
  slot.lifecycle.unmount();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
});

afterAll(async () => {
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (const { client, container } of mounted) {
      expect(container.isConnected).toBe(false);
      expect(client.getQueryCache().getAll()).toHaveLength(0);
      expect(client.getMutationCache().getAll()).toHaveLength(0);
    }
    expect(queryClients().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
