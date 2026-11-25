// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "./host";

function host() {
  const accepted = vi.fn(async () => makeThreadResponse({ id: "child" }));
  const sdk = { threads: { conversationOutline: vi.fn(async () => ({ items: [], maxSeq: 0 })), spawn: accepted, send: vi.fn(async () => ({ delivery: "sent" })), get: vi.fn(async () => makeThreadResponse()), storageLocation: vi.fn(async () => ({ hostId: "host", storageRootPath: "/tmp/thread" })), getPluginMetadata: accepted, updatePluginMetadata: accepted, events: { list: accepted }, queuedMessages: { delete: accepted } }, environments: { get: accepted, listProviders: accepted }, providers: { models: accepted }, projects: { list: accepted }, plugins: { callRpc: accepted }, files: { write: accepted } };
  return { ...createFakePluginHost({ pluginId: "tavern", sdk }), accepted };
}
const spawn = { projectId: "project", environment: { type: "project-default" }, input: [{ type: "text", text: "The task", mentions: [] }] };
const invalid: [string, unknown][] = [
  ["threads.spawn", { ...spawn, input: [] }],
  ["threads.spawn", { ...spawn, projectId: undefined }],
  ["threads.spawn", { ...spawn, environment: undefined }],
  ["threads.spawn", { ...spawn, prompt: "Also a task" }],
  ["threads.send", { threadId: "child", mode: "queue-if-active", input: [] }],
  ["threads.send", { threadId: "child", mode: "invalid", input: spawn.input }],
  ["threads.updatePluginMetadata", { threadId: "child", set: { progress: 1 }, remove: ["progress"] }],
  ["threads.updatePluginMetadata", { threadId: "child", remove: ["progress", "progress"] }],
  ["threads.updatePluginMetadata", { threadId: "child", set: { progress: Infinity } }],
  ["threads.getPluginMetadata", { threadId: "child", pluginId: "NOT_A_PLUGIN" }],
  ["threads.events.list", { threadId: "child", limit: "101" }],
  ["threads.conversationOutline", { threadId: "" }],
  ["threads.conversationOutline", { threadId: "child", signal: {} }],
  ["threads.conversationOutline", { threadId: "child", role: "tool" }],
  ["threads.queuedMessages.delete", { threadId: "child" }],
  ["environments.get", {}],
  ["projects.list", { includePersonal: "true" }],
  ["projects.list", { include: [] }],
  ["projects.list", { signal: {} }],
  ["environments.listProviders", { hostId: "host" }],
  ["environments.listProviders", { projectId: "" }],
  ["threads.spawn", { ...spawn, environment: { type: "provider", environmentProviderId: "git-worktree", inputs: { branch: { kind: "named" } } } }],
  ["threads.spawn", { ...spawn, environment: { type: "provider", environmentProviderId: "git-worktree", inputs: { branch: { kind: "new", baseBranch: "main" } } } }],
  ["providers.models", {}],
  ["plugins.callRpc", { method: "usage", input: {} }],
  ["files.write", { hostId: "host", path: "/tmp/fixture" }],
];
function invoke(sdk: unknown, path: string, input: unknown) {
  const parts = path.split(".");
  let namespace = sdk as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) namespace = namespace[part] as Record<string, unknown>;
  return (namespace[parts.at(-1)!] as (input: unknown) => Promise<unknown>)(input);
}
describe("SDK request boundaries in the shared host", () => {
  it.each(invalid)("rejects invalid %s before its fixture handler runs (%#)", async (path, input) => {
    const f = host();
    await expect(invoke(f.bb.sdk, path, input)).rejects.toMatchObject({ status: 400 });
    expect(f.accepted).not.toHaveBeenCalled();
  });
  it("keeps validation after direct replacement, spy replacement and namespace replacement", async () => {
    const f = host(), handler = vi.fn(async () => makeThreadResponse());
    f.bb.sdk.threads.spawn = handler as never;
    await expect(f.bb.sdk.threads.spawn({ ...spawn, input: [] } as never)).rejects.toMatchObject({ status: 400 });
    vi.spyOn(f.bb.sdk.threads, "spawn").mockImplementation(async () => makeThreadResponse() as never);
    await expect(f.bb.sdk.threads.spawn({ ...spawn, input: [] } as never)).rejects.toMatchObject({ status: 400 });
    Object.assign(f.bb.sdk, { threads: { spawn: handler } });
    await expect(f.bb.sdk.threads.spawn({ ...spawn, input: [] } as never)).rejects.toMatchObject({ status: 400 });
    expect(handler).not.toHaveBeenCalled();
    await f.bb.sdk.threads.spawn(spawn as never);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("accepts an outline request for one thread with a deadline signal", async () => {
    const f = host();
    const request = { threadId: "child", signal: new AbortController().signal };
    await expect(f.bb.sdk.threads.conversationOutline(request)).resolves.toEqual({ items: [], maxSeq: 0 });
    expect(f.harness.inspection.sdk.callsTo("threads.conversationOutline")).toHaveLength(1);
  });
  it("keeps mock inspection and call recording intact for valid requests", async () => {
    const f = host(), spy = vi.spyOn(f.bb.sdk.threads, "spawn");
    await f.bb.sdk.threads.spawn(spawn as never);
    expect(spy).toHaveBeenCalledOnce();
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });
  it("returns core's pending-environment 409 even after the storage handler is replaced", async () => {
    const f = host();
    await f.bb.sdk.threads.get({ threadId: "test" });
    const handler = vi.fn(async () => ({ hostId: "host", storageRootPath: "/tmp/thread" }));
    f.bb.sdk.threads.storageLocation = handler;
    await expect(f.bb.sdk.threads.storageLocation({ threadId: "test" })).rejects.toMatchObject({ status: 409, code: "thread_environment_unavailable" });
    expect(handler).not.toHaveBeenCalled();
    vi.mocked(f.bb.sdk.threads.get).mockResolvedValueOnce(makeThreadResponse({ id: "test", environmentId: "env" }) as never);
    await f.bb.sdk.threads.get({ threadId: "test" });
    await expect(f.bb.sdk.threads.storageLocation({ threadId: "test" })).resolves.toMatchObject({ hostId: "host" });
  });
});
