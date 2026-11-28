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
  f.k.bind("scout", "ranger", null, "project", {
    keeperThreadId: "lead", boardQuestId: null, waypointId: null, title: "Scout", errand: true,
    brief: { outcome: "Scout", mode: "make-it-work", outOfScope: "", doneWhen: "Done", context: [], questions: [], timeboxMinutes: null },
  });
  const registered = vi.spyOn(f.bb.agents, "registerTool");
  registerJournal(f.bb, f.k.store.db, { roleOf: () => null, invalidate: () => {} });
  registerTools(f.bb, f.runtime);
  const tools = registered.mock.calls.map(([tool]) => tool);
  const names = tools.map(tool => tool.name);
  const configured = (id: string) => f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id } })).tools;
  const nameOf = (tool: ReturnType<typeof configured>[number]) => typeof tool === "string" ? tool : tool.name;
  const reportFor = (id: string) => {
    const tool = configured(id).find(tool => nameOf(tool) === "tavern_report")!;
    return (typeof tool === "string" ? tools.find(definition => definition.name === tool)! : tool).parameters as { properties: Record<string, unknown> };
  };
  try {
    expect(configured("lead").map(nameOf)).toEqual(expect.arrayContaining(["journal", "tavern_memory", "tavern_ask"]));
    expect(configured("checker").map(nameOf)).toEqual(expect.arrayContaining(["journal", "tavern_memory", "tavern_report", "tavern_act_verdict"]));
    expect(names).toEqual(expect.arrayContaining([...configured("lead").map(nameOf), ...configured("checker").map(nameOf), "quest", "tavern_ready", "tavern_draft_pr"]));
    expect(reportFor("scout").properties).toHaveProperty("checkpoint");
    expect(reportFor("scout").properties.status).toMatchObject({ enum: expect.arrayContaining(["checkpoint"]) });
    expect(reportFor("checker").properties).not.toHaveProperty("checkpoint");
    expect(reportFor("checker").properties.status).toMatchObject({ enum: ["done", "needs-decision", "blocked"] });
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
      tavern_ask: ["operation", ["open", "held-message", "merge", "withdraw"]],
      tavern_pull_request: ["action", ["ready", "close", "comment", "reply", "resolve", "draft"]],
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

it("accepts plain and structured ask options without changing explicit ids", async () => {
  const f = setup();
  registerTools(f.bb, f.runtime);
  const input = { question: "Which route should we take?", why: "Different tradeoffs", kind: "decision", meanwhile: "", holds: [] };
  const call = (options: unknown, operation?: string) => f.harness.behavior.invokeAgentTool("tavern_ask", {
    ...input, options, ...(operation ? { operation } : {}),
  }, { threadId: "lead" });
  try {
    for (const operation of ["open", undefined]) {
      for (const options of [false, [false], [{ id: "a" }]]) {
        await expect(call(options, operation)).rejects.toThrow(/^(?:operation open: )?options(?:\.0)?:[^\n]*string[^\n]*object[^\n]*$/);
      }
    }
    expect(f.k.store.openAsks("lead")).toEqual([]);
    await expect(call(["Walk", { id: "option-1", label: "Ride", recommended: true }], "open")).resolves.toContain("Ask recorded");
    expect(f.k.store.openAsks("lead")[0]?.options).toEqual([
      { id: expect.stringMatching(/^option-/), label: "Walk", detail: "", recommended: false },
      { id: "option-1", label: "Ride", detail: "", recommended: true },
    ]);
    expect(f.k.store.openAsks("lead")[0]?.options[0]?.id).not.toBe("option-1");
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
    const missingQuestion = { why: "Different tradeoffs", kind: "decision", options: ["Wait"], meanwhile: "", holds: [] };
    await expect(call("tavern_ask", { ...missingQuestion, operation: "open" })).rejects.toThrow(/question/);
    await expect(call("tavern_ask", missingQuestion)).rejects.toThrow(/question/);
    expect(retire).not.toHaveBeenCalled();
    await expect(call("tavern_release", { operation: "confirm-retirement", confirmRetirement: true })).resolves.toContain("Retirement confirmed");
    await expect(call("tavern_release", { confirmRetirement: true })).resolves.toContain("Retirement confirmed");
    expect(retire).toHaveBeenCalledTimes(2);
  } finally {
    f.k.store.db.close();
  }
});
