// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
import { catalog, model, provider, providerSdk } from "./provider-fixture";
import { registerTools } from "../../src/server/tools";
import type { ClassDef } from "../../src/shared/schema";

const input = {
  classId: "ranger",
  errand: true,
  title: "Scout",
  brief: {
    outcome: "Read",
    mode: "make-it-work" as const,
    outOfScope: "Writes",
    doneWhen: "Report",
    context: [],
    questions: ["1. What failed?"],
    timeboxMinutes: 5,
  },
};
function fixture(patch: Partial<ClassDef> = {}, sdkOverrides: Record<string, unknown> = {}) {
  const f = setup(sdkOverrides);
  f.bb.sdk.providers = providerSdk();
  const snapshot = f.runtime.snapshot();
  vi.spyOn(f.runtime, "snapshot").mockReturnValue({
    ...snapshot,
    classes: snapshot.classes.map((role) =>
      role.id === "ranger" ? { ...role, permission: "auto" as const, ...patch } : role,
    ),
  });
  return f;
}
function spawned(f: ReturnType<typeof fixture>) {
  return f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0] as Record<string, unknown>;
}

describe("hire execution compatibility", () => {
  it("refuses the real unknown class model instead of silently using a routed provider default", async () => {
    const f = fixture({ model: "anthropic/no-such-model" });
    f.bb.sdk.providers.models = async () => catalog([model("corp-router-anthropic/corp/dev")]);
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/no-such-model.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
  });

  it("states an advertised model alias substitution in its first line and requires user disclosure", async () => {
    const f = fixture({ model: "model-alias" });
    f.bb.sdk.providers.models = async () => catalog([{ ...model("anthropic/claude-sonnet-5-5"), id: "model-alias" }]);
    registerTools(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool("tavern_hire", input, { threadId: "lead" });
    expect(text).toMatch(/^[^\n]*model-alias -> anthropic\/claude-sonnet-5-5/);
    expect(text).toContain("Tell the user in this turn");
    expect(spawned(f).model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("refuses a model retained only as a stale selection, not as an offered model", async () => {
    const f = fixture();
    f.bb.sdk.providers.models = async () => ({ ...catalog([model("provider-default")]), selectedOnlyModels: [model()] });
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/claude-sonnet-5-5.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("names a model explicitly refused by the provider and tells the Keeper which class setting to change", async () => {
    const f = fixture();
    f.bb.sdk.threads.spawn = vi.fn(async () => { throw Object.assign(new Error("HTTP 400: model is not available"), { status: 400 }); });
    await expect(f.runtime.hire("lead", "project", input)).rejects.toThrow(/claude-sonnet-5-5.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(f.k.store.all("hires")).toEqual([]);
  });

  it("fixes the real pi auto-permission failure before spawning and reports the substitution", async () => {
    const f = fixture();
    registerTools(f.bb, f.runtime);
    const text = await f.harness.behavior.invokeAgentTool("tavern_hire", input, {
      threadId: "lead",
    });
    expect(spawned(f)).toMatchObject({
      providerId: "pi",
      permissionMode: "full",
      model: "anthropic/claude-sonnet-5-5",
      reasoningLevel: "high",
    });
    expect(text).toContain("permission auto -> full");
  });
  it.each([
    { requested: "auto", supported: ["accept-edits", "full"], expected: "full" },
    { requested: "full", supported: ["accept-edits", "auto"], expected: "auto" },
    { requested: "auto", supported: ["auto", "full"], expected: "auto" },
  ] as const)(
    "resolves permission $requested against $supported as $expected",
    async ({ requested, supported, expected }) => {
      const f = fixture({ permission: requested });
      f.bb.sdk.providers.list = async () => [provider("pi", [...supported])];
      await f.runtime.hire("lead", "project", input);
      expect(spawned(f).permissionMode).toBe(expected);
    },
  );
  it("refuses a missing configured model instead of substituting a declared provider default", async () => {
    const f = fixture({ model: "missing-model", reasoning: "xhigh" });
    registerTools(f.bb, f.runtime);
    f.bb.sdk.providers.models = async () =>
      catalog([
        model("non-default", ["xhigh"], false),
        model("provider-default", ["low", "medium"], true, "medium"),
      ]);
    await expect(f.harness.behavior.invokeAgentTool("tavern_hire", input, { threadId: "lead" })).rejects.toThrow(/missing-model.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
  });
  it.each([
    { requested: "medium", levels: ["low", "high"], expected: "high" },
    { requested: "xhigh", levels: ["high", "max"], expected: "max" },
    { requested: "high", levels: ["none", "low"], expected: "low" },
    { requested: "ultracode", levels: ["high", "xhigh"], expected: "xhigh" },
    { requested: "adaptive", levels: ["adaptive", "deep"], expected: "adaptive" },
    { requested: "unknown", levels: ["balanced", "deep"], expected: "balanced" },
  ])(
    "resolves reasoning $requested using the target model's levels",
    async ({ requested, levels, expected }) => {
      const f = fixture({ reasoning: requested });
      f.bb.sdk.providers.models = async () => catalog([model(undefined, levels)]);
      await f.runtime.hire("lead", "project", input);
      expect(spawned(f).reasoningLevel).toBe(expected);
    },
  );
  it("queries the explicitly selected provider in the parent environment rather than assuming pi", async () => {
    const f = fixture(
      { provider: "codex", model: "codex-model", permission: "auto" },
      {
        environments: { get: async () => ({ hostId: "host", isGitRepo: false }) },
      },
    );
    const get = f.bb.sdk.threads.get;
    f.bb.sdk.threads.get = async (args) => ({ ...(await get(args)), environmentId: "env" });
    const list = vi.fn(async () => [
      provider(),
      provider("codex", ["accept-edits", "auto", "full"]),
    ]);
    const models = vi.fn(async () => catalog([model("codex-model")], [provider("codex")]));
    f.bb.sdk.providers.list = list;
    f.bb.sdk.providers.models = models;
    await f.runtime.hire("lead", "project", input);
    expect(list).toHaveBeenCalledWith({ environmentId: "env" });
    expect(models).toHaveBeenCalledWith({ providerId: "codex", environmentId: "env" });
    expect(spawned(f)).toMatchObject({
      providerId: "codex",
      model: "codex-model",
      permissionMode: "auto",
    });
  });
  it("preserves inheritance when the class does not specify execution overrides", async () => {
    const f = fixture({ provider: null, model: null, reasoning: null, permission: null });
    await f.runtime.hire("lead", "project", input);
    expect(spawned(f)).not.toHaveProperty("model");
    expect(spawned(f)).not.toHaveProperty("reasoningLevel");
    expect(spawned(f)).not.toHaveProperty("permissionMode");
  });
  it("refuses a configured model when both capability lookups fail", async () => {
    const f = fixture();
    registerTools(f.bb, f.runtime);
    f.bb.sdk.providers.list = async () => {
      throw new Error("provider probe unavailable");
    };
    f.bb.sdk.providers.models = async () => {
      throw new Error("model probe unavailable");
    };
    await expect(f.harness.behavior.invokeAgentTool("tavern_hire", input, { threadId: "lead" })).rejects.toThrow(/claude-sonnet-5-5.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
  });
  it("omits reasoning when the selected model has no advertised levels", async () => {
    const f = fixture();
    f.bb.sdk.providers.models = async () => catalog([model(undefined, [], true, "none")]);
    const member = await f.runtime.hire("lead", "project", input);
    expect(spawned(f)).not.toHaveProperty("reasoningLevel");
    expect(member.executionNotes.join(" ")).toContain("not advertised");
    expect(f.k.store.runtime(member.threadId).executionNotes).toEqual(member.executionNotes);
    expect(
      f.k.store.events("lead").find((event) => event.type === "member.hired")?.data,
    ).toMatchObject({ adjustments: member.executionNotes });
  });
  it("refuses an unverified class model when catalog discovery fails", async () => {
    const f = fixture();
    registerTools(f.bb, f.runtime);
    f.bb.sdk.providers.models = async () => {
      throw new Error("model probe unavailable");
    };
    await expect(f.harness.behavior.invokeAgentTool("tavern_hire", input, { threadId: "lead" })).rejects.toThrow(/claude-sonnet-5-5.*classes[.]ranger[.]model/);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(f.k.store.all("hires")).toEqual([]);
  });
});
