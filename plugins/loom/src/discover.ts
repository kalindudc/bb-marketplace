// How each repo is reached, read from the machine and from bb: its remotes, whether gh serves them, the environment
// providers bb offers for it, and whether Loom can add its own integration worktree. loom_discover reports these facts
// to the planner as found or ask; loom_propose refuses a spec that leaves one of them unanswered.
import { environmentFor, inputsProblems } from "./environments";
import type { HostOutput } from "./host-contract";
import type { BbPort, EnvironmentProviderInfo, HostPort, PluginInfo } from "./ports";
import { isMultiRepo, repoSettings, type RepoSettings } from "./repos";
import type { Spec } from "./spec";

const PLUGIN_HELP_MS = 30_000;

type GhStatus = HostOutput<"ghStatus">;

export interface RemoteFacts {
  name: string;
  pushUrls: string[];
  /** Null when gh was not asked: the remote has no single push URL, or the repo's forge is not gh. */
  gh: GhStatus | null;
}

/** One repo to check: the project's own (index null) or one [[repo]]; settings are null before there is a spec. */
export interface RepoTarget {
  label: string;
  index: number | null;
  bbProjectId: string;
  settings: RepoSettings | null;
  /** The environment inputs patches of the spec's tickets in this repo, by spec path. */
  tickets?: Array<{ at: string; inputs: Record<string, unknown> }>;
}

export interface RepoFacts extends RepoTarget {
  hostId: string;
  checkout: string | null;
  remotes: RemoteFacts[];
  providers: Array<EnvironmentProviderInfo & { builtin: boolean }>;
  plugins: PluginInfo[];
  worktreeTrial: HostOutput<"trialWorktree"> | null;
  /** `bb plugin run <plugin> <first word> --help` for a [merge.worktree] that names a plugin. */
  pluginCommand: { ok: boolean; output: string } | null;
}

/** The repos a spec changes, with their settings and their tickets' environment patches. */
export function specTargets(spec: Spec, bbProjectId: string): RepoTarget[] {
  const tickets = (repo: string | null) => spec.ticket.flatMap((ticket, index) => ((ticket.repo ?? null) === repo && ticket.environment !== undefined ? [{ at: `ticket[${index}].environment`, inputs: ticket.environment.inputs }] : []));
  if (!isMultiRepo(spec)) return [{ label: "the project's repository", index: null, bbProjectId, settings: repoSettings(spec, null), tickets: tickets(null) }];
  return spec.repo!.map((repo, index) => ({ label: `the repo "${repo.name}"`, index, bbProjectId: repo.project, settings: repoSettings(spec, repo.name), tickets: tickets(repo.name) }));
}

export async function gatherFacts(ctx: { bb: BbPort; host: HostPort }, targets: readonly RepoTarget[], hostId: string): Promise<RepoFacts[]> {
  const plugins = await ctx.bb.plugins();
  const builtin = new Set(plugins.filter((plugin) => plugin.builtin).map((plugin) => plugin.id));
  const facts: RepoFacts[] = [];
  for (const target of targets) {
    const settings = target.settings;
    const providers = (await ctx.bb.environmentProviders(target.bbProjectId, hostId)).map((provider) => ({ ...provider, builtin: builtin.has(provider.pluginId) }));
    const checkout = await ctx.bb.projectCheckout(target.bbProjectId, hostId);
    const known = { ...target, hostId, checkout, providers, plugins };
    if (checkout === null) {
      facts.push({ ...known, remotes: [], worktreeTrial: null, pluginCommand: null });
      continue;
    }
    const remotes: RemoteFacts[] = [];
    for (const remote of (await ctx.host.call(hostId, "remotes", { repo: checkout })).remotes) {
      const asked = settings === null || (settings.forge.kind === "gh" && settings.remote === remote.name);
      const gh = asked && remote.pushUrls.length === 1 ? await ctx.host.call(hostId, "ghStatus", { repo: checkout, pushUrl: remote.pushUrls[0]! }) : null;
      remotes.push({ ...remote, gh });
    }
    const integration = settings === null || (settings.branch !== null && settings.worktree === null);
    const worktreeTrial = integration ? await ctx.host.call(hostId, "trialWorktree", { repo: checkout }) : null;
    facts.push({ ...known, remotes, worktreeTrial, pluginCommand: await pluginCommand(ctx, hostId, checkout, settings, plugins) });
  }
  return facts;
}

async function pluginCommand(ctx: { host: HostPort }, hostId: string, checkout: string, settings: RepoSettings | null, plugins: PluginInfo[]): Promise<RepoFacts["pluginCommand"]> {
  const plugin = settings?.worktree?.plugin;
  if (plugin === undefined || !plugins.some((entry) => entry.id === plugin && entry.enabled)) return null;
  const first = settings!.worktree!.command.trim().split(/\s+/u)[0] ?? "";
  // Only a word a CLI command name could be reaches the shell.
  if (!/^[a-z0-9][a-z0-9:_-]*$/u.test(first)) return { ok: false, output: `"${first}" is not a command name.` };
  const result = await ctx.host.call(hostId, "exec", { cwd: checkout, command: `bb plugin run ${plugin} ${first} --help`, timeoutMs: PLUGIN_HELP_MS });
  return { ok: result.exitCode === 0 && !result.timedOut, output: result.output.trim().slice(-500) };
}

