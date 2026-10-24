// A server reached through shell commands, one per operation, each printing JSON.
import { z } from "zod";
import { OPERATIONS, type ListOperation, type Operation, type ServerConfig } from "../config";
import { linkFor } from "../keys";
import type { MergeOptions, PrChange } from "../contract";
import { activitySchema, editOptionsSchema, mergeOptionsInputSchema, prSummarySchema, reviewPostedSchema, toSummary, whoamiSchema, type Activity, type EditOptions, type PrSummary } from "../model";
import { AdapterError, changeOperation, type Adapter, type ListOptions, type ListResult, type MergeInput, type ReviewPost, type ReviewPosted } from "./adapter";
import { fillCommand, runProcess, shellQuote, tail, type Runner } from "./exec";

export const COMMAND_TIMEOUT_MS = 60_000;

/** What a server without merge_options, or one that leaves fields out, can merge with. */
export const MERGE_DEFAULTS: MergeOptions = { methods: ["squash", "merge"], default: "squash", deleteBranch: false, canAuto: false, state: "unknown", detail: null };
const flag = (value: boolean) => (value ? "1" : "0");

export class CommandAdapter implements Adapter {
  constructor(
    readonly server: ServerConfig,
    private readonly run: Runner = runProcess,
  ) {}

  operations(): Operation[] {
    return OPERATIONS.filter((op) => Boolean(this.server.commands[op]));
  }

  private async exec(operation: Operation, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
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
    return result.stdout;
  }

  private async json(operation: Operation, env: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const out = (await this.exec(operation, env, signal)).trim();
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
    // A view always counts as having read the description, even when the server sends none.
    return this.withUrl({ ...toSummary(row), body: row.body ?? "" });
  }

  async activity(repo: string, number: number, signal?: AbortSignal): Promise<Activity> {
    return this.parse("activity", activitySchema, await this.json("activity", this.refEnv(repo, number), signal));
  }

  async change(repo: string, number: number, change: PrChange, signal?: AbortSignal): Promise<void> {
    const env = this.refEnv(repo, number);
    const lines = (values: readonly string[]) => values.join("\n");
    if (change.kind === "labels") Object.assign(env, { SHUTTLE_ADD: lines(change.add), SHUTTLE_REMOVE: lines(change.remove) });
    if (change.kind === "reviewers") {
      const pick = (refs: typeof change.add, team: boolean) => lines(refs.filter((r) => r.team === team).map((r) => r.login));
      Object.assign(env, { SHUTTLE_ADD: pick(change.add, false), SHUTTLE_REMOVE: pick(change.remove, false), SHUTTLE_ADD_TEAMS: pick(change.add, true), SHUTTLE_REMOVE_TEAMS: pick(change.remove, true) });
    }
    await this.exec(changeOperation(change), env, signal);
  }

  async editOptions(repo: string, number: number, signal?: AbortSignal): Promise<EditOptions> {
    return this.parse("edit_options", editOptionsSchema, await this.json("edit_options", this.refEnv(repo, number), signal));
  }

  async mergeOptions(repo: string, number: number, signal?: AbortSignal): Promise<MergeOptions> {
    if (!this.server.commands.merge_options) return { ...MERGE_DEFAULTS, methods: [...MERGE_DEFAULTS.methods] };
    const raw = this.parse("merge_options", mergeOptionsInputSchema, await this.json("merge_options", this.refEnv(repo, number), signal));
    const methods = [...new Set(raw.methods ?? MERGE_DEFAULTS.methods)];
    const first = raw.default ?? methods[0]!;
    if (!methods.includes(first)) throw new AdapterError("merge_options", `merge_options printed JSON in the wrong shape: default ${first} is not one of its methods`);
    return {
      methods: [first, ...methods.filter((m) => m !== first)],
      default: first,
      deleteBranch: raw.delete_branch ?? MERGE_DEFAULTS.deleteBranch,
      canAuto: raw.can_auto ?? MERGE_DEFAULTS.canAuto,
      state: raw.state ?? MERGE_DEFAULTS.state,
      detail: raw.detail ?? null,
    };
  }

  async merge(repo: string, number: number, input: MergeInput, signal?: AbortSignal): Promise<{ merged: boolean }> {
    await this.exec("merge", {
      ...this.refEnv(repo, number),
      SHUTTLE_METHOD: input.method,
      SHUTTLE_HEAD: input.head,
      SHUTTLE_AUTO: flag(input.auto),
      SHUTTLE_DELETE_BRANCH: flag(input.deleteBranch),
      SHUTTLE_SUBJECT: input.subject ?? "",
    }, signal);
    return { merged: !input.auto };
  }

  async comment(repo: string, number: number, body: string, signal?: AbortSignal): Promise<void> {
    await this.exec("comment", { ...this.refEnv(repo, number), SHUTTLE_BODY: body }, signal);
  }

  async review(repo: string, number: number, post: ReviewPost, signal?: AbortSignal): Promise<ReviewPosted> {
    const out = (await this.exec("review", {
      ...this.refEnv(repo, number),
      SHUTTLE_VERDICT: post.verdict,
      SHUTTLE_BODY: post.body,
      SHUTTLE_HEAD: post.head ?? "",
      SHUTTLE_COMMENTS: JSON.stringify(post.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }))),
    }, signal)).trim();
    if (!out) return { placed: post.comments.length, inBody: 0 };
    let value: unknown;
    try {
      value = JSON.parse(out);
    } catch {
      throw new AdapterError("review", `review did not print JSON: ${tail(out, 2, 200)}`);
    }
    const posted = this.parse("review", reviewPostedSchema, value);
    return { placed: posted.placed ?? 0, inBody: posted.in_body ?? 0 };
  }

  async reply(repo: string, number: number, thread: string, body: string, signal?: AbortSignal): Promise<void> {
    await this.exec("reply", { ...this.refEnv(repo, number), SHUTTLE_THREAD: thread, SHUTTLE_BODY: body }, signal);
  }

  async resolve(repo: string, number: number, thread: string, resolved: boolean, signal?: AbortSignal): Promise<void> {
    await this.exec("resolve", { ...this.refEnv(repo, number), SHUTTLE_THREAD: thread, SHUTTLE_RESOLVED: flag(resolved) }, signal);
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
