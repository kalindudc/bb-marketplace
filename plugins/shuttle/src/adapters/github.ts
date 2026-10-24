// The built-in GitHub adapter: gh's GraphQL API, mapped onto the same shapes command adapters print.
import { z } from "zod";
import { OPERATIONS, type ListOperation, type Operation, type ServerConfig } from "../config";
import type { CheckState, PrState, ReviewState } from "../contract";
import { linkFor } from "../keys";
import type { Activity, ActivityItem, PrSummary } from "../model";
import { AdapterError, type Adapter, type ListOptions, type ListResult } from "./adapter";
import { fillCommand, runProcess, shellQuote, tail, type Runner } from "./exec";

const GH_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 50;
/** Pages per list; past this a list is incomplete and keeps the reasons it did not see. */
export const SEARCH_PAGES = 6;

const SUMMARY_FIELDS = `number title url isDraft state reviewDecision headRefOid headRefName baseRefName updatedAt additions deletions changedFiles
  author { login } repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on Team { combinedSlug } } } }`;

const actor = z.object({ login: z.string(), __typename: z.string().optional() }).nullable();
const summaryNode = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  reviewDecision: z.string().nullable(),
  headRefOid: z.string().nullable(),
  headRefName: z.string().nullable(),
  baseRefName: z.string().nullable(),
  updatedAt: z.string(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  changedFiles: z.number().nullable(),
  body: z.string().optional(),
  author: actor,
  repository: z.object({ nameWithOwner: z.string() }),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string(), combinedSlug: z.string().optional() }).nullable() })) }).nullable(),
});
type SummaryNode = z.infer<typeof summaryNode>;

/** Search qualifiers per list. Team requests leave out the ones that also name the viewer. */
export function searchQuery(operation: ListOperation, options: ListOptions): string {
  const base = "is:pr archived:false sort:updated-desc";
  switch (operation) {
    case "authored":
      return options.state === "closed" ? `${base} author:@me is:closed updated:>=${options.since}` : `${base} author:@me is:open`;
    case "review_requested":
      return `${base} is:open user-review-requested:@me`;
    case "team_requested":
      return `${base} is:open review-requested:@me -user-review-requested:@me`;
    case "mentioned":
      return `${base} is:open mentions:@me`;
  }
}

export function checksState(rollup: string | null | undefined): CheckState {
  if (!rollup) return "none";
  if (rollup === "SUCCESS") return "passed";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failed";
  return "pending";
}

export function reviewState(decision: string | null): ReviewState {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes";
  if (decision === "REVIEW_REQUIRED") return "required";
  return "none";
}

export function toSummary(node: SummaryNode): PrSummary {
  const state: PrState = node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft ? "draft" : "open";
  const teams = (node.reviewRequests?.nodes ?? []).flatMap((n) => (n.requestedReviewer?.__typename === "Team" && n.requestedReviewer.combinedSlug ? [`@${n.requestedReviewer.combinedSlug}`] : []));
  const updated = Date.parse(node.updatedAt);
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    author: node.author?.login ?? "ghost",
    state,
    url: node.url,
    head: node.headRefOid,
    headRef: node.headRefName,
    base: node.baseRefName,
    checks: checksState(node.commits.nodes[0]?.commit.statusCheckRollup?.state),
    review: reviewState(node.reviewDecision),
    updatedAt: Number.isFinite(updated) ? updated : null,
    additions: node.additions,
    deletions: node.deletions,
    files: node.changedFiles,
    teams,
    body: node.body ?? null,
  };
}

const isBot = (a: z.infer<typeof actor>) => a?.__typename === "Bot" || Boolean(a?.login.endsWith("[bot]"));

const activityNode = z.object({
  headRefOid: z.string().nullable(),
  reviews: z.object({ nodes: z.array(z.object({ id: z.string(), state: z.string(), body: z.string(), url: z.string().nullable(), author: actor })) }),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        isResolved: z.boolean(),
        path: z.string().nullable(),
        line: z.number().nullable(),
        comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), url: z.string().nullable(), author: actor })) }),
      }),
    ),
  }),
  comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), url: z.string().nullable(), author: actor })) }),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              contexts: z.object({
                nodes: z.array(
                  z.object({
                    __typename: z.string(),
                    id: z.string().optional(),
                    name: z.string().optional(),
                    conclusion: z.string().nullable().optional(),
                    detailsUrl: z.string().nullable().optional(),
                    context: z.string().optional(),
                    state: z.string().optional(),
                    targetUrl: z.string().nullable().optional(),
                  }),
                ),
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});

const FAILED_RUN = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const REVIEW_LABEL: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };

export function toActivity(node: z.infer<typeof activityNode>): Activity {
  const head = node.headRefOid;
  const items: ActivityItem[] = [];
  for (const review of node.reviews.nodes) {
    if (review.state === "PENDING") continue;
    // A comment-only review with no body is just the container of its threads, which arrive on their own.
    if (review.state === "COMMENTED" && !review.body.trim()) continue;
    items.push({ id: `${review.id}:${review.state}`, kind: "review", author: review.author?.login ?? null, bot: isBot(review.author), state: REVIEW_LABEL[review.state] ?? review.state.toLowerCase(), body: review.body, url: review.url, path: null, line: null });
  }
  for (const thread of node.reviewThreads.nodes) {
    if (thread.isResolved) continue;
    for (const comment of thread.comments.nodes) {
      items.push({ id: `${thread.id}:${comment.id}`, kind: "thread", author: comment.author?.login ?? null, bot: isBot(comment.author), state: null, body: comment.body, url: comment.url, path: thread.path, line: thread.line });
    }
  }
  for (const comment of node.comments.nodes) {
    items.push({ id: comment.id, kind: "comment", author: comment.author?.login ?? null, bot: isBot(comment.author), state: null, body: comment.body, url: comment.url, path: null, line: null });
  }
  for (const context of node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) {
    const failed = context.__typename === "CheckRun" ? FAILED_RUN.has(context.conclusion ?? "") : context.state === "FAILURE" || context.state === "ERROR";
    if (!failed || !context.id) continue;
    const name = context.name ?? context.context ?? "check";
    items.push({ id: `${context.id}:${head ?? ""}`, kind: "check", author: null, bot: false, state: "failed", body: `${name} failed`, url: context.detailsUrl ?? context.targetUrl ?? null, path: null, line: null });
  }
  return { head, items };
}

