import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { resolvePolicy } from "./policy";
import type { PressStore, DecisionRow } from "./store";
import type { PressService } from "./service";
import { ledgerPath, readLedger } from "./ledger";
import { composerPaths, ensureComposerInstalled } from "./installer";

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const threadOption = { type: "string", description: "The thread to use; defaults to the thread the command runs in" } as const;

function envThreadId(): string | undefined {
  const value = process.env.BB_THREAD_ID;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function targetThread(positional: string | undefined, ctx: { threadId?: string }): string {
  const id = positional ?? ctx.threadId ?? envThreadId();
  if (id === undefined || id === "") {
    throw new PluginCliError("No thread to use", {
      code: "no_thread",
      hint: "Run it inside a bb thread, or name a thread id.",
    });
  }
  return id;
}

function describeDecision(row: DecisionRow): string {
  const at = new Date(row.at).toISOString();
  const outcome = row.outcome === null ? "" : `  outcome=${row.outcome}${row.outcomeError !== null ? ` (${row.outcomeError})` : ""}`;
  return `${at}  ${row.threadId}  ${row.decision}  point=${row.point ?? "-"}  reason=${row.reason ?? "-"}  ${row.percent ?? "?"}%  est=${row.estMs}ms  mode=${row.mode}${outcome}`;
}

export function registerCli(bb: BbPluginApi, store: PressStore, service: PressService): void {
  bb.cli.register(
    defineCli({
      name: "press",
      summary: "The compaction governor: status, policy, decision log, manual compaction and the ledger",
      commands: {
        status: cliCommand({
          summary: "One line per idle thread: context percent, mode, last compaction",
          positionals: [{ name: "thread", description: "One thread to show; without it, every idle thread" }],
          options: {
            limit: { type: "integer", min: 1, max: 200, default: 20, description: "How many threads, newest first" },
            json,
          },
          async run({ positionals, options }) {
            if (positionals.thread !== undefined) {
              const status = await service.buildThreadStatus(positionals.thread);
              return { exitCode: 0, stdout: `${options.json ? JSON.stringify(status, null, 2) : JSON.stringify(status)}\n` };
            }
            const threads = (await bb.sdk.threads.list({ limit: options.limit })) as unknown as Array<{
              id: string;
              status?: string;
              archivedAt?: number | null;
              createdAt: number;
            }>;
            const statuses = [];
            for (const thread of threads) {
              if (thread.archivedAt != null || thread.status !== "idle") continue;
              statuses.push(await service.buildThreadStatus(thread.id));
            }
            statuses.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0) || a.threadId.localeCompare(b.threadId));
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ threads: statuses }, null, 2)}\n` };
            const text = statuses
              .map((row) => {
                const percent = row.percent !== null ? `${row.percent.toFixed(0)}%` : "?";
                const last = row.lastCompaction !== null ? row.lastCompaction.at : "never";
                return `${row.threadId}  ${percent}  mode=${row.mode}  next=${row.nextPoint ?? "-"}  last=${last}`;
              })
              .join("\n");
            return { exitCode: 0, stdout: `${text || "No idle threads."}\n` };
          },
        }),
        policy: cliCommand({
          summary: "Show the resolved policy, or set or reset an override",
          positionals: [
            { name: "action", description: "show (default), set or reset" },
            { name: "value", description: "With set: the policy JSON" },
          ],
          options: { thread: threadOption, json },
          async run({ positionals, options }, ctx) {
            const action = positionals.action ?? "show";
            if (action === "set") {
              if (positionals.value === undefined) {
                throw new PluginCliError("No policy to set", {
                  code: "policy_required",
                  hint: `Pass the policy JSON: bb press policy set '{ "mode": "auto" }'.`,
                });
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(positionals.value);
              } catch (error) {
                throw new PluginCliError("The policy is not valid JSON", {
                  code: "invalid_json",
                  hint: error instanceof Error ? error.message : String(error),
                });
              }
              resolvePolicy([{ source: "cli", value: parsed }]);
              if (options.thread !== undefined) {
                store.setThreadPolicyOverride(options.thread, JSON.stringify(parsed));
                return { exitCode: 0, stdout: `Per-thread override saved for ${options.thread}.\n` };
              }
              const threadId = ctx.threadId;
              const workspace = threadId !== undefined ? await service.workspaceOfThread(threadId) : null;
              if (workspace === null) {
                throw new PluginCliError("No workspace to write the policy to", {
                  code: "no_workspace",
                  hint: "Run inside a bb thread, or use --thread to name one.",
                });
              }
              const io = service.ledgerIo(workspace);
              const base = `${workspace.path.replace(/[/\\]+$/, "")}/.bb/press`;
              await io.mkdir(base);
              await io.write(`${base}/policy.json`, `${JSON.stringify(parsed, null, 2)}\n`);
              return { exitCode: 0, stdout: `Workspace policy saved to ${base}/policy.json.\n` };
            }
            if (action === "reset") {
              if (options.thread !== undefined) {
                store.setThreadPolicyOverride(options.thread, null);
                return { exitCode: 0, stdout: `Per-thread override cleared for ${options.thread}.\n` };
              }
              const threadId = ctx.threadId;
              const workspace = threadId !== undefined ? await service.workspaceOfThread(threadId) : null;
              if (workspace === null) {
                throw new PluginCliError("No workspace to reset the policy of", {
                  code: "no_workspace",
                  hint: "Run inside a bb thread, or use --thread to name one.",
                });
              }
              const path = `${workspace.path.replace(/[/\\]+$/, "")}/.bb/press/policy.json`;
              try {
                await bb.sdk.files.remove({
                  path,
                  ...(workspace.hostId !== null ? { hostId: workspace.hostId } : {}),
                });
                return { exitCode: 0, stdout: `Workspace policy removed: ${path}\n` };
              } catch {
                return { exitCode: 0, stdout: `No workspace policy at ${path}\n` };
              }
            }
            const threadId = options.thread ?? ctx.threadId ?? null;
            const workspace = threadId !== null ? await service.workspaceOfThread(threadId) : null;
            const policy = await service.policyFor(threadId ?? "(none)", workspace);
            return { exitCode: 0, stdout: `${options.json ? JSON.stringify(policy, null, 2) : JSON.stringify(policy)}\n` };
          },
        }),
        log: cliCommand({
          summary: "The decision log: one row per evaluation that reached a trigger or a veto",
          options: {
            thread: threadOption,
            limit: { type: "integer", min: 1, max: 5000, default: 20, description: "How many rows, newest first" },
            json,
          },
          async run({ options }) {
            const rows = store.decisions({ threadId: options.thread, limit: options.limit });
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ rows }, null, 2)}\n` };
            return { exitCode: 0, stdout: `${rows.map(describeDecision).join("\n") || "No decisions recorded yet."}\n` };
          },
        }),
        compact: cliCommand({
          summary: "Evaluate a thread now and, in auto mode, ask the provider to compact",
          positionals: [{ name: "thread", description: "Thread id; defaults to the thread you run it from" }],
          options: {
            point: { type: "string", description: "Force this compaction point as the candidate" },
            "dry-run": { type: "boolean", description: "Record the decision but do not act, even in auto mode" },
            json,
          },
          async run({ positionals, options }, ctx) {
            const threadId = targetThread(positionals.thread, ctx);
            const result = await service.evaluate(threadId, {
              origin: "cli",
              forcePoint: options.point,
              dryRun: options["dry-run"] === true,
            });
            const summary = {
              threadId,
              decision: result.decision.decision,
              point: result.decision.point,
              reason: result.decision.reason,
              percent: result.decision.percent,
              tokens: result.decision.tokens,
              window: result.decision.window,
              estMs: result.decision.estMs,
              estCostUsd: result.decision.estCostUsd,
              mode: result.mode,
              acted: result.acted,
            };
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(summary, null, 2)}\n` };
            const head =
              result.decision.decision === "skip"
                ? "no compaction point fires"
                : `${result.decision.decision}: point ${result.decision.point}, reason ${result.decision.reason ?? "-"}`;
            return {
              exitCode: 0,
              stdout: `${threadId}  ${head}  mode=${result.mode}${result.acted ? "  compaction requested" : ""}\n`,
            };
          },
        }),
        point: cliCommand({
          summary: "Record an agent hint: now is a good moment to compact this thread",
          description:
            "Writes a hint row the service consumes on its next evaluation, so the `agent` compaction point fires once. Run it through bash whenever a phase of your work just finished.",
          positionals: [],
          options: {
            reason: { type: "string", default: "agent hint", description: "One line on what just finished" },
            thread: threadOption,
            json,
          },
          async run({ options }, ctx) {
            const threadId = targetThread(options.thread, ctx);
            const at = Date.now();
            const row = store.recordHint({ threadId, at, reason: options.reason });
            const iso = new Date(at).toISOString();
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify({ hint: { id: row.id, threadId, at: iso, reason: row.reason } }, null, 2)}\n` };
            }
            return { exitCode: 0, stdout: `hint recorded for ${threadId} at ${iso}\n` };
          },
        }),
        composer: cliCommand({
          summary: "Show the Press composer's install state, or install it into pi",
          description:
            "The composer is the pi extension that writes the summary. Press keeps it installed at ~/.pi/agent/extensions/press-composer from its own composer directory; this reports that install and can force one.",
          positionals: [],
          options: {
            status: { type: "boolean", description: "Report only; the default" },
            install: { type: "boolean", description: "Install or update now, even when the version already matches" },
            json,
          },
          async run({ options }) {
            const paths = composerPaths(import.meta.url, homedir());
            const report = await ensureComposerInstalled({
              ...paths,
              force: options.install === true,
              readonly: options.install !== true,
            });
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n` };
            const lines: string[] = [];
            if (report.error !== null) lines.push(`composer: ${report.error}`);
            const installed =
              report.installedVersion !== null
                ? `installed  version=${report.installedVersion}`
                : "not installed";
            lines.push(`composer  ${installed}  path=${report.target}`);
            lines.push(
              report.source !== null
                ? `source  version=${report.sourceVersion ?? "?"}  path=${report.source}`
                : "source  not found next to the plugin",
            );
            lines.push(`decision=${report.action}`);
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        ledger: cliCommand({
          summary: "Read a thread's workspace ledger",
          positionals: [{ name: "thread", description: "Thread id; defaults to the thread you run it from" }],
          options: { json },
          async run({ positionals, options }, ctx) {
            const threadId = targetThread(positionals.thread, ctx);
            const workspace = await service.workspaceOfThread(threadId);
            if (workspace === null) {
              throw new PluginCliError("This thread has no workspace", {
                code: "no_workspace",
                hint: "The ledger lives in the thread's workspace; pick a thread with one.",
              });
            }
            const ledger = await readLedger(service.ledgerIo(workspace), ledgerPath(workspace.path));
            if (ledger === null) {
              return { exitCode: 0, stdout: options.json ? `${JSON.stringify({ ledger: null }, null, 2)}\n` : "No ledger yet.\n" };
            }
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify({ ledger }, null, 2)}\n` };
            const lines = [
              `thread ${ledger.threadId ?? "-"}  compactions=${ledger.compactions}  updated=${ledger.updatedAt}`,
              `constraints: ${ledger.constraints.length}`,
              ...ledger.constraints.map((constraint) => `  [${constraint.id}] ${constraint.text}`),
              `resume: ${ledger.resume !== null ? `${ledger.resume.state} | ${ledger.resume.next} | ${ledger.resume.verify}` : "-"}`,
              `history: ${ledger.history.length}`,
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
      },
    }),
  );
}