// ---------------------------------------------------------------- paths and words

type Key = "remote" | "forge" | "environment" | "worktree";
const TOP: Record<Key, string> = { remote: "merge.remote", forge: "merge.forge", environment: "environment", worktree: "merge.worktree" };
const pathOf = (facts: RepoTarget, key: Key) => (facts.index === null ? TOP[key] : `repo[${facts.index}].${key}`);

const listRemotes = (remotes: readonly RemoteFacts[]) => (remotes.length === 0 ? "none" : remotes.map((remote) => `${remote.name} (${remote.pushUrls.join(", ") || "no push URL"})`).join(", "));
const describeProvider = (provider: EnvironmentProviderInfo) => `${provider.displayName} (${provider.id}${provider.description === null ? "" : `: ${provider.description.replace(/\.$/u, "")}`})`;
const pluginProviders = (facts: RepoFacts) => facts.providers.filter((provider) => !provider.builtin && provider.available);

function ghProblem(gh: GhStatus, url: string): string | null {
  switch (gh.status) {
    case "ready":
      return null;
    case "missing":
      return "the gh CLI is not installed on this machine";
    case "signed_out":
      return `gh is not signed in to ${gh.host}`;
    case "not_a_url":
      return `${url} is not a repository URL gh can use`;
  }
}

const forgeFix = (facts: RepoTarget, host: string | null) =>
  `Set ${pathOf(facts, "forge")} to kind = "command" with open and state commands for the CLI that opens pull requests on ${host ?? "that server"} (look in your loaded skills and the repository's docs, or ask the human), or to kind = "none" to only push branches.`;

const environmentFix = (facts: RepoTarget, providers: readonly EnvironmentProviderInfo[]) =>
  `Ask the human whether Loom's threads (workers, reviewers and the spec reviewer) should run in ${providers.length === 1 ? "it" : "one of them"}, then set ${pathOf(facts, "environment")} = { provider = "<id>", inputs = { … } }, or { provider = "git-worktree" } to keep plain git worktrees.`;

const worktreeFix = (facts: RepoTarget) =>
  `Use merge.strategy = "pr", or set ${pathOf(facts, "worktree")} to a command, or a plugin's CLI command (plugin = "<id>"), that prepares a checkout of the repository and prints its path last.`;

// ---------------------------------------------------------------- loom_discover

/** The planner's report: per repo, every choice ends in "found" or "ask". */
export function discoverText(all: readonly RepoFacts[]): string {
  return all.map(repoText).join("\n\n");
}

