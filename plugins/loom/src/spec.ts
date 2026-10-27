import { createHash } from "node:crypto";
import { TomlError, parse } from "smol-toml";
import { z } from "zod";
import { unknownPlaceholders } from "./environments";
import { plural } from "./format";
import { matchesAny } from "./scope";

const MAX_ERRORS = 20;
const MAX_OVERLAP_WARNINGS = 10;

// The rules of `git check-ref-format --branch`; a remote name follows the same rules.
const GIT_NAME_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^-/, "it starts with '-'"],
  [/^@$/, "it is a lone '@'"],
  [/^\/|\/$|\/\//, "it starts or ends with '/' or has '//'"],
  [/^\.|\/\./, "a '/'-separated part starts with '.'"],
  [/\.$|\.lock(?:\/|$)/, "it ends with '.', or a '/'-separated part ends with '.lock'"],
  [/\.\./, "it contains '..'"],
  [/@\{/, "it contains '@{'"],
  [/[\u0000-\u0020\u007f~^:?*[\\]/, "it contains a space, a control character or one of ~ ^ : ? * [ \\"],
];

function gitNameProblem(name: string): string | null {
  if (name === "") return "it is empty";
  return GIT_NAME_RULES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

const gitNameOf = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((name, ctx) => {
      const problem = gitNameProblem(name);
      if (problem !== null) ctx.addIssue({ code: "custom", message: `is not a valid git name: ${problem}` });
    });
const gitName = gitNameOf(200);
const remoteName = gitNameOf(100);
const command = z.string().min(1).max(2000);
const glob = z.string().min(1).max(200);

function isRealDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// TOML reads an unquoted 2026-12-31 as a date object, not a string.
const isoDate = z.preprocess((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value), z.string().refine(isRealDate, "must be a real date such as 2026-12-31"));

// The server that hosts a repo's pull requests: gh, the spec's own commands, or none (Loom only pushes the branch).
export const forgeSchema = z
  .object({
    kind: z.enum(["gh", "command", "none"]),
    open: command.optional(),
    state: command.optional(),
    feedback: command.optional(),
    after_open: z.array(command).max(5).optional(),
  })
  .strict();

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const providerId = z.string().regex(PROVIDER_ID, "must be a bb environment provider id, such as git-worktree");
const inputsSchema = z.record(z.string(), z.unknown());

// A bb machine provider that gives each thread a new machine, with inputs that may hold the same placeholders.
export const machineSchema = z.object({ provider: z.string().regex(PROVIDER_ID, "must be a bb machine provider id"), inputs: inputsSchema.optional() }).strict();

// A bb environment provider for workers and reviewers, with inputs that may hold the {branch} and {base} placeholders,
// and optionally a new machine per thread. `reviewer` lets reviewers, the spec reviewer and the summary agent start in
// another provider, or in the same one with a merge patch over the inputs, and on a machine of their own.
export const environmentSchema = z
  .object({
    provider: providerId,
    inputs: inputsSchema.optional(),
    machine: machineSchema.optional(),
    reviewer: z.object({ provider: providerId.optional(), inputs: inputsSchema.optional(), machine: machineSchema.optional() }).strict().optional(),
  })
  .strict();

// A ticket's own merge patch over its repo's environment inputs, for the threads that start in the repo's provider.
export const ticketEnvironmentSchema = z.object({ inputs: inputsSchema }).strict();

// A command, or a plugin's CLI command, that prepares the integration worktree and prints its path last.
export const worktreeSchema = z
  .object({
    plugin: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "must be a bb plugin id, such as example-trees").optional(),
    command,
  })
  .strict();

const agentSchema = z
  .object({
    provider: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(100).optional(),
    reasoning: z.string().min(1).max(40).optional(),
    permission_mode: z.enum(["accept-edits", "auto", "full"]).default("full"),
  })
  .strict();

export const ticketSpecSchema = z
  .object({
    ref: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be 1-40 lowercase letters, digits or dashes, starting with a letter or digit (for example csv-model)"),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(8000),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
    verify: z.array(command).max(10).default([]),
    scope: z.array(glob).min(1).max(50),
    depends_on: z.array(z.string().min(1).max(40)).max(20).default([]),
    // No default, so a spec without it hashes as it did before it existed.
    merge_after: z.array(z.string().min(1).max(40)).max(20).optional(),
    priority: z.number().int().min(0).max(3).default(2),
    repo: z.string().min(1).max(24).optional(),
    environment: ticketEnvironmentSchema.optional(),
  })
  .strict();

export const repoSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "must be 1-24 lowercase letters, digits or dashes, starting with a letter (for example web)"),
    project: z.string().min(1).max(100),
    base: gitName.optional(),
    remote: remoteName.optional(),
    checks: z.array(command).max(10).optional(),
    after_merge: z.array(command).max(10).optional(),
    ci: z.boolean().optional(),
    protected: z.array(glob).max(100).optional(),
    forge: forgeSchema.optional(),
    environment: environmentSchema.optional(),
    worktree: worktreeSchema.optional(),
  })
  .strict();

