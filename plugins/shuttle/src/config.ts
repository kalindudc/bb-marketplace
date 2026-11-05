// Shuttle's own configuration: servers, review presets and automations. bb's declarative
// settings (settings.ts) hold only the flat knobs; this lives in the plugin database.
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";

export const OPERATIONS = [
  "whoami", "authored", "review_requested", "team_requested", "mentioned", "reviewed", "view", "activity",
  "ready", "draft", "close", "reopen", "edit_labels", "edit_reviewers", "edit_options",
  "merge", "merge_options", "comment", "review", "reply", "resolve", "files", "file",
] as const;
export type Operation = (typeof OPERATIONS)[number];
export const LIST_OPERATIONS = ["authored", "review_requested", "team_requested", "mentioned", "reviewed"] as const;
export type ListOperation = (typeof LIST_OPERATIONS)[number];
/** Operations that change a PR on its server. A server test never runs them. */
export const CHANGE_OPERATIONS = ["ready", "draft", "close", "reopen", "edit_labels", "edit_reviewers"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];
/** Operations that write to a PR's conversation or merge it. A server test never runs them either. */
export const WRITE_OPERATIONS = ["merge", "comment", "review", "reply", "resolve"] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];

export const AUTO_TRIGGERS = ["requested", "team", "mentioned"] as const;
export const WORKSPACES = ["project-default", "worktree"] as const;
export const WATCH_MODES = ["act", "forward"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];

const command = z.string().trim().min(1).max(4000);

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/u;

/**
 * How a review gets its own checkout of this server's PRs, when its preset asks for one. Without
 * it, bb's git worktree. Some repositories refuse worktrees outside their own place (a monorepo may
 * want them in its own trees folder), so a server can name a bb environment provider, or a command that prints a path.
 */
export const serverWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("provider"),
    provider: z.string().regex(PROVIDER_ID, "must be a bb environment provider id such as my-trees"),
    /** The provider's inputs; every string may use {number}, {repo}, {repo_name}, {head_ref}, {base}, {head}, {server} and {slug}. */
    inputs: z.record(z.string(), z.unknown()).default({}),
    /** A new machine for each review from this bb machine provider, instead of the machine with the project's checkout. */
    machine: z.object({
      provider: z.string().regex(PROVIDER_ID, "must be a bb machine provider id, as `bb machine providers` lists them"),
      /** The machine provider's inputs, with the same placeholders. */
      inputs: z.record(z.string(), z.unknown()).default({}),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("command"),
    /** Prints the checkout's absolute path on its last line; the same placeholders, shell-quoted. */
    command,
  }).strict(),
]);
export type ServerWorkspace = z.infer<typeof serverWorkspaceSchema>;

export const serverSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u, "must be lowercase letters, digits and dashes, starting with a letter"),
    name: z.string().trim().min(1).max(40),
    kind: z.enum(["github", "command"]),
    enabled: z.boolean().default(true),
    /** github only: passed to gh as --hostname, for GitHub Enterprise. */
    hostname: z.string().regex(/^[a-z0-9.-]+$/iu).max(200).optional(),
    /** A regular expression for the server's PR links, with (?<repo>…) and (?<number>…) groups. */
    pattern: z.string().min(1).max(500).optional(),
    /** The PR link for a repo and number, with {repo} and {number}. */
    link: z.string().min(1).max(500).optional(),
    sep: z.enum(["#", "!"]).default("#"),
    /** How an agent reads the PR with its conversation, with {repo}, {number} and {url}; shown in review and watch prompts. */
    read: z.string().min(1).max(1000).optional(),
    workspace: serverWorkspaceSchema.optional(),
    commands: z.partialRecord(z.enum(OPERATIONS), command).default({}),
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.kind !== "command") return;
    if (!server.pattern) ctx.addIssue({ code: "custom", path: ["pattern"], message: "a command server needs a link pattern" });
    if (!server.link) ctx.addIssue({ code: "custom", path: ["link"], message: "a command server needs a link template" });
    if (!server.commands.view) ctx.addIssue({ code: "custom", path: ["commands", "view"], message: "a command server needs a view command" });
    if (server.pattern) {
      try {
        const re = new RegExp(server.pattern, "u");
        if (!/\(\?<repo>/u.test(server.pattern) || !/\(\?<number>/u.test(server.pattern)) ctx.addIssue({ code: "custom", path: ["pattern"], message: "needs (?<repo>…) and (?<number>…) groups" });
        void re;
      } catch (error) {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: `is not a valid regular expression: ${(error as Error).message}` });
      }
    }
  });
export type ServerConfig = z.infer<typeof serverSchema>;

