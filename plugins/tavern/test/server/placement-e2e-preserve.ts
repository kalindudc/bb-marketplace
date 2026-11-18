import { putQuestFixture } from "./support";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { PlacementPreservation } from "../../src/server/placement/preserve";
import { PlacementTransport } from "../../src/server/placement/transport";
import { submissionFixture, submissionGit } from "./placement-e2e-submission";
import { Keeper } from "../../src/server/keeper/service";
import { Registry } from "../../src/server/registry";
import { TavernRuntime } from "../../src/server/runtime";
import { fakePort, seedQuest } from "./support";

export async function preservationFixture() {
  const f = await submissionFixture();
  const state = { archived: false };
  const archive = vi.fn(async () => { state.archived = true; return { ok: true as const }; });
  f.harness.sdk.stub("threads.archive", archive);
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: threadId === "maker" ? "maker-env" : "home-env", status: threadId === "maker" ? f.state.status : "idle", updatedAt: f.state.updatedAt, archivedAt: threadId === "maker" && state.archived ? 100 : null }));
  f.harness.sdk.stub("threads.storageLocation", async () => ({ threadId: "maker", hostId: "storage", storageRootPath: f.storage }));
  writeFileSync(join(f.storage, "report.txt"), "declared storage evidence\n");
  f.entries[0]!.evidence.push({ kind: "file", ref: join(f.maker, "ignored"), detail: "", exitCode: null }, { kind: "file", ref: join(f.storage, "report.txt"), detail: "", exitCode: null });
  const preserve = new PlacementPreservation(f.bb, f.port, f.placements, f.holds, f.keepers, f.journal, new PlacementTransport(f.bb, f.port, f.placements));
  return { ...f, preserve, archive, releaseState: state };
}

export async function provePreserveStage() {
  const f = await preservationFixture();
  try {
    const order: string[] = [];
    f.state.intercept = method => { if (method === "importCommit" || method === "finishArtifact" || method === "releaseEndpoint") order.push(method); };
    f.archive.mockImplementation(async () => { order.push("archive"); f.releaseState.archived = true; return { ok: true }; });
    expect(await f.preserve.beforeRelease("maker", "Release")).toMatchObject({ state: "released" });
    const record = f.placements.byMember("maker")!;
    expect(record).toMatchObject({ phase: "released", preservation: { source: "saved", artifacts: "saved", liveOwnerThreadId: null, stopConfirmed: true } });
    const snapshot = f.placements.snapshot(record.preservation.snapshotId!)!;
    expect(submissionGit(f.home, "show", snapshot.homeRef + ":tracked")).toBe("submitted");
    expect(submissionGit(f.home, "show", snapshot.homeRef + ":untracked")).toBe("submitted new file");
    const manifest = f.preserve.manifest(record.preservation.artifactManifestId!)!;
    expect(manifest.notPreserved).toEqual([]); expect(manifest.saved).toHaveLength(3);
    for (const receipt of manifest.saved) {
      const file = manifest.files.find(file => file.id === receipt.artifactId)!;
      const bytes = readFileSync(join(f.registries.get("home")!.dataDir, receipt.storageKey));
      const expected = file.relativePath === "report.txt" ? "declared storage evidence\n" : file.relativePath === "ignored" ? "not declared\n" : "submitted\n";
      expect(bytes.toString()).toBe(expected);
    }
    expect(order.indexOf("archive")).toBeGreaterThan(order.lastIndexOf("finishArtifact"));
    expect(order.indexOf("archive")).toBeGreaterThan(order.indexOf("importCommit"));
    expect(order.indexOf("releaseEndpoint")).toBeGreaterThan(order.indexOf("archive"));
    expect(record.posture.aggregate).toBe("remote-detection-only");
    expect(f.stop).not.toHaveBeenCalled();
  } finally { await f.close(); }
}

export async function proveStopStage() {
  const stopped = await preservationFixture();
  try {
    const port = { ...fakePort(), prepare: stopped.journal.prepare, get: (threadId: string) => ({ ...fakePort().get(threadId), entries: stopped.entries }) };
    const keeper = new Keeper(stopped.keepers, port, () => 1_000_000);
    keeper.bind("keeper", "keeper", "wren", "project");
    const quest = await seedQuest(keeper, "keeper", "Save before stop", "Source and evidence survive");
    putQuestFixture(keeper.store, "quest", { ...quest, id: "quest" }); keeper.store.remove("quests", quest.id);
    const runtime = new TavernRuntime(stopped.bb, keeper, new Registry(fileURLToPath(new URL("../../", import.meta.url)), "/nonexistent"));
    stopped.state.intercept = method => { if (method === "snapshotWorktree") throw new Error("source refused"); };
    expect(await runtime.stop("quest", "Stop fixture")).toMatchObject({ phase: "stopping" });
    expect(stopped.archive).not.toHaveBeenCalled();
    expect(stopped.placements.byMember("maker")!.preservation.liveOwnerThreadId).toBe("maker");
    stopped.state.intercept = undefined;
    stopped.archive.mockImplementation(async () => {
      expect(keeper.quest("quest").phase).toBe("stopping");
      expect(stopped.placements.byMember("maker")!.preservation).toMatchObject({ source: "saved", artifacts: "saved" });
      stopped.releaseState.archived = true; return { ok: true };
    });
    const retried = await runtime.stop("quest", "Retry stop");
    expect(retried, JSON.stringify(stopped.placements.byMember("maker")!.blocked)).toEqual({ phase: "stopped", unconfirmed: 0 });
    expect(stopped.placements.byMember("maker")).toMatchObject({ phase: "released", preservation: { source: "saved", artifacts: "saved", stopConfirmed: true, liveOwnerThreadId: null } });
    expect(keeper.store.runtime("maker")).toMatchObject({ archivePending: false, archiveError: null });
    expect(stopped.archive).toHaveBeenCalledOnce();
  } finally { await stopped.close(); }
  const f = await preservationFixture();
  try {
    f.state.intercept = method => { if (method === "snapshotWorktree") throw new Error("source refused"); };
    expect(await f.preserve.beforeRelease("maker", "Quest stop")).toMatchObject({ state: "blocked" });
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.placements.byMember("maker")!.preservation.liveOwnerThreadId).toBe("maker");
    f.preserve.observeLoss("maker", "The owning thread was archived externally before preservation finished.");
    expect(f.placements.byMember("maker")).toMatchObject({ phase: "blocked", preservation: { source: "lost", artifacts: "not-declared", liveOwnerThreadId: null, reason: expect.stringContaining("externally") } });
    expect(await f.preserve.beforeRelease("maker", "Retry")).toMatchObject({ state: "lost", message: expect.stringContaining("externally") });
    expect(f.placements.byMember("maker")).toMatchObject({ phase: "released", preservation: { source: "lost", liveOwnerThreadId: null } });
    expect(f.placements.counts("keeper").makers).toBe(0);
  } finally { await f.close(); }
}
