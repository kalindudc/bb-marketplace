// Where a review thread works: the project's default workspace, bb's git worktree, or the
// server's own workspace (an environment provider, or a command that prints a path).
import { shellQuote, type Runner } from "./adapters/exec";
import type { Preset, ServerWorkspace } from "./config";
import { ShuttleError } from "./ctx";
import type { PrRow } from "./db/store";
import { renderTemplate } from "./templates";

export type Workspace =
  | { kind: "project-default" }
  | { kind: "worktree" }
  | { kind: "provider"; providerId: string; inputs: Record<string, unknown> }
  | { kind: "path"; path: string };

export const WORKSPACE_COMMAND_TIMEOUT_MS = 10 * 60_000;

export function workspaceVars(pr: PrRow): Record<string, string> {
  return {
    number: String(pr.number),
    repo: pr.repo,
    repo_name: pr.repo.split("/").at(-1) ?? pr.repo,
    head_ref: pr.head_ref ?? "",
    base: pr.base ?? "",
    head: pr.head ?? "",
    server: pr.server,
    slug: `${pr.server}-${pr.repo}-${pr.number}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, ""),
  };
}

/** Every string in the provider's inputs, at any depth, with the placeholders filled. */
export function fillInputs(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => fillInputs(item, vars));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillInputs(item, vars)]));
  return value;
}

/** The command's last non-empty line, which must be an absolute path. */
export function pathFromOutput(stdout: string): string {
  const line = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (!line.startsWith("/")) throw new ShuttleError(`the workspace command must print an absolute path on its last line; it printed ${line ? `"${line.slice(0, 200)}"` : "nothing"}`);
  return line;
}

export async function workspaceFor(preset: Preset, workspace: ServerWorkspace | undefined, pr: PrRow, run: Runner): Promise<Workspace> {
  if (preset.workspace === "project-default") return { kind: "project-default" };
  if (!workspace) return { kind: "worktree" };
  const vars = workspaceVars(pr);
  if (workspace.kind === "provider") return { kind: "provider", providerId: workspace.provider, inputs: fillInputs(workspace.inputs, vars) as Record<string, unknown> };
  const quoted = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, shellQuote(value)]));
  const result = await run("/bin/sh", ["-c", renderTemplate(workspace.command, quoted)], { timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS });
  if (result.timedOut) throw new ShuttleError(`the workspace command took longer than ${WORKSPACE_COMMAND_TIMEOUT_MS / 60_000} minutes`);
  if (result.code !== 0) throw new ShuttleError(`the workspace command exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  return { kind: "path", path: pathFromOutput(result.stdout) };
}