function repoText(facts: RepoFacts): string {
  const head = `${facts.label[0]!.toUpperCase()}${facts.label.slice(1)} (bb project ${facts.bbProjectId})`;
  if (facts.checkout === null) return `${head}\n- ask: it has no checkout on this machine (${facts.hostId}). Clone it with \`bb project source add ${facts.bbProjectId} --clone --machine ${facts.hostId}\` once the human agrees.`;
  const lines = [`${head}, checkout ${facts.checkout}`];
  const remote = facts.remotes.find((entry) => entry.name === (facts.settings?.remote ?? "origin")) ?? (facts.remotes.length === 1 ? facts.remotes[0]! : null);
  lines.push(`- Remotes: ${listRemotes(facts.remotes)}.`);
  if (remote === null) lines.push(`- Remote: ask: there is no remote named ${facts.settings?.remote ?? "origin"}. Ask the human which remote its pull requests go through, and set ${pathOf(facts, "remote")}.`);
  else lines.push(`- Remote: found: ${remote.name}${remote.name === "origin" ? "" : `; set ${pathOf(facts, "remote")} = "${remote.name}"`}.`);

  const candidates = remote === null ? facts.remotes : [remote];
  for (const entry of candidates) {
    if (entry.gh === null) continue;
    const problem = ghProblem(entry.gh, entry.pushUrls[0]!);
    lines.push(problem === null ? `- Forge for ${entry.name}: found: gh can open pull requests on ${entry.gh.host}.` : `- Forge for ${entry.name}: ask: ${problem}. ${forgeFix(facts, entry.gh.host)}`);
  }

  const own = facts.providers.filter((provider) => provider.builtin).map((provider) => provider.id);
  const plugins = pluginProviders(facts);
  lines.push(`- Environments: bb's own providers here are ${own.join(", ") || "none"}; workers use git-worktree unless the spec names another.`);
  if (plugins.length === 0) lines.push("- Environment: found: no plugin offers an environment for this repository, so plain git worktrees fit.");
  else {
    for (const provider of plugins) lines.push(`  - ${describeProvider(provider)}. It ${provider.acceptsEmptyInputs ? "accepts no inputs" : "needs inputs"}; inputs schema: ${JSON.stringify(provider.inputs)}`);
    lines.push(`- Environment: ask: ${environmentFix(facts, plugins)} Fill the inputs from the provider's description and its plugin's skill, and use {branch} and {base} where each thread's branch and base go.`);
  }

  if (facts.worktreeTrial !== null) {
    lines.push(
      facts.worktreeTrial.outcome === "ok"
        ? "- Integration worktree: found: Loom can add its own worktree of this repository."
        : `- Integration worktree: ask (only for merge.strategy = "integration"): git refused Loom's own worktree: ${facts.worktreeTrial.message} ${worktreeFix(facts)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- loom_propose

/** Every reason the spec cannot reach a repo as written, for loom_propose. Each names the spec path to change. */
export function reachErrors(all: readonly RepoFacts[]): string[] {
  return all.flatMap((facts) => (facts.settings === null ? [] : repoErrors(facts, facts.settings)));
}

// A repo with no checkout here is refused by loom_propose's own repo check, or by `bb loom start`; only its environment is checked.
function repoErrors(facts: RepoFacts, settings: RepoSettings): string[] {
  const errors: string[] = [];
  const remote = facts.remotes.find((entry) => entry.name === settings.remote);
  if (facts.checkout === null) {
    // Nothing on the machine to read.
  } else if (remote === undefined) {
    errors.push(`${pathOf(facts, "remote")}: ${facts.label} has no git remote "${settings.remote}"; its remotes are ${listRemotes(facts.remotes)}. Ask the human which remote its pull requests go through, and set ${pathOf(facts, "remote")}.`);
  } else if (settings.forge.kind === "gh" && remote.gh !== null) {
    const problem = ghProblem(remote.gh, remote.pushUrls[0]!);
    if (problem !== null) errors.push(`${pathOf(facts, "forge")}: ${facts.label} pushes to ${remote.pushUrls[0]}, and ${problem}, so Loom cannot open its pull requests with gh. ${forgeFix(facts, remote.gh.host)}`);
  }

  const at = pathOf(facts, "environment");
  if (settings.environment === null) {
    const plugins = pluginProviders(facts);
    if (plugins.length > 0) errors.push(`${at}: bb offers ${plugins.map(describeProvider).join("; ")} for ${facts.label} on this machine, besides its own git worktrees. ${environmentFix(facts, plugins)}`);
  } else {
    const usable = facts.providers.filter((entry) => entry.available).map((entry) => entry.id);
    const usableAt = (path: string, id: string): EnvironmentProviderInfo | null => {
      const provider = facts.providers.find((entry) => entry.id === id);
      if (provider === undefined) errors.push(`${path}: bb has no environment provider "${id}" for ${facts.label} on this machine. Use one of: ${usable.join(", ") || "(none)"}.`);
      else if (!provider.available) errors.push(`${path}: ${describeProvider(provider)} is not available for ${facts.label} on this machine: ${provider.unavailableReason ?? "bb gave no reason"}. Use one of: ${usable.join(", ") || "(none)"}.`);
      else return provider;
      return null;
    };
    const provider = usableAt(`${at}.provider`, settings.environment.provider);
    if (provider !== null) {
      errors.push(...inputsProblems(at, provider, settings.environment.inputs));
      for (const ticket of facts.tickets ?? []) errors.push(...inputsProblems(ticket.at, provider, environmentFor(settings, "worker", ticket.inputs)!.inputs));
    }
    const reviewer = settings.environment.reviewer;
    const other = reviewer?.provider !== undefined && reviewer.provider !== settings.environment.provider;
    const reviewerProvider = other ? usableAt(`${at}.reviewer.provider`, reviewer.provider!) : provider;
    if (reviewer !== undefined && reviewerProvider !== null) errors.push(...inputsProblems(`${at}.reviewer`, reviewerProvider, environmentFor(settings, "reviewer")!.inputs));
  }

  const worktree = settings.worktree;
  if (settings.branch !== null && worktree === null && facts.worktreeTrial?.outcome === "refused") {
    errors.push(`${pathOf(facts, "worktree")}: Loom cannot add its own worktree of ${facts.label} on this machine; git said: ${facts.worktreeTrial.message} ${worktreeFix(facts)}`);
  }
  if (worktree?.plugin !== undefined) {
    const plugin = facts.plugins.find((entry) => entry.id === worktree.plugin);
    if (plugin === undefined) errors.push(`${pathOf(facts, "worktree")}.plugin: bb has no plugin "${worktree.plugin}". Install it, or name another plugin, or drop plugin and give a shell command.`);
    else if (!plugin.enabled) errors.push(`${pathOf(facts, "worktree")}.plugin: the plugin "${worktree.plugin}" is turned off. Ask the human to turn it on, then call loom_propose again.`);
    else if (facts.pluginCommand !== null && !facts.pluginCommand.ok) {
      errors.push(`${pathOf(facts, "worktree")}.command: \`bb plugin run ${worktree.plugin} ${worktree.command.trim().split(/\s+/u)[0]} --help\` failed, so that is not a command of the plugin: ${facts.pluginCommand.output}. Run \`bb plugin run ${worktree.plugin} --help\` to see its commands.`);
    }
  }
  return errors;
}
