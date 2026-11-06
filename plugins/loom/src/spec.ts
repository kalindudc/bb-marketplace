import { createHash } from "node:crypto";
import { TomlError, parse } from "smol-toml";
import { z } from "zod";
import { unknownPlaceholders } from "./environments";
import { deploysOnMerge, SOAK_PATTERN } from "./rollout";
import { plural } from "./format";
import { GIT_INDEX_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_SECONDS } from "./git-network";
import { HOOK_EVENTS } from "./hook-events";
import { andList } from "./prompts";
import { AUTO_MERGE_DEFAULTS, canReady, followsFeedback, PR_DEFAULTS } from "./repos";
import { matchesAny } from "./scope";

const MAX_ERRORS = 20;
const TICKET_TIMEOUT_MINUTES = 180;
const CHECKS_TIMEOUT_MINUTES = 25;
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

const stageName = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "must be 1-24 lowercase letters, digits or dashes, starting with a letter (for example expand)");
const rolloutRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be 1-40 lowercase letters, digits or dashes, starting with a letter or digit (for example old-traffic-zero)");
const deployHow = z.string().trim().min(1).max(300);

// How a repo's merged changes reach traffic; a [[repo]]'s fields override the [rollout] table's.
export const deploySchema = z.object({ on_merge: z.boolean().optional(), how: deployHow.optional() }).strict();

// Where a ticket's change sits in the deploy order. Advice for the human: nothing here holds a start, a review or a merge.
export const ticketRolloutSchema = z
  .object({
    stage: stageName.optional(),
    requires_live: z.array(z.string().min(1).max(40)).max(20).optional(),
    release: rolloutRef.optional(),
    dark: z.boolean().optional(),
    how: deployHow.optional(),
    verify: command.optional(),
    rollback: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const rolloutSchema = z
  .object({
    deploy: deploySchema.optional(),
    stage: z
      .array(z.object({ name: stageName, goal: z.string().trim().min(1).max(300), soak: z.string().regex(SOAK_PATTERN, "must be a duration such as 30m, 2h or 1d").optional() }).strict())
      .max(12)
      .optional(),
    milestone: z.array(z.object({ ref: rolloutRef, title: z.string().trim().min(1).max(200), check: command.optional(), stage: stageName.optional() }).strict()).max(30).optional(),
    window: z.array(z.object({ title: z.string().trim().min(1).max(120), from: isoDate, to: isoDate, note: z.string().trim().min(1).max(500).optional() }).strict()).max(20).optional(),
  })
  .strict();

// Globs, not regular expressions, for the same reason as ignore_checks.
const nonBlankGlob = z.string().max(200).refine((pattern) => pattern.trim() !== "", "must not be blank");

export const AUTO_MERGE_METHODS = ["squash", "merge", "rebase", "queue", "comment", "command"] as const;
/** "manual": a ready pull request waits for the human to confirm its merge, in the panel or through the planner; "auto": Loom asks at once. */
export const AUTO_MERGE_MODES = ["auto", "manual"] as const;

// Opt-in: Loom merges a ticket's pull request itself once its Ready to merge verdict holds. No defaults, so a forge without
// it hashes as it did before it existed; autoMergeOf fills them in.
// One short agent turn right before each merge, on the head Loom would merge, as agents.reviewer at low reasoning within 10
// minutes (finalReviewOf). An empty table or true turns it on; true is read as the empty table, so both hash alike.
export const finalReviewSchema = z.preprocess((value) => (value === true ? {} : value), z.object({}).strict());

export const autoMergeSchema = z
  .object({
    method: z.enum(AUTO_MERGE_METHODS),
    // Unset: "manual" (autoMergeOf). No default here, so a spec without it hashes as before.
    mode: z.enum(AUTO_MERGE_MODES).optional(),
    // method = "comment": the comment gh posts to hand the pull request to a merge service.
    comment: z.string().trim().min(1).max(500).optional(),
    // Comments that appear after Loom's attempt and match one of these are the merge service rejecting it.
    rejected: z.array(nonBlankGlob).max(10).optional(),
    require_live: z.boolean().optional(),
    max_attempts: z.number().int().min(1).max(10).optional(),
    final_review: finalReviewSchema.optional(),
  })
  .strict();

const forgeLogin = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,199}$/, "must be a forge login, such as alice or alice@example.com");

// Who Loom asks to review each pull request it opens: a sample of fixed logins.
export const reviewerRuleSchema = z
  .object({
    users: z.array(forgeLogin).min(1).max(50),
    count: z.number().int().min(1).max(10).optional(),
  })
  .strict();

// The keys a forge profile shares with a spec's forge: the commands Loom runs, the checks it drops, the authors it counts
// as bots, and what it tells workers and reviewers about the server.
const forgeKeys = {
  open: command.optional(),
  state: command.optional(),
  feedback: command.optional(),
  edit: command.optional(),
  reply: command.optional(),
  // Moves an open pull request to another base branch; gh does it itself.
  retarget: command.optional(),
  after_open: z.array(command).max(5).optional(),
  // Run after each push to an open pull request, and after Loom moves one to another base.
  after_push: z.array(command).max(5).optional(),
  // Globs, not regular expressions: a pattern from a spec must never be able to stall the plugin's thread.
  ignore_checks: z.array(nonBlankGlob).max(20).optional(),
  // Hands a ready pull request to the forge's merge; auto_merge says when.
  merge: command.optional(),
  // Marks a draft pull request ready for review in LOOM_URL; gh does it itself.
  ready: command.optional(),
  // Asks the logins in LOOM_REVIEWERS to review.
  request_reviews: command.optional(),
  // Authors whose top-level comments start no fix round, on top of the ones the forge marks as bots and Loom's botAuthors setting.
  bots: z.array(nonBlankGlob).max(50).optional(),
  // What workers and reviewers of this forge's pull requests are told about the server, such as how its review bot clears a finding.
  notes: z.string().trim().min(1).max(4000).optional(),
};

