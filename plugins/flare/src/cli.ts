import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { flaresText } from "./format";
import { KINDS } from "./kinds";
import type { FlareService } from "./service";
import { resultText } from "./tools";

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const thread = { type: "string", description: "The thread to use; defaults to the thread the command runs in" } as const;

function targetThread(option: string | undefined, ctx: { threadId?: string }): string {
  const id = option ?? ctx.threadId;
  if (id === undefined || id === "") {
    throw new PluginCliError("No thread to use", {
      code: "no_thread",
      exitCode: 2,
      hint: "Run it inside a bb thread, or pass --thread <thread-id>.",
    });
  }
  return id;
}

export function registerCli(bb: BbPluginApi, flares: FlareService): void {
  bb.cli.register(
    defineCli({
      name: "flare",
      summary: "Send a flare the user sees mid-turn, or list a thread's flares",
      usageErrorExitCode: 2,
      commands: {
        send: cliCommand({
          summary: "Send a flare: a short note the user sees at once in the thread's banner and Flares tab",
          description:
            "It returns at once and nothing replies, so keep working after it. Blockers, and flares sent with --notify, also push a notification when the user's settings allow.",
          positionals: [{ name: "title", description: "One line that stands on its own, about 80 characters", variadic: true }],
          options: {
            body: { type: "string", description: "Markdown detail: evidence, numbers, paths. A few lines at most." },
            kind: { type: "enum", values: KINDS, default: "finding", description: "finding, progress, decision, blocker or summary" },
            notify: { type: "boolean", description: "Also push a notification to the user's devices" },
            thread,
            json,
          },
          async run({ options, positionals }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            const projectId = options.thread === undefined ? (ctx.projectId ?? null) : null;
            const fields = { title: positionals.title.join(" "), body: options.body, kind: options.kind, notify: options.notify };
            const result = flares.send({ threadId, projectId, fields, source: "cli" });
            const exitCode = result.status === "refused" ? 2 : result.status === "failed" ? 1 : 0;
            if (options.json) {
              const flare = "flare" in result ? { id: result.flare.id, threadId: result.flare.threadId, kind: result.flare.kind, title: result.flare.title } : null;
              const notes = result.status === "sent" ? result.notes : [];
              const reason = "reason" in result ? result.reason : null;
              return { exitCode, stdout: `${JSON.stringify({ status: result.status, flare, notes, reason }, null, 2)}\n` };
            }
            const text = `${resultText(result)}\n`;
            return exitCode === 0 ? { exitCode, stdout: text } : { exitCode, stderr: text };
          },
        }),
        list: cliCommand({
          summary: "List a thread's flares, newest first, including those from threads it started",
          options: {
            limit: { type: "integer", min: 1, max: 5000, default: 20, description: "How many flares to print, at most 5000" },
            own: { type: "boolean", description: "Only the thread's own flares, without its child threads'" },
            full: { type: "boolean", description: "Print each body in full instead of one line" },
            thread,
            json,
          },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            const rows = flares.list(threadId, { limit: options.limit, children: !options.own });
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ threadId, flares: rows }, null, 2)}\n` };
            return { exitCode: 0, stdout: flaresText(rows, threadId, Date.now(), { bodies: options.full ? "full" : "excerpt" }) };
          },
        }),
      },
    }),
  );
}
