// bb loom forge check: reads a live pull request through a repo's forge on the project's machine, with the host call a
// poll makes, and says what Loom reads from it. It changes no ticket and writes no event, so any thread may run it.
import { repoCheckout } from "./checkouts";
import type { TicketRow } from "./db/store";
import { githubPull, type HostOutput } from "./host-contract";
import { LoomError } from "./projects";
import { replaceLoomBlock } from "./prompts";
import { keptChecks } from "./pull-requests";
import { followsFeedback, isMultiRepo, prSettings, repoSettings, type RepoSettings } from "./repos";
import type { ForgeSpec, Spec } from "./spec";
import type { EngineCtx } from "./workers";

type Feedback = Extract<HostOutput<"prFeedback">, { outcome: "ok" }>;
type Transient = "server" | "rate_limit" | "network";
type Issue = { path: string; message: string };

export interface ForgeCheckRead {
  state: "OPEN" | "MERGED" | "CLOSED";
  /** Null where the forge's answer does not say, as a state command's never does. */
  draft: boolean | null;
  review: string | null;
  base: string | null;
  mergeable: boolean | null;
  head: string | null;
  author: string | null;
  /** Null when the read has no feedback: a state command, or a spec whose merge.max_fix_rounds is 0. */
  checks: Array<{ name: string; state: string; key: string; url: string | null }> | null;
  /** The checks the forge's ignore_checks drops from what Loom counts, by name; null with no checks. */
  ignored: string[] | null;
  items: Array<{ kind: string; author: string; bot: boolean; key: string; line: string }> | null;
  /** The description's length and whether it has exactly one block of Loom's own, which a refresh of its Rollout section needs; null when the read gives none. */
  description: { chars: number; block: "one" | "none" | "several" } | null;
}

export interface ForgeCheck {
  slug: string;
  url: string;
  /** The ticket whose pull request it is, when Loom knows it. */
  ticket: string | null;
  repo: string | null;
  /** The spec version whose forge ran. */
  version: number;
  forge: "gh" | "command";
  call: "prBatch" | "prFeedback" | "prState";
  /** What the call runs on the machine: gh's GraphQL read, or the spec's command. */
  runs: string;
  /** Why the read has no feedback, when it has none. */
  noFeedback: string | null;
  hostId: string;
  checkout: string;
  read: ForgeCheckRead | null;
  /** Why the read failed, with the kind of failure a poll waits out; `issues` are the fields the host contract refused. */
  failure: { message: string; transient: Transient | null; issues: Issue[] } | null;
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
};

const descriptionOf = (body: string | null | undefined): ForgeCheckRead["description"] => {
  if (body == null) return null;
  const replaced = replaceLoomBlock(body, "");
  return { chars: body.length, block: "problem" in replaced ? replaced.problem : "one" };
};

const BLOCK_TEXT = {
  one: "with Loom's markers, so Loom can refresh its Rollout section",
  none: "with no Loom markers, so Loom cannot refresh its Rollout section",
  several: "with Loom's markers more than once, so Loom cannot tell its own section and does not refresh it",
} as const;

function readOf(feedback: Feedback, forge: ForgeSpec): ForgeCheckRead {
  const { kept, ignored } = keptChecks(forge, feedback.checks);
  return {
    state: feedback.state,
    draft: feedback.draft ?? null,
    review: feedback.review ?? null,
    base: feedback.base ?? null,
    mergeable: feedback.mergeable ?? null,
    head: feedback.head,
    author: feedback.author === "" ? null : feedback.author,
    checks: kept.map((check) => ({ name: check.name, state: check.state, key: check.key, url: check.url })),
    ignored: ignored.map((check) => check.name),
    items: feedback.items.map((item) => ({ kind: item.kind, author: item.author, bot: item.bot, key: item.key, line: firstLine(item.body) })),
    description: descriptionOf(feedback.body),
  };
}

