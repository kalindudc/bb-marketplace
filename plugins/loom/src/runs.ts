// Loom's own record of each call it makes to the machine for a ticket's checks and merge, shown in the ticket page's check and merge cards.
import type { Store, TicketRow } from "./db/store";
import type { HostInput, HostMethod, HostOutput } from "./host-contract";
import type { HostPort } from "./ports";
import { clip } from "./prompts";

export type RunStage = "check" | "merge";

export const RUN_OUTPUT_MAX = 70_000;

export const STEP_LABELS: Partial<Record<HostMethod, string>> = {
  commitAll: "git commit",
  worktreeState: "git status",
  ensureWorktree: "prepare the Loom worktree",
  merge: "git merge",
  resetHard: "git reset --hard",
  prState: "read the pull request",
  prCommit: "build the pull request's commit",
  push: "git push",
  prCreate: "open the pull request",
};

const sha12 = (sha: string) => sha.slice(0, 12);

function differing(files: readonly string[]): string {
  if (files.length === 0) return "No files differ from the base.";
  const head = files.length === 1 ? "1 file differs from the base:" : `${files.length} files differ from the base:`;
  return [head, ...files].join("\n");
}

export function stepSummary(method: HostMethod, output: unknown): { ok: boolean; text: string } {
  const unavailable = output as { outcome?: unknown; message?: unknown };
  if (unavailable.outcome === "unavailable" && typeof unavailable.message === "string") return { ok: false, text: unavailable.message };
  switch (method) {
    case "commitAll": {
      const { sha, committed } = output as HostOutput<"commitAll">;
      return { ok: true, text: committed ? `Committed ${sha12(sha)}.` : `Nothing new to commit; HEAD is ${sha12(sha)}.` };
    }
    case "worktreeState": {
      const state = output as HostOutput<"worktreeState">;
      const where = `HEAD ${sha12(state.head)} on ${state.branch ?? "a detached HEAD"}, ${state.dirty ? "with uncommitted changes" : "clean"}.`;
      return { ok: true, text: `${where} ${differing(state.changed)}` };
    }
    case "resetHard":
      return { ok: true, text: `Reset to ${sha12((output as HostOutput<"resetHard">).sha)}.` };
    case "ensureWorktree":
      return { ok: true, text: `Ready at ${(output as { path: string }).path}.` };
    case "merge": {
      const merged = output as HostOutput<"merge">;
      if (merged.outcome === "conflict") return { ok: false, text: ["Conflicts in:", ...merged.files].join("\n") };
      return { ok: true, text: `Merged as ${sha12(merged.sha)}; the branch was at ${sha12(merged.before)}.${merged.already ? " (already merged)" : ""}` };
    }
    case "prState":
      return { ok: true, text: `The pull request is ${(output as { state: string }).state.toLowerCase()}.` };
    case "prCommit": {
      const built = output as HostOutput<"prCommit">;
      if (built.outcome === "diverged") return { ok: false, text: `The branch has commits Loom did not push; its tip is ${sha12(built.tip)}.` };
      if (built.outcome !== "ok") return { ok: false, text: "unavailable" };
      return { ok: true, text: built.created ? `Built ${sha12(built.sha)} with the reviewed work's files.` : `The branch already has the reviewed work at ${sha12(built.sha)}; nothing new to commit.` };
    }
    case "push":
      return { ok: true, text: "Pushed." };
    case "prCreate":
      return { ok: true, text: `Opened ${(output as { url: string }).url}.` };
    default:
      return { ok: true, text: JSON.stringify(output) };
  }
}

/** A host port that records every call it passes on as a run of `ticket` in `stage`. */
export function recordingHost(store: Store, host: HostPort, ticket: Pick<TicketRow, "id" | "project_id">, stage: RunStage): HostPort {
  return {
    async call<M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> {
      const exec = method === "exec";
      const label = exec ? (input as HostInput<"exec">).command : (STEP_LABELS[method] ?? method);
      const id = store.startRun({ project_id: ticket.project_id, ticket_id: ticket.id, stage, kind: exec ? "command" : "git", label });
      let output: HostOutput<M>;
      try {
        output = await host.call(hostId, method, input);
      } catch (error) {
        store.finishRun(id, { ok: false, output: clip(error instanceof Error ? error.message : String(error), RUN_OUTPUT_MAX) });
        throw error;
      }
      if (exec) {
        const result = output as HostOutput<"exec">;
        store.finishRun(id, {
          ok: result.exitCode === 0 && !result.timedOut,
          output: clip(result.output, RUN_OUTPUT_MAX),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      } else {
        const summary = stepSummary(method, output);
        store.finishRun(id, { ok: summary.ok, output: clip(summary.text, RUN_OUTPUT_MAX) });
      }
      return output;
    },
  };
}
