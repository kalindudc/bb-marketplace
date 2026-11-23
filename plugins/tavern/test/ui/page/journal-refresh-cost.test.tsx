import { Profiler } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { definePluginApp, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { rpcContract, tags } from "../../../src/shared/contract";
import { registerPageSurfaces, useTavernBadge } from "../../../src/ui/page/register";
import { withAttention } from "../attention-fixture";
import { registry, richRoom } from "./scenes";
import { setup } from "../../server/runtime-fixture";
import { seedQuest } from "../../server/support";
import { registerRpc, rpcHandlers } from "../../../src/server/rpc";
import { onAuthorityReceipt } from "../../../src/server/authority";

it("counts refreshes for journal signals and the SDK's identical-data commits", async () => {
  const room = withAttention(richRoom);
  const app = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
  const Page = app.navPanels[0]!.component;
  let commits = 0;
  let reply: typeof room | Promise<typeof room> = room;
  function Surface() {
    const badge = useTavernBadge();
    const { isFetching, refetch } = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
    experimental_useRpcQuery({ contract: rpcContract, method: "crests", input: { threadIds: ["unmanaged", "maker", "linked"] } });
    return <><output aria-label="Badge">{badge?.count ?? 0}</output><output aria-label="Room request">{isFetching ? "fetching" : "settled"}</output><button onClick={() => void refetch()}>Refetch room fixture</button><Page subPath="room" /></>;
  }
  const slot = renderSlot({ component: () => <Profiler id="room" onRender={() => commits++}><Surface /></Profiler> }, {}, {
    pluginId: "tavern", experimental_rpcContract: rpcContract,
    rpc: {
      room: async () => structuredClone(await reply), registry: () => registry, identities: () => ({ identities: [] }), crests: () => ({ crests: [] }),
      stopAllStatus: () => ({ state: "running", since: null, by: null, receipt: null }),
      deletedQuestCount: () => ({ total: 0 }), attentionCount: () => ({ count: room.attention!.needYou }),
    } as never,
  });
  try {
    await slot.findByRole("heading", { name: /The quest board/ });
    await waitFor(() => expect(slot.getByLabelText("Badge").textContent).toBe(String(room.attention!.needYou)));
    const calls = slot.inspection.rpcCalls;
    async function replay(signal: string[]) {
      const before = calls.length, priorCommits = commits;
      await act(async () => { await slot.experimental_invalidateRpc(signal); });
      return { methods: calls.slice(before).map(call => call.method).sort(), commits: commits - priorCommits };
    }
    const signals = [
      [tags.journal("unmanaged"), tags.thread("unmanaged")],
      [tags.journal("maker"), tags.thread("maker"), tags.room(), tags.thread("lead"), tags.boardQuest("quest")],
      [tags.journal("linked"), tags.thread("linked"), tags.boardQuest("quest"), tags.thread("lead"), tags.room(), tags.thread("maker")],
    ];
    const changes = [];
    for (const signal of signals) changes.push(await replay(signal));
    const user = await replay([tags.room()]);
    await waitFor(() => expect(slot.getByLabelText("Room request").textContent).toBe("settled"));
    let finish!: (room: typeof reply) => void;
    reply = new Promise<typeof room>(resolve => { finish = resolve; });
    const before = calls.length, priorCommits = commits;
    fireEvent.click(slot.getByRole("button", { name: "Refetch room fixture" }));
    try {
      await waitFor(() => expect(slot.getByLabelText("Room request").textContent).toBe("fetching"));
    } finally {
      await act(async () => { finish(room); });
    }
    await waitFor(() => expect(slot.getByLabelText("Room request").textContent).toBe("settled"));
    const identical = { methods: calls.slice(before).map(call => call.method).sort(), commits: commits - priorCommits };
    console.log("U1 journal refresh", JSON.stringify({ changes, user, identical }));
    const roomReaders = ["attentionCount", "room"];
    expect(changes.map(change => change.methods)).toEqual([[], roomReaders, roomReaders]);
    expect(user.methods).toEqual(roomReaders);
    expect(identical.methods).toEqual(["room"]);
    expect(identical.commits).toBeGreaterThanOrEqual(2);
    expect(identical.commits).toBeLessThanOrEqual(3);
    expect((await replay([tags.attentionCount()])).methods).toEqual(["attentionCount"]);
    expect((await replay([tags.deletedQuestCount()])).methods).toEqual(["deletedQuestCount"]);
    expect((await replay([tags.settings()])).methods).not.toContain("deletedQuestCount");
    expect(slot.getByLabelText("Badge").textContent).toBe(String(room.attention!.needYou));
  } finally { slot.lifecycle.unmount(); }
});

it("refreshes only the deleted list on a deleted quest's linked-entry signal", async () => {
  function DeletedList() {
    const query = experimental_useRpcQuery({ contract: rpcContract, method: "deletedBoardQuests", input: { cursor: null, limit: 20 } });
    experimental_useRpcQuery({ contract: rpcContract, method: "deletedQuestCount", input: {} });
    return <output aria-label="Deleted list">{query.data?.total ?? "Loading"}</output>;
  }
  const slot = renderSlot({ component: DeletedList }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
    deletedBoardQuests: () => ({ boardQuests: [], total: 0, nextCursor: null }),
    deletedQuestCount: () => ({ total: 0 }),
  } as never });
  try {
    await waitFor(() => expect(slot.getByLabelText("Deleted list").textContent).toBe("0"));
    const before = slot.inspection.rpcCalls.length;
    await act(async () => { await slot.experimental_invalidateRpc([tags.deletedQuests()]); });
    expect(slot.inspection.rpcCalls.slice(before).map(call => call.method)).toEqual(["deletedBoardQuests"]);
  } finally { slot.lifecycle.unmount(); }
});