/** What merge.publish waits for besides the review gate and the base: the checks passed on the pushed commit, and the rollout's prerequisites are live. */
export const PUBLISH_WHEN = ["checks", "live"] as const;

export const FORGE_PROFILE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const profileId = z.string().regex(FORGE_PROFILE_ID, "must be 1-32 lowercase letters, digits or dashes, starting with a letter (for example forge)");

// The server that hosts a repo's pull requests: gh, the spec's own commands, a forge profile from Loom's settings, or none
// (Loom only pushes the branch). A forge that names a profile is a command forge, so its kind may be left out.
export const forgeSchema = z.preprocess(
  (value) => (value !== null && typeof value === "object" && !Array.isArray(value) && "profile" in value && !("kind" in value) ? { kind: "command", ...value } : value),
  z
    .object({
      kind: z.enum(["gh", "command", "none"]),
      // A forge profile kept in Loom's settings; the keys the spec sets beside it win over the profile's.
      profile: profileId.optional(),
      ...forgeKeys,
      auto_merge: autoMergeSchema.optional(),
      reviewers: z.array(reviewerRuleSchema).min(1).max(10).optional(),
    })
    .strict(),
);

// A command forge kept in Loom's settings rather than in a spec: any spec names it with forge = { profile = "<id>" }, and
// an edit to it reaches every project that uses it at Loom's next forge call.
export const forgeProfileSchema = z
  .object({
    id: profileId,
    name: z.string().trim().min(1).max(60),
    kind: z.literal("command").default("command"),
    ...forgeKeys,
    open: command,
    state: command,
  })
  .strict();

export type ForgeProfile = z.output<typeof forgeProfileSchema>;

/** Where a spec's forge profiles come from: the store, or none for a spec read with no settings at hand. */
export interface ForgeProfiles {
  forgeProfile(id: string): ForgeProfile | null;
  forgeProfileIds(): string[];
}

export const NO_PROFILES: ForgeProfiles = { forgeProfile: () => null, forgeProfileIds: () => [] };

// What happens when a project event happens: the planner, or for ticket.started each worker's brief, is told to do
// something with its own tools. Loom only delivers it; it blocks nothing.
export const hookSchema = z
  .object({
    on: z.enum(HOOK_EVENTS),
    tell: z.string().trim().min(1).max(2000),
    // Unset: the planner.
    to: z.enum(["planner", "worker"]).optional(),
  })
  .strict();

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const providerId = z.string().regex(PROVIDER_ID, "must be a bb environment provider id, such as git-worktree");
const inputsSchema = z.record(z.string(), z.unknown());

// A bb machine provider that gives each thread a new machine, with inputs that may hold the same placeholders.
export const machineSchema = z.object({ provider: z.string().regex(PROVIDER_ID, "must be a bb machine provider id"), inputs: inputsSchema.optional() }).strict();

// A bb environment provider for workers and reviewers, with inputs that may hold the {branch} and {base} placeholders,
// and optionally a new machine per thread.
export const environmentSchema = z
  .object({
    provider: providerId,
    inputs: inputsSchema.optional(),
    machine: machineSchema.optional(),
  })
  .strict();

// A ticket's own merge patch over its repo's environment inputs, for the threads that start in the repo's provider.
export const ticketEnvironmentSchema = z.object({ inputs: inputsSchema }).strict();

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
    rollout: ticketRolloutSchema.optional(),
    // Keep the pull request a draft until the human releases it; Loom marks every other one ready for review. No default, so specs hash as before.
    keep_draft: z.boolean().optional(),
  })
  .strict();

// How long each git fetch, ls-remote or push for a repo may take. No default, so a spec without it hashes as it did before it existed.
const gitNetworkTimeoutSeconds = z.number().int().min(GIT_NETWORK_TIMEOUT_SECONDS.min).max(GIT_NETWORK_TIMEOUT_SECONDS.max);

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
    deploy: deploySchema.optional(),
    refresh_behind: z.number().int().min(1).max(1_000_000).optional(),
    git_network_timeout_seconds: gitNetworkTimeoutSeconds.optional(),
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
    rollout: ticketSpecSchema.shape.rollout,
    keep_draft: ticketSpecSchema.shape.keep_draft,
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
        remote: remoteName.default("origin"),
        draft: z.boolean().default(true),
        forge: forgeSchema.optional(),
        // No defaults, so a spec without them hashes as it did before they existed; prSettings fills them in.
        describe: z.enum(["worker", "loom"]).optional(),
        max_fix_rounds: z.number().int().min(0).max(20).optional(),
        stack: z.boolean().optional(),
        // Commits an open pull request's branch may lack of its remote base before Loom merges the base into it; unset is off.
        refresh_behind: z.number().int().min(1).max(1_000_000).optional(),
        // Unset: GIT_NETWORK_TIMEOUT_MS. A [[repo]] table's own value replaces it.
        git_network_timeout_seconds: gitNetworkTimeoutSeconds.optional(),
        // Keep each pull request a draft until it can ship, then mark it ready; unset, Loom marks it ready once it targets its base.
        publish: z.object({ when: z.array(z.enum(PUBLISH_WHEN)).min(1).max(PUBLISH_WHEN.length).optional() }).strict().optional(),
      })
      .strict(),
    checks: z
      .object({
        commands: z.array(command).max(10).default([]),
        after_merge: z.array(command).max(10).default([]),
        timeout_minutes: z.number().int().min(1).max(29).default(CHECKS_TIMEOUT_MINUTES),
        // No default: unset follows the forge (repoSettings), true where it reports checks.
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
        ticket_timeout_minutes: z.number().int().min(10).max(1440).default(TICKET_TIMEOUT_MINUTES),
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
    rollout: rolloutSchema.optional(),
    hook: z.array(hookSchema).max(20).optional(),
    ticket: z.array(ticketSpecSchema).min(1).max(200),
  })
  .strict();