export const presetSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
    name: z.string().trim().min(1).max(60),
    default: z.boolean().default(false),
    /** A skill name the reviewer is told to use; empty for none. */
    skill: z.string().max(100).default(""),
    providerId: z.string().max(100).optional(),
    model: z.string().max(200).optional(),
    reasoningLevel: z.string().max(40).optional(),
    workspace: z.enum(WORKSPACES).default("project-default"),
    prompt: z.string().min(1).max(8000),
  })
  .strict();
export type Preset = z.infer<typeof presetSchema>;

export const autoReviewSchema = z
  .object({
    enabled: z.boolean().default(true),
    when: z.array(z.enum(AUTO_TRIGGERS)).default(["requested"]),
    drafts: z.boolean().default(false),
    /** A preset id; empty for the default preset. */
    preset: z.string().max(32).default(""),
    /** Repository globs such as acme/app or acme/*; empty for every repository. */
    repos: z.array(z.string().min(1).max(200)).max(50).default([]),
    maxPerDay: z.number().int().min(0).max(100).default(8),
    rerun: z.enum(["never", "new_head"]).default("never"),
  })
  .strict();

export const watchSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(WATCH_MODES).default("act"),
    autoWatch: z.boolean().default(true),
    includeChecks: z.boolean().default(true),
    ignoreBots: z.boolean().default(true),
    /** Bot logins that Ignore bots lets through, with or without GitHub's [bot] suffix. */
    allowBots: z.array(z.string().trim().regex(/^[^\s,]{1,100}$/u, "must be one login, with no spaces or commas")).max(50).default([]),
    batchMinutes: z.number().int().min(0).max(60).default(2),
    actPrompt: z.string().min(1).max(8000),
  })
  .strict();

/**
 * off: nothing runs. shadow: decisions are recorded and nothing posts. countdown: a passing review posts after a delay,
 * unless you stop it. auto: it posts at once. Only off and shadow are defaults; you choose to post.
 */
export const AUTO_POST_MODES = ["off", "shadow", "countdown", "auto"] as const;
export type AutoPostMode = (typeof AUTO_POST_MODES)[number];
export const POSTING_MODES: readonly AutoPostMode[] = ["countdown", "auto"];
export const DEFAULT_DISCLOSURE =
  "_Shuttle posted this review from an AI review it checked against the review's critics, the quoted code and a second model. Reply here if anything in it is wrong._";
export const AUTO_POST_SEVERITIES = ["low", "medium", "high"] as const;
/**
 * What a reviewer's concern about the PR as a whole is about: the description does not match the diff, changes outside
 * the PR's purpose (unrelated files, tests changed to pass), something the reviewer could not verify or run, CI, approval
 * or merge state, a design or behaviour point, or no kind given (older reviews).
 */
export const CONCERN_KINDS = ["description", "scope", "unverified", "process", "design", "other"] as const;
export type ConcernKind = (typeof CONCERN_KINDS)[number];
/**
 * The fast verifier: no tools, skills, context files or session, run from the temp directory so no project's own
 * resources load, so it judges only the evidence Shuttle hands it on stdin. Extensions still load, since some set
 * up the model's credentials; add `--no-extensions -e <that extension>` to the command to leave the rest out.
 */
export const DEFAULT_VERIFIER_COMMAND =
  'cd "${TMPDIR:-/tmp}" && pi -p --no-tools --no-skills --no-prompt-templates --no-themes --no-context-files --no-session --system-prompt "You audit one code review finding and reply with JSON only." --model fireworks/fireworks:accounts/fireworks/models/kimi-k3 --thinking low';
const repoGlob = z.string().trim().min(1).max(200);
const unit = (fallback: number) => z.number().min(0).max(1).default(fallback);

export const autoPostRepoSchema = z
  .object({
    repo: repoGlob,
    mode: z.enum(AUTO_POST_MODES).default("shadow"),
    /** The repository's review standards, in a few lines, for the verifier. */
    guidelines: z.string().max(4000).default(""),
    /** Path globs: a draft whose PR changes one of these files is held for you. */
    holdPaths: z.array(repoGlob).max(50).default([]),
    /** Author globs judged like people although they count as bots, such as an agent account that opens PRs for someone. */
    allowAuthors: z.array(repoGlob).max(50).default([]),
    /** Approvals' own mode; posting needs `approvePaths` too. */
    approve: z.enum(AUTO_POST_MODES).default("shadow"),
    /** Path globs an approval may cover: a PR that changes any other file is never approved. Empty means never approve. */
    approvePaths: z.array(repoGlob).max(50).default([]),
    /** The footer of reviews Shuttle posts here; empty uses the one in auto post's settings. */
    disclosure: z.string().max(1000).default(""),
  })
  .strict();
