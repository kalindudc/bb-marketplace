// @vitest-environment node
import { seedQuest } from "./support";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePluginAgentConfigurationContext } from "./host";
import { setup } from "./runtime-fixture";
import { planInput } from "./support";
import { catalog, model } from "./provider-fixture";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const brief = { outcome: "Build", mode: "make-it-work" as const, outOfScope: "Other work", doneWhen: "Tests pass", context: [], questions: [], timeboxMinutes: null };
async function planned(characterId: string | null = "bram", modelName: string | null = "openai/gpt-6.1-sol") {
  const f = setup();
  const q = await seedQuest(f.k,"lead", "Build", "Build");
  f.k.plan("lead", { ...planInput(q.id), party: [{ classId: "smith", characterId, model: modelName, purpose: "Build", waypointIds: ["w1"] }] });
  f.k.answerAsk(f.k.asks("lead").find(ask => ask.kind === "greenlight")!.id, "approve", null, "page");
  return { ...f, q, input: { classId: "smith", boardQuestId: q.id, waypointId: "w1", title: "Build", brief } };
}

describe("class hire snapshots", () => {
  it("applies the greenlit slot's character and model without the Keeper repeating them", async () => {
    const f = await planned();
    const member = await f.runtime.hire("lead", "project", f.input);
    expect(member.characterId).toBe("bram");
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")[0]!.args[0]).toMatchObject({ model: "openai/gpt-6.1-sol" });
  });

  it.each(["missing", "wren"])("refuses unknown/incompatible planned character %s before spawning", async characterId => {
    const f = await planned(characterId);
    await expect(f.runtime.hire("lead", "project", f.input)).rejects.toThrow(/character/i);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("shows a project Keeper override notice before its first hire", async () => {
    const f = setup();
    const root = mkdtempSync(join(tmpdir(), "tavern-class-override-")); roots.push(root);
    mkdirSync(join(root, ".agents/tavern/classes"), { recursive: true });
    writeFileSync(join(root, ".agents/tavern/classes/keeper.md"), readFileSync(new URL("../../classes/keeper.md", import.meta.url), "utf8"));
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }], gitRemoteUrl: null }) as never;
    await f.runtime.hire("lead", "project", { classId: "ranger", errand: true, title: "Scout", brief: { ...brief, questions: ["What exists?"], timeboxMinutes: 5 } });
    expect(f.k.store.runtime("lead").classNotice?.message).toContain("Project class override:");
    expect(f.k.store.runtime("lead").classNotice?.message).toContain(root);
  });

  it("keeps the hire's role prompt after the project class changes", async () => {
    const f = await planned();
    const original = f.runtime.snapshot("project").classes.find(role => role.id === "smith")!.body;
    const member = await f.runtime.hire("lead", "project", f.input);
    const later = f.runtime.snapshot("project");
    f.runtime.snapshot = () => ({ ...later, classes: later.classes.map(role => role.id === "smith" ? { ...role, body: "UNRELATED NEW ROLE" } : role) });
    const ctx = makePluginAgentConfigurationContext({ thread: { id: member.threadId } });
    const configured = f.runtime.configure(ctx);
    expect(configured.instructions).toContain(original);
    expect(configured.instructions).not.toContain("UNRELATED NEW ROLE");
  });

  it("never reads a member worktree as the project's class source", async () => {
    const f = setup();
    const root = mkdtempSync(join(tmpdir(), "tavern-class-root-")); roots.push(root);
    const worktree = mkdtempSync(join(tmpdir(), "tavern-class-member-")); roots.push(worktree);
    for (const [path, label] of [[root, "Project Ranger"], [worktree, "Member Ranger"]]) {
      mkdirSync(join(path!, ".agents/tavern/classes"), { recursive: true });
      writeFileSync(join(path!, ".agents/tavern/classes/ranger.md"), readFileSync(new URL("../../classes/ranger.md", import.meta.url), "utf8").replace("label: Ranger", `label: ${label}`));
    }
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }], gitRemoteUrl: null }) as never;
    await f.runtime.prepareRegistry("project");
    const ctx = makePluginAgentConfigurationContext({ thread: { id: "lead" } });
    f.runtime.configure({ ...ctx, project: { ...ctx.project, id: "project" }, environment: { ...ctx.environment, path: worktree }, host: { ...ctx.host, id: "host" } });
    expect(f.runtime.projectPath("project")).toBe(root);
    expect(f.runtime.snapshot("project").classes.find(role => role.id === "ranger")!.label).toBe("Project Ranger");
  });
});
