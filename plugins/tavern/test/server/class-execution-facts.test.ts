// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provider, catalog } from "./provider-fixture";
import { describe, expect, it } from "vitest";
import { classExecutionFacts } from "../../src/server/class-execution";
import { classStartRefusal } from "../../src/shared/class-execution-contract";
import { setup } from "./runtime-fixture";

describe("class execution server facts", () => {
  it("resolves the same explicit model/reasoning/permission as a start's class", async () => {
    const f = setup();
    const out = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", providerId: "pi", environmentId: null, mode: "start" });
    expect(out.errors).toEqual([]);
    expect(out.execution).toMatchObject({ providerId: "pi", model: "anthropic/claude-sonnet-5-5", reasoningLevel: "high", permissionMode: "full" });
    expect(out.fields.find(field => field.field === "tools")).toMatchObject({ source: "role", value: "journal, tavern_memory" });
    expect(out.fields.find(field => field.field === "role prompt")!.rule).toContain("plainly");
  });

  it("uses the enforced scope and keeps start permission distinct from forced hire permission", async () => {
    const f = setup(), root = mkdtempSync(join(tmpdir(), "tavern-class-facts-"));
    try {
      f.runtime.enableScopes({ dataDir: root, installGuard: false, policyOptions: { home: root } });
      const providers = [provider("pi", ["accept-edits", "auto", "full"])];
      f.bb.sdk.providers.list = async () => providers;
      f.bb.sdk.providers.models = async () => catalog(undefined, providers);
      const snapshot = f.runtime.snapshot();
      f.runtime.snapshot = () => ({ ...snapshot, classes: snapshot.classes.map(role => role.id === "ranger" ? { ...role, permission: "auto", scope: "open" } : role) });
      const start = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", providerId: "pi", mode: "start" });
      expect.soft(start.execution?.permissionMode).toBe("auto");
      expect.soft(start.requiresPi).toBe(true);
      expect.soft(start.fields.find(field => field.field === "scope")?.value).toBe("readonly");
      expect.soft(start.fields.find(field => field.field === "provider")?.varies).toBeUndefined();
      const hire = await classExecutionFacts(f.runtime, { classId: "ranger", projectId: "project", mode: "hire" });
      expect.soft(hire.fields.find(field => field.field === "permission")).toMatchObject({ value: "full", source: "forced" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not invent a Keeper or maker for a page preview", async () => {
    const f = setup();
    const out = await classExecutionFacts(f.runtime, { classId: "warden", projectId: "project", mode: "hire" });
    expect(out.execution).toBeNull();
    expect(out.fields.find(field => field.field === "provider")!.varies).toBe("keeper");
    expect(out.fields.find(field => field.field === "model")!.varies).toBe("maker");
  });

  it("returns a missing/default class problem as data", async () => {
    const f = setup();
    const out = await classExecutionFacts(f.runtime, { classId: "missing", projectId: "project", providerId: "pi", mode: "start" });
    expect(out.execution).toBeNull();
    expect(out.errors.join(" ")).toContain("missing");
  });

  it("never refuses model/reasoning choices; only wider permissions and guarded-provider violations", () => {
    const expected = { providerId: "pi", permissionMode: "auto" as const, model: "large", reasoningLevel: "high" };
    expect(classStartRefusal(expected, { providerId: "pi", permissionMode: "auto", model: "small", reasoningLevel: "low" }, false)).toBeNull();
    expect(classStartRefusal(expected, { providerId: "pi", permissionMode: "full" }, false)).toContain("permission");
    expect(classStartRefusal(expected, { providerId: "codex", permissionMode: "auto" }, true)).toContain("Pi");
    expect(classStartRefusal(expected, { providerId: "codex", permissionMode: "accept-edits" }, false)).toBeNull();
  });
});