export type AutoPostRepo = z.infer<typeof autoPostRepoSchema>;

export const autoPostSchema = z
  .object({
    repos: z.array(autoPostRepoSchema).max(50).default([]),
    verifier: command.default(DEFAULT_VERIFIER_COMMAND),
    verifierTimeoutSeconds: z.number().int().min(10).max(600).default(120),
    /** The lowest severity that can post; nits never do. */
    minSeverity: z.enum(AUTO_POST_SEVERITIES).default("medium"),
    maxComments: z.number().int().min(1).max(20).default(5),
    /** A PR with more changed lines than this is held for you. */
    maxLines: z.number().int().min(10).max(100_000).default(800),
    /** The share of auto-posted findings you would have posted yourself. */
    targetPrecision: z.number().min(0.5).max(1).default(0.9),
    /** Floors for the verifier's scores; `blocking` vetoes an approval when the verifier puts a blocking problem at or above it. */
    floors: z.object({ holds: unit(0.7), worth: unit(0.7), blocking: unit(0.2) }).strict().prefault({}),
    /** In countdown mode, how long a comment review waits before it posts. */
    countdownMinutes: z.number().int().min(1).max(1440).default(30),
    /** Reviews Shuttle may post in a repository in a day, comments and approvals together. */
    maxPerDay: z.number().int().min(0).max(50).default(5),
    /** The footer of every review Shuttle posts, below the review's summary. Approvals always carry one. */
    disclosure: z.string().max(1000).default(DEFAULT_DISCLOSURE),
    /** Shuttle stops posting comments in a repository when you mark more than `maxMarked` of its last `window` posted findings. */
    breaker: z.object({ window: z.number().int().min(1).max(200).default(20), maxMarked: z.number().int().min(0).max(50).default(2) }).strict().prefault({}),
    /** The kinds of reviewer concern that hold a draft: comments by default only for signs of a careless change; approvals for more. */
    holdConcerns: z
      .object({
        comment: z.array(z.enum(CONCERN_KINDS)).max(CONCERN_KINDS.length).default(["description", "scope", "other"]),
        approve: z.array(z.enum(CONCERN_KINDS)).max(CONCERN_KINDS.length).default(["description", "scope", "unverified", "process", "other"]),
      })
      .strict()
      .prefault({}),
    /** Approvals, recorded in shadow mode: the largest PR one could approve, and the share of them you must agree with. */
    approvals: z
      .object({
        maxLines: z.number().int().min(1).max(100_000).default(200),
        target: z.number().min(0.5).max(1).default(0.98),
        /** The highest finding severity an approval may carry as comments; above it the PR is not approved. */
        maxSeverity: z.enum(["nit", "low", "medium"]).default("low"),
        /** passed: every check passed (or there are none); not_failed: checks may still be running. */
        checks: z.enum(["passed", "not_failed"]).default("passed"),
        /** In countdown mode, how long an approval waits before it posts. */
        countdownMinutes: z.number().int().min(1).max(2880).default(120),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type AutoPost = z.infer<typeof autoPostSchema>;

export const configSchema = z
  .object({
    servers: z.array(serverSchema).max(20),
    presets: z.array(presetSchema).min(1).max(20),
    autoReview: autoReviewSchema,
    watch: watchSchema,
    // A config saved before auto post existed has no autoPost; prefault parses {} so every inner default applies.
    autoPost: autoPostSchema.prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const dup = (ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, index) => {
        if (seen.has(id)) ctx.addIssue({ code: "custom", path: [path, index, "id"], message: `duplicate id ${id}` });
        seen.add(id);
      });
    };
    dup(config.servers.map((s) => s.id), "servers");
    dup(config.presets.map((p) => p.id), "presets");
    if (config.presets.filter((p) => p.default).length > 1) ctx.addIssue({ code: "custom", path: ["presets"], message: "only one preset can be the default" });
    const preset = config.autoReview.preset;
    if (preset && !config.presets.some((p) => p.id === preset)) ctx.addIssue({ code: "custom", path: ["autoReview", "preset"], message: `no preset ${preset}` });
  });
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_REVIEW_PROMPT = [
  "Review the pull request {url} ({key}, head {head}): {title}.",
  "{skill_line}Read it with: {view_command}",
  "",
  "Answer four questions about it:",
  "1. What: what does the PR change? Read the diff and the changed files, not only the description, and say where the two differ (a description concern).",
  "2. Why: what problem does it solve, and for whom? Use the description, linked issues and the code around the change.",
  "3. How: does the implementation get there? Look for defects the change introduces or makes worse: crashes and type errors, security or permission gaps, lost or wrong data, broken compatibility for deployed callers, serious performance problems such as N+1 queries, unbounded work or races, missed error handling or transaction boundaries, and config or rollout mistakes.",
  "4. Should: is it worth doing at all, and is this the right way? Say so when a simpler change, something that already exists, or no change would do; when it duplicates or works around a pattern the codebase already has; or when the risk outweighs the benefit.",
  "What, Why, Should and your overall view of How go in your notes for me. Each defect you find becomes a finding, and the summary tells the author in a few lines what you found.",
  "",
  "A finding needs a clear failure, a realistic way to reach it, and evidence a reviewer can check. Before keeping one, try to disprove it: drop it when earlier validation prevents it, later code handles it, a test whose assertions show that exact case works, or it rests on a guess about how a language or library behaves. Follow the repository's own instructions and conventions, such as AGENTS.md. Comment only on lines the PR changes, at the smallest line or range that causes the problem, and check each line number against the file at the head you read. Leave out style, naming, formatting and generic requests for more tests; a missing test matters only when it lets a concrete regression through, so describe the regression.",
  "Severity: high for a likely crash, security hole, data loss, outage, or a break for deployed callers with no safe migration; medium for wrong behaviour, a performance regression, missed error handling or a compatibility risk with bounded impact; low for a real defect with small impact; nit for a one-line point that is not a defect, never style, naming or formatting.",
  "",
  "Draft your findings with file and line references. Do not post anything on the pull request until I confirm what to post.{note}",
].join("\n");

export const DEFAULT_ACT_PROMPT =
  "Classify each finding (valid, already fixed, intentional, needs a decision). Fix the valid ones and run the tests that cover them. Ask me before you push, reply or resolve anything.";

export const DEFAULT_CONFIG: Config = configSchema.parse({
  servers: [{ id: "github", name: "GitHub", kind: "github" }],
  presets: [{ id: "standard", name: "Standard review", default: true, prompt: DEFAULT_REVIEW_PROMPT }],
  autoReview: {},
  watch: { actPrompt: DEFAULT_ACT_PROMPT },
});

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function issuesText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
}

export function parseConfig(value: unknown): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new ConfigError(issuesText(result.error));
  return result.data;
}

