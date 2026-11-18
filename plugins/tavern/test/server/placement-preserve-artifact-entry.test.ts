// @vitest-environment node
import { expect, it } from "vitest";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createTavernHostEntry } from "../../src/host/entry";
import { preservationFixture } from "./placement-e2e-preserve";

it("round-trips per-file missing and unsafe declarations through the real host entry", async () => {
  const f = await preservationFixture();
  const dataDir = f.registries.get("storage")!.dataDir;
  const entry = createTavernHostEntry({ artifactPath: join(dataDir, "unused-guard.js") });
  const harness = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir, tempDir: dataDir } });
  const authority = { placementId: "entry", generation: 1, endpointId: "artifacts", operationId: "inspect" };
  try {
    symlinkSync(join(f.storage, "report.txt"), join(f.storage, "unsafe"));
    await harness.experimental_call("registerEndpoint", { placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, endpoint: { hostId: "storage", environmentId: null, root: f.storage }, ownerThreadId: "maker", access: "artifact-read", workspaceKind: null, objectFormat: null, allowedRefs: [] });
    const result = await harness.experimental_call("inspectArtifacts", { ...authority, relativePaths: ["report.txt", "missing.txt", "unsafe"] });
    expect(result).toMatchObject({ files: [{ relativePath: "report.txt" }], notPreserved: [
      { relativePath: "missing.txt", code: "artifact-unavailable", message: expect.stringContaining("missing") },
      { relativePath: "unsafe", code: "unsafe-artifact", message: expect.stringContaining("symlink") },
    ] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  } finally { await harness.experimental_dispose(); await f.close(); }
});

it("consumes typed per-file omissions from the host entry without blocking preservation", async () => {
  const f = await preservationFixture();
  const dataDir = f.registries.get("storage")!.dataDir;
  const harness = experimental_createHostEntryHarness(createTavernHostEntry({ artifactPath: join(dataDir, "unused-guard.js") }), { experimental_paths: { dataDir, tempDir: dataDir } });
  const call = f.port.call.bind(f.port);
  f.port.call = (hostId, method, input, options) => hostId === "storage" && method === "inspectArtifacts"
    ? harness.experimental_call(method, input as Parameters<typeof harness.experimental_call<"inspectArtifacts">>[1], options) as ReturnType<typeof f.port.call<typeof method>>
    : call(hostId, method, input, options);
  try {
    f.entries[0]!.evidence.push({ kind: "file", ref: join(f.storage, "missing.txt"), detail: "", exitCode: null });
    expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
    const record = f.placements.byMember("maker")!;
    expect(f.preserve.manifest(record.preservation.artifactManifestId!)!.notPreserved).toEqual([expect.stringContaining("missing.txt")]);
    expect(record.preservation).toMatchObject({ artifacts: "unpreserved", reason: expect.stringContaining("missing.txt") });
  } finally { await harness.experimental_dispose(); await f.close(); }
}, 60_000);
