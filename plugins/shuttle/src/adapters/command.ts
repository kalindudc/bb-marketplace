// A server reached through shell commands, one per operation, each printing JSON.
import { z } from "zod";
import { OPERATIONS, type ListOperation, type Operation, type ServerConfig } from "../config";
import { linkFor } from "../keys";
import { activitySchema, prSummarySchema, toSummary, whoamiSchema, type Activity, type PrSummary } from "../model";
import { AdapterError, type Adapter, type ListOptions, type ListResult } from "./adapter";
import { fillCommand, runProcess, shellQuote, tail, type Runner } from "./exec";

export const COMMAND_TIMEOUT_MS = 60_000;

export class CommandAdapter implements Adapter {
  constructor(
    readonly server: ServerConfig,
    private readonly run: Runner = runProcess,
  ) {}

  operations(): Operation[] {
    return OPERATIONS.filter((op) => Boolean(this.server.commands[op]));
  }

  private async json(operation: Operation, env: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const command = this.server.commands[operation];
    if (!command) throw new AdapterError(operation, `${this.server.name} has no ${operation} command`);
    const result = await this.run("/bin/sh", ["-c", command], {
      env: { SHUTTLE_SERVER: this.server.id, SHUTTLE_OPERATION: operation, ...env },
      timeoutMs: COMMAND_TIMEOUT_MS,
      signal,
    }).catch((error: unknown) => {
      throw new AdapterError(operation, `${operation} could not start: ${(error as Error).message}`);
    });
    if (result.timedOut) throw new AdapterError(operation, `${operation} took longer than ${COMMAND_TIMEOUT_MS / 1000}s`);
    if (result.code !== 0) throw new AdapterError(operation, `${operation} exited ${result.code}: ${tail(result.stderr || result.stdout) || "no output"}`);
    const out = result.stdout.trim();
    if (operation === "whoami" && out && !out.startsWith("{") && !out.startsWith("\"")) return { login: out.split("\n")[0]!.trim() };
    try {
      return JSON.parse(out);
    } catch {
      throw new AdapterError(operation, `${operation} did not print JSON: ${tail(out, 2, 200) || "no output"}`);
    }
  }

  private parse<S extends z.ZodType>(operation: Operation, schema: S, value: unknown): z.output<S> {
    const result = schema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new AdapterError(operation, `${operation} printed JSON in the wrong shape: ${issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "unknown"}`);
    }
    return result.data;
  }

  async whoami(signal?: AbortSignal): Promise<string> {
    const value = await this.json("whoami", {}, signal);
    return this.parse("whoami", whoamiSchema, typeof value === "string" ? { login: value } : value).login;
  }

  async list(operation: ListOperation, options: ListOptions, signal?: AbortSignal): Promise<ListResult> {
    const env: Record<string, string> = {};
    if (options.state) env.SHUTTLE_STATE = options.state;
    if (options.since) env.SHUTTLE_SINCE = options.since;
    // A bare array is the whole list; `{items, complete: false}` says the server cut it short.
    const list = z.union([z.array(prSummarySchema).max(1000), z.object({ items: z.array(prSummarySchema).max(1000), complete: z.boolean() })]);
    const value = this.parse(operation, list, await this.json(operation, env, signal));
    const rows = Array.isArray(value) ? value : value.items;
    return { rows: rows.map((row) => this.withUrl(toSummary(row))), complete: Array.isArray(value) ? true : value.complete };
  }

  async view(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary> {
    const row = this.parse("view", prSummarySchema, await this.json("view", this.refEnv(repo, number), signal));
    return this.withUrl(toSummary(row));
  }

  async activity(repo: string, number: number, signal?: AbortSignal): Promise<Activity> {
    return this.parse("activity", activitySchema, await this.json("activity", this.refEnv(repo, number), signal));
  }

  readCommand(repo: string, number: number, url: string): string {
    if (this.server.read) return fillCommand(this.server.read, repo, number, url);
    return `open ${shellQuote(url)}`;
  }

  private refEnv(repo: string, number: number): Record<string, string> {
    return { SHUTTLE_REPO: repo, SHUTTLE_NUMBER: String(number), SHUTTLE_URL: linkFor(this.server, repo, number) };
  }

  private withUrl(summary: PrSummary): PrSummary {
    return summary.url ? summary : { ...summary, url: linkFor(this.server, summary.repo, summary.number) };
  }
}