export function defaultPreset(config: Config): Preset {
  return config.presets.find((p) => p.default) ?? config.presets[0]!;
}

export function presetById(config: Config, id: string | undefined | null): Preset {
  if (!id) return defaultPreset(config);
  const preset = config.presets.find((p) => p.id === id);
  if (!preset) throw new ConfigError(`no preset ${id}`);
  return preset;
}

/** TOML for export. Arrays of tables read as [[server]] and [[preset]], like the docs. */
export function configToToml(config: Config): string {
  const { servers, presets, autoReview, watch, autoPost } = config;
  return `${stringifyToml({ server: servers, preset: presets, auto_review: autoReview, watch, auto_post: autoPost })}\n`;
}

export function configFromToml(toml: string): Config {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(toml) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`the TOML does not parse: ${(error as Error).message}`);
  }
  const known = new Set(["server", "preset", "auto_review", "watch", "auto_post"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length) throw new ConfigError(`unknown table ${unknown.join(", ")}; expected [[server]], [[preset]], [auto_review], [watch] and [auto_post]`);
  return parseConfig({
    servers: raw.server ?? DEFAULT_CONFIG.servers,
    presets: raw.preset ?? DEFAULT_CONFIG.presets,
    autoReview: raw.auto_review ?? {},
    watch: { actPrompt: DEFAULT_ACT_PROMPT, ...((raw.watch as object | undefined) ?? {}) },
    autoPost: raw.auto_post ?? {},
  });
}

/** One line per difference, for the import preview. */
export function configChanges(before: Config, after: Config): string[] {
  const out: string[] = [];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
  for (const [label, a, b] of [
    ["server", byId(before.servers), byId(after.servers)],
    ["preset", byId(before.presets), byId(after.presets)],
  ] as const) {
    for (const [id, row] of b) {
      const old = (a as Map<string, unknown>).get(id);
      if (!old) out.push(`adds ${label} ${id}`);
      else if (JSON.stringify(old) !== JSON.stringify(row)) out.push(`changes ${label} ${id}`);
    }
    for (const id of a.keys()) if (!b.has(id)) out.push(`removes ${label} ${id}`);
  }
  if (JSON.stringify(before.autoReview) !== JSON.stringify(after.autoReview)) out.push("changes auto review");
  if (JSON.stringify(before.watch) !== JSON.stringify(after.watch)) out.push("changes watched PRs");
  if (JSON.stringify(before.autoPost) !== JSON.stringify(after.autoPost)) out.push("changes auto post");
  return out;
}