export type Spec = z.output<typeof specSchema>;

/**
 * A spec version's stored JSON, as every reader gets it: as it was saved, with the defaults a later schema gave keys a
 * stored version may lack. A value it holds, an old default included, is kept.
 */
export function readSpec(json: string, profiles: ForgeProfiles): Spec {
  const spec = JSON.parse(json) as Spec;
  spec.agents.ticket_timeout_minutes ??= TICKET_TIMEOUT_MINUTES;
  spec.checks.timeout_minutes ??= CHECKS_TIMEOUT_MINUTES;
  const resolved = withProfiles(spec, profiles);
  if (resolved.errors.length > 0) throw new Error(`This spec cannot run: ${resolved.errors.join(" ")}`);
  return resolved.spec;
}

/** The forge as it runs: the profile's keys, under the ones the spec sets beside it. */
export function profileForge(forge: ForgeSpec, profile: ForgeProfile): ForgeSpec {
  const { id: _id, name: _name, kind: _kind, ...keys } = profile;
  return { ...keys, ...forge, kind: "command" };
}

/**
 * The spec with every forge that names a profile filled in from it, and an error for each profile Loom does not have; the
 * spec as stored keeps only the profile's id, so an edit to the profile reaches it.
 */
export function withProfiles(spec: Spec, profiles: ForgeProfiles): { spec: Spec; errors: string[] } {
  const errors: string[] = [];
  const fill = (forge: ForgeSpec | undefined, at: string): ForgeSpec | undefined => {
    if (forge?.profile === undefined) return forge;
    if (forge.kind !== "command") {
      errors.push(`${at}.kind: a forge profile is a command forge, so kind must be "command" or left out, not "${forge.kind}". Remove kind, or remove profile.`);
      return forge;
    }
    const profile = profiles.forgeProfile(forge.profile);
    if (profile !== null) return profileForge(forge, profile);
    const ids = profiles.forgeProfileIds();
    errors.push(
      `${at}.profile: Loom has no forge profile "${forge.profile}". ${ids.length === 0 ? "It has none yet: add one in Loom's settings under Forges, or with `bb loom forge import <file> --apply`." : `Use one of: ${ids.join(", ")}.`}`,
    );
    return forge;
  };
  const named = (forge: ForgeSpec | undefined) => forge?.profile !== undefined;
  if (!named(spec.merge.forge) && !(spec.repo ?? []).some((repo) => named(repo.forge))) return { spec, errors };
  const merge = { ...spec.merge, forge: fill(spec.merge.forge, "merge.forge") };
  const repo = spec.repo?.map((entry, index) => ({ ...entry, forge: fill(entry.forge, `repo[${index}].forge`) }));
  return { spec: { ...spec, merge, ...(repo === undefined ? {} : { repo }) }, errors };
}

/** The ids of the forge profiles a spec names, in its order, once each. */
export function profilesNamed(spec: Spec): string[] {
  const ids = [spec.merge.forge?.profile, ...(spec.repo ?? []).map((repo) => repo.forge?.profile)].filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}
export type TicketSpec = z.output<typeof ticketSpecSchema>;
export type TicketPatch = z.output<typeof ticketPatchSchema>;
export type RepoSpec = z.output<typeof repoSpecSchema>;
export type ForgeSpec = z.output<typeof forgeSchema>;
export type AutoMergeSpec = z.output<typeof autoMergeSchema>;
export type ReviewerRuleSpec = z.output<typeof reviewerRuleSchema>;
export type EnvironmentSpec = z.output<typeof environmentSchema>;
export type MachineSpec = z.output<typeof machineSchema>;
export type TicketRolloutSpec = z.output<typeof ticketRolloutSchema>;
export type RolloutSpec = z.output<typeof rolloutSchema>;
export type HookSpec = z.output<typeof hookSchema>;
export type { HookEvent } from "./hook-events";

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

const settingHome = (setting: string) => `Loom's ${setting} setting is its only home, for every project: remove the key, and change the setting on Loom's settings page if you need another value.`;

const INDEX_FIXED = `Loom gives the index and tree steps of one call on a checkout ${GIT_INDEX_TIMEOUT_MS / 1000} seconds, which no project needed to change: remove the key.`;

const WORKTREE_GONE = "Loom always adds its own git worktree of the integration branch; for a repository that refuses one, use merge.strategy = \"pr\": remove the key.";

const APPROVAL_GONE = "Loom merges only once the forge says a person approved the pull request: remove the key.";
const FINAL_FIXED = "The final review always uses agents.reviewer at low reasoning, within 10 minutes: remove the key, and keep final_review = {} or final_review = true to turn it on.";

const REVIEWER_ENV_GONE = "Reviewers, the spec reviewer and the summary agent start in the repo's own environment, as workers do: remove the key.";

const TEAMS_GONE = "A reviewers rule names its people in users, with an optional count to pick from them: remove the key.";

