import { cliCommand, defineCli, PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { terminalUserAct } from "./authority";
import type { TavernRuntime } from "./runtime";
import { currentAskNames } from "./quest-names";
import { settingsCommands } from "./settings/cli";
import { setupDiscoveryCommands } from "./settings/setup-discovery";
import { backupCommands } from "./backup/cli";
import type { BackupService } from "./backup/service";
import type { SetupService } from "./settings/setup";

function output(value: unknown) {
  return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
}

function statusOutput(runtime: TavernRuntime, thread?: string) {
  const { items, ...review } = runtime.review();
  const members = runtime.keeper.store.all("members").filter(m => !thread || m.threadId === thread || m.keeperThreadId === thread);
  const selected = new Set(members.map(m => m.threadId));
  const store = runtime.keeper.store;
  const asks = store.openAsks().filter(a => !thread || a.keeperThreadId === thread || a.scopeChange?.memberThreadId === thread).map(ask => currentAskNames(store, ask));
  const reviews = items.filter(i => !thread || i.member && selected.has(i.member.threadId));
  const project = ({ title, url, boardQuestId }: typeof items[number]) => ({ title, url, boardQuestId });
  const status = { members, asks, review: { ...review, items: reviews.map(project) } };
  const result = output(status);
  if (Buffer.byteLength(result.stdout) <= PLUGIN_CLI_OUTPUT_MAX_BYTES) return result;

  const list = <T,>(rows: T[], stamp: (value: T, index: number) => number) => {
    const sorted = rows.map((value, index) => ({ index, age: stamp(value, index), bytes: Buffer.byteLength(JSON.stringify(value)) + 1 }));
    return { sorted: sorted.sort((a, b) => a.age - b.age || a.index - b.index), bytes: sorted.reduce((sum, row) => sum + row.bytes, 0), omitted: new Set<number>() };
  };
  const byMember = list(members, m => m.createdAt), byAsk = list(asks, a => a.createdAt);
  const byReview = list(status.review.items, (_, i) => reviews[i]?.reportedAt ?? 0);
  const lists = [byMember, byAsk, byReview];
  const narrow = "Use bb tavern status --thread <id> to narrow the result.";
  const overhead = Buffer.byteLength(JSON.stringify({ members: [], asks: [], review: { ...review, items: [] }, truncated: { members: members.length, asks: asks.length, reviewItems: reviews.length, narrow } }));
  let bytes = overhead + lists.reduce((sum, group) => sum + group.bytes, 0);
  while (bytes > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    const largest = lists.reduce((a, b) => a.bytes >= b.bytes ? a : b);
    const row = largest.sorted[largest.omitted.size];
    if (!row) throw new PluginCliError("The fixed status fields are too large. Use bb tavern status --thread <id> to narrow the result.");
    largest.omitted.add(row.index); largest.bytes -= row.bytes; bytes -= row.bytes;
  }
  const truncated = { members: byMember.omitted.size, asks: byAsk.omitted.size, reviewItems: byReview.omitted.size, narrow };
  return { exitCode: 0, stdout: JSON.stringify({
    members: members.filter((_, i) => !byMember.omitted.has(i)),
    asks: asks.filter((_, i) => !byAsk.omitted.has(i)),
    review: { ...review, items: status.review.items.filter((_, i) => !byReview.omitted.has(i)) },
    ...(lists.some(group => group.omitted.size) ? { truncated } : {}),
  }) };
}
export function registerCli(bb: BbPluginApi, runtime: TavernRuntime, backups?: BackupService, setup?: SetupService) {
  const scopes = () => {
    if (!runtime.scopes) throw new Error("Tavern scopes are not registered");
    return runtime.scopes;
  };
  const guard = (action: "status" | "install" | "uninstall", ctx: PluginCliContext) => {
    if (ctx.threadId && action !== "status")
      throw new PluginCliError("Agents cannot install or remove the guard. Use an ordinary terminal.");
    const result = action === "status" ? scopes().guard(action) : terminalUserAct(ctx, action === "install" ? "guardInstall" : "guardUninstall", runtime.keeper.store, () => runtime.keeper.now(), () => scopes().guard(action));
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
        ...(runtime.settings ? { ...settingsCommands(bb, runtime.settings), ...setupDiscoveryCommands(bb, runtime.settings) } : {}),
        ...(backups ? backupCommands(backups) : {}),
        ...(setup ? setup.commands() : {}),
        "stop-all": cliCommand({
          summary: "Stop every Keeper and member turn and hold new Tavern work",
          run: async (_input, ctx) => output(await runtime.stopAll.stop(ctx.threadId ? { kind: "agent", threadId: ctx.threadId } : { kind: "user" }, { surface: "CLI" })),
        }),
        "stop-all status": cliCommand({
          summary: "Read the stored Stop all state and last receipt; resume only on the common room",
          run: () => output(runtime.stopAll.snapshot()),
        }),
        status: cliCommand({
          summary: "Read the party and needs-you queue",
          options: { thread: { type: "string", description: "Show one thread and its party" } },
          run: input => statusOutput(runtime, input.options.thread),
        }),
        "study-events": cliCommand({
          summary: "Export private local study events as JSON",
          options: { after: { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, default: 0, description: "Continue from the preceding JSON page's next cursor" } },
          run: ({ options }, ctx) => {
            if (ctx.threadId) throw new PluginCliError("Run study-events from your terminal, outside a thread.");
            return { exitCode: 0, stdout: JSON.stringify(runtime.study.page(options.after ?? 0)) };
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
              throw new PluginCliError(
                "Agents cannot answer the user's asks. Use the banner, page, phone or an ordinary terminal.",
              );
            await terminalUserAct(ctx, "answerAsk", runtime.keeper.store, () => runtime.keeper.now(), receipt => runtime.answerAsk(input.positionals.id, input.positionals.option, null, "cli", true, "terminal", receipt));
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
              "Run node node_modules/vitest/vitest.mjs run test/server/steer.test.ts in plugins/tavern.\nLive replay: docs/contributing/development.md#steer-replay\nIndex: stage first\nWhat is waiting?\nThanks for the update\nProxy: retry only once\nWhich model checks it?\nIndex: keep the rollback\nThat reminds me of the old setup\nProxy: stop the extra rollout\nWhat is the ETA?\nIndex: test staging again",
          }),
        }),
      },
    }),
  );
}
