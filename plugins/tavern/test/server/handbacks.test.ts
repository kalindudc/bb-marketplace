// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { rpcHandlers } from "../../src/server/rpc";
import { isNewsEvent, isWakeEvent } from "../../src/server/news";
const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };

it("refuses a new informational hand-back and points to facts and summaries", () => {
  const f = setup();
  expect(() => f.k.memory.note("lead", { kind: "waiting-on-user", text: "Verification is finished" })).toThrow(/action.*fact.*summar/i);
});
it.each(["done", "replied"] as const)("a user %s resolves once, records the action, and wakes the Keeper", async how => {
  const f = setup();
  const note = f.k.memory.note("lead", { kind: "waiting-on-user", text: "The access request is pending", action: "Approve the Okta request", why: "The member cannot sign in" } as any);
  const wake = vi.spyOn(f.runtime, "wakeKeeper").mockResolvedValue(undefined as never);
  const rpc = rpcHandlers(f.runtime) as any;
  await expect(async () => rpc.resolveHandBack({ noteId: note.id, how }, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/client/);
  expect(f.k.store.get("notes", note.id)?.state).toBe("open");
  await rpc.resolveHandBack({ noteId: note.id, how }, client);
  expect(f.k.store.get("notes", note.id)).toMatchObject({ state: "done", resolution: { by: "user", how } });
  const events = f.k.store.events("lead").filter(event => event.type === "handback.resolved");
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toMatchObject({ by: "user", how, noteId: note.id });
  expect(events[0]?.text).toContain("Approve the Okta request");
  expect(isNewsEvent(events[0]!, "lead")).toBe(true);
  expect(isWakeEvent(events[0]!, "lead")).toBe(true);
  expect(wake).toHaveBeenCalledWith("lead", "user-action");
  await rpc.resolveHandBack({ noteId: note.id, how }, client);
  expect(f.k.store.events("lead").filter(event => event.type === "handback.resolved")).toHaveLength(1);
});
