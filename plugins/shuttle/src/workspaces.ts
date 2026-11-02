// Where a review thread works: the project's default workspace, bb's git worktree, or the
// server's own workspace (an environment provider, on the project's machine or a new one, or a
// command that prints a path).
import { z } from "zod";
import { shellQuote, type Runner } from "./adapters/exec";
import type { Preset, ServerWorkspace } from "./config";
import { ShuttleError } from "./ctx";
import type { PrRow } from "./db/store";
import type { BbPort, EnvironmentProviderInfo } from "./ports";
import { renderTemplate } from "./templates";

export type Workspace =
  | { kind: "project-default" }
  | { kind: "worktree" }
  | { kind: "provider"; providerId: string; inputs: Record<string, unknown>; machine?: { providerId: string; inputs: Record<string, unknown> } }
  | { kind: "path"; path: string };

export const WORKSPACE_COMMAND_TIMEOUT_MS = 10 * 60_000;

export function workspaceVars(pr: Pick<PrRow, "number" | "repo" | "head_ref" | "base" | "head" | "server">): Record<string, string> {
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
  if (workspace.kind === "provider") {
    const filled = (inputs: Record<string, unknown>) => fillInputs(inputs, vars) as Record<string, unknown>;
    const { machine } = workspace;
    return { kind: "provider", providerId: workspace.provider, inputs: filled(workspace.inputs), ...(machine ? { machine: { providerId: machine.provider, inputs: filled(machine.inputs) } } : {}) };
  }
  const quoted = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, shellQuote(value)]));
  const result = await run("/bin/sh", ["-c", renderTemplate(workspace.command, quoted)], { timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS });
  if (result.timedOut) throw new ShuttleError(`the workspace command took longer than ${WORKSPACE_COMMAND_TIMEOUT_MS / 60_000} minutes`);
  if (result.code !== 0) throw new ShuttleError(`the workspace command exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
  return { kind: "path", path: pathFromOutput(result.stdout) };
}

type InputsOwner = Pick<EnvironmentProviderInfo, "id" | "displayName" | "inputs">;

const named = (provider: Pick<InputsOwner, "id" | "displayName">) => `${provider.displayName} (${provider.id})`;

/** The placeholders a check fills in, each a value bb would accept for its kind, so a pattern on a sha or a branch passes. */
const sampleVars = (server: string) => workspaceVars({ number: 1234, repo: "owner/repo", head_ref: "sample/branch", base: "main", head: "0123456789abcdef0123456789abcdef01234567", server });

/**
 * Why bb would refuse these inputs, at `at` in the server's workspace, checked against the provider's JSON Schema with
 * sample placeholder values. `emptyAsNone` says whether the port sends empty inputs as none, as it does for a machine.
 */
function inputsProblems(at: string, provider: InputsOwner, inputs: Record<string, unknown>, server: string, emptyAsNone: boolean): string[] {
  if (provider.inputs === null) {
    if (!emptyAsNone) return [`${at}: ${named(provider)} takes no inputs, and bb refuses the empty inputs Shuttle sends it`];
    return Object.keys(inputs).length === 0 ? [] : [`${at}: ${named(provider)} takes none`];
  }
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(provider.inputs as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // bb still checks a schema zod cannot read when the review starts.
    return [];
  }
  const parsed = schema.safeParse(fillInputs(inputs, sampleVars(server)));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${[at, ...issue.path].join(".")}: ${issue.message}`);
}

/**
 * Where the server's reviews start, checked against the providers bb has now, for the server test. Throws with every
 * reason bb would refuse to start one there. Whether a provider has room is bb's answer when a review starts.
 */
export async function checkWorkspace(port: Pick<BbPort, "environmentProviders" | "machineProviders">, server: string, workspace: ServerWorkspace | undefined): Promise<string> {
  if (!workspace) return "bb's git worktree, on the machine with the project's checkout";
  if (workspace.kind === "command") return "a command prints the checkout's path; the test does not run it";
  const environments = await port.environmentProviders();
  const environment = environments.find((provider) => provider.id === workspace.provider);
  const ids = (providers: ReadonlyArray<{ id: string }>) => providers.map((provider) => provider.id).sort().join(", ") || "none";
  if (!environment) throw new ShuttleError(`bb has no environment provider "${workspace.provider}"; it has ${ids(environments)}`);
  const problems: string[] = [];
  const { machine } = workspace;
  if (environment.machineProviderId !== null && machine?.provider !== environment.machineProviderId) {
    problems.push(`${named(environment)} makes a new machine for each review with the machine provider ${environment.machineProviderId}, so the machine must be ${environment.machineProviderId}`);
  }
  problems.push(...inputsProblems("inputs", environment, workspace.inputs, server, false));
  let where = "on the machine with the project's checkout";
  if (machine) {
    const machines = await port.machineProviders();
    const provider = machines.find((candidate) => candidate.id === machine.provider);
    if (!provider) problems.push(`bb has no machine provider "${machine.provider}"; it has ${ids(machines)}`);
    else {
      problems.push(...inputsProblems("machine.inputs", provider, machine.inputs, server, true));
      where = `on a new ${provider.displayName} machine (${provider.id}) for each review`;
    }
  }
  if (problems.length) throw new ShuttleError(problems.join("; "));
  return `${named(environment)}, ${where}`;
}