it("refreshes the badge after a counted ask is withdrawn and only the room is invalidated", async () => {
  const f = setup({}, process.cwd());
  const handlers = rpcHandlers(f.runtime);
  try {
    const quest = await seedQuest(f.k, "lead", "A decision", "Decision");
    const ask = f.k.ask("lead", { boardQuestId: quest.id, kind: "decision", effect: { type: "decision" }, question: "Use the draft?", why: "Your call", options: [{ id: "yes", label: "Use it", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
    function Badge() { return <output aria-label="Badge">{useTavernBadge()?.count ?? 0}</output>; }
    const slot = renderSlot({ component: Badge }, {}, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: { attentionCount: handlers.attentionCount } as never });
    try {
      await waitFor(() => expect(slot.getByLabelText("Badge").textContent).toBe("1"));
      expect(f.k.withdrawAsk(ask.id, "turn-recovered")?.state).toBe("withdrawn");
      expect(await handlers.attentionCount({})).toEqual({ count: 0 });
      const before = slot.inspection.rpcCalls.length;
      await act(async () => { await slot.experimental_invalidateRpc([tags.room(), tags.thread("lead")]); });
      expect(slot.inspection.rpcCalls.slice(before).map(call => call.method)).toEqual(["attentionCount"]);
      await waitFor(() => expect(slot.getByLabelText("Badge").textContent).toBe("0"));
    } finally { slot.lifecycle.unmount(); }
  } finally { f.k.store.db.close(); }
});

it("refetches the room only once when you answer an ask on the page", async () => {
  const f = setup({}, process.cwd());
  registerRpc(f.bb, f.runtime);
  const invalidate = vi.mocked(f.bb.rpc.experimental_invalidate);
  const dispose = onAuthorityReceipt(f.k.store.db, () => invalidate([tags.room()]));
  try {
    const quest = await seedQuest(f.k, "lead", "A decision", "Decision");
    const ask = f.k.ask("lead", { boardQuestId: quest.id, effect: { type: "decision" }, question: "Which region?", why: "Your call", kind: "decision", options: [{ id: "yes", label: "Use Toronto", detail: "", recommended: true }], meanwhile: "Wait", holds: [] });
    const app = await loadPluginApp(async () => ({ default: definePluginApp(registerPageSurfaces) }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "room" }, { pluginId: "tavern", experimental_rpcContract: rpcContract, rpc: {
      room: () => f.harness.invokeRpc("room", {}),
      registry: () => registry,
      identities: () => ({ identities: [] }),
      stopAllStatus: () => ({ state: "running", since: null, by: null, receipt: null }),
      deletedQuestCount: () => ({ total: 0 }),
      answerAsk: (input: unknown) => f.harness.invokeRpc("answerAsk", input),
    } as never });
    try {
      fireEvent.click(await slot.findByText("Open answer form"));
      fireEvent.click(await slot.findByRole("radio", { name: /Use Toronto/ }));
      const start = invalidate.mock.calls.length, before = slot.inspection.rpcCalls.length;
      fireEvent.click(slot.getByRole("button", { name: "Send answer" }));
      await waitFor(() => expect(f.k.store.get("asks", ask.id)?.state).toBe("answered"));
      const signals = invalidate.mock.calls.slice(start).map(([tagSet]) => tagSet);
      // The desktop can deliver independent invalidations apart; complete each fetch before delivering the next.
      for (const signal of signals) await act(async () => { await slot.experimental_invalidateRpc(signal); });
      const reads = slot.inspection.rpcCalls.slice(before).filter(call => call.method === "room").length;
      console.log("U1 answered ask", JSON.stringify({ roomSignals: signals.filter(signal => signal?.includes(tags.room())).length, roomReads: reads }));
      expect(reads).toBe(1);
      expect(f.k.store.events().some(event => event.type === "authority.acted" && event.data.act === "answerAsk")).toBe(true);
    } finally { slot.lifecycle.unmount(); }
  } finally { dispose(); f.k.store.db.close(); }
});
