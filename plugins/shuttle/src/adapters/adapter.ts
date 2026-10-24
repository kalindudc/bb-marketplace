import type { ListOperation, Operation, ServerConfig } from "../config";
import type { Activity, PrSummary } from "../model";

export interface ListOptions {
  /** authored only: open PRs, or closed and merged ones updated since `since`. */
  state?: "open" | "closed";
  /** YYYY-MM-DD. */
  since?: string;
}

/** A list says whether it holds every matching PR; an incomplete one never removes a reason. */
export interface ListResult {
  rows: PrSummary[];
  complete: boolean;
}

export interface Adapter {
  readonly server: ServerConfig;
  operations(): Operation[];
  whoami(signal?: AbortSignal): Promise<string>;
  list(operation: ListOperation, options: ListOptions, signal?: AbortSignal): Promise<ListResult>;
  view(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary>;
  activity(repo: string, number: number, signal?: AbortSignal): Promise<Activity>;
  /** How an agent reads the PR with its conversation, for prompts. */
  readCommand(repo: string, number: number, url: string): string;
}

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  constructor(
    readonly operation: Operation,
    message: string,
  ) {
    super(message);
  }
}
