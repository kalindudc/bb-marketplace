// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "./host";
import { setup } from "./runtime-fixture";
import { SettingsStore } from "../../src/server/settings/store";
import { InsightsReader } from "../../src/server/insights";
import { registerRpc } from "../../src/server/rpc";
import { provider, catalog } from "./provider-fixture";

function fixture(defaultClass = "keeper") {
  const f = setup();
  const settings = new SettingsStore(f.k.store.db, f.time);
  f.runtime.enableSettings(settings, new InsightsReader(f.k.store.db, settings, f.time));
  settings.update({ revision: 0, patch: { tavern: { defaultClass } }, why: "Set default" });
  const ctx = makeMessageDispatchHookContext({ thread: { id: "new", status: "pending" } });
  ctx.requestedExecution = { providerId: "pi", model: "small", reasoningLevel: "low", permissionMode: "full", serviceTier: null };
  ctx.executionSources.model = "explicit";
  return { ...f, ctx, settings };
}

describe("user-started class admission", () => {
  it("allows the first Keeper turn on the user's model and records the class difference as a notice", async () => {
    const f = fixture();
    expect(await f.runtime.dispatch(f.ctx)).toEqual({ action: "proceed" });
    expect(f.k.member("new")?.role).toBe("keeper");
    expect(f.k.store.runtime("new").classNotice?.message).toMatch(/Running on small.*Keeper class says/);
    expect(f.k.store.runtime("new").classExecutionChoice?.modelSource).toBe("explicit");
  });

  it("pins a display name on a user-started thread", async () => {
    const f = fixture();
    f.ctx.thread.title = "Route this work";
    await f.runtime.dispatch(f.ctx);
    const member = f.k.member("new")!;
    expect(member.displayName).toBeTruthy();
  });

  it("does not reconcile subsequent deliberate model changes or recreate a dismissed notice", async () => {
    const f = fixture();
    await f.runtime.dispatch(f.ctx);
    f.k.store.patch("new", { classNotice: null });
    f.ctx.thread.status = "idle";
    f.ctx.requestedExecution.model = "another-model";
    expect(await f.runtime.dispatch(f.ctx)).toEqual({ action: "proceed" });
    expect(f.k.store.runtime("new").classNotice).toBeNull();
  });

  it.each(["missing", "smith"])("falls back from invalid default %s with a persistent settings notice", async classId => {
    const f = fixture(classId);
    if (classId === "smith") {
      const snapshot = f.runtime.snapshot();
      vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "smith" ? { ...role, startable: false } : role) });
    }
    expect(await f.runtime.dispatch(f.ctx)).toEqual({ action: "proceed" });
    expect(f.k.member("new")).toBeNull();
    expect(f.k.store.runtime("new").classNotice).toMatchObject({ settings: true, switchExecution: null, message: expect.stringMatching(/Started as a plain thread:.*default class/i) });
  });

  it("puts the live Ranger-minute limit in the Keeper ledger instead of a fixed body value", async () => {
    const f = fixture();
    f.settings.update({ revision: f.settings.snapshot().revision, patch: { knobs: { rangerTimeboxMaxMinutes: 7 } }, why: "Short scouts" });
    await f.runtime.prepareRegistry("project");
    const text = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "lead" } })).instructions!;
    expect(text).toContain('"rangerMinutes":7');
    expect(f.runtime.snapshot().classes.find(role => role.id === "keeper")!.body).not.toContain("at most 12 minutes");
  });

  it("treats classId none as an explicit plain thread, not the default", async () => {
    const f = fixture();
    f.ctx.experimental_submission = { pluginId: "tavern", data: { classId: "none" } };
    expect(await f.runtime.dispatch(f.ctx)).toEqual({ action: "proceed" });
    expect(f.k.member("new")).toBeNull();
  });

  it("refuses an explicitly selected malformed character pool rather than silently dropping the class", async () => {
    const f = fixture("none");
    const snapshot = f.runtime.snapshot();
    vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "keeper" ? { ...role, characters: ["missing"] } : role) });
    f.ctx.experimental_submission = { pluginId: "tavern", data: { classId: "keeper" } };
    expect(await f.runtime.dispatch(f.ctx)).toMatchObject({ action: "reject", message: expect.stringMatching(/character/i) });
    expect(f.k.member("new")).toBeNull();
  });

  it("refuses a wider permission on the first turn, without binding the thread", async () => {
    const f = fixture("ranger");
    f.bb.sdk.providers.list = async () => [provider("pi", ["accept-edits", "auto", "full"])];
    f.bb.sdk.providers.models = async () => catalog(undefined, [provider("pi", ["accept-edits", "auto", "full"])]);
    const snapshot = f.runtime.snapshot();
    vi.spyOn(f.runtime, "snapshot").mockReturnValue({ ...snapshot, classes: snapshot.classes.map(role => role.id === "ranger" ? { ...role, permission: "accept-edits" } : role) });
    expect(await f.runtime.dispatch(f.ctx)).toMatchObject({ action: "reject", message: expect.stringMatching(/permission/) });
    expect(f.k.member("new")).toBeNull();
  });

  it("refuses a first-start provider that cannot carry the class guard", async () => {
    const f = fixture();
    f.runtime.scopes = { api: { shouldScope: () => true }, resolve: async () => ({ scope: { preset: "keeper" }, problems: [] }) } as never;
    f.ctx.requestedExecution.providerId = "codex";
    expect(await f.runtime.dispatch(f.ctx)).toMatchObject({ action: "reject", message: expect.stringMatching(/requires Pi/) });
  });

  it("dismisses persistently and clears a switch notice only after bb confirms the applied tuple", async () => {
    const f = fixture();
    await f.runtime.dispatch(f.ctx);
    registerRpc(f.bb, f.runtime);
    await f.harness.invokeRpc("dismissClassNotice", { threadId: "new" });
    expect(f.k.store.runtime("new").classNotice).toBeNull();
    f.k.store.patch("new", { classNotice: { message: "Difference", settings: true, switchExecution: { model: "large", reasoningLevel: "high" } } });
    f.bb.sdk.threads.update = vi.fn(async () => ({ ok: true })) as never;
    f.bb.sdk.threads.defaultExecutionOptions = async () => ({ model: "large", reasoningLevel: "high" }) as never;
    expect(await f.harness.invokeRpc("applyClassExecution", { threadId: "new" })).toEqual({ model: "large", reasoningLevel: "high" });
    expect(f.k.store.runtime("new").classNotice).toBeNull();
  });
});