// Not `.partial()`: that would fill in verify, depends_on and priority, and a title-only patch would wipe them.
export const ticketPatchSchema = z
  .object({
    title: ticketSpecSchema.shape.title.optional(),
    body: ticketSpecSchema.shape.body.optional(),
    acceptance: ticketSpecSchema.shape.acceptance.optional(),
    verify: ticketSpecSchema.shape.verify.unwrap().optional(),
    scope: ticketSpecSchema.shape.scope.optional(),
    depends_on: ticketSpecSchema.shape.depends_on.unwrap().optional(),
    merge_after: ticketSpecSchema.shape.merge_after,
    priority: ticketSpecSchema.shape.priority.unwrap().optional(),
    repo: ticketSpecSchema.shape.repo,
    environment: ticketSpecSchema.shape.environment,
  })
  .strict();

export const specSchema = z
  .object({
    project: z
      .object({
        slug: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "must be 2-40 lowercase letters, digits or dashes, starting with a letter (for example csv-export)"),
        name: z.string().trim().min(1).max(80),
        key: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/, "must be 2-8 capital letters or digits, starting with a letter (for example CSV)"),
        goal: z.string().trim().min(20).max(4000),
        // Optional here so the specs stored before it existed still parse; a proposal without one is refused (proposalErrorsOf).
        summary: z.string().trim().min(20).max(300).optional(),
        done_when: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
        non_goals: z.array(z.string().min(1).max(500)).max(50).default([]),
        base: gitName.default("main"),
        open_questions: z.array(z.string()).default([]),
      })
      .strict(),
    merge: z
      .object({
        strategy: z.enum(["integration", "pr"]),
        branch: gitName.optional(),
        remote: remoteName.default("origin"),
        draft: z.boolean().default(true),
        forge: forgeSchema.optional(),
        worktree: worktreeSchema.optional(),
        // No defaults, so a spec without them hashes as it did before they existed; prSettings fills them in.
        describe: z.enum(["worker", "loom"]).optional(),
        squash: z.boolean().optional(),
        max_fix_rounds: z.number().int().min(0).max(20).optional(),
        stack: z.boolean().optional(),
        release_workers: z.boolean().optional(),
        // Unset: Loom's checksQueuedMinutes and checksNearDonePercent settings apply.
        checks_queued_minutes: z.number().int().min(0).max(1440).optional(),
        checks_near_done_percent: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
    checks: z
      .object({
        commands: z.array(command).max(10).default([]),
        after_merge: z.array(command).max(10).default([]),
        timeout_minutes: z.number().int().min(1).max(29).default(15),
        // No default, so a spec without it hashes as it did before it existed; repoSettings reads unset as true.
        ci: z.boolean().optional(),
      })
      .strict()
      .prefault({}),
    scope: z
      .object({
        protected: z.array(glob).max(100).default([]),
        enforce: z.enum(["warn", "reject"]).default("warn"),
      })
      .strict()
      .prefault({}),
    agents: z
      .object({
        max_workers: z.number().int().min(1).max(8).default(2),
        max_reviewers: z.number().int().min(1).max(8).default(2),
        ticket_timeout_minutes: z.number().int().min(10).max(1440).default(120),
        triage: z.boolean().default(true),
        worker: agentSchema.prefault({}),
        reviewer: agentSchema.prefault({}),
      })
      .strict()
      .prefault({}),
    review: z
      .object({
        approvals: z.number().int().min(1).max(3).default(1),
        max_rounds: z.number().int().min(1).max(10).default(3),
        rubric: z.array(z.string().min(1).max(500)).max(20).default([]),
      })
      .strict()
      .prefault({}),
    budget: z
      .object({
        max_attempts: z.number().int().min(1).max(10).default(3),
        max_check_failures: z.number().int().min(1).max(20).default(5),
        max_tokens: z.number().int().positive().optional(),
        deadline: isoDate.optional(),
      })
      .strict()
      .prefault({}),
    // No default: a spec without [[repo]] must parse, and hash, exactly as it did before repos existed.
    environment: environmentSchema.optional(),
    repo: z.array(repoSpecSchema).max(10).optional(),
    ticket: z.array(ticketSpecSchema).min(1).max(200),
  })
  .strict();

