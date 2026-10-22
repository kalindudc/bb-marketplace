import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { type Complete, createProxy } from "./src/proxy";
import { type Outcome, retitle } from "./src/retitle";

// bb gives its own title request 8 seconds; check once it has surely settled.
export const AUTO_DELAY_MS = 10_000;
const PAGE_SIZE = 200;

function describe(outcome: Outcome): string {
  return outcome.status === "titled"
    ? `${outcome.threadId}  ${outcome.title}`
    : `${outcome.threadId}  ${outcome.status}: ${outcome.reason}`;
}

export default function retitlePlugin(bb: BbPluginApi, complete: Complete = createProxy()): void {
  const deps = () => ({ sdk: bb.sdk, complete });
  const attempted = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  bb.onDispose(() => timers.forEach(clearTimeout));

  bb.events.on("thread.active", ({ thread }) => {
    if (thread.title || thread.visibility === "hidden" || attempted.has(thread.id)) return;
    attempted.add(thread.id);
    const timer = setTimeout(async () => {
      timers.delete(timer);
      try {
        const outcome = await retitle(deps(), thread.id, false);
        if (outcome.status !== "skipped") bb.log.info(`auto: ${describe(outcome)}`);
      } catch (error) {
        bb.log.warn(`auto: ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, AUTO_DELAY_MS);
    timers.add(timer);
  });

  bb.cli.register(
    defineCli({
      name: "retitle",
      summary: "Title a thread again with Shopify AI, or backfill threads bb left untitled",
      commands: {},
      root: cliCommand({
        summary: "Title one thread (even a titled one), or every untitled thread with --untitled",
        positionals: [{ name: "thread", description: "Thread id; defaults to the thread you run it from" }],
        options: {
          untitled: { type: "boolean", description: "Title every visible, unarchived thread that has no title" },
          project: { type: "string", description: "With --untitled, only this project's threads" },
          limit: { type: "integer", min: 1, max: 500, default: 20, description: "With --untitled, title at most this many, newest first (1 to 500)" },
          "dry-run": { type: "boolean", description: "With --untitled, list the threads without titling them" },
          json: { type: "boolean", description: "Print the outcomes as JSON" },
        },
        async run({ positionals, options }, ctx) {
          const print = (outcomes: Outcome[]) => ({
            exitCode: outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0,
            stdout: options.json ? JSON.stringify(outcomes, null, 2) : outcomes.map(describe).join("\n") || "No untitled threads.",
          });

          if (!options.untitled) {
            if (options.project || options["dry-run"]) {
              throw new PluginCliError("--project and --dry-run only apply with --untitled", { code: "invalid_options" });
            }
            const threadId = positionals.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("Name the thread to title", {
                code: "thread_required",
                hint: "Run `bb retitle <thread-id>`, or `bb retitle --untitled` to backfill.",
              });
            }
            return print([await retitle(deps(), threadId, true)]);
          }
          if (positionals.thread) {
            throw new PluginCliError("Pass a thread id or --untitled, not both", { code: "invalid_options" });
          }

          const untitled = [];
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const page = await bb.sdk.threads.list({ projectId: options.project, limit: PAGE_SIZE, offset });
            untitled.push(...page.filter((t) => !t.title && !t.archivedAt && t.visibility !== "hidden"));
            if (page.length < PAGE_SIZE) break;
          }
          const targets = untitled.sort((a, b) => b.createdAt - a.createdAt).slice(0, options.limit);
          if (options["dry-run"]) {
            const lines = targets.map((t) => `${t.id}  ${t.titleFallback ?? "(no text)"}`);
            return { exitCode: 0, stdout: options.json ? JSON.stringify(targets.map((t) => t.id)) : lines.join("\n") || "No untitled threads." };
          }
          const outcomes: Outcome[] = [];
          for (const thread of targets) outcomes.push(await retitle(deps(), thread.id, false));
          return print(outcomes);
        },
      }),
    }),
  );
}