/** Keys Loom once read and no longer does, by their path with every array index written [], and what replaces each. */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  "merge.checks_queued_minutes": settingHome("checksQueuedMinutes"),
  "merge.checks_near_done_percent": settingHome("checksNearDonePercent"),
  "merge.git_index_timeout_seconds": INDEX_FIXED,
  "repo[].git_index_timeout_seconds": INDEX_FIXED,
  "merge.branch": "The integration branch is always loom/<slug>, from project.slug: remove the key.",
  "merge.worktree": WORKTREE_GONE,
  "repo[].worktree": WORKTREE_GONE,
  "merge.forge.auto_merge.approval": APPROVAL_GONE,
  "repo[].forge.auto_merge.approval": APPROVAL_GONE,
  ...Object.fromEntries(["provider", "model", "reasoning", "timeout_minutes"].flatMap((key) => ["merge.forge", "repo[].forge"].map((at) => [`${at}.auto_merge.final_review.${key}`, FINAL_FIXED]))),
  "environment.reviewer": REVIEWER_ENV_GONE,
  "repo[].environment.reviewer": REVIEWER_ENV_GONE,
  "merge.forge.team_members": TEAMS_GONE,
  "repo[].forge.team_members": TEAMS_GONE,
  "merge.forge.reviewers[].team": TEAMS_GONE,
  "repo[].forge.reviewers[].team": TEAMS_GONE,
  "hook[].run": "A hook tells the planner, or each worker, what to do; for a command on an event, use the doneHook setting, or a forge's after_open and after_push: remove the key.",
  "merge.squash": "Loom always pushes the reviewed work as one commit, and each fix round as one more: remove the key.",
  "merge.release_workers": "Loom always releases an idle worker whose pull request is open, so bb frees its environment, and brings it back when the pull request needs it: remove the key.",
};

const templatePath = (path: readonly PropertyKey[]) => path.map((part, index) => (typeof part === "number" ? "[]" : `${index > 0 ? "." : ""}${String(part)}`)).join("");

function describeIssue(issue: z.core.$ZodIssue): string[] {
  if (issue.code !== "unrecognized_keys") return [describeOtherIssue(issue)];
  const path = formatPath(issue.path);
  const template = templatePath(issue.path);
  const removed = issue.keys.filter((key) => REMOVED_KEYS[`${template}.${key}`] !== undefined);
  const unknown = issue.keys.filter((key) => !removed.includes(key));
  const many = unknown.length > 1;
  return [
    ...removed.map((key) => `${path}.${key}: Loom no longer reads this key. ${REMOVED_KEYS[`${template}.${key}`]}`),
    ...(unknown.length === 0
      ? []
      : [`${path}: unknown ${many ? "keys" : "key"} ${unknown.map((key) => JSON.stringify(key)).join(", ")}. Remove ${many ? "them" : "it"} or correct ${many ? "their" : "its"} spelling; the loom skill lists every key in references/spec.md.`]),
  ];
}

function describeOtherIssue(issue: z.core.$ZodIssue): string {
  const path = formatPath(issue.path);
  switch (issue.code) {
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

/**
 * Parses and checks a spec. A forge that names a profile is checked as it would run, with the profile's keys filled in from
 * `profiles`; the spec returned keeps only the profile's id.
 */
export function parseSpec(toml: string, profiles: ForgeProfiles = NO_PROFILES): SpecResult {
  let raw: unknown;
  try {
    raw = parse(toml);
  } catch (error) {
    return failed([describeTomlError(error)]);
  }
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) return failed(parsed.error.issues.flatMap(describeIssue));
  const resolved = withProfiles(parsed.data, profiles);
  if (resolved.errors.length > 0) return failed(resolved.errors);
  const { errors, warnings } = validateSemantics(resolved.spec, toml);
  if (errors.length > 0) return { ok: false, spec: null, errors, warnings };
  return { ok: true, spec: parsed.data, errors: [], warnings };
}

// ---------------------------------------------------------------- keys set to their default

/** ci left out follows the forge: true where it reports checks. */
const FROM_FORGE = Symbol("ci from the forge");

/** The defaults Loom applies in code rather than in the schema, by key path with every array index written []. */
const CODE_DEFAULTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ...Object.entries(PR_DEFAULTS).map(([key, value]): [string, unknown] => [`merge.${key}`, value]),
  ["merge.git_network_timeout_seconds", GIT_NETWORK_TIMEOUT_MS / 1000],
  ["repo[].git_network_timeout_seconds", GIT_NETWORK_TIMEOUT_MS / 1000],
  ...["merge.forge", "repo[].forge"].flatMap((at) => Object.entries(AUTO_MERGE_DEFAULTS).map(([key, value]): [string, unknown] => [`${at}.auto_merge.${key}`, value])),
  ["checks.ci", FROM_FORGE],
  ["repo[].ci", FROM_FORGE],
]);

type ZodNode = { _zod: { def: Record<string, unknown> & { type: string } } };

/** Every scalar key path of the schema, in its order, with the default the schema or the code gives it. */
function defaultsOf(schema: ZodNode, path: string, out: Array<[string, unknown]>): Array<[string, unknown]> {
  const def = schema._zod.def;
  switch (def.type) {
    case "optional":
    case "prefault":
      return defaultsOf(def.innerType as ZodNode, path, out);
    case "pipe":
      return defaultsOf(def.out as ZodNode, path, out);
    case "default": {
      const value = def.defaultValue;
      if (value !== null && typeof value === "object") return defaultsOf(def.innerType as ZodNode, path, out);
      out.push([path, value]);
      return out;
    }
    case "object":
      for (const [key, child] of Object.entries(def.shape as Record<string, ZodNode>)) defaultsOf(child, path === "" ? key : `${path}.${key}`, out);
      return out;
    case "array":
      return defaultsOf(def.element as ZodNode, `${path}[]`, out);
    default:
      if (CODE_DEFAULTS.has(path)) out.push([path, CODE_DEFAULTS.get(path)]);
      return out;
  }
}

let defaultPaths: Array<[string, unknown]> | null = null;

/** Each value at a key path, one per array entry, with the table that holds it. */
function valuesAt(node: unknown, parts: readonly string[], table: Record<string, unknown> | null = null): Array<{ value: unknown; table: Record<string, unknown> | null }> {
  if (parts.length === 0) return [{ value: node, table }];
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [];
  const [head, ...rest] = parts;
  const list = head!.endsWith("[]");
  const child = (node as Record<string, unknown>)[list ? head!.slice(0, -2) : head!];
  if (child === undefined) return [];
  if (!list) return valuesAt(child, rest, node as Record<string, unknown>);
  return Array.isArray(child) ? child.flatMap((entry) => valuesAt(entry, rest, entry as Record<string, unknown>)) : [];
}

