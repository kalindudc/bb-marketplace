// Where workers and reviewers run: today's managed git worktree, or a bb environment provider the spec names, with
// Loom's {branch} and {base} placeholders filled in for each thread.
import { z } from "zod";
import type { EnvironmentProviderInfo, SpawnArgs } from "./ports";
import type { RepoSettings } from "./repos";
import type { MachineSpec } from "./spec";

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN = new Set(["branch", "base"]);
// bb's managed-worktree workspace is the git-worktree provider, so naming it without inputs keeps today's spawn.
const GIT_WORKTREE = "git-worktree";
// What a propose-time check fills in; both satisfy every ref pattern a provider is likely to have.
const SAMPLE = { branch: "loom/sample/key-1", base: "origin/main" };
const MAX_SCHEMA_TEXT = 1500;

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  }
  return value;
}

/** A deep copy of `inputs` with {branch} and {base} replaced in every string. */
export function fillInputs(inputs: Record<string, unknown>, values: { branch: string; base: string }): Record<string, unknown> {
  return mapStrings(inputs, (text) => text.replace(PLACEHOLDER, (whole, name: string) => (name === "branch" ? values.branch : name === "base" ? values.base : whole))) as Record<string, unknown>;
}

/** The {names} in `inputs` that are not Loom placeholders, in order of first use. */
export function unknownPlaceholders(inputs: Record<string, unknown>): string[] {
  const found = new Set<string>();
  mapStrings(inputs, (text) => {
    for (const match of text.matchAll(PLACEHOLDER)) if (!KNOWN.has(match[1]!)) found.add(match[1]!);
    return text;
  });
  return [...found];
}

/** The branch a thread started in a provider environment works on. */
export function threadBranch(slug: string, key: string, suffix: string): string {
  return `loom/${slug}/${key.toLowerCase()}-${suffix}`;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

/**
 * `patch` applied to `target` as a JSON merge patch (RFC 7396): a table merges key by key, a null removes the key, and
 * any other value, an array included, replaces it.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const merged: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

/** Who a thread is: a worker, or a reviewer-like reader (a ticket's reviewer, the spec reviewer, the summary agent). */
export type ThreadRole = "worker" | "reviewer";

/**
 * The provider, inputs and new machine a thread of `repo` starts in: the repo's environment; for a reviewer, its
 * `reviewer` table on top (another provider, which drops the workers' machine, or a merge patch over the inputs, and its
 * own machine); then the ticket's own inputs patch, when the thread uses the repo's provider. Null keeps today's managed
 * worktree.
 */
export function environmentFor(
  repo: RepoSettings,
  role: ThreadRole,
  ticketInputs: Record<string, unknown> | null = null,
): { provider: string; inputs: Record<string, unknown> | undefined; machine: MachineSpec | undefined } | null {
  const environment = repo.environment;
  if (environment === null) return null;
  const reviewer = role === "reviewer" ? environment.reviewer : undefined;
  if (reviewer?.provider !== undefined && reviewer.provider !== environment.provider) return { provider: reviewer.provider, inputs: reviewer.inputs, machine: reviewer.machine };
  let inputs = environment.inputs;
  if (reviewer?.inputs !== undefined) inputs = mergePatch(inputs ?? {}, reviewer.inputs) as Record<string, unknown>;
  if (ticketInputs !== null) inputs = mergePatch(inputs ?? {}, ticketInputs) as Record<string, unknown>;
  return { provider: environment.provider, inputs, machine: reviewer?.machine ?? environment.machine };
}

/** Whether a worker or reviewer of `repo` starts on a new machine of its own, away from the project's checkout. */
export const usesNewMachine = (repo: RepoSettings, role: ThreadRole): boolean => environmentFor(repo, role)?.machine !== undefined;

/** A ticket's merge patch over its repo's environment inputs, or null. */
export const ticketInputsOf = (ticket: { environment_json: string | null }): Record<string, unknown> | null => (ticket.environment_json === null ? null : (JSON.parse(ticket.environment_json) as Record<string, unknown>));

/** The environment a worker or reviewer of `repo` spawns into; undefined keeps today's managed worktree. */
export function spawnEnvironment(repo: RepoSettings, values: { branch: string; base: string }, role: ThreadRole = "worker", ticketInputs: Record<string, unknown> | null = null): SpawnArgs["environment"] {
  const environment = environmentFor(repo, role, ticketInputs);
  if (environment === null || (environment.provider === GIT_WORKTREE && environment.inputs === undefined && environment.machine === undefined)) return undefined;
  const filled = (inputs: Record<string, unknown> | undefined) => (inputs === undefined ? null : fillInputs(inputs, values));
  const { machine } = environment;
  // bb refuses git-worktree without inputs; this is the base the managed worktree starts from.
  const inputs = environment.provider === GIT_WORKTREE && environment.inputs === undefined ? { branch: { kind: "named", name: values.base } } : filled(environment.inputs);
  return { providerId: environment.provider, inputs, ...(machine === undefined ? {} : { machine: { providerId: machine.provider, inputs: filled(machine.inputs) } }) };
}

/** What inputsProblems reads of an environment provider or a machine provider. */
type InputsOwner = Pick<EnvironmentProviderInfo, "id" | "displayName" | "description" | "acceptsEmptyInputs" | "inputs">;

const describe = (provider: InputsOwner) => `${provider.displayName} (${provider.id}${provider.description === null ? "" : `: ${provider.description.replace(/\.$/u, "")}`})`;

function schemaText(provider: InputsOwner): string {
  const text = JSON.stringify(provider.inputs);
  return text.length <= MAX_SCHEMA_TEXT ? text : `${text.slice(0, MAX_SCHEMA_TEXT)}…`;
}

/**
 * Why `inputs` would not start a thread in `provider`, an environment provider or a machine provider as `what` says,
 * checked against the provider's JSON Schema with sample placeholder values.
 */
export function inputsProblems(at: string, provider: InputsOwner, inputs: Record<string, unknown> | undefined, what = "environment provider"): string[] {
  const ask = "Ask the human for any value you cannot find in the goal, the repository or the provider's plugin skill.";
  if (inputs === undefined) {
    if (provider.acceptsEmptyInputs) return [];
    return [`${at}.inputs: the ${what} ${describe(provider)} needs inputs, and its inputs schema is ${schemaText(provider)}. ${ask} Then set ${at}.inputs.`];
  }
  if (provider.inputs === null) return [`${at}.inputs: the ${what} ${describe(provider)} takes no inputs. Remove ${at}.inputs.`];
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(provider.inputs as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // A schema zod cannot read is still checked by bb when it starts the thread.
    return [];
  }
  const parsed = schema.safeParse(fillInputs(inputs, SAMPLE));
  if (parsed.success) return [];
  const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "the inputs" : issue.path.join(".")}: ${issue.message}`).join("; ");
  return [`${at}.inputs: ${issues}. They do not match the ${what} ${describe(provider)}, whose inputs schema is ${schemaText(provider)}. ${ask}`];
}
