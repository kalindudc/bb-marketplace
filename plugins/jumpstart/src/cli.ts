import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { KickResult } from "./contract";
import { kickThreads, listFailedThreads, type FailedThread } from "./threads";

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function textThread(thread: FailedThread): string {
  const kind = thread.network ? "network" : "other";
  const when = thread.failedAt === null ? "" : ` (${iso(thread.failedAt)})`;
  const queued = thread.queued ? " [a message is already queued]" : "";
  return `${thread.id}  ${kind}  ${thread.title}${queued}\n  ${thread.reason ?? "bb logged no error for its last turn"}${when}`;
}

function textResult(result: KickResult): string {
  switch (result.outcome) {
    case "sent":
      return `${result.threadId}  ${result.restarted ? "restarted the agent, resuming" : "resuming"}`;
    case "queued":
      return `${result.threadId}  ${result.restarted ? "restarted the agent, " : ""}queued: ${result.waitingOn}`;
    case "failed":
      return `${result.threadId}  failed: ${result.message}`;
  }
}

const lines = (items: string[]): string => (items.length === 0 ? "" : `${items.join("\n")}\n`);

export function registerCli(bb: BbPluginApi): void {
  bb.cli.register(
    defineCli({
      name: "jumpstart",
      summary: "Resume threads that stopped on an error, such as a dropped connection",
      usageErrorExitCode: 2,
      commands: {
        list: cliCommand({
          summary: "List failed threads, newest failure first, with the error that stopped each",
          description: "`network` marks a dropped connection, a timeout or a provider outage, which a retry can get past.",
          options: { json },
          async run({ options }) {
            const threads = await listFailedThreads(bb.sdk);
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ threads }, null, 2)}\n` };
            return { exitCode: 0, stdout: threads.length === 0 ? "No failed threads.\n" : lines(threads.map(textThread)) };
          },
        }),
        kick: cliCommand({
          summary: "Retry the failed turn on the threads you name, on every network failure, or on every failed thread",
          description:
            "A retry continues a turn the agent had started with \"Please continue.\" and sends a turn it never started again, with the same model. When the error says the agent's process died or stopped answering, the thread is stopped first so bb starts a fresh one. --network and --all leave out threads that already have a message queued.",
          positionals: [{ name: "thread-id", description: "Threads to resume", variadic: true }],
          options: {
            network: { type: "boolean", description: "Every failed thread whose error looks like a network failure" },
            all: { type: "boolean", description: "Every failed thread" },
            json,
          },
          constraints: [{ kind: "at-most-one", options: ["network", "all"] }],
          async run({ options, positionals }) {
            const named = positionals["thread-id"];
            const bulk = options.network || options.all;
            if (named.length > 0 === bulk) {
              throw new PluginCliError("Name the threads to resume, or pass --network or --all", {
                code: "invalid_selection",
                exitCode: 2,
                hint: "Run `bb jumpstart list` to see the failed threads.",
              });
            }
            const ids = bulk
              ? (await listFailedThreads(bb.sdk))
                  .filter((thread) => !thread.queued && (options.all || thread.network))
                  .map((thread) => thread.id)
              : named;
            const results = ids.length === 0 ? [] : await kickThreads(bb.sdk, ids);
            const exitCode = results.some((result) => result.outcome === "failed") ? 1 : 0;
            if (options.json) return { exitCode, stdout: `${JSON.stringify({ results }, null, 2)}\n` };
            return { exitCode, stdout: results.length === 0 ? "No failed threads to resume.\n" : lines(results.map(textResult)) };
          },
        }),
      },
    }),
  );
}
