// @vitest-environment node
import { describe, expect, it } from "vitest";
import { memberName } from "../../src/shared/member-name";
import { resolveHireExecution } from "../../src/server/execution";
import { instructions } from "../../src/server/instructions";
import { setup } from "./runtime-fixture";
import { catalog, model } from "./provider-fixture";
import { makePluginAgentConfigurationContext } from "./host";

describe("class quality contracts", () => {
  it("names a member by display name, character, class label, then capitalized class id", () => {
    const registry = { characters: [{ id: "bram", name: "Bram" }], classes: [{ id: "smith", label: "Smith" }] };
    expect(memberName({ classId: "smith", characterId: "bram", displayName: "Bram II" }, registry)).toBe("Bram II");
    expect(memberName({ classId: "smith", characterId: "bram" }, registry)).toBe("Bram");
    expect(memberName({ classId: "smith", characterId: null }, registry)).toBe("Smith");
    expect(memberName({ classId: "smith", characterId: "missing" }, registry)).toBe("Smith");
    expect(memberName({ classId: "ranger", characterId: null }, registry)).toBe("Ranger");
  });

  it("keeps the configured Warden model when it already differs from the maker family", async () => {
    const f = setup();
    const configured = "anthropic/claude-sonnet-5-5";
    f.bb.sdk.providers.models = async () => catalog([model("anthropic/claude-haiku"), model(configured, ["high"], false)]);
    const execution = await resolveHireExecution(f.bb, { ...f.runtime.snapshot().classes.find(c => c.id === "warden")!, model: configured }, {
      providerId: "pi", environmentId: null, projectId: "project", maker: { providerId: "pi", model: "openai/gpt-6.1-sol", environmentId: null },
    });
    expect(execution).toMatchObject({ model: configured, checkIndependence: "independent" });
  });

  it.each(["ranger", "smith", "warden", "wanderer"])("never tells a solo %s to use a missing report tool", async classId => {
    const f = setup();
    const character = f.runtime.registry.character(classId, []);
    f.k.bind("solo", classId, character!.id, "project");
    await f.runtime.prepareRegistry("project");
    const configured = f.runtime.configure({ ...makePluginAgentConfigurationContext({ thread: { id: "solo" } }), project: { ...makePluginAgentConfigurationContext().project, id: "project" } });
    expect(configured.tools).not.toContain("tavern_report");
    expect(configured.instructions).not.toContain("tavern_report");
    expect(configured.instructions).toContain("Answer the user in plain text");
  });

  it("tells a member without a character its class label, never Unnamed", async () => {
    const f = setup();
    f.k.bind("unnamed", "smith", null, "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Build", brief: { outcome: "Build", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } });
    await f.runtime.prepareRegistry("project");
    const configured = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "unnamed" } }));
    expect(configured.instructions).toContain('Character: "Smith".');
    expect(configured.instructions).not.toContain("Unnamed");
  });

  it("adds reporting and plain-blocker rules independently of a custom member body", () => {
    const text = instructions("A custom role.", undefined, "", "", "member");
    expect(text).toContain("tavern_report");
    expect(text).toContain("headline");
    expect(text).toContain("evidence");
    expect(text).toContain("Write asks, blockers and failures plainly");
  });
});