/**
 * The key paths, with every array index written [], that the TOML sets to the value Loom uses when they are left out;
 * a ci counts where it equals what its forge gives. Empty when the TOML does not parse: parseSpec reports that.
 */
export function defaultKeysIn(toml: string): string[] {
  let raw: Record<string, unknown>;
  try {
    raw = parse(toml) as Record<string, unknown>;
  } catch {
    return [];
  }
  defaultPaths ??= defaultsOf(specSchema as unknown as ZodNode, "", []);
  const merge = (raw.merge ?? {}) as { forge?: object };
  const checks = (raw.checks ?? {}) as { ci?: unknown };
  const repos = Array.isArray(raw.repo) ? raw.repo : [];
  // A profile's commands are in Loom's settings, not the TOML, so a ci beside one is never judged a default.
  const forgeGives = (forge: object | undefined) => (forge !== undefined && "profile" in forge ? FROM_FORGE : followsFeedback({ kind: "gh", ...forge } as ForgeSpec));
  // A top-level ci in a multi-repo spec is each repo's default, whose forges may differ, so only a repo's own ci is judged there.
  const ciDefault = (path: string, table: Record<string, unknown> | null): unknown =>
    path === "checks.ci" ? (repos.length === 0 ? forgeGives(merge.forge) : FROM_FORGE) : checks.ci === undefined ? forgeGives((table?.forge as object | undefined) ?? merge.forge) : FROM_FORGE;
  return defaultPaths
    .filter(([path, value]) => valuesAt(raw, path.split(".")).some((at) => at.value === (value === FROM_FORGE ? ciDefault(path, at.table) : value)))
    .map(([path]) => path);
}

/** The warning loom_propose adds for keys set to their default, or null when there are none. */
export function defaultKeysWarning(toml: string): string | null {
  const keys = defaultKeysIn(toml);
  if (keys.length === 0) return null;
  return `These keys are set to the value Loom uses when they are left out, so they only make the spec longer: ${andList(keys)}. Leave them out of the next version; Loom saved this one as written.`;
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
  let looped = cycle !== null;
  if (cycle === null && spec.ticket.some((ticket) => (ticket.merge_after ?? []).length > 0)) {
    const order = dependencyCycle(spec.ticket.map((ticket) => ({ ref: ticket.ref, depends_on: [...ticket.depends_on, ...(ticket.merge_after ?? []).filter((ref) => ref !== ticket.ref)] })));
    if (order !== null) errors.push(`ticket[${indexOfRef.get(order[0]!)}].merge_after: merge order cycle ${order.join(" -> ")} through depends_on and merge_after. Remove one merge_after entry to break the cycle.`);
    looped = order !== null;
  }
  const rollout = rolloutProblems(spec, indexOfRef, looped);
  errors.push(...rollout.errors);
  warnings.push(...rollout.warnings);

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
    for (const key of ["describe", "max_fix_rounds", "stack", "refresh_behind", "publish"] as const) {
      if (spec.merge[key] !== undefined) errors.push(`merge.${key}: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`);
    }
    repos.forEach((repo, index) => {
      if (repo.refresh_behind !== undefined) errors.push(`repo[${index}].refresh_behind: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`);
    });
    const ciPaths = [...(spec.checks.ci === undefined ? [] : ["checks.ci"]), ...repos.flatMap((repo, index) => (repo.ci === undefined ? [] : [`repo[${index}].ci`]))];
    for (const at of ciPaths) errors.push(`${at}: it says whether Loom relies on the CI of the pull request it opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`);
  } else {
    errors.push(...ciForgeErrors(spec), ...publishErrors(spec));
  }

  errors.push(...forgeErrors(spec, spec.merge.forge, "merge.forge"), ...environmentErrors(spec.environment, "environment"));
  spec.ticket.forEach((ticket, index) => {
    const repo = ticket.repo === undefined ? undefined : repos.find((entry) => entry.name === ticket.repo);
    // A ticket whose repo is unknown has an error above.
    if (ticket.repo !== undefined && repo === undefined) return;
    errors.push(...ticketEnvironmentErrors(ticket.environment, repo?.environment ?? spec.environment ?? null, `ticket[${index}].environment`));
  });
  repos.forEach((repo, index) => {
    errors.push(...forgeErrors(spec, repo.forge, `repo[${index}].forge`), ...environmentErrors(repo.environment, `repo[${index}].environment`));
  });
  errors.push(...machineErrors(spec), ...hookErrors(spec));

  const { worker, reviewer } = spec.agents;
  if (worker.provider === reviewer.provider && worker.model === reviewer.model) {
    warnings.push("agents.reviewer: the reviewer uses the same provider and model as the worker, so it shares the worker's blind spots. Set agents.reviewer.provider and model to a different model.");
  }
  warnings.push(...overlapWarnings(scopeOverlaps(spec.ticket)));
  for (const [forge, at] of forgesOf(spec)) {
    const method = forge?.auto_merge?.method;
    if ((method === "comment" || method === "command") && forge!.auto_merge!.rejected === undefined) {
      warnings.push(`${at}.auto_merge.rejected: unset, so Loom cannot tell when the merge service turns the pull request away; it waits until the pull request merges. Add globs for the service's failure comments, such as "Merge failed*".`);
    }
  }

  return { errors, warnings };
}

/** The forges the spec sets, with their paths. */
const forgesOf = (spec: Spec): Array<[ForgeSpec | undefined, string]> => [[spec.merge.forge, "merge.forge"], ...(spec.repo ?? []).map((repo, index): [ForgeSpec | undefined, string] => [repo.forge, `repo[${index}].forge`])];

