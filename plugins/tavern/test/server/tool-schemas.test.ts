// @vitest-environment node
import { expect, it, vi } from "vitest";
import { registerJournal } from "../../src/server/journal";
import { registerTools } from "../../src/server/tools";
import { makePluginAgentConfigurationContext } from "./host";
import { setup } from "./runtime-fixture";

it("exposes object roots without top-level composition on every registered tool", async () => {
  const f = setup();
  f.bb.sdk.projects.get = async () => ({ sources: [{ path: process.cwd(), hostId: "host", isDefault: true }], gitRemoteUrl: null }) as never;
  await f.runtime.prepareRegistry("project");
  f.k.bind("checker", "warden", null, "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, title: "Check", errand: true,
    brief: { outcome: "Check", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null },
  });
  const registered = vi.spyOn(f.bb.agents, "registerTool");
  registerJournal(f.bb, f.k.store.db, { roleOf: () => null, invalidate: () => {} });
  registerTools(f.bb, f.runtime);
  const tools = registered.mock.calls.map(([tool]) => tool);
  const names = tools.map(tool => tool.name);
  const configured = (id: string) => f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id } })).tools;
  try {
    expect(configured("lead")).toEqual(expect.arrayContaining(["journal", "tavern_memory", "tavern_ask"]));
    expect(configured("checker")).toEqual(expect.arrayContaining(["journal", "tavern_memory", "tavern_report", "tavern_act_verdict"]));
    expect(names).toEqual(expect.arrayContaining([...configured("lead"), ...configured("checker"), "quest", "tavern_ready", "tavern_draft_pr"]));
    const incompatible = tools.flatMap(({ name, parameters }) => {
      const root = parameters as Record<string, unknown>;
      return root.type !== "object" || ["anyOf", "oneOf", "allOf"].some(keyword => keyword in root) ? [name] : [];
    });
    expect(incompatible).toEqual([]);
    const selectors = {
      tavern_memory: ["op", ["find", "save", "unreviewed", "read", "curate"]],
      tavern_note: ["op", ["add", "done"]],
      tavern_release: ["operation", ["release", "confirm-retirement"]],
      tavern_scope: ["operation", ["override", "repair-guard"]],
      tavern_ask: ["operation", ["open", "held-message", "merge"]],
      tavern_pull_request: ["action", ["ready", "close", "comment", "draft"]],
    } as const;
    for (const [name, [key, values]] of Object.entries(selectors)) {
      const root = tools.find(tool => tool.name === name)!.parameters as { properties: Record<string, unknown> };
      expect(root, name).toMatchObject({ required: expect.arrayContaining([key]), properties: { [key]: { enum: values } } });
      for (const field of Object.values(root.properties)) expect(field, name).toMatchObject({ description: expect.stringMatching(/\S/) });
    }
  } finally {
    f.k.store.db.close();
  }
});

it("validates the selected branch before a tool can act and still accepts legacy inputs", async () => {
  const f = setup();
  registerTools(f.bb, f.runtime);
  const retire = vi.spyOn(f.runtime, "confirmLeadRetirement").mockImplementation(() => {});
  const call = (name: string, input: unknown) => f.harness.behavior.invokeAgentTool(name, input, { threadId: "lead" });
  try {
    await expect(call("tavern_release", { operation: "release", confirmRetirement: true })).rejects.toThrow(/operation release.*confirmRetirement/s);
    await expect(call("tavern_release", { operation: "unknown", confirmRetirement: true })).rejects.toThrow(/choose release or confirm-retirement/i);
    await expect(call("tavern_scope", { operation: "repair-guard", member: "Morgan", override: {} })).rejects.toThrow(/repairGuard/);
    await expect(call("tavern_ask", { operation: "merge", heldCommunicationAskId: "held" })).rejects.toThrow(/mergeAskId/);
    expect(retire).not.toHaveBeenCalled();
    await expect(call("tavern_release", { operation: "confirm-retirement", confirmRetirement: true })).resolves.toContain("Retirement confirmed");
    await expect(call("tavern_release", { confirmRetirement: true })).resolves.toContain("Retirement confirmed");
    expect(retire).toHaveBeenCalledTimes(2);
  } finally {
    f.k.store.db.close();
  }
});
