// @vitest-environment node
import type { ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AUTHORITY, authorize, requireUserAct } from "../../src/server/authority";
import { rpcHandlers } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";
import { seedQuest } from "./support";
import { SettingsStore } from "../../src/server/settings/store";
import { SettingsFiles } from "../../src/server/settings/files";
import { settingsHandlers } from "../../src/server/settings/rpc";
import { backupHandlers } from "../../src/server/backup/rpc";
import type { BackupService } from "../../src/server/backup/service";
import { registerCli } from "../../src/server/cli";

const client = { experimental_caller: { kind: "client" as const }, experimental_signal: new AbortController().signal };
describe("one authority policy", () => {
  it("requires the user's cited words, not a bare user actor, to reopen", async () => {
    const f = setup(), q = await seedQuest(f.k, "lead", "Stopped", "Stopped");
    await f.runtime.stop(q.id);
    expect(() => f.k.reopenQuest(q.id, { kind: "user" })).toThrow(/user-in-words/);
  });
  it("refuses plugins and agent-marked clients on every registered user-only RPC", async () => {
    const f = setup(), settings = new SettingsStore(f.k.store.db);
    const handlers = { ...rpcHandlers(f.runtime), ...settingsHandlers(settings, new SettingsFiles(settings, "/nonexistent/settings.toml")), ...backupHandlers({ options: { settings } } as BackupService) };
    let checked = 0;
    for (const [name, handler] of Object.entries(handlers)) {
      if (!(name in AUTHORITY) || AUTHORITY[name as keyof typeof AUTHORITY].level !== "user-explicit") continue;
      checked++;
      for (const caller of [{ kind: "plugin", pluginId: "tavern" }, { kind: "client", threadId: "agent" }, { kind: "client", agent: true }, { kind: "client", cli: true }]) {
        const input = { apply: true, action: "save" };
        await expect(async () => (handler as Function)(input, { experimental_caller: caller })).rejects.toThrow(/client/);
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
  it.each(["placementRetry", "placementModelFailureClear", "saveCharacterAvatar", "saveCharacterVoice"])("requires user authority before %s reads input", async act => {
    expect(AUTHORITY).toHaveProperty(act, expect.objectContaining({ level: "user-explicit" }));
    const f = setup();
    for (const context of [undefined, { experimental_caller: { kind: "plugin", pluginId: "other" } }, { experimental_caller: { kind: "client", threadId: "agent" } }, { experimental_caller: { kind: "client", cli: true } }])
      await expect(async () => (rpcHandlers(f.runtime) as any)[act](undefined, context)).rejects.toThrow(/explicit client action/);
  });
  it("refuses a context without a caller instead of dereferencing it", () => {
    expect(() => requireUserAct({} as ExperimentalPluginRpcHandlerContext, "answerAsk")).toThrow(/explicit client action/);
  });
  it("records the terminal surface for an ordinary settings command", async () => {
    const f = setup();
    f.runtime.settings = new SettingsStore(f.k.store.db);
    registerCli(f.bb, f.runtime);
    expect((await f.harness.inspection.registrations.cli[0]!.run(["settings", "set", "attention.reviewBudget=4", "--apply"], {})).exitCode).toBe(0);
    expect(f.k.store.events().find(event => event.type === "authority.acted")?.data).toMatchObject({ act: "settingsUpdate", surface: "terminal" });
  });
  it.each([
    ["ask", "ask-id", "approve"], ["guard", "install"], ["guard", "uninstall"],
    ["settings", "export", "--file", "/tmp/settings.toml", "--host", "host"],
    ["backup", "restore", "fixture", "--apply"],
  ])("refuses a thread's user-only CLI command %s", async (...args) => {
    const f = setup();
    f.runtime.settings = new SettingsStore(f.k.store.db);
    registerCli(f.bb, f.runtime, {} as BackupService);
    const result = await f.harness.inspection.registrations.cli[0]!.run(args, { threadId: "agent" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Agents/);
  });
  it.each(Object.entries(AUTHORITY))("enforces %s", (act, rule) => {
    if (rule.level === "user-explicit") {
      expect(requireUserAct(client, act as keyof typeof AUTHORITY)).toMatchObject({ act, surface: "client (unattested)" });
      for (const context of [undefined, { experimental_caller: { kind: "plugin", pluginId: "other" } }, { experimental_caller: { kind: "client", threadId: "agent" } }, { ...client, cli: true }, { ...client, cliContext: {} }])
        expect(() => requireUserAct(context as never, act as keyof typeof AUTHORITY)).toThrow();
    } else {
      expect(() => authorize(act as keyof typeof AUTHORITY, { level: rule.level, receipt: "proof" })).not.toThrow();
      expect(() => authorize(act as keyof typeof AUTHORITY, { level: "user-explicit", receipt: "proof" })).toThrow();
    }
  });
  it.each(["answerAsk", "stopBoardQuest", "addRule", "widenRule", "confirmRule", "undoDecision", "correctRoute", "holdBoardQuest", "resumeBoardQuest", "journalEdit", "saveCharacterVoice"])("refuses a plugin before %s reads input", async act => {
    const f = setup();
    await expect(async () => (rpcHandlers(f.runtime) as any)[act]({}, { experimental_caller: { kind: "plugin", pluginId: "other" } })).rejects.toThrow(/client/);
  });
});
