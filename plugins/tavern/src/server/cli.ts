import { cliCommand, defineCli, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import type { TavernRuntime } from "./runtime";
import { settingsCommands } from "./settings/cli";
import { backupCommands } from "./backup/cli";
import type { BackupService } from "./backup/service";

function output(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    exitCode: 0,
    stdout:
      text.length <= 60000
        ? text
        : `${text.slice(0, 59800)}\nOutput truncated; request one thread or a narrower result.`,
  };
}
export function registerCli(bb: BbPluginApi, runtime: TavernRuntime, backups?: BackupService) {
  const scopes = () => {
    if (!runtime.scopes) throw new Error("Tavern scopes are not registered");
    return runtime.scopes;
  };
  const guard = (action: "status" | "install" | "uninstall", ctx: PluginCliContext) => {
    if (ctx.threadId && action !== "status")
      throw new PluginCliError("Agents cannot install or remove the guard. Use an ordinary terminal.");
    const result = scopes().guard(action);
    return {
      ...output(result),
      exitCode: result === "unmarked" || result === "no-agent-dir" ? 1 : 0,
    };
  };
  bb.cli.register(
    defineCli({
      name: "tavern",
      summary: "Read the board, answer asks and inspect Tavern guardrails",
      commands: {
        ...(runtime.settings ? settingsCommands(bb, runtime.settings) : {}),
        ...(backups ? backupCommands(backups) : {}),
        status: cliCommand({
          summary: "Read the party and needs-you queue",
          run: () => {
            const review = runtime.review();
            return output({
              members: runtime.keeper.store.all("members"),
              asks: runtime.keeper.store.openAsks(),
              review: { ...review, items: review.items.map(({ title, url, boardQuestId }) => ({ title, url, boardQuestId })) },
            });
          },
        }),
        quests: cliCommand({
          summary: "List board quests",
          run: () => ({
            exitCode: 0,
            stdout: runtime.keeper.store
              .all("quests")
              .map((q) => `${q.id}\t${q.phase}\tv${q.planVersion}\t${q.title}`)
              .join("\n"),
          }),
        }),
        ask: cliCommand({
          summary: "Answer an ask as the user (not as an agent)",
          positionals: [
            { name: "id", description: "Ask id", required: true },
            { name: "option", description: "Option id", required: true },
          ],
          run: async (input, ctx) => {
            if (ctx.threadId)
              throw new Error(
                "Agents cannot answer the user's asks. Use the banner, page, phone or an ordinary terminal.",
              );
            await runtime.answerAsk(input.positionals.id, input.positionals.option, null, "cli");
            void runtime
              .tick(runtime.keeper.store.get("asks", input.positionals.id)!.keeperThreadId)
              .catch((error) => bb.log.warn(String(error)));
            return { exitCode: 0, stdout: "Answer recorded." };
          },
        }),
        scope: cliCommand({
          summary: "Show a thread's resolved scope and guard arming state",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          run: (input) =>
            output({
              thread: scopes().view(input.positionals.thread),
              guard: scopes().api.status().guard,
            }),
        }),
        violations: cliCommand({
          summary: "Show scope violations with evidence, stop results and latency",
          positionals: [{ name: "thread", description: "Optional thread id" }],
          run: (input) => output(scopes().api.violations(input.positionals.thread).slice(-100)),
        }),
        "guard status": cliCommand({
          summary: "Inspect the pi guard shim",
          run: (_input, ctx) => guard("status", ctx),
        }),
        "guard install": cliCommand({
          summary: "Install or update only the Tavern-marked pi shim",
          run: (_input, ctx) => guard("install", ctx),
        }),
        "guard uninstall": cliCommand({
          summary: "Remove only the Tavern-marked pi shim",
          run: (_input, ctx) => guard("uninstall", ctx),
        }),
        "journal export": cliCommand({
          summary: "Print a thread's journal as Markdown, grouped as the panel shows it",
          positionals: [{ name: "thread", description: "Thread id; defaults to the calling thread" }],
          options: { markdown: { type: "boolean", description: "Markdown output, the only format for now" } },
          run: async (input, ctx) => {
            const threadId = input.positionals.thread ?? ctx.threadId;
            if (!threadId) throw new PluginCliError("Name a thread: bb tavern journal export <thread> --markdown");
            return { exitCode: 0, stdout: await runtime.keeper.journal.exportMarkdown(threadId) };
          },
        }),
        "steer-test": cliCommand({
          summary: "Print the two-goal steer replay",
          run: () => ({
            exitCode: 0,
            stdout:
              "Run npx vitest run test/server/steer.test.ts in plugins/tavern.\nLive replay: docs/steer-test.md\nVault: stage first\nWhat is waiting?\nLook up lunch menus\nProxy: retry only once\nWhich model checks it?\nVault: keep the rollback\nCheck the weather\nProxy: stop the extra rollout\nWhat is the ETA?\nVault: test staging again",
          }),
        }),
      },
    }),
  );
}
