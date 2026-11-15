// @vitest-environment node
import { expect, it } from "vitest";
import { z } from "zod";
import { scopeForClass } from "../../src/scope/presets";
import * as schema from "../../src/scope/schema";

function fixture(role = "smith") {
  const template = { ...scopeForClass(role), threadId: "member", issuedAt: 1234 };
  return { ...template, bindingTemplate: structuredClone(template), workspaceBinding: { kind: "dedicated-machine" as const, hostId: "guest", environmentId: "member-env", root: "/guest/worktree", placementId: "placement", generation: 1, snapshotId: null as string | null, expectedTree: null as string | null }, bindingEndpoints: { threadStorage: "registered-storage-endpoint" } };
}
it("exports the canonical incoming schema and preserves an original unbound template with grants", () => {
  expect(schema).toHaveProperty("scopeDeliveryFileSchema");
  const value = fixture(), grant = { id: "user-grant", argv: ["git", "push"], why: "Approved grant" }; value.shell.allow.push(grant); value.bindingTemplate.shell.allow.push(grant);
  const parsed = schema.scopeDeliveryFileSchema.parse(value); expect(parsed).toEqual(value); expect(parsed.writes.allow).toContain("${worktree}");
});
it.each(["hostBinding", "controllerBinding", "bindingError", "scopeDigest", "templateDigest"])("rejects self-contained proof or controller-only %s in incoming bytes", field => {
  expect(schema.scopeDeliveryFileSchema.safeParse({ ...fixture(), [field]: field === "bindingError" ? "bad" : {} }).success).toBe(false);
});
it.each(["mode", "grant", "root", "thread", "issued"])("rejects a changed outer %s rather than interpreting it as the original template", change => {
  const value = fixture();
  if (change === "mode") value.mode = "off";
  if (change === "grant") value.shell.allow.push({ id: "extra", argv: ["anything"], why: "Not original" });
  if (change === "root") value.expectedWorktree = "/controller-bound-root";
  if (change === "thread") value.threadId = "other";
  if (change === "issued") value.issuedAt++;
  expect(schema.scopeDeliveryFileSchema.safeParse(value).success).toBe(false);
});
it.each(["environment", "host", "relative-root", "generation", "half-snapshot"])("rejects invalid member workspace %s", change => {
  const value = fixture();
  if (change === "environment") Object.assign(value.workspaceBinding, { environmentId: null });
  if (change === "host") value.workspaceBinding.hostId = "x".repeat(201);
  if (change === "relative-root") value.workspaceBinding.root = "relative/path";
  if (change === "generation") value.workspaceBinding.generation = 0;
  if (change === "half-snapshot") value.workspaceBinding.snapshotId = "snapshot";
  expect(schema.scopeDeliveryFileSchema.safeParse(value).success).toBe(false);
});
it("requires a real checker snapshot/tree pair and accepts a fully pinned one", () => {
  const value = fixture("warden"); expect(schema.scopeDeliveryFileSchema.safeParse(value).success).toBe(false);
  value.workspaceBinding.snapshotId = "snapshot"; value.workspaceBinding.expectedTree = "a".repeat(40); expect(schema.scopeDeliveryFileSchema.safeParse(value).success).toBe(true);
});
it("requires the original template and workspace binding but does not require optional thread storage", () => {
  const value = fixture(); const { bindingTemplate, workspaceBinding, bindingEndpoints, ...bare } = value;
  expect(schema.scopeDeliveryFileSchema.safeParse(bare).success).toBe(false);
  expect(schema.scopeDeliveryFileSchema.safeParse({ ...bare, workspaceBinding }).success).toBe(false);
  expect(schema.scopeDeliveryFileSchema.safeParse({ ...bare, bindingTemplate, workspaceBinding }).success).toBe(true);
  expect(schema.scopeDeliveryFileSchema.safeParse({ ...value, bindingEndpoints: { threadStorage: "x".repeat(201) } }).success).toBe(false);
  expect(schema.scopeDeliveryFileSchema.safeParse({ ...value, bindingEndpoints: { threadStorage: "id", arbitraryPath: "/tmp" } }).success).toBe(false);
});
it("exports both JSON Schema directions without a shared/browser dependency", () => {
  for (const io of ["input", "output"] as const) expect(() => z.toJSONSchema(schema.scopeDeliveryFileSchema, { io })).not.toThrow();
});