export class GithubAdapter implements Adapter {
  constructor(
    readonly server: ServerConfig,
    private readonly run: Runner = runProcess,
  ) {}

  operations(): Operation[] {
    return [...OPERATIONS];
  }

  private hostArgs(): string[] {
    return this.server.hostname ? ["--hostname", this.server.hostname] : [];
  }

  private async gh(operation: Operation, args: string[], signal?: AbortSignal): Promise<string> {
    const result = await this.run("gh", args, { timeoutMs: GH_TIMEOUT_MS, signal }).catch((error: unknown) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new AdapterError(operation, missing ? "gh is not installed or not on PATH" : `gh could not start: ${(error as Error).message}`);
    });
    if (result.timedOut) throw new AdapterError(operation, `gh took longer than ${GH_TIMEOUT_MS / 1000}s`);
    if (result.code !== 0) throw new AdapterError(operation, `gh exited ${result.code}: ${tail(result.stderr || result.stdout) || "no output"}`);
    return result.stdout;
  }

  private async graphql<S extends z.ZodType>(operation: Operation, query: string, vars: Record<string, string | number>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
    const args = ["api", "graphql", ...this.hostArgs(), "-f", `query=${query}`];
    for (const [name, value] of Object.entries(vars)) args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
    const out = await this.gh(operation, args, signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new AdapterError(operation, "gh did not print JSON");
    }
    const errors = (parsed as { errors?: Array<{ message?: string }> }).errors;
    const result = schema.safeParse((parsed as { data?: unknown }).data);
    if (!result.success) throw new AdapterError(operation, errors?.length ? `GitHub: ${errors.map((e) => e.message).join("; ")}` : `unexpected answer from GitHub: ${result.error.issues[0]?.message ?? ""}`);
    return result.data;
  }

  async whoami(signal?: AbortSignal): Promise<string> {
    const out = await this.gh("whoami", ["api", "user", ...this.hostArgs(), "--jq", ".login"], signal);
    const login = out.trim();
    if (!login) throw new AdapterError("whoami", "gh printed no login");
    return login;
  }

  async list(operation: ListOperation, options: ListOptions, signal?: AbortSignal): Promise<ListResult> {
    const query = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
      pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${SUMMARY_FIELDS} } } } }`;
    const schema = z.object({
      search: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(z.union([summaryNode, z.object({}).strict()])) }),
    });
    const rows: PrSummary[] = [];
    let after: string | null = null;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const vars: Record<string, string> = { q: searchQuery(operation, options), ...(after ? { after } : {}) };
      const data = await this.graphql(operation, query, vars, schema, signal);
      for (const node of data.search.nodes) if ("number" in node) rows.push(toSummary(node as SummaryNode));
      if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) return { rows, complete: true };
      after = data.search.pageInfo.endCursor;
    }
    return { rows, complete: false };
  }

  private repoVars(repo: string, number: number) {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new AdapterError("view", `${repo} is not owner/name`);
    return { owner, name, number };
  }

  async view(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary> {
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${SUMMARY_FIELDS} body } } }`;
    const schema = z.object({ repository: z.object({ pullRequest: summaryNode.nullable() }).nullable() });
    const data = await this.graphql("view", query, this.repoVars(repo, number), schema, signal);
    const node = data.repository?.pullRequest;
    if (!node) throw new AdapterError("view", `${repo}#${number} was not found`);
    return toSummary(node);
  }

  async activity(repo: string, number: number, signal?: AbortSignal): Promise<Activity> {
    const who = "author { login __typename }";
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      headRefOid
      reviews(last: 50) { nodes { id state body url ${who} } }
      reviewThreads(last: 50) { nodes { id isResolved path line comments(last: 20) { nodes { id body url ${who} } } } }
      comments(last: 50) { nodes { id body url ${who} } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { __typename
        ... on CheckRun { id name conclusion detailsUrl } ... on StatusContext { id context state targetUrl } } } } } } }
    } } }`;
    const schema = z.object({ repository: z.object({ pullRequest: activityNode.nullable() }).nullable() });
    const data = await this.graphql("activity", query, this.repoVars(repo, number), schema, signal);
    const node = data.repository?.pullRequest;
    if (!node) throw new AdapterError("activity", `${repo}#${number} was not found`);
    return toActivity(node);
  }

  readCommand(repo: string, number: number, url: string): string {
    if (this.server.read) return fillCommand(this.server.read, repo, number, url);
    const host = this.server.hostname ? `GH_HOST=${shellQuote(this.server.hostname)} ` : "";
    return `${host}gh pr view ${number} -R ${shellQuote(repo)} --comments`;
  }

  linkFor(repo: string, number: number): string {
    return linkFor(this.server, repo, number);
  }
}
