import type { ChangeOperation, ListOperation, Operation, ServerConfig } from "../config";
import type { PrChange } from "../contract";
import type { Activity, EditOptions, PrSummary } from "../model";

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
  /** Changes the PR on its server; resolves once the server accepted the change. */
  change(repo: string, number: number, change: PrChange, signal?: AbortSignal): Promise<void>;
  /** The repo's labels, and people the server suggests as reviewers. */
  editOptions(repo: string, number: number, signal?: AbortSignal): Promise<EditOptions>;
  /** How an agent reads the PR with its conversation, for prompts. */
  readCommand(repo: string, number: number, url: string): string;
}

/** The operation that carries out a change. */
export function changeOperation(change: PrChange): ChangeOperation {
  if (change.kind === "labels") return "edit_labels";
  if (change.kind === "reviewers") return "edit_reviewers";
  return change.kind;
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