/** The fields a host contract refused, from the RPC error bb raises for an answer that fails its output schema. */
function issuesOf(error: unknown): Issue[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue: { path?: unknown; message?: unknown }) => ({
    path: Array.isArray(issue.path) ? issue.path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index > 0 ? "." : ""}${String(part)}`)).join("") : "",
    message: typeof issue.message === "string" ? issue.message : String(issue.message),
  }));
}

function target(ctx: EngineCtx, projectId: number, spec: Spec, a: { target: string; repo?: string }): { url: string; ticket: TicketRow | null; repo: string | null } {
  const tickets = ctx.store.tickets(projectId);
  let url: string;
  let ticket: TicketRow | null;
  if (/^https?:\/\//u.test(a.target)) {
    url = a.target;
    ticket = tickets.find((row) => row.pr_url === url) ?? null;
  } else {
    ticket = tickets.find((row) => row.key === a.target) ?? null;
    if (ticket === null) throw new LoomError("loom_not_found", `No ticket ${a.target} in this project.`, "Give a ticket key from `bb loom tickets <slug>`, or a pull request URL.");
    if (ticket.pr_url === null) throw new LoomError("loom_invalid_input", `${ticket.key} has no pull request yet.`, "Give the URL of a pull request to read instead.");
    url = ticket.pr_url;
  }
  if (!/^https?:\/\/\S+$/u.test(url) || url.length > 500) throw new LoomError("loom_invalid_input", `${url} is not a pull request URL.`);
  if (a.repo !== undefined && ticket !== null && ticket.repo !== a.repo) throw new LoomError("loom_invalid_input", `${ticket.key} is in the repo "${ticket.repo ?? "(the project's own)"}", not "${a.repo}".`);
  const repo = a.repo ?? ticket?.repo ?? null;
  if (repo === null && isMultiRepo(spec)) throw new LoomError("loom_invalid_input", "This project has several repos, so Loom cannot tell whose forge reads this pull request.", `Name the repo with --repo, one of: ${spec.repo!.map((entry) => entry.name).join(", ")}.`);
  return { url, ticket, repo };
}

function settingsOf(spec: Spec, repo: string | null): RepoSettings {
  try {
    return repoSettings(spec, repo);
  } catch (error) {
    throw new LoomError("loom_invalid_input", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads the pull request as a poll of the project reads it: gh's batch read for GitHub, a command forge's feedback
 * command, else its state command. `version` picks the spec version whose forge runs, by default the version in force,
 * or the newest for a draft. A failed read is reported, not thrown.
 */
export async function forgeCheck(ctx: EngineCtx, a: { slug: string; target: string; repo?: string; version?: number }): Promise<ForgeCheck> {
  const { store } = ctx;
  const project = store.projectBySlug(a.slug);
  if (project === null) throw new LoomError("loom_not_found", `No project ${a.slug}.`, "Run `bb loom list` to see the projects.");
  const version = a.version ?? project.approved_version ?? store.latestSpecVersion(project.id)!.version;
  const row = store.specVersion(project.id, version);
  if (row === null) throw new LoomError("loom_not_found", `${a.slug} has no spec v${version}.`, `Run \`bb loom show ${a.slug}\` to see its versions.`);
  const spec = JSON.parse(row.spec_json) as Spec;
  const { url, ticket, repo } = target(ctx, project.id, spec, a);
  const settings = settingsOf(spec, repo);
  const { forge } = settings;
  if (forge.kind === "none") throw new LoomError("loom_invalid_input", `The forge of ${repo === null ? "the project's repo" : `the repo "${repo}"`} in v${version} is none: Loom only pushes the branch and reads no pull request, so there is nothing to check.`);
  const checkout = await repoCheckout(ctx, project, spec, repo);
  const follows = prSettings(spec).maxFixRounds > 0;
  const base = { slug: project.slug, url, ticket: ticket?.key ?? null, repo, version, forge: forge.kind, hostId: checkout.hostId, checkout: checkout.path };
  const failed = (call: ForgeCheck["call"], runs: string, noFeedback: string | null, message: string, transient?: Transient, issues: Issue[] = []): ForgeCheck => ({
    ...base,
    call,
    runs,
    noFeedback,
    read: null,
    failure: { message, transient: transient ?? null, issues },
  });
  const noFeedback = !follows ? `merge.max_fix_rounds is 0 in v${version}, so Loom follows only merged and closed and reads no checks or items` : !followsFeedback(forge) ? "this forge has no feedback command, so Loom reads only the state" : null;

  if (forge.kind === "gh") {
    const runs = "gh api graphql";
    const pull = githubPull(url);
    if (pull === null) return failed("prBatch", runs, noFeedback, `${url} is not a GitHub pull request URL, so gh cannot read it.`);
    try {
      const answer = await ctx.host.call(checkout.hostId, "prBatch", { repo: checkout.path, host: pull.host, owner: pull.owner, name: pull.name, numbers: [pull.number], feedback: follows });
      if (answer.outcome === "unavailable") return failed("prBatch", runs, noFeedback, answer.message, answer.transient);
      const read = answer.pulls.find((each) => each.number === pull.number);
      if (read === undefined) {
        const miss = answer.missing.find((each) => each.number === pull.number);
        return failed("prBatch", runs, noFeedback, miss?.message ?? `gh found no pull request at ${url}.`, miss?.transient);
      }
      const fields = read.feedback === null ? { head: null, author: null, checks: null, ignored: null, items: null } : readOf(read.feedback, forge);
      return { ...base, call: "prBatch", runs, noFeedback, read: { ...fields, state: read.state, draft: read.draft, review: read.review, base: read.base, mergeable: read.mergeable ?? null, description: descriptionOf(read.body) }, failure: null };
    } catch (error) {
      return failed("prBatch", runs, noFeedback, error instanceof Error ? error.message : String(error), undefined, issuesOf(error));
    }
  }

  if (follows && forge.feedback !== undefined) {
    try {
      const answer = await ctx.host.call(checkout.hostId, "prFeedback", { repo: checkout.path, url, forge: { kind: "command", feedback: forge.feedback } });
      if (answer.outcome === "unavailable") return failed("prFeedback", forge.feedback, noFeedback, answer.message, answer.transient);
      return { ...base, call: "prFeedback", runs: forge.feedback, noFeedback, read: readOf(answer, forge), failure: null };
    } catch (error) {
      return failed("prFeedback", forge.feedback, noFeedback, error instanceof Error ? error.message : String(error), undefined, issuesOf(error));
    }
  }
  const state = forge.state!;
  try {
    const answer = await ctx.host.call(checkout.hostId, "prState", { repo: checkout.path, url, forge: { kind: "command", state } });
    if (answer.outcome === "unavailable") return failed("prState", state, noFeedback, answer.message, answer.transient);
    return { ...base, call: "prState", runs: state, noFeedback, read: { state: answer.state, draft: null, review: null, base: null, mergeable: null, head: null, author: null, checks: null, ignored: null, items: null, description: null }, failure: null };
  } catch (error) {
    return failed("prState", state, noFeedback, error instanceof Error ? error.message : String(error), undefined, issuesOf(error));
  }
}

const TRANSIENT_TEXT: Record<Transient, string> = {
  server: "A poll waits this out as a server error or timeout: that pull request's next read waits longer, and the project pauses only after an hour of them.",
  rate_limit: "A poll reads this as a rate limit: no read goes to that host for a while, and the project does not pause.",
  network: "A poll reads this as a network failure: no read goes to that host for a while, and the project pauses only after an hour of them.",
};

const shown = (value: boolean | string | null) => (value === null ? "unknown" : value === true ? "yes" : value === false ? "no" : value);

/** The check as the CLI prints it: what ran where, then what Loom reads, or why the read failed. */
export function formatForgeCheck(check: ForgeCheck): string {
  const what = check.ticket === null ? check.url : `${check.url} (${check.ticket})`;
  const repo = check.repo === null ? "" : `the repo "${check.repo}", `;
  const lines = [`Read ${what} as a poll of ${check.slug} would: ${repo}the forge of spec v${check.version} (${check.forge}), ${check.call} on ${check.hostId} in ${check.checkout}.`, `Ran: ${check.runs}`];
  if (check.failure !== null) {
    lines.push(`The read failed: ${check.failure.message}`);
    lines.push(check.failure.transient === null ? "A poll pauses the project for a failure like this one." : TRANSIENT_TEXT[check.failure.transient]);
    if (check.failure.issues.length > 0) lines.push("The host contract refused these fields:", ...check.failure.issues.map((issue) => `  ${issue.path === "" ? "(the answer)" : issue.path}: ${issue.message}`));
    return `${lines.join("\n")}\n`;
  }
  const read = check.read!;
  const facts = [`State ${read.state}`, `draft ${shown(read.draft)}`, `review ${shown(read.review)}`, `base ${shown(read.base)}`, `mergeable ${shown(read.mergeable)}`, ...(read.head === null ? [] : [`head ${read.head}`]), ...(read.author === null ? [] : [`author ${read.author}`])];
  lines.push(facts.join(" · "));
  if (check.noFeedback !== null) lines.push(`No checks or items: ${check.noFeedback}.`);
  if (read.checks !== null) {
    lines.push(`Checks: ${read.checks.length}`);
    const width = Math.max(0, ...read.checks.map((each) => each.state.length));
    for (const each of read.checks) lines.push(`  ${each.state.padEnd(width)}  ${each.name}  (${each.key})`);
  }
  if (read.ignored !== null && read.ignored.length > 0) lines.push(`Dropped by ignore_checks: ${read.ignored.length}`, ...read.ignored.map((name) => `  ${name}`));
  lines.push(
    read.description === null
      ? "Description: not read, so Loom cannot refresh its Rollout section when a prerequisite goes live."
      : `Description: ${read.description.chars} characters, ${BLOCK_TEXT[read.description.block]}.`,
  );
  if (read.items !== null) {
    lines.push(`Items: ${read.items.length}`);
    for (const item of read.items) lines.push(`  ${item.kind}  ${item.author}${item.bot ? " (bot)" : ""}  ${item.key}  ${item.line}`);
  }
  return `${lines.join("\n")}\n`;
}