/**
 * The rollout's own checks. Deploy order is advice for each ticket's pull request, so the integration strategy refuses it;
 * on the pr strategy every name must resolve, stages must not run backwards, and the work, merge and deploy orders
 * together must not loop. `looped` says a depends_on or merge order cycle was reported already.
 */
function rolloutProblems(spec: Spec, indexOfRef: ReadonlyMap<string, number>, looped: boolean): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const repos = spec.repo ?? [];
  if (spec.merge.strategy === "integration") {
    const why = (at: string, what: string) =>
      `${at}: deploy order is advice for the pull requests Loom opens for each ticket, but merge.strategy is "integration", where every ticket lands together. Remove ${what}, or use merge.strategy = "pr".`;
    if (spec.rollout !== undefined) errors.push(why("rollout", "[rollout]"));
    repos.forEach((repo, index) => repo.deploy !== undefined && errors.push(why(`repo[${index}].deploy`, "deploy")));
    spec.ticket.forEach((ticket, index) => ticket.rollout !== undefined && errors.push(why(`ticket[${index}].rollout`, "rollout")));
    return { errors, warnings };
  }

  const stages = spec.rollout?.stage ?? [];
  const milestones = spec.rollout?.milestone ?? [];
  const stageIndex = new Map<string, number>();
  stages.forEach((stage, index) => {
    const first = stageIndex.get(stage.name);
    if (first === undefined) stageIndex.set(stage.name, index);
    else errors.push(`rollout.stage[${index}].name: "${stage.name}" is also the name of rollout.stage[${first}]. Give every stage a unique name.`);
  });
  const milestoneIndex = new Map<string, number>();
  milestones.forEach((milestone, index) => {
    const first = milestoneIndex.get(milestone.ref);
    if (first !== undefined) errors.push(`rollout.milestone[${index}].ref: "${milestone.ref}" is also the ref of rollout.milestone[${first}]. Give every milestone a unique ref.`);
    else if (indexOfRef.has(milestone.ref)) errors.push(`rollout.milestone[${index}].ref: "${milestone.ref}" is also the ref of ticket[${indexOfRef.get(milestone.ref)}]. A milestone is a prerequisite no ticket delivers: give it another ref, or name the ticket in requires_live instead.`);
    else milestoneIndex.set(milestone.ref, index);
  });

  const stageNames = [...stageIndex.keys()].join(", ");
  const unnamed = new Set<string>();
  const stageProblem = (at: string, name: string | undefined) => {
    if (name === undefined || stageIndex.has(name)) return;
    if (stages.length === 0) unnamed.add(name);
    else errors.push(`${at}: "${name}" is not a [[rollout.stage]] name. Use one of: ${stageNames}.`);
  };
  milestones.forEach((milestone, index) => stageProblem(`rollout.milestone[${index}].stage`, milestone.stage));
  spec.ticket.forEach((ticket, index) => stageProblem(`ticket[${index}].rollout.stage`, ticket.rollout?.stage));

  const known = [...new Set([...indexOfRef.keys(), ...milestones.map((milestone) => milestone.ref)])];
  spec.ticket.forEach((ticket, index) => {
    for (const ref of ticket.rollout?.requires_live ?? []) {
      if (ref === ticket.ref) errors.push(`ticket[${index}].rollout.requires_live: "${ref}" is this ticket's own ref. Remove it.`);
      else if (!indexOfRef.has(ref) && !milestoneIndex.has(ref)) {
        const others = known.filter((other) => other !== ticket.ref);
        errors.push(`ticket[${index}].rollout.requires_live: "${ref}" is not a ticket ref or a [[rollout.milestone]] ref. ${others.length > 0 ? `Use one of: ${others.join(", ")}.` : "Remove it."}`);
      }
    }
  });

  (spec.rollout?.window ?? []).forEach((window, index) => {
    if (window.from > window.to) errors.push(`rollout.window[${index}]: from (${window.from}) is after to (${window.to}). Swap them.`);
  });

  if (!looped && spec.ticket.some((ticket) => (ticket.rollout?.requires_live ?? []).length > 0)) {
    const order = dependencyCycle(
      spec.ticket.map((ticket) => ({ ref: ticket.ref, depends_on: [...ticket.depends_on, ...(ticket.merge_after ?? []), ...(ticket.rollout?.requires_live ?? [])].filter((ref) => ref !== ticket.ref) })),
    );
    if (order !== null) {
      errors.push(`ticket[${indexOfRef.get(order[0]!)}].rollout.requires_live: rollout order cycle ${order.join(" -> ")} through depends_on, merge_after and requires_live. Remove one requires_live entry to break the cycle.`);
    }
  }

  const stageOfRef = new Map<string, string>([
    ...spec.ticket.flatMap((ticket) => (ticket.rollout?.stage === undefined ? [] : [[ticket.ref, ticket.rollout.stage] as const])),
    ...milestones.flatMap((milestone) => (milestone.stage === undefined ? [] : [[milestone.ref, milestone.stage] as const])),
  ]);
  spec.ticket.forEach((ticket, index) => {
    const own = ticket.rollout?.stage === undefined ? undefined : stageIndex.get(ticket.rollout.stage);
    if (own === undefined) return;
    for (const ref of ticket.rollout?.requires_live ?? []) {
      const theirs = stageOfRef.get(ref);
      const at = theirs === undefined ? undefined : stageIndex.get(theirs);
      if (at === undefined || at <= own) continue;
      errors.push(
        `ticket[${index}].rollout.requires_live: "${ref}" is in the stage "${theirs}", which comes after this ticket's stage "${ticket.rollout!.stage}". Require only what the same or an earlier stage delivers, or move one of them to another stage.`,
      );
    }
  });

  if (unnamed.size > 0) {
    const names = [...unnamed];
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    warnings.push(
      `rollout: tickets name the ${names.length === 1 ? "stage" : "stages"} ${list}, but the spec has no [[rollout.stage]] tables, so the stages have no goal or soak and Loom orders them by the first ticket that names each. Add a [[rollout.stage]] table for each, in order.`,
    );
  }
  spec.ticket.forEach((ticket, index) => {
    if (ticket.rollout?.verify === undefined || !deploysOnMerge(spec, ticket.repo ?? null)) return;
    const where = ticket.repo === undefined ? "the project's repo" : `the repo ${JSON.stringify(ticket.repo)}`;
    warnings.push(`ticket[${index}].rollout.verify: ${where} deploys on merge, so Loom marks this ticket live when its pull request merges and never runs verify. Remove verify, or set deploy.on_merge = false.`);
  });
  return { errors, warnings };
}

