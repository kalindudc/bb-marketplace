// What every engine step works with: the engine's context, the approved spec of a project, and the standing of a
// ticket's worker. A leaf of the engine's modules, so any of them can import it without an import cycle.
import type { CheckWait } from "./check-wait";
import type { HostBackoffs } from "./forge-waits";
import type { ProjectRow, Store, ThreadRow, TicketRow } from "./db/store";
import type { HostPort } from "./ports";
import type { PrReads } from "./pr-sync";
import { COMMENT_SIGNATURE } from "./prompts";
import { LoomError, type Ctx } from "./projects";
import { readSpec, type Spec } from "./spec";

export interface EngineCtx extends Ctx {
  host: HostPort;
  /** The host port without the forge gate, for a forge profile's test, which reads what the forge says now (forge-gate.ts). */
  hostDirect: HostPort;
  kick(): void;
  disposed(): boolean;
  workerStopped: boolean;
  /** Forge hosts that rate-limited Loom's pull request reads, for every project; in memory only. */
  forgeBackoffs: HostBackoffs;
  /** The pull request reads the human's syncs ask for and follow (pr-sync.ts); in memory only. */
  prReads?: PrReads;
  /** Which pending checks hold a pull request's failed ones, from Loom's settings (checkWaitOf). */
  checkWait?: () => CheckWait;
  /** The line a worker ends its pull request comments with; Loom's commentSignature setting. */
  commentSignature?: () => string;
  /** Author globs Loom counts as bots on every forge; Loom's botAuthors setting. */
  botAuthors?: () => string[];
  /** The command that says what a thread used, on top of bb's usage events; Loom's usageCommand setting. Empty for none. */
  usageCommand?: () => string;
}

export const passStopped = (ctx: EngineCtx): boolean => ctx.disposed() || ctx.workerStopped;

export const signatureOf = (ctx: EngineCtx): string => ctx.commentSignature?.() ?? COMMENT_SIGNATURE;

export const DEFAULT_BOT_AUTHORS = "dependabot*, renovate*, *[bot]";
/** The globs in a comma-separated setting, blanks left out. */
export const globsIn = (text: string): string[] => text.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");
export const botAuthorsOf = (ctx: EngineCtx): string[] => ctx.botAuthors?.() ?? globsIn(DEFAULT_BOT_AUTHORS);

export function specOf(store: Store, project: ProjectRow): Spec {
  const row = project.approved_version === null ? null : store.specVersion(project.id, project.approved_version);
  if (row === null) throw new LoomError("loom_invalid_state", `Project ${project.slug} has no approved spec.`);
  return readSpec(row.spec_json, store);
}

// An `ending` worker is not gone: the endThread that claimed its row still owns the ticket's move, so the checks leave the ticket alone.
export type WorkerStanding = { standing: "active" | "ending"; row: ThreadRow } | { standing: "gone"; row: null };

export function workerOf(store: Store, ticket: TicketRow): WorkerStanding {
  const row = ticket.worker_thread_id === null ? null : store.threadByThreadId(ticket.worker_thread_id);
  if (row !== null && row.state === "active") return { standing: "active", row };
  if (row !== null && row.state === "ending") return { standing: "ending", row };
  return { standing: "gone", row: null };
}

// A message to a worker that pause --now stopped would start it again, so results reach workers only while the project runs.
// Resume hands over a failed result that was held back.
export const delivers = (ctx: EngineCtx, projectId: number) => ctx.store.project(projectId)?.state === "running";
