// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { configToToml } from "../src/config";
import { createShuttlePlugin } from "../server";
import { FakePort, testConfig, fakeRunner, pr } from "./helpers";

async function boot(options: { port?: FakePort; now?: () => number } = {}) {
  const port = options.port ?? new FakePort();
  port.addThread("thr_1", "Owner");
  const runner = fakeRunner((operation, env) => {
    if (operation === "whoami") return { login: "me" };
    if (operation === "authored") return [pr(1, { author: "me" })];
    if (operation === "view") return pr(Number(env.SHUTTLE_NUMBER), { author: Number(env.SHUTTLE_NUMBER) === 1 ? "me" : "dana", review: Number(env.SHUTTLE_NUMBER) === 1 ? "approved" : "required" });
    if (operation === "activity") return { items: [] };
    if (operation === "review") return "";
    return [];
  });
  const host = createFakePluginHost({ pluginId: "shuttle", dataDir: mkdtempSync(join(tmpdir(), "shuttle-")) });
  const plugin = createShuttlePlugin({ port: () => port, runner, tickMs: 3_600_000, now: options.now });
  await plugin(host.bb);
  const { behavior, inspection, lifecycle } = host.harness;
  return { port, behavior, inspection, lifecycle, harness: host.harness, plugin };
}

const text = (result: unknown) => (typeof result === "string" ? result : (result as { content: Array<{ type: string; text?: string }> }).content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n"));

describe("the plugin", () => {
  it("serves its RPC, CLI and tools over one store", async () => {
    const { behavior, inspection, lifecycle, harness, port } = await boot();
    const toml = configToToml(testConfig());
    expect((await behavior.callRpc("importToml", { toml, apply: true })) as { changes: string[] }).toMatchObject({ changes: expect.arrayContaining(["adds server forge"]) });
    await behavior.callRpc("sync", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inflight = (await behavior.callRpc("list", { area: "mine" })) as { prs: Array<{ key: string }> };
    expect(inflight.prs.map((p) => p.key)).toEqual(["forge:acme/app#1"]);
    await behavior.callRpc("link", { key: "https://forge.test/acme/app/pull/2", threadId: "thr_1" });
    const linked = (await behavior.callRpc("threadPrs", { threadId: "thr_1" })) as { prs: Array<{ key: string }> };
    expect(linked.prs.map((p) => p.key)).toEqual(["forge:acme/app#2"]);
    const cli = await behavior.runCli(["link", "forge:acme/app#1"], { threadId: "thr_1" } as never);
    expect(cli, JSON.stringify(cli)).toMatchObject({ exitCode: 0 });
    const list = await behavior.runCli(["list", "--area", "mine"]);
    expect(list.stdout).toContain("forge:acme/app#1");
    const gate = await behavior.runCli(["gate", "forge:acme/app#2"]);
    expect(JSON.stringify(gate)).toContain("forge:acme/app#2 has no AI review draft to check");
    expect(gate).toMatchObject({ exitCode: 1 });
    const impossible = text(await harness.callAgentTool("shuttle_review_draft", {
      pr: "forge:acme/app#2", summary: "s", verdict: "comment",
      findings: [{ severity: "high", path: "a.go", line: 1, body: "b", consensus: { keep: 2, total: 1 } }],
    }, { threadId: "thr_1", projectId: "proj_app" }).catch((error: unknown) => String(error)));
    expect(impossible).toContain("keep cannot be more than total");
    const kinds = text(await harness.callAgentTool("shuttle_review_draft", {
      pr: "forge:acme/app#2", summary: "s", verdict: "comment", findings: [],
      assessment: { risk: "low", concerns: [{ kind: "unverified", text: "Could not run the tests." }, "An older plain concern."] },
    }, { threadId: "thr_1", projectId: "proj_app" }).catch((error: unknown) => String(error)));
    expect(kinds).not.toContain("Invalid");
    const draft = (await behavior.callRpc("detail", { key: "forge:acme/app#2" })) as { draft: { assessment: unknown } | null };
    expect(draft.draft?.assessment).toEqual({ risk: "low", concerns: [{ kind: "unverified", text: "Could not run the tests." }, { kind: "other", text: "An older plain concern." }] });

    const created = text(await harness.callAgentTool(
      "shuttle_board_create",
      { name: "Release board", prs: ["https://forge.test/acme/app/pull/2"] },
      { threadId: "thr_1", projectId: "proj_app" },
    ));
    expect(created).toContain("Release board");
    const boards = (await behavior.callRpc("boards", { archived: "include" })) as { boards: Array<{ id: string; name: string; createdBy: string | null }> };
    expect(boards.boards).toMatchObject([{ name: "Release board", createdBy: "thr_1" }]);
    const boardId = boards.boards[0]!.id;

    const add = JSON.parse((await behavior.runCli(["board", "add", boardId, "forge:acme/app#1", "--json"])).stdout) as { added: string[]; alreadyPresent: string[] };
    expect(add).toMatchObject({ added: ["forge:acme/app#1"], alreadyPresent: [] });
    const shown = JSON.parse((await behavior.runCli(["board", "show", boardId, "--json"])).stdout) as { board: { id: string }; prs: Array<{ key: string }> };
    expect(shown.board.id).toBe(boardId);
    expect(shown.prs.map((pr) => pr.key)).toEqual(["forge:acme/app#2", "forge:acme/app#1"]);
    const member = (await behavior.callRpc("boards", { archived: "include", key: "forge:acme/app#1" })) as { boards: Array<{ id: string }> };
    expect(member.boards.map((board) => board.id)).toEqual([boardId]);
    expect(text(await harness.callAgentTool("shuttle_board", { id: boardId }, { threadId: "thr_1", projectId: "proj_app" }))).toContain("Release board");

    expect(port.invalidations.some((tags) => tags.includes("boards"))).toBe(true);
    const tools = JSON.stringify(inspection.registrations);
    for (const name of [
      "shuttle_link",
      "shuttle_unlink",
      "shuttle_prs",
      "shuttle_review_draft",
      "shuttle_feedback_done",
      "shuttle_boards",
      "shuttle_board",
      "shuttle_board_create",
      "shuttle_board_update",
      "shuttle_board_add",
      "shuttle_board_remove",
    ]) expect(tools).toContain(name);
    await lifecycle.dispose();
  });

  it("takes a review's notes for the user through shuttle_review_draft and keeps them out of what posts", async () => {
    const { behavior, inspection, lifecycle, harness } = await boot();
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    const tool = inspection.registrations.agentTools.find((t) => t.name === "shuttle_review_draft")!;
    expect(JSON.stringify(tool.inputSchema)).toMatch(/"notes".*never posted/u);
    const saved = text(await harness.callAgentTool(
      "shuttle_review_draft",
      { pr: "forge:acme/app#2", summary: "Looks right", verdict: "comment", findings: [], notes: "  **Lean:** worth doing.  " },
      { threadId: "thr_1", projectId: "proj_app" },
    ));
    expect(saved).toContain("notes for the user");
    const detail = (await behavior.callRpc("detail", { key: "forge:acme/app#2" })) as { draft: { summary: string; notes: string | null } };
    expect(detail.draft).toMatchObject({ summary: "Looks right", notes: "**Lean:** worth doing." });
    await lifecycle.dispose();
  });

  it("refuses expected failures with typed codes and invalidates its reads after a background change", async () => {
    const { behavior, inspection, lifecycle } = await boot();
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    await expect(behavior.callRpc("watch", { key: "forge:acme/app#99", mode: "act" })).rejects.toMatchObject({ code: "not_found" });
    await behavior.callRpc("lookup", { query: "forge:acme/app#2" });
    await expect(behavior.callRpc("watch", { key: "forge:acme/app#2", mode: "act" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("no agent") });
    const before = inspection.experimental_rpcInvalidations.length;
    await behavior.callRpc("sync", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inspection.experimental_rpcInvalidations.slice(before)).toContainEqual(["prs", "servers", "conversation"]);
    const detail = (await behavior.callRpc("detail", { key: "forge:acme/app#7" })) as { pr: { key: string } };
    expect(detail.pr.key).toBe("forge:acme/app#2".replace("#2", "#7"));
    await lifecycle.dispose();
  });

  it("keeps cleanup pending across a reload and completes it through bb's idle event", async () => {
    const { behavior, lifecycle, harness, port, plugin } = await boot();
    const config = testConfig();
    config.servers[0]!.commands.review = "rv";
    await behavior.callRpc("importToml", { toml: configToToml(config), apply: true });
    await behavior.setSettings({ reviewCleanupPrompt: "Use cortex_update to close this review task." });
    await expect(behavior.setSettings({ reviewCleanupPrompt: "x".repeat(16_001) })).rejects.toThrow();
    const key = "forge:acme/app#2";
    await behavior.callRpc("lookup", { query: key });
    const { threadId } = await behavior.callRpc("review", { key }) as { threadId: string };
    await harness.callAgentTool("shuttle_review_draft", { pr: key, summary: "Looks right", verdict: "comment", findings: [] }, { threadId, projectId: "proj_app" });
    await behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText: "Review ready." });
    const { draft } = await behavior.callRpc("detail", { key }) as { draft: { id: number } };
    await behavior.callRpc("queueReview", { key, verdict: "comment", body: "Looks right", findings: [], draftId: draft.id });
    await expect.poll(() => port.sent).toHaveLength(1);
    expect(port.sent[0]!.text).toContain("Use cortex_update to close this review task.");
    expect(port.lifecycle).toEqual([]);
    const marker = port.sent[0]!.text.match(/\[shuttle:review-cleanup:\d+\]/u)![0];
    const reloaded = await lifecycle.reload(plugin);
    const next = reloaded.harness.behavior;
    await next.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText: "Still blocked." });
    expect(port.lifecycle).toEqual([]);
    const event = await next.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: threadId }), lastAssistantText: `Cleaned up.\n${marker}` });
    expect(event.errors).toEqual([]);
    await expect.poll(() => port.lifecycle).toEqual([`archive ${threadId}`]);
    expect(port.sent).toHaveLength(1);
    await reloaded.harness.lifecycle.dispose();
  });

  // bb gives a stopping service 5 s, then marks the plugin degraded and loads no new version until someone reloads it.
  it("stops the sync service at once when bb aborts it while bb holds a call, and dispose waits for that tick", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    let reached = false;
    class HeldPort extends FakePort {
      override async threadsById(threadIds: readonly string[]) {
        if (holding) {
          reached = true;
          await held;
        }
        return super.threadsById(threadIds);
      }
    }
    const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
    const { behavior, lifecycle, harness } = await boot({ port: new HeldPort(), now: () => clock.now });
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    await behavior.callRpc("lookup", { query: "forge:acme/app#2" });
    await behavior.callRpc("review", { key: "forge:acme/app#2" });
    // Three quiet hours later, the tick asks bb about the review thread, and bb does not answer.
    clock.now += 3 * 60 * 60_000;
    holding = true;
    const service = harness.runService("sync");
    await expect.poll(() => reached).toBe(true);

    service.controller.abort();
    const settled = await Promise.race([service.done.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("still running"), 200))]);
    expect(settled).toBe("stopped");

    let disposed = false;
    const disposing = lifecycle.dispose().then(() => (disposed = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("hands bb's thread.failed to Shuttle with whether the thread got a workspace, so only a setup failure starts the review again", async () => {
    const { behavior, lifecycle, harness, port } = await boot();
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    await behavior.callRpc("lookup", { query: "forge:acme/app#2" });
    const { threadId } = (await behavior.callRpc("review", { key: "forge:acme/app#2" })) as { threadId: string };
    // Not bb's "Provisioning thread failed", so only the environment it reports can say the workspace never came.
    const failed = (id: string, environmentId: string | null) =>
      harness.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id, status: "error", environmentId }), error: "The machine went away" });
    expect((await failed(threadId, "env_1")).errors).toEqual([]);
    expect(port.spawned).toHaveLength(1);

    const { threadId: second } = (await behavior.callRpc("review", { key: "forge:acme/app#2", newThread: true })) as { threadId: string };
    expect((await failed(second, null)).errors).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(port.spawned.map((s) => s.threadId)).toEqual([threadId, second, "thr_spawned3"]);
    await lifecycle.dispose();
  });
});