export type Spec = z.output<typeof specSchema>;
export type TicketSpec = z.output<typeof ticketSpecSchema>;
export type TicketPatch = z.output<typeof ticketPatchSchema>;
export type RepoSpec = z.output<typeof repoSpecSchema>;
export type ForgeSpec = z.output<typeof forgeSchema>;
export type EnvironmentSpec = z.output<typeof environmentSchema>;
export type MachineSpec = z.output<typeof machineSchema>;
export type WorktreeSpec = z.output<typeof worktreeSchema>;

export interface SpecResult {
  ok: boolean;
  spec: Spec | null;
  errors: string[];
  warnings: string[];
}

const failed = (errors: string[]): SpecResult => ({ ok: false, spec: null, errors, warnings: [] });

export function numberErrors(errors: readonly string[]): string {
  const lines = errors.slice(0, MAX_ERRORS).map((error, index) => `${index + 1}. ${error}`);
  if (errors.length > MAX_ERRORS) lines.push(`… and ${errors.length - MAX_ERRORS} more`);
  return lines.join("\n");
}

function formatPath(path: readonly PropertyKey[]): string {
  const text = path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index > 0 ? "." : ""}${String(part)}`)).join("");
  return text === "" ? "spec" : text;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = formatPath(issue.path);
  switch (issue.code) {
    case "unrecognized_keys": {
      const many = issue.keys.length > 1;
      return `${path}: unknown ${many ? "keys" : "key"} ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}. Remove ${many ? "them" : "it"} or correct ${many ? "their" : "its"} spelling; the loom skill lists every key in references/spec.md.`;
    }
    case "invalid_type":
      return issue.message.endsWith("received undefined") ? `${path}: is required. Add it.` : `${path}: ${issue.message}. Use a value of the right type.`;
    case "too_small":
      return `${path}: ${issue.message}. ${issue.origin === "array" ? "Add the missing entries." : "Lengthen the value or raise it."}`;
    case "too_big":
      return `${path}: ${issue.message}. ${issue.origin === "array" ? "Remove entries or split the work." : "Shorten the value or lower it."}`;
    case "invalid_value":
      return `${path}: ${issue.message}. Use one of the listed values.`;
    default:
      return `${path}: ${issue.message}.`;
  }
}

function describeTomlError(error: unknown): string {
  if (error instanceof TomlError) {
    const reason = (error.message.split("\n")[0] ?? "").replace(/^Invalid TOML document: /, "");
    return `TOML: ${reason} (line ${error.line}, column ${error.column}). Fix the syntax and propose again.`;
  }
  return `TOML: ${error instanceof Error ? (error.message.split("\n")[0] ?? String(error)) : String(error)}. Fix the syntax and propose again.`;
}

/**
 * What every new draft or revision must have, beyond what parses: a project summary. The schema leaves it optional so the
 * specs stored before it existed still load, so this is checked where a spec is proposed, and only there.
 */
export function proposalErrorsOf(spec: Spec): string[] {
  if (spec.project.summary !== undefined) return [];
  return ["project.summary: required. Write one or two plain sentences, 20 to 300 characters, that say what the project changes and why; Loom shows it on the project page and in its home list."];
}

export function parseSpec(toml: string): SpecResult {
  let raw: unknown;
  try {
    raw = parse(toml);
  } catch (error) {
    return failed([describeTomlError(error)]);
  }
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) return failed(parsed.error.issues.map(describeIssue));
  const { errors, warnings } = validateSemantics(parsed.data, toml);
  if (errors.length > 0) return { ok: false, spec: null, errors, warnings };
  const spec = parsed.data;
  if (spec.merge.strategy === "integration" && spec.merge.branch === undefined) spec.merge.branch = `loom/${spec.project.slug}`;
  return { ok: true, spec, errors: [], warnings };
}

const literalPrefix = (pattern: string): string => {
  const text = pattern.replace(/^\.\//, "");
  const at = text.search(/[*?]/);
  return at === -1 ? text : text.slice(0, at);
};

// Conservative on purpose: a false positive only makes two tickets run one after the other.
export function globsOverlap(a: string, b: string): boolean {
  const left = literalPrefix(a);
  const right = literalPrefix(b);
  return left.startsWith(right) || right.startsWith(left);
}

// `**`, `**/*`, `**/**/*`: the globs that match every path in the repository.
const isUniversalGlob = (glob: string): boolean => /^(?:\*\*\/)*\*\*$|^(?:\*\*\/)+\*$/.test(glob.replace(/^\.\//, "").replace(/\/$/, "/**"));

// A wildcard scope is judged by its literal prefix. A literal scope is also tested against the protected glob itself,
// which is the only way to catch a glob such as "**/*.lock" that has no literal prefix.
export function fallsUnder(scope: string, protectedGlob: string): boolean {
  if (scope.replace(/^\.\//, "") === protectedGlob.replace(/^\.\//, "")) return true;
  const guard = literalPrefix(protectedGlob);
  if (guard === "" ? isUniversalGlob(protectedGlob) : literalPrefix(scope).startsWith(guard)) return true;
  return !/[*?]/.test(scope) && matchesAny(scope.replace(/^\.\//, ""), [protectedGlob]);
}

export function dependencyCycle(tickets: readonly { ref: string; depends_on: readonly string[] }[]): string[] | null {
  const deps = new Map<string, Set<string>>();
  for (const ticket of tickets) deps.set(ticket.ref, new Set(ticket.depends_on));
  for (const set of deps.values()) for (const dep of set) if (!deps.has(dep)) set.delete(dep);

  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [ref, set] of deps) {
    waiting.set(ref, set.size);
    for (const dep of set) dependents.set(dep, [...(dependents.get(dep) ?? []), ref]);
  }
  const ready = [...waiting].filter(([, count]) => count === 0).map(([ref]) => ref);
  while (ready.length > 0) {
    const ref = ready.pop()!;
    waiting.delete(ref);
    for (const dependent of dependents.get(ref) ?? []) {
      const left = (waiting.get(dependent) ?? 0) - 1;
      waiting.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  if (waiting.size === 0) return null;

  // Every ref still waiting depends on another one that is still waiting, so walking those edges must loop.
  const path: string[] = [];
  const seenAt = new Map<string, number>();
  let current = [...deps.keys()].find((ref) => waiting.has(ref))!;
  while (!seenAt.has(current)) {
    seenAt.set(current, path.length);
    path.push(current);
    current = [...deps.get(current)!].find((dep) => waiting.has(dep))!;
  }
  return [...path.slice(seenAt.get(current)), current];
}

export function validateSemantics(spec: Spec, rawToml: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rawToml.includes("[NEEDS CLARIFICATION")) {
    errors.push('spec: the text contains a "[NEEDS CLARIFICATION" marker. Settle it with the human and remove the marker before proposing.');
  }
  const open = spec.project.open_questions.length;
  if (open > 0) {
    errors.push(`project.open_questions: ${open} open ${open === 1 ? "question remains" : "questions remain"}. Ask the human, write the answers into the spec, and leave this list empty.`);
  }

  const indexOfRef = new Map<string, number>();
  spec.ticket.forEach((ticket, index) => {
    const first = indexOfRef.get(ticket.ref);
    if (first === undefined) indexOfRef.set(ticket.ref, index);
    else errors.push(`ticket[${index}].ref: "${ticket.ref}" is also the ref of ticket[${first}]. Give every ticket a unique ref.`);
  });

  spec.ticket.forEach((ticket, index) => {
    for (const dep of ticket.depends_on) {
      if (indexOfRef.has(dep)) continue;
      const others = [...indexOfRef.keys()].filter((ref) => ref !== ticket.ref);
      errors.push(`ticket[${index}].depends_on: "${dep}" is not a ticket ref. ${others.length > 0 ? `Use one of: ${others.join(", ")}.` : "This spec has no other ticket; remove it."}`);
    }
  });

  const cycle = dependencyCycle(spec.ticket);
  if (cycle !== null) {
    errors.push(`ticket[${indexOfRef.get(cycle[0]!)}].depends_on: dependency cycle ${cycle.join(" -> ")}. Remove one depends_on entry to break the cycle.`);
  }

  spec.ticket.forEach((ticket, index) => {
    for (const ref of ticket.merge_after ?? []) {
      if (ref === ticket.ref) errors.push(`ticket[${index}].merge_after: "${ref}" is this ticket's own ref. Remove it.`);
      else if (!indexOfRef.has(ref)) {
        const others = [...indexOfRef.keys()].filter((other) => other !== ticket.ref);
        errors.push(`ticket[${index}].merge_after: "${ref}" is not a ticket ref. ${others.length > 0 ? `Use one of: ${others.join(", ")}.` : "This spec has no other ticket; remove it."}`);
      } else if (ticket.depends_on.includes(ref)) warnings.push(`ticket[${index}].merge_after: "${ref}" is in depends_on too, which already merges it first. Remove it from merge_after.`);
    }
  });
  // Only when depends_on has no cycle of its own, so one loop is not reported twice.
  if (cycle === null && spec.ticket.some((ticket) => (ticket.merge_after ?? []).length > 0)) {
    const order = dependencyCycle(spec.ticket.map((ticket) => ({ ref: ticket.ref, depends_on: [...ticket.depends_on, ...(ticket.merge_after ?? []).filter((ref) => ref !== ticket.ref)] })));
    if (order !== null) errors.push(`ticket[${indexOfRef.get(order[0]!)}].merge_after: merge order cycle ${order.join(" -> ")} through depends_on and merge_after. Remove one merge_after entry to break the cycle.`);
  }

  const repos = spec.repo ?? [];
  const repoIndex = new Map<string, number>();
  const projectIndex = new Map<string, number>();
  repos.forEach((repo, index) => {
    const sameName = repoIndex.get(repo.name);
    if (sameName === undefined) repoIndex.set(repo.name, index);
    else errors.push(`repo[${index}].name: "${repo.name}" is also the name of repo[${sameName}]. Give every repo a unique name.`);
    const sameProject = projectIndex.get(repo.project);
    if (sameProject === undefined) projectIndex.set(repo.project, index);
    else errors.push(`repo[${index}].project: "${repo.project}" is also the project of repo[${sameProject}]. List each bb project in one [[repo]] table only.`);
  });
  const repoNames = [...repoIndex.keys()].join(", ");

  spec.ticket.forEach((ticket, index) => {
    if (repos.length === 0) {
      if (ticket.repo !== undefined) errors.push(`ticket[${index}].repo: "${ticket.repo}" names a repo, but the spec has no [[repo]] table, so every ticket runs in the project's own repository. Add a [[repo]] table named "${ticket.repo}", or remove repo from the ticket.`);
    } else if (ticket.repo === undefined) {
      errors.push(`ticket[${index}].repo: is required, because the spec lists [[repo]] tables. Set it to one of: ${repoNames}.`);
    } else if (!repoIndex.has(ticket.repo)) {
      errors.push(`ticket[${index}].repo: "${ticket.repo}" is not the name of a [[repo]] table. Use one of: ${repoNames}.`);
    }
  });

  spec.ticket.forEach((ticket, index) => {
    // A ticket whose repo is unknown has an error above; it is still checked against the top-level settings.
    const at = ticket.repo === undefined ? undefined : repoIndex.get(ticket.repo);
    const repo = at === undefined ? undefined : repos[at]!;
    for (const scope of ticket.scope) {
      const guard = spec.scope.protected.find((protectedGlob) => fallsUnder(scope, protectedGlob));
      if (guard !== undefined) {
        errors.push(`ticket[${index}].scope: "${scope}" falls under the protected path "${guard}". Remove it from the ticket, or take the path out of scope.protected.`);
        continue;
      }
      const repoGuard = repo?.protected?.find((protectedGlob) => fallsUnder(scope, protectedGlob));
      if (repoGuard !== undefined) errors.push(`ticket[${index}].scope: "${scope}" falls under the protected path "${repoGuard}" of repo "${repo!.name}". Remove it from the ticket, or take the path out of repo[${at}].protected.`);
    }
    if (ticket.verify.length > 0) return;
    if (repo?.checks === undefined) {
      if (spec.checks.commands.length === 0) errors.push(`ticket[${index}].verify: nothing would check this ticket, because it has no verify commands and checks.commands is empty. Add a verify command to the ticket or a command to [checks].`);
    } else if (repo.checks.length === 0) {
      errors.push(`ticket[${index}].verify: nothing would check this ticket, because it has no verify commands and repo[${at}].checks, which replaces checks.commands for repo "${repo.name}", is empty. Add a verify command to the ticket or a command to repo[${at}].checks.`);
    }
  });

  if (spec.merge.strategy === "pr" && spec.checks.after_merge.length > 0) {
    errors.push('checks.after_merge: these run on the merged integration branch, but merge.strategy is "pr". Remove after_merge, or use merge.strategy = "integration".');
  }
  repos.forEach((repo, index) => {
    if (spec.merge.strategy === "pr" && (repo.after_merge?.length ?? 0) > 0) {
      errors.push(`repo[${index}].after_merge: these run on the merged integration branch, but merge.strategy is "pr". Remove after_merge, or use merge.strategy = "integration".`);
    }
  });

  if (spec.merge.strategy === "integration") {
    for (const key of ["describe", "squash", "max_fix_rounds", "stack", "release_workers", "checks_queued_minutes", "checks_near_done_percent"] as const) {
      if (spec.merge[key] !== undefined) errors.push(`merge.${key}: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`);
    }
    const ciPaths = [...(spec.checks.ci === undefined ? [] : ["checks.ci"]), ...repos.flatMap((repo, index) => (repo.ci === undefined ? [] : [`repo[${index}].ci`]))];
    for (const at of ciPaths) errors.push(`${at}: it says whether Loom relies on the CI of the pull request it opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`);
  } else {
    errors.push(...ciForgeErrors(spec));
  }

  errors.push(...forgeErrors(spec.merge.forge, "merge.forge"), ...worktreeErrors(spec, spec.merge.worktree, "merge.worktree"), ...environmentErrors(spec.environment, "environment"));
  spec.ticket.forEach((ticket, index) => {
    const repo = ticket.repo === undefined ? undefined : repos.find((entry) => entry.name === ticket.repo);
    // A ticket whose repo is unknown has an error above.
    if (ticket.repo !== undefined && repo === undefined) return;
    errors.push(...ticketEnvironmentErrors(ticket.environment, repo?.environment ?? spec.environment ?? null, `ticket[${index}].environment`));
  });
  repos.forEach((repo, index) => {
    errors.push(...forgeErrors(repo.forge, `repo[${index}].forge`), ...worktreeErrors(spec, repo.worktree, `repo[${index}].worktree`), ...environmentErrors(repo.environment, `repo[${index}].environment`));
  });
  errors.push(...machineErrors(spec));

  const { worker, reviewer } = spec.agents;
  if (worker.provider === reviewer.provider && worker.model === reviewer.model) {
    warnings.push("agents.reviewer: the reviewer uses the same provider and model as the worker, so it shares the worker's blind spots. Set agents.reviewer.provider and model to a different model.");
  }
  warnings.push(...overlapWarnings(scopeOverlaps(spec.ticket)));

  return { errors, warnings };
}

/**
 * A repo that relies on its pull requests' CI, which is every repo on the pr strategy unless its ci, or the top-level
 * one, is false, needs a forge that reports checks: gh, or a command forge with a feedback command.
 */
function ciForgeErrors(spec: Spec): string[] {
  const repos = spec.repo ?? [];
  const entries: Array<{ name: string | null; forge: ForgeSpec; forgeAt: string; ciAt: string; ci: boolean | undefined }> =
    repos.length === 0
      ? [{ name: null, forge: spec.merge.forge ?? { kind: "gh" }, forgeAt: "merge.forge", ciAt: "checks.ci", ci: spec.checks.ci }]
      : repos.map((repo, index) => ({ name: repo.name, forge: repo.forge ?? spec.merge.forge ?? { kind: "gh" }, forgeAt: repo.forge === undefined ? "merge.forge" : `repo[${index}].forge`, ciAt: `repo[${index}].ci`, ci: repo.ci ?? spec.checks.ci }));
  return entries.flatMap(({ name, forge, forgeAt, ciAt, ci }) => {
    if (ci === false || forge.kind === "gh" || (forge.kind === "command" && forge.feedback !== undefined)) return [];
    const who = name === null ? "the repo" : `the repo ${JSON.stringify(name)}`;
    const relies = `${who} relies on its pull requests' CI (${ciAt} is not false), but`;
    const off = `set ${ciAt} = false so the plugin checks are the whole bar.`;
    return [
      forge.kind === "none"
        ? `${forgeAt}: ${relies} kind = "none" opens no pull request and reports no checks. Use kind = "gh", or kind = "command" with a feedback command, or ${off}`
        : `${forgeAt}: ${relies} this forge reports no checks, so Loom could never send a failed one back. Add a feedback command to ${forgeAt}, or ${off}`,
    ];
  });
}

function forgeErrors(forge: ForgeSpec | undefined, at: string): string[] {
  if (forge === undefined) return [];
  const errors: string[] = [];
  if (forge.kind === "command") {
    if (forge.open === undefined) {
      errors.push(`${at}.open: is required when ${at}.kind is "command". Add the command that opens a pull request: it gets LOOM_REMOTE, LOOM_BASE, LOOM_HEAD, LOOM_TITLE and LOOM_DRAFT, reads the body on stdin, and prints the pull request's URL.`);
    }
    if (forge.state === undefined) {
      errors.push(`${at}.state: is required when ${at}.kind is "command". Add the command that prints open, merged or closed for the pull request in LOOM_URL (its number is in LOOM_PR_NUMBER).`);
    }
    return errors;
  }
  for (const key of ["open", "state", "feedback"] as const) {
    if (forge[key] !== undefined) errors.push(`${at}.${key}: only kind = "command" runs it, and ${at}.kind is "${forge.kind}". Remove it, or set kind = "command".`);
  }
  if (forge.kind === "none" && forge.after_open !== undefined) {
    errors.push(`${at}.after_open: kind = "none" opens no pull request, so nothing would run these. Remove after_open, or use kind = "gh" or "command".`);
  }
  return errors;
}

function worktreeErrors(spec: Spec, worktree: WorktreeSpec | undefined, at: string): string[] {
  if (worktree === undefined || spec.merge.strategy === "integration") return [];
  return [`${at}: only the integration strategy has an integration worktree, and merge.strategy is "pr". Remove ${at}, or use merge.strategy = "integration".`];
}

function placeholderErrors(inputs: Record<string, unknown> | undefined, at: string): string[] {
  if (inputs === undefined) return [];
  return unknownPlaceholders(inputs).map((name) => `${at}: {${name}} is not a Loom placeholder. Use {branch} or {base}, or write the value out.`);
}

function environmentErrors(environment: EnvironmentSpec | undefined, at: string): string[] {
  if (environment === undefined) return [];
  return [
    ...placeholderErrors(environment.inputs, `${at}.inputs`),
    ...placeholderErrors(environment.machine?.inputs, `${at}.machine.inputs`),
    ...placeholderErrors(environment.reviewer?.inputs, `${at}.reviewer.inputs`),
    ...placeholderErrors(environment.reviewer?.machine?.inputs, `${at}.reviewer.machine.inputs`),
  ];
}

/**
 * A repo whose workers or reviewers run on new machines works only on the pr strategy: the integration branch is made on
 * the project's machine, and Loom does not carry it elsewhere. A repo without an environment of its own uses the top-level
 * one, so its error names that path, once.
 */
function machineErrors(spec: Spec): string[] {
  if (spec.merge.strategy === "pr") return [];
  const used: Array<[EnvironmentSpec | undefined, string]> = (spec.repo ?? []).length === 0 ? [[spec.environment, "environment"]] : spec.repo!.map((repo, index) => (repo.environment === undefined ? [spec.environment, "environment"] : [repo.environment, `repo[${index}].environment`]));
  const paths = used.flatMap(([environment, at]) => (environment?.machine !== undefined ? [`${at}.machine`] : environment?.reviewer?.machine !== undefined ? [`${at}.reviewer.machine`] : []));
  return [...new Set(paths)].map(
    (at) =>
      `${at}: a thread on a new machine needs merge.strategy = "pr", because Loom does not carry the integration branch, which lives only on the project's machine, to other machines. Set merge.strategy = "pr", or remove ${at}.`,
  );
}

/** A ticket's environment patch needs an environment provider in its repo to patch, and only Loom's placeholders. */
export function ticketEnvironmentErrors(environment: { inputs: Record<string, unknown> } | undefined, repoEnvironment: EnvironmentSpec | null, at: string): string[] {
  if (environment === undefined) return [];
  if (repoEnvironment === null) return [`${at}: the ticket's repo starts its threads in git worktrees, with no environment inputs to patch. Remove ${at}, or set an [environment] with a provider for the repo.`];
  return placeholderErrors(environment.inputs, `${at}.inputs`);
}

export interface ScopeOverlap {
  i: number;
  j: number;
  paths: string[];
}

/** Every pair of tickets in the same repo, by index, whose scopes overlap with no dependency path between them, and the globs of either one that overlap the other's. */
export function scopeOverlaps(tickets: readonly TicketSpec[]): ScopeOverlap[] {
  const indexOfRef = new Map<string, number>();
  tickets.forEach((ticket, index) => {
    if (!indexOfRef.has(ticket.ref)) indexOfRef.set(ticket.ref, index);
  });
  const reaches = (from: TicketSpec, target: string): boolean => {
    const visited = new Set<string>();
    const stack = [...from.depends_on];
    while (stack.length > 0) {
      const ref = stack.pop()!;
      if (ref === target) return true;
      if (visited.has(ref)) continue;
      visited.add(ref);
      const next = indexOfRef.get(ref);
      if (next !== undefined) stack.push(...tickets[next]!.depends_on);
    }
    return false;
  };

  const overlaps: ScopeOverlap[] = [];
  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const a = tickets[i]!;
      const b = tickets[j]!;
      if (a.repo !== b.repo) continue;
      const paths = [...a.scope.filter((left) => b.scope.some((right) => globsOverlap(left, right))), ...b.scope.filter((right) => a.scope.some((left) => globsOverlap(left, right)))];
      if (paths.length === 0) continue;
      if (reaches(a, b.ref) || reaches(b, a.ref)) continue;
      overlaps.push({ i, j, paths: [...new Set(paths)] });
    }
  }
  return overlaps;
}

function overlapWarnings(overlaps: readonly ScopeOverlap[]): string[] {
  const warnings = overlaps
    .slice(0, MAX_OVERLAP_WARNINGS)
    .map(({ i, j }) => `ticket[${i}] and ticket[${j}] have overlapping scope and no dependency between them, so they will run one at a time. Add depends_on if the order matters, or narrow their scope.`);
  const hidden = overlaps.length - warnings.length;
  if (hidden > 0) warnings.push(`… and ${plural(hidden, "more pair")} of tickets with overlapping scope.`);
  return warnings;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function specHash(spec: Spec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}
