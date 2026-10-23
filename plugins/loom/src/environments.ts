// Where workers and reviewers run: today's managed git worktree, or a bb environment provider the spec names, with
// Loom's {branch} and {base} placeholders filled in for each thread.
import { z } from "zod";
import type { EnvironmentProviderInfo, SpawnArgs } from "./ports";
import type { RepoSettings } from "./repos";

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

/** The environment a worker or reviewer of `repo` spawns into; undefined keeps today's managed worktree. */
export function spawnEnvironment(repo: RepoSettings, values: { branch: string; base: string }): SpawnArgs["environment"] {
  const environment = repo.environment;
  if (environment === null || (environment.provider === GIT_WORKTREE && environment.inputs === undefined)) return undefined;
  return { providerId: environment.provider, inputs: environment.inputs === undefined ? null : fillInputs(environment.inputs, values) };
}

const describe = (provider: EnvironmentProviderInfo) => `${provider.displayName} (${provider.id}${provider.description === null ? "" : `: ${provider.description.replace(/\.$/u, "")}`})`;

function schemaText(provider: EnvironmentProviderInfo): string {
  const text = JSON.stringify(provider.inputs);
  return text.length <= MAX_SCHEMA_TEXT ? text : `${text.slice(0, MAX_SCHEMA_TEXT)}…`;
}

/** Why `inputs` would not start a thread in `provider`, checked against the provider's JSON Schema with sample placeholder values. */
export function inputsProblems(at: string, provider: EnvironmentProviderInfo, inputs: Record<string, unknown> | undefined): string[] {
  const ask = "Ask the human for any value you cannot find in the goal, the repository or the provider's plugin skill.";
  if (inputs === undefined) {
    if (provider.acceptsEmptyInputs) return [];
    return [`${at}.inputs: the environment provider ${describe(provider)} needs inputs, and its inputs schema is ${schemaText(provider)}. ${ask} Then set ${at}.inputs.`];
  }
  if (provider.inputs === null) return [`${at}.inputs: the environment provider ${describe(provider)} takes no inputs. Remove ${at}.inputs.`];
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
  return [`${at}.inputs: ${issues}. They do not match the environment provider ${describe(provider)}, whose inputs schema is ${schemaText(provider)}. ${ask}`];
}
