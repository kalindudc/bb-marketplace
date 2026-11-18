// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavernRuntime } from "../../src/server/runtime";
import { setup } from "./runtime-fixture";
import { makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from "./host";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const context = (id: string) => ({ ...makePluginAgentConfigurationContext({ thread: { id } }), environment: { ...makePluginAgentConfigurationContext().environment, path: "/wrong-worktree" } });

function projectRoot(marker: string) {
  const root = mkdtempSync(join(tmpdir(), "tavern-configure-")); roots.push(root);
  mkdirSync(join(root, ".agents/tavern/classes"), { recursive: true });
  writeFileSync(join(root, ".agents/tavern/classes/keeper.md"), readFileSync(new URL("../../classes/keeper.md", import.meta.url), "utf8").replace("# You are a Keeper", marker));
  return root;
}

describe("class configuration across restart", () => {
  it("prewarms the canonical project root at startup before configuring an existing Keeper", async () => {
    const f = setup(), root = projectRoot("CANONICAL-PROJECT-KEEPER.");
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }], gitRemoteUrl: null }) as never;
    const restarted = new TavernRuntime(f.bb, f.k, f.runtime.registry);
    await restarted.reconcile();
    expect(restarted.configure(context("lead")).instructions).toContain("CANONICAL-PROJECT-KEEPER");
  });

  it("holds a cold-start Keeper on root failure, then binds through normal admission when loading recovers", async () => {
    const f = setup();
    f.bb.sdk.projects.get = async () => { throw new Error("Project source unavailable"); };
    const dispatch = makeMessageDispatchHookContext({ thread: { id: "fresh", status: "pending" } });
    dispatch.experimental_submission = { pluginId: "tavern", data: { classId: "keeper" } };
    expect(await f.runtime.dispatch(dispatch)).toMatchObject({ action: "wait", reason: expect.stringContaining("Project source unavailable") });
    expect(f.k.member("fresh")).toBeNull();
    const root = projectRoot("RECOVERED-PROJECT-KEEPER.");
    f.bb.sdk.projects.get = async () => ({ sources: [{ path: root, hostId: "host", isDefault: true }], gitRemoteUrl: null }) as never;
    expect(await f.runtime.dispatch(dispatch)).toEqual({ action: "proceed" });
    expect(f.k.member("fresh")?.role).toBe("keeper");
    expect(f.runtime.configure(context("fresh")).instructions).toContain("RECOVERED-PROJECT-KEEPER");
    expect(f.k.store.runtime("fresh").classNotice?.message ?? "").not.toContain("Project source unavailable");
  });

  it("keeps a Keeper able to talk on root failure, but refuses hires until files load", async () => {
    const f = setup();
    f.bb.sdk.projects.get = async () => { throw new Error("Project source unavailable"); };
    await expect(f.runtime.prepareRegistry("project")).rejects.toThrow("Project source unavailable");
    const configured = f.runtime.configure(context("lead"));
    expect(configured.instructions).toContain("You are a Keeper");
    expect(configured.instructions).toContain("Project source unavailable");
    expect(configured.instructions).toContain("hires are unavailable");
    expect(configured.tools).toContain("tavern_route");
    await expect(f.runtime.hire("lead", "project", { classId: "ranger", errand: true, title: "Scout", brief: { outcome: "Look", mode: "make-it-work", outOfScope: "Work", doneWhen: "Evidence", context: [], questions: ["What exists?"], timeboxMinutes: 5 } })).rejects.toThrow("Project source unavailable");
    expect(f.harness.inspection.sdk.callsTo("threads.create")).toHaveLength(0);
  });

  it("tells a member to report a blocker naming the root problem and do no work", async () => {
    const f = setup();
    f.k.bind("worker", "smith", "bram", "project", { keeperThreadId: "lead", boardQuestId: null, waypointId: null, errand: true, title: "Work", brief: { outcome: "Work", mode: "make-it-work", outOfScope: "Other work", doneWhen: "Evidence", context: [], questions: [], timeboxMinutes: null } });
    f.bb.sdk.projects.get = async () => { throw new Error("Project source unavailable"); };
    await expect(f.runtime.prepareRegistry("project")).rejects.toThrow("Project source unavailable");
    const configured = f.runtime.configure(context("worker"));
    expect(configured.instructions).toContain("Project source unavailable");
    expect(configured.instructions).toContain("Do no work");
    expect(configured.instructions).toContain("tavern_report");
    expect(configured.tools).toEqual(["tavern_report"]);
  });

  it("bounds dispatch root lookup to twenty seconds while configure itself remains synchronous", async () => {
    const f = setup();
    vi.useFakeTimers();
    f.bb.sdk.projects.get = () => new Promise(() => {});
    const pending = f.runtime.dispatch(makeMessageDispatchHookContext({ thread: { id: "lead", status: "idle" } }));
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await pending).toMatchObject({ action: "wait", sendAt: expect.any(Number) });
    const configured = f.runtime.configure(context("lead"));
    expect(configured).not.toBeInstanceOf(Promise);
    expect(configured.instructions).toContain("timed out after 20 seconds");
    expect(configured.instructions).toContain("You are a Keeper");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed synchronously before startup finishes warming", () => {
    const f = setup(), lookup = vi.fn();
    f.bb.sdk.projects.get = lookup;
    const configured = f.runtime.configure(context("lead"));
    expect(configured).not.toBeInstanceOf(Promise);
    expect(configured.instructions).toContain("has not warmed yet");
    expect(configured.tools).toContain("tavern_route");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns voice-check isolation before any project lookup, including a never-settling one", () => {
    const f = setup(), lookup = vi.fn(() => new Promise<never>(() => {}));
    f.bb.sdk.projects.get = lookup;
    const configured = f.runtime.configure(makePluginAgentConfigurationContext({ thread: { id: "voice" }, pluginMetadata: { voiceCheck: "vex" } }));
    expect(configured).toEqual({ tools: [], skills: [], instructions: "" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