/**
 * A repo whose ci, or the top-level one, says true needs a forge that reports checks: gh, or a command forge with a
 * feedback command. Unset, ci follows the forge, so it needs nothing.
 */
function ciForgeErrors(spec: Spec): string[] {
  const repos = spec.repo ?? [];
  const entries: Array<{ name: string | null; forge: ForgeSpec; forgeAt: string; ciAt: string; ci: boolean | undefined }> =
    repos.length === 0
      ? [{ name: null, forge: spec.merge.forge ?? { kind: "gh" }, forgeAt: "merge.forge", ciAt: "checks.ci", ci: spec.checks.ci }]
      : repos.map((repo, index) => ({ name: repo.name, forge: repo.forge ?? spec.merge.forge ?? { kind: "gh" }, forgeAt: repo.forge === undefined ? "merge.forge" : `repo[${index}].forge`, ciAt: `repo[${index}].ci`, ci: repo.ci ?? spec.checks.ci }));
  return entries.flatMap(({ name, forge, forgeAt, ciAt, ci }) => {
    if (ci !== true || forge.kind === "gh" || (forge.kind === "command" && forge.feedback !== undefined)) return [];
    const who = name === null ? "the repo" : `the repo ${JSON.stringify(name)}`;
    const relies = `${who} relies on its pull requests' CI (${ciAt} is true), but`;
    const off = `remove ${ciAt} so the plugin checks are the whole bar.`;
    return [
      forge.kind === "none"
        ? `${forgeAt}: ${relies} kind = "none" opens no pull request and reports no checks. Use kind = "gh", or kind = "command" with a feedback command, or ${off}`
        : `${forgeAt}: ${relies} this forge reports no checks, so Loom could never send a failed one back. Add a feedback command to ${forgeAt}, or ${off}`,
    ];
  });
}

/** Only a worker that starts on a ticket reads a hook: every other event finds it done, gone or waiting. */
/** merge.publish keeps pull requests drafts and marks them ready once they can ship, so each repo's forge must read and mark drafts. */
function publishErrors(spec: Spec): string[] {
  if (spec.merge.publish === undefined) return [];
  const errors: string[] = [];
  if (!spec.merge.draft) errors.push("merge.publish: Loom publishes a pull request by marking its draft ready, but merge.draft is false, so each one opens ready for review. Set merge.draft = true, or remove publish.");
  if (spec.merge.max_fix_rounds === 0) errors.push("merge.publish: Loom reads a pull request's checks only while it follows its feedback, and merge.max_fix_rounds is 0. Raise max_fix_rounds, or remove publish.");
  const repos = spec.repo ?? [];
  const entries = repos.length === 0 ? [{ forge: spec.merge.forge ?? { kind: "gh" as const }, at: "merge.forge" }] : repos.map((repo, index) => ({ forge: repo.forge ?? spec.merge.forge ?? { kind: "gh" as const }, at: repo.forge === undefined ? "merge.forge" : `repo[${index}].forge` }));
  for (const { forge, at } of entries.filter((entry, index) => entries.findIndex((other) => other.at === entry.at) === index)) {
    if (forge.kind === "none") errors.push(`${at}: merge.publish marks pull requests ready, and kind = "none" opens none. Use kind = "gh" or "command", or remove publish.`);
    else if (!followsFeedback(forge)) errors.push(`${at}: merge.publish reads a pull request's draft flag and checks, and this forge has no feedback command. Add ${at}.feedback, or remove publish.`);
    else if (!canReady(forge)) errors.push(`${at}: merge.publish marks drafts ready, and this forge has no ready command. Add ${at}.ready, or remove publish.`);
  }
  return errors;
}

function hookErrors(spec: Spec): string[] {
  return (spec.hook ?? []).flatMap((hook, index) => {
    const at = `hook[${index}]`;
    if (hook.to === "worker" && hook.on !== "ticket.started") {
      return [`${at}.to: a worker reads a hook only when it starts on a ticket, in its brief; on ${hook.on} its work is handed in or done. Use on = "ticket.started", or leave to unset so the planner does it.`];
    }
    return [];
  });
}

function forgeErrors(spec: Spec, forge: ForgeSpec | undefined, at: string): string[] {
  if (forge === undefined) return [];
  const errors = [...autoMergeErrors(spec, forge, at), ...reviewerErrors(spec, forge, at)];
  if (forge.kind === "command") {
    if (forge.open === undefined) {
      errors.push(`${at}.open: is required when ${at}.kind is "command". Add the command that opens a pull request: it gets LOOM_REMOTE, LOOM_BASE, LOOM_HEAD, LOOM_TITLE and LOOM_DRAFT, reads the body on stdin, and prints the pull request's URL.`);
    }
    if (forge.state === undefined) {
      errors.push(`${at}.state: is required when ${at}.kind is "command". Add the command that prints open, merged or closed for the pull request in LOOM_URL (its number is in LOOM_PR_NUMBER).`);
    }
    return errors;
  }
  for (const key of ["open", "state", "feedback", "edit", "reply", "retarget", "merge", "request_reviews"] as const) {
    if (forge[key] !== undefined) errors.push(`${at}.${key}: only kind = "command" runs it, and ${at}.kind is "${forge.kind}". Remove it, or set kind = "command".`);
  }
  if (forge.kind === "none") {
    for (const key of ["after_open", "after_push"] as const) {
      if (forge[key] !== undefined) errors.push(`${at}.${key}: kind = "none" opens no pull request, so nothing would run these. Remove ${key}, or use kind = "gh" or "command".`);
    }
    if (forge.ignore_checks !== undefined) errors.push(`${at}.ignore_checks: kind = "none" reads no checks, so there is nothing to ignore. Remove ignore_checks, or use kind = "gh" or "command".`);
  }
  return errors;
}

