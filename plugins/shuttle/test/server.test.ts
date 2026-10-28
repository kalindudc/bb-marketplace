// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { configToToml } from "../src/config";
import { createShuttlePlugin } from "../server";
import { FakePort, testConfig, fakeRunner, pr } from "./helpers";

async function boot() {
  const port = new FakePort();
  port.addThread("thr_1", "Owner");
  const runner = fakeRunner((operation, env) => {
    if (operation === "whoami") return { login: "me" };
    if (operation === "authored") return [pr(1, { author: "me" })];
    if (operation === "view") return pr(Number(env.SHUTTLE_NUMBER), { author: Number(env.SHUTTLE_NUMBER) === 1 ? "me" : "dana", review: Number(env.SHUTTLE_NUMBER) === 1 ? "approved" : "required" });
    if (operation === "activity") return { items: [] };
    return [];
  });
  const host = createFakePluginHost({ pluginId: "shuttle", dataDir: mkdtempSync(join(tmpdir(), "shuttle-")) });
  await createShuttlePlugin({ port: () => port, runner, tickMs: 3_600_000 })(host.bb);
  const { behavior, inspection, lifecycle } = host.harness;
  return { port, behavior, inspection, lifecycle, harness: host.harness };
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
    expect(inflight.prs.map((p) => p.key)).toEqual(["forge:shop/world#1"]);
    await behavior.callRpc("link", { key: "https://forge.test/shop/world/pull/2", threadId: "thr_1" });
    const linked = (await behavior.callRpc("threadPrs", { threadId: "thr_1" })) as { prs: Array<{ key: string }> };
    expect(linked.prs.map((p) => p.key)).toEqual(["forge:shop/world#2"]);
    const cli = await behavior.runCli(["link", "forge:shop/world#1"], { threadId: "thr_1" } as never);
    expect(cli, JSON.stringify(cli)).toMatchObject({ exitCode: 0 });
    const list = await behavior.runCli(["list", "--area", "mine"]);
    expect(list.stdout).toContain("forge:shop/world#1");

    const created = text(await harness.callAgentTool(
      "shuttle_board_create",
      { name: "Release board", prs: ["https://forge.test/shop/world/pull/2"] },
      { threadId: "thr_1", projectId: "proj_world" },
    ));
    expect(created).toContain("Release board");
    const boards = (await behavior.callRpc("boards", { archived: "include" })) as { boards: Array<{ id: string; name: string; createdBy: string | null }> };
    expect(boards.boards).toMatchObject([{ name: "Release board", createdBy: "thr_1" }]);
    const boardId = boards.boards[0]!.id;

    const add = JSON.parse((await behavior.runCli(["board", "add", boardId, "forge:shop/world#1", "--json"])).stdout) as { added: string[]; alreadyPresent: string[] };
    expect(add).toMatchObject({ added: ["forge:shop/world#1"], alreadyPresent: [] });
    const shown = JSON.parse((await behavior.runCli(["board", "show", boardId, "--json"])).stdout) as { board: { id: string }; prs: Array<{ key: string }> };
    expect(shown.board.id).toBe(boardId);
    expect(shown.prs.map((pr) => pr.key)).toEqual(["forge:shop/world#2", "forge:shop/world#1"]);
    const member = (await behavior.callRpc("boards", { archived: "include", key: "forge:shop/world#1" })) as { boards: Array<{ id: string }> };
    expect(member.boards.map((board) => board.id)).toEqual([boardId]);
    expect(text(await harness.callAgentTool("shuttle_board", { id: boardId }, { threadId: "thr_1", projectId: "proj_world" }))).toContain("Release board");

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

  it("refuses expected failures with typed codes and invalidates its reads after a background change", async () => {
    const { behavior, inspection, lifecycle } = await boot();
    await behavior.callRpc("importToml", { toml: configToToml(testConfig()), apply: true });
    await expect(behavior.callRpc("watch", { key: "forge:shop/world#99", mode: "act" })).rejects.toMatchObject({ code: "not_found" });
    await behavior.callRpc("lookup", { query: "forge:shop/world#2" });
    await expect(behavior.callRpc("watch", { key: "forge:shop/world#2", mode: "act" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("no agent") });
    const before = inspection.experimental_rpcInvalidations.length;
    await behavior.callRpc("sync", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inspection.experimental_rpcInvalidations.slice(before)).toContainEqual(["prs", "servers", "conversation"]);
    const detail = (await behavior.callRpc("detail", { key: "forge:shop/world#7" })) as { pr: { key: string } };
    expect(detail.pr.key).toBe("forge:shop/world#2".replace("#2", "#7"));
    await lifecycle.dispose();
  });
});