/** The most people Loom asks to review one pull request: what one prRequestReview call takes. */
export const REVIEWERS_MAX = 20;

const PR_ONLY = (at: string, what: string) => `${at}: ${what} the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".`;

/** auto_merge needs a forge that opens pull requests, reports what Ready to merge reads, and has the method it names. */
function autoMergeErrors(spec: Spec, forge: ForgeSpec, at: string): string[] {
  const auto = forge.auto_merge;
  const errors: string[] = [];
  if (forge.kind === "command" && forge.merge !== undefined && auto === undefined) errors.push(`${at}.merge: only auto_merge runs it, and ${at} has none. Add ${at}.auto_merge with method = "command", or remove merge.`);
  if (auto === undefined) return errors;
  const path = `${at}.auto_merge`;
  if (spec.merge.strategy === "integration") return [...errors, PR_ONLY(path, "it merges")];
  if (forge.kind === "none") return [...errors, `${path}: kind = "none" opens no pull request, so there is nothing to merge. Remove auto_merge, or use kind = "gh" or "command".`];
  if ((spec.merge.max_fix_rounds ?? PR_DEFAULTS.max_fix_rounds) === 0) errors.push(`${path}: merge.max_fix_rounds is 0, so Loom reads no checks or reviews and its Ready to merge verdict can never hold. Raise max_fix_rounds, or remove auto_merge.`);
  if (forge.kind === "command") {
    if (auto.method !== "command") errors.push(`${path}.method: a kind = "command" forge merges with its own merge command. Use method = "command".`);
    if (forge.merge === undefined) errors.push(`${at}.merge: is required with auto_merge on a kind = "command" forge. Add the command that merges the pull request in LOOM_URL, or hands it to the server's merge service.`);
    if (forge.feedback === undefined) errors.push(`${path}: Loom merges only once the forge says the pull request is approved, not a draft and its checks pass, and this forge has no feedback command to say so. Add ${at}.feedback, or remove auto_merge.`);
  } else {
    if (auto.method === "command") errors.push(`${path}.method: "command" runs a kind = "command" forge's merge command, and ${at}.kind is "gh". Use "squash", "merge", "rebase", "queue" or "comment".`);
    if (auto.method === "comment" && auto.comment === undefined) errors.push(`${path}.comment: is required with method = "comment". Set the comment that hands the pull request to the merge service, such as "/merge".`);
  }
  if (auto.comment !== undefined && auto.method !== "comment") errors.push(`${path}.comment: only method = "comment" posts it. Remove comment, or use method = "comment".`);
  if (auto.rejected !== undefined && auto.method !== "comment" && auto.method !== "command") {
    errors.push(`${path}.rejected: ${auto.method === "queue" ? "GitHub's merge queue says itself why it removed a pull request" : `gh pr merge --${auto.method} answers at once`}, so there are no comments to read. Remove rejected.`);
  }
  return errors;
}

/** reviewers needs a forge that opens pull requests and can ask people, and each rule one source of logins. */
function reviewerErrors(spec: Spec, forge: ForgeSpec, at: string): string[] {
  const errors: string[] = [];
  if (forge.kind === "command" && forge.request_reviews !== undefined && forge.reviewers === undefined) errors.push(`${at}.request_reviews: only reviewers runs it, and ${at} has none. Add ${at}.reviewers, or remove request_reviews.`);
  const rules = forge.reviewers;
  if (rules === undefined) return errors;
  if (spec.merge.strategy === "integration") return [...errors, PR_ONLY(`${at}.reviewers`, "it asks for reviews of")];
  if (forge.kind === "none") return [...errors, `${at}.reviewers: kind = "none" opens no pull request, so there is no one to ask. Remove reviewers, or use kind = "gh" or "command".`];
  if (forge.kind === "command" && forge.request_reviews === undefined) errors.push(`${at}.request_reviews: is required with reviewers on a kind = "command" forge. Add the command that asks the logins in LOOM_REVIEWERS to review the pull request in LOOM_URL.`);
  if (forge.kind === "command" && forge.feedback === undefined) errors.push(`${at}.reviewers: Loom asks for reviews once the forge says the pull request is not a draft, and this forge has no feedback command to say so. Add ${at}.feedback, printing draft, or remove reviewers.`);
  const most = rules.reduce((sum, rule) => sum + (rule.count ?? rule.users.length), 0);
  if (most > REVIEWERS_MAX) errors.push(`${at}.reviewers: these rules may ask up to ${most} people to review one pull request, and Loom asks at most ${REVIEWERS_MAX}. Lower the counts, or set count on a rule of users.`);
  rules.forEach((rule, index) => {
    const path = `${at}.reviewers[${index}]`;
    if (rule.count !== undefined && rule.count > rule.users.length) errors.push(`${path}.count: ${rule.count} is more than the ${plural(rule.users.length, "login")} in users. Lower count, or add logins.`);
  });
  return [...new Set(errors)];
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
  const paths = used.flatMap(([environment, at]) => (environment?.machine !== undefined ? [`${at}.machine`] : []));
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

export function canonicalJson(value: unknown): string {
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
