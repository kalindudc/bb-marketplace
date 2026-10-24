// The built-in GitHub adapter: gh's GraphQL API, mapped onto the same shapes command adapters print.
import { z } from "zod";
import { OPERATIONS, type ListOperation, type Operation, type ServerConfig } from "../config";
import type { CheckCounts, CheckState, MergeMethod, MergeOptions, MyReview, PrChange, PrState, Reviewer, ReviewerState, ReviewState } from "../contract";
import { linkFor } from "../keys";
import type { Activity, ActivityItem, EditOptions, PrSummary } from "../model";
import { AdapterError, changeOperation, type Adapter, type ListOptions, type ListResult, type MergeInput, type ReviewComment, type ReviewPost, type ReviewPosted } from "./adapter";
import { fillCommand, runProcess, shellQuote, tail, type RunResult, type Runner } from "./exec";

const GH_TIMEOUT_MS = 45_000;
const PAGE_SIZE = 50;
/** Pages per list; past this a list is incomplete and keeps the reasons it did not see. */
export const SEARCH_PAGES = 6;

// Counts by state rather than the contexts themselves, so a list of 300 PRs stays light.
const SUMMARY_FIELDS = `number title url isDraft state reviewDecision headRefOid headRefName baseRefName createdAt updatedAt closedAt mergedAt additions deletions changedFiles
  author { login __typename } repository { nameWithOwner } autoMergeRequest { enabledAt }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
  labels(first: 30) { nodes { name color } }
  latestReviews(first: 30) { nodes { state submittedAt viewerDidAuthor commit { oid } author { login __typename } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on Team { combinedSlug } ... on User { login } ... on Bot { login } } } }`;
// A PR that asks many teams at once (CODEOWNERS) pushes the user's own request out of the last five.
const REQUESTED_FIELDS = `viewerDidAuthor timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) { nodes { ... on ReviewRequestedEvent { createdAt
  requestedReviewer { __typename ... on Team { combinedSlug } ... on User { isViewer } } } } }`;
const FIRST_REVIEW_FIELDS = "reviews(first: 20) { nodes { state submittedAt author { login __typename } } }";

/** Only the lists that ask the user read when they were asked; only the author's read the first review. */
export function listFields(operation: ListOperation): string {
  if (operation === "authored") return `${SUMMARY_FIELDS} ${FIRST_REVIEW_FIELDS}`;
  if (operation === "mentioned") return SUMMARY_FIELDS;
  return `${SUMMARY_FIELDS} ${REQUESTED_FIELDS}`;
}

const actor = z.object({ login: z.string(), __typename: z.string().optional() }).nullable();
const stateCounts = z.array(z.object({ state: z.string(), count: z.number() })).nullish();
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
  createdAt: z.string().nullish(),
  updatedAt: z.string(),
  closedAt: z.string().nullish(),
  mergedAt: z.string().nullish(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  changedFiles: z.number().nullable(),
  body: z.string().optional(),
  author: actor,
  repository: z.object({ nameWithOwner: z.string() }),
  autoMergeRequest: z.object({ enabledAt: z.string().nullable() }).nullish(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              state: z.string(),
              contexts: z.object({ totalCount: z.number(), checkRunCountsByState: stateCounts, statusContextCountsByState: stateCounts }).optional(),
            })
            .nullable(),
        }),
      }),
    ),
  }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string().nullable() })) }).nullish(),
  latestReviews: z
    .object({
      nodes: z.array(
        z.object({
          state: z.string(),
          submittedAt: z.string().nullish(),
          viewerDidAuthor: z.boolean().optional(),
          commit: z.object({ oid: z.string() }).nullish(),
          author: z.object({ login: z.string(), __typename: z.string().optional() }).nullable(),
        }),
      ),
    })
    .nullish(),
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string(), combinedSlug: z.string().optional(), login: z.string().optional() }).nullable() })) }).nullable(),
  viewerDidAuthor: z.boolean().optional(),
  timelineItems: z
    .object({
      nodes: z.array(
        z
          .object({
            createdAt: z.string().optional(),
            requestedReviewer: z.object({ __typename: z.string(), combinedSlug: z.string().optional(), isViewer: z.boolean().optional() }).nullish(),
          })
          .nullable(),
      ),
    })
    .optional(),
  reviews: z.object({ nodes: z.array(z.object({ state: z.string(), submittedAt: z.string().nullish(), author: actor })) }).optional(),
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
    case "reviewed":
      return `${base} is:open reviewed-by:@me -author:@me`;
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

const isBot = (a: z.infer<typeof actor>) => a?.__typename === "Bot" || Boolean(a?.login.endsWith("[bot]"));

const ms = (value: string | null | undefined): number | null => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const REVIEWER_STATE: Record<string, ReviewerState> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", DISMISSED: "dismissed" };
const MY_VERDICT: Record<string, MyReview["verdict"]> = { APPROVED: "approve", CHANGES_REQUESTED: "changes", COMMENTED: "comment", DISMISSED: "dismissed" };

/** Who is asked to review, then the latest review of everyone else; a re-request shows as requested. */
export function reviewersOf(node: SummaryNode): Reviewer[] {
  const author = node.author?.login;
  const latest = new Map<string, { at: number | null; head: string | null }>();
  for (const review of node.latestReviews?.nodes ?? []) if (review.author) latest.set(review.author.login, { at: ms(review.submittedAt), head: review.commit?.oid ?? null });
  const out: Reviewer[] = [];
  for (const { requestedReviewer: r } of node.reviewRequests?.nodes ?? []) {
    if (r?.__typename === "Team" && r.combinedSlug) out.push({ login: r.combinedSlug, team: true, state: "requested", at: null, head: null });
    else if (r?.login) out.push({ login: r.login, team: false, state: "requested", ...(latest.get(r.login) ?? { at: null, head: null }), ...(r.__typename === "Bot" ? { bot: true } : {}) });
  }
  for (const review of node.latestReviews?.nodes ?? []) {
    const login = review.author?.login;
    const state = REVIEWER_STATE[review.state];
    if (!login || !state || login === author || out.some((r) => !r.team && r.login === login)) continue;
    out.push({ login, team: false, state, at: ms(review.submittedAt), head: review.commit?.oid ?? null, ...(review.author?.__typename === "Bot" ? { bot: true } : {}) });
  }
  return out;
}

/** The viewer's own latest review, even when they have been asked again since. */
export function myReviewOf(node: SummaryNode): MyReview | null {
  const mine = node.latestReviews?.nodes.find((r) => r.viewerDidAuthor && MY_VERDICT[r.state]);
  return mine ? { verdict: MY_VERDICT[mine.state]!, at: ms(mine.submittedAt), head: mine.commit?.oid ?? null } : null;
}

/** The newest request of the viewer, or of a team the PR still asks; never on the viewer's own PR. */
export function requestedAtOf(node: SummaryNode): number | null {
  if (!node.timelineItems || node.viewerDidAuthor) return null;
  const teams = new Set((node.reviewRequests?.nodes ?? []).flatMap((n) => (n.requestedReviewer?.__typename === "Team" && n.requestedReviewer.combinedSlug ? [n.requestedReviewer.combinedSlug] : [])));
  let newest: number | null = null;
  for (const event of node.timelineItems.nodes) {
    const r = event?.requestedReviewer;
    const asksMe = r?.__typename === "User" ? r.isViewer === true : r?.__typename === "Team" && Boolean(r.combinedSlug && teams.has(r.combinedSlug));
    const at = ms(event?.createdAt);
    if (asksMe && at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** The first submitted review by someone other than the author and bots. */
export function firstReviewAtOf(node: SummaryNode): number | null {
  if (!node.reviews) return null;
  let first: number | null = null;
  for (const review of node.reviews.nodes) {
    if (review.state === "PENDING" || !review.author || review.author.login === node.author?.login || isBot(review.author)) continue;
    const at = ms(review.submittedAt);
    if (at !== null && (first === null || at < first)) first = at;
  }
  return first;
}

const PASSED_RUN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED_RUN = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** Checks on the head by outcome; a head with no checks has all zeros. */
export function checkCountsOf(node: SummaryNode): CheckCounts | null {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup;
  if (!rollup) return { passed: 0, failed: 0, pending: 0, total: 0 };
  if (!rollup.contexts) return null;
  const counts = { passed: 0, failed: 0, pending: 0, total: rollup.contexts.totalCount };
  for (const { state, count } of rollup.contexts.checkRunCountsByState ?? []) counts[PASSED_RUN.has(state) ? "passed" : FAILED_RUN.has(state) ? "failed" : "pending"] += count;
  for (const { state, count } of rollup.contexts.statusContextCountsByState ?? []) counts[state === "SUCCESS" ? "passed" : state === "FAILURE" || state === "ERROR" ? "failed" : "pending"] += count;
  return counts;
}

export function toSummary(node: SummaryNode): PrSummary {
  const state: PrState = node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft ? "draft" : "open";
  const teams = (node.reviewRequests?.nodes ?? []).flatMap((n) => (n.requestedReviewer?.__typename === "Team" && n.requestedReviewer.combinedSlug ? [`@${n.requestedReviewer.combinedSlug}`] : []));
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
    updatedAt: ms(node.updatedAt),
    additions: node.additions,
    deletions: node.deletions,
    files: node.changedFiles,
    teams,
    body: node.body ?? null,
    labels: node.labels ? node.labels.nodes.map((l) => ({ name: l.name, color: l.color ? l.color.toLowerCase() : null })) : null,
    reviewers: node.reviewRequests && node.latestReviews ? reviewersOf(node) : null,
    createdAt: ms(node.createdAt),
    closedAt: state === "merged" ? ms(node.mergedAt ?? node.closedAt) : state === "closed" ? ms(node.closedAt) : null,
    checkCounts: checkCountsOf(node),
    myReview: myReviewOf(node),
    autoMerge: Boolean(node.autoMergeRequest),
    authorBot: isBot(node.author),
    requestedAt: requestedAtOf(node),
    firstReviewAt: firstReviewAtOf(node),
  };
}

const activityNode = z.object({
  headRefOid: z.string().nullable(),
  reviews: z.object({ nodes: z.array(z.object({ id: z.string(), state: z.string(), body: z.string(), url: z.string().nullable(), submittedAt: z.string().nullish(), author: actor })) }),
  reviewThreads: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        isResolved: z.boolean(),
        path: z.string().nullable(),
        line: z.number().nullable(),
        comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), url: z.string().nullable(), createdAt: z.string().nullish(), author: actor })) }),
      }),
    ),
  }),
  comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string(), url: z.string().nullable(), createdAt: z.string().nullish(), author: actor })) }),
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
                    completedAt: z.string().nullish(),
                    context: z.string().optional(),
                    state: z.string().optional(),
                    targetUrl: z.string().nullable().optional(),
                    createdAt: z.string().nullish(),
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

const REVIEW_LABEL: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", COMMENTED: "commented", DISMISSED: "dismissed" };

export function toActivity(node: z.infer<typeof activityNode>): Activity {
  const head = node.headRefOid;
  const items: ActivityItem[] = [];
  for (const review of node.reviews.nodes) {
    if (review.state === "PENDING") continue;
    // A comment-only review with no body is just the container of its threads, which arrive on their own.
    if (review.state === "COMMENTED" && !review.body.trim()) continue;
    items.push({ id: `${review.id}:${review.state}`, kind: "review", author: review.author?.login ?? null, bot: isBot(review.author), state: REVIEW_LABEL[review.state] ?? review.state.toLowerCase(), body: review.body, url: review.url, path: null, line: null, at: ms(review.submittedAt), thread: null, resolved: null });
  }
  for (const thread of node.reviewThreads.nodes) {
    for (const comment of thread.comments.nodes) {
      items.push({ id: `${thread.id}:${comment.id}`, kind: "thread", author: comment.author?.login ?? null, bot: isBot(comment.author), state: null, body: comment.body, url: comment.url, path: thread.path, line: thread.line, at: ms(comment.createdAt), thread: thread.id, resolved: thread.isResolved });
    }
  }
  for (const comment of node.comments.nodes) {
    items.push({ id: comment.id, kind: "comment", author: comment.author?.login ?? null, bot: isBot(comment.author), state: null, body: comment.body, url: comment.url, path: null, line: null, at: ms(comment.createdAt), thread: null, resolved: null });
  }
  for (const context of node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) {
    const failed = context.__typename === "CheckRun" ? FAILED_RUN.has(context.conclusion ?? "") : context.state === "FAILURE" || context.state === "ERROR";
    if (!failed || !context.id) continue;
    const name = context.name ?? context.context ?? "check";
    items.push({ id: `${context.id}:${head ?? ""}`, kind: "check", author: null, bot: false, state: "failed", body: `${name} failed`, url: context.detailsUrl ?? context.targetUrl ?? null, path: null, line: null, at: ms(context.completedAt ?? context.createdAt), thread: null, resolved: null });
  }
  return { head, items };
}

const mergeNode = z.object({
  squashMergeAllowed: z.boolean(),
  mergeCommitAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  autoMergeAllowed: z.boolean(),
  deleteBranchOnMerge: z.boolean(),
  viewerDefaultMergeMethod: z.string().nullable(),
  pullRequest: z
    .object({
      isDraft: z.boolean(),
      mergeable: z.string(),
      mergeStateStatus: z.string(),
      viewerCanEnableAutoMerge: z.boolean(),
      reviewDecision: z.string().nullable(),
      commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
    })
    .nullable(),
});
type MergeNode = z.infer<typeof mergeNode> & { pullRequest: NonNullable<z.infer<typeof mergeNode>["pullRequest"]> };

const METHOD_OF: Record<string, MergeMethod> = { SQUASH: "squash", MERGE: "merge", REBASE: "rebase" };

function mergeState(pr: MergeNode["pullRequest"]): Pick<MergeOptions, "state" | "detail"> {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  const checksPending = rollup === "PENDING" || rollup === "EXPECTED";
  const status = pr.mergeStateStatus;
  if (pr.isDraft || status === "DRAFT") return { state: "blocked", detail: "It is a draft." };
  if (status === "DIRTY" || pr.mergeable === "CONFLICTING") return { state: "conflicts", detail: "It has conflicts with the base branch." };
  if (status === "CLEAN" || status === "HAS_HOOKS") return { state: "clean", detail: null };
  if (status === "BLOCKED") {
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { state: "blocked", detail: "A reviewer requested changes." };
    if (pr.reviewDecision === "REVIEW_REQUIRED") return { state: "blocked", detail: "It needs an approving review." };
    if (checksPending) return { state: "pending", detail: "Required checks are still running." };
    return { state: "blocked", detail: "A required check or branch rule blocks it." };
  }
  if (status === "BEHIND") return { state: "behind", detail: "The base branch has moved on; update the branch first." };
  if (status === "UNSTABLE" || checksPending) return { state: "pending", detail: checksPending ? "Checks are still running." : "Some checks have not passed." };
  return { state: "unknown", detail: "GitHub has not worked out yet whether it can merge." };
}

export function toMergeOptions(repo: MergeNode): MergeOptions {
  const allowed: MergeMethod[] = [];
  if (repo.squashMergeAllowed) allowed.push("squash");
  if (repo.mergeCommitAllowed) allowed.push("merge");
  if (repo.rebaseMergeAllowed) allowed.push("rebase");
  const preferred = METHOD_OF[repo.viewerDefaultMergeMethod ?? ""];
  const first = preferred && allowed.includes(preferred) ? preferred : (allowed[0] ?? "merge");
  return {
    methods: [first, ...allowed.filter((m) => m !== first)],
    default: first,
    deleteBranch: repo.deleteBranchOnMerge,
    canAuto: repo.autoMergeAllowed && repo.pullRequest.viewerCanEnableAutoMerge,
    ...mergeState(repo.pullRequest),
  };
}

const EVENT_OF = { comment: "COMMENT", approve: "APPROVE", changes: "REQUEST_CHANGES" } as const;

/** Inline comments GitHub could not place, as a list under the review's body. */
export function commentsInBody(body: string, comments: readonly ReviewComment[]): string {
  const list = comments.map((c) => `- \`${c.line === null ? c.path : `${c.path}:${c.line}`}\` ${c.body.trim().replaceAll("\n", "\n  ")}`);
  return [body.trim(), list.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * A refusal of a comment's place in the diff, such as "Line could not be resolved". Anything that names
 * the commit is about the review itself (a head that moved on) and must fail rather than post again.
 */
export function isPlacementError(text: string): boolean {
  return /\b(line|start_line|path|position|side|start_side|subject_type|diff|diff_hunk)\b|could not be resolved/iu.test(text) && !/\b(commit|commit_id|commit_oid|sha|head)\b/iu.test(text);
}

/** GitHub's own words from an API error body, such as "Line could not be resolved". */
function apiDetail(stdout: string): string {
  try {
    const body = JSON.parse(stdout) as { message?: string; errors?: unknown[] };
    const errors = (body.errors ?? []).map((e) => (typeof e === "string" ? e : ((e as { message?: string }).message ?? JSON.stringify(e))));
    return [body.message, ...errors].filter(Boolean).join("; ");
  } catch {
    return "";
  }
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

  /** gh pr takes the host in the repository. */
  private target(repo: string): string[] {
    return ["-R", this.server.hostname ? `${this.server.hostname}/${repo}` : repo];
  }

  private async call(operation: Operation, args: string[], signal?: AbortSignal, stdin?: string): Promise<RunResult> {
    const result = await this.run("gh", args, { timeoutMs: GH_TIMEOUT_MS, signal, ...(stdin === undefined ? {} : { stdin }) }).catch((error: unknown) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new AdapterError(operation, missing ? "gh is not installed or not on PATH" : `gh could not start: ${(error as Error).message}`);
    });
    if (result.timedOut) throw new AdapterError(operation, `gh took longer than ${GH_TIMEOUT_MS / 1000}s`);
    return result;
  }

  private failure(operation: Operation, result: RunResult): AdapterError {
    const detail = apiDetail(result.stdout);
    return new AdapterError(operation, `gh exited ${result.code}: ${tail(result.stderr || result.stdout) || "no output"}${detail ? ` (${detail})` : ""}`);
  }

  private async gh(operation: Operation, args: string[], signal?: AbortSignal, stdin?: string): Promise<string> {
    const result = await this.call(operation, args, signal, stdin);
    if (result.code !== 0) throw this.failure(operation, result);
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
      pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${listFields(operation)} } } } }`;
    const schema = z.object({
      search: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(z.union([summaryNode, z.object({}).strict()])) }),
    });
    const rows: PrSummary[] = [];
    let after: string | null = null;
    for (let page = 0; page < SEARCH_PAGES; page++) {
      const vars: Record<string, string> = { q: searchQuery(operation, options), ...(after ? { after } : {}) };
      // Search pages of 50 full PRs sometimes run past GitHub's own time limit; a second try usually lands.
      const data = await this.graphql(operation, query, vars, schema, signal).catch((error: unknown) => {
        if (!(error instanceof AdapterError) || !/HTTP 50[24]/u.test(error.message) || signal?.aborted) throw error;
        return this.graphql(operation, query, vars, schema, signal);
      });
      for (const node of data.search.nodes) if ("number" in node) rows.push(toSummary(node as SummaryNode));
      if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) return { rows, complete: true };
      after = data.search.pageInfo.endCursor;
    }
    return { rows, complete: false };
  }

  private repoVars(repo: string, number: number, operation: Operation = "view") {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new AdapterError(operation, `${repo} is not owner/name`);
    return { owner, name, number };
  }

  async view(repo: string, number: number, signal?: AbortSignal): Promise<PrSummary> {
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      ${SUMMARY_FIELDS} ${REQUESTED_FIELDS} ${FIRST_REVIEW_FIELDS} body } } }`;
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
      reviews(last: 50) { nodes { id state body url submittedAt ${who} } }
      reviewThreads(last: 50) { nodes { id isResolved path line comments(last: 20) { nodes { id body url createdAt ${who} } } } }
      comments(last: 50) { nodes { id body url createdAt ${who} } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes { __typename
        ... on CheckRun { id name conclusion detailsUrl completedAt } ... on StatusContext { id context state targetUrl createdAt } } } } } } }
    } } }`;
    const schema = z.object({ repository: z.object({ pullRequest: activityNode.nullable() }).nullable() });
    const data = await this.graphql("activity", query, this.repoVars(repo, number, "activity"), schema, signal);
    const node = data.repository?.pullRequest;
    if (!node) throw new AdapterError("activity", `${repo}#${number} was not found`);
    return toActivity(node);
  }

  async change(repo: string, number: number, change: PrChange, signal?: AbortSignal): Promise<void> {
    const op = changeOperation(change);
    const target = this.target(repo);
    const api = (method: string, path: string, fields: Array<[string, string]>) =>
      this.gh(op, ["api", ...this.hostArgs(), "-X", method, path, ...fields.flatMap(([k, v]) => ["-f", `${k}=${v}`])], signal);
    switch (change.kind) {
      case "ready":
      case "draft":
        await this.gh(op, ["pr", "ready", String(number), ...target, ...(change.kind === "draft" ? ["--undo"] : [])], signal);
        return;
      case "close":
      case "reopen":
        await this.gh(op, ["pr", change.kind, String(number), ...target], signal);
        return;
      case "labels":
        if (change.add.length) await api("POST", `repos/${repo}/issues/${number}/labels`, change.add.map((l) => ["labels[]", l]));
        for (const label of change.remove) await api("DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, []);
        return;
      case "reviewers": {
        // REST wants a team's slug without its org.
        const fields = (refs: typeof change.add): Array<[string, string]> =>
          refs.map((r) => (r.team ? ["team_reviewers[]", r.login.split("/").pop()!] : ["reviewers[]", r.login]));
        if (change.add.length) await api("POST", `repos/${repo}/pulls/${number}/requested_reviewers`, fields(change.add));
        if (change.remove.length) await api("DELETE", `repos/${repo}/pulls/${number}/requested_reviewers`, fields(change.remove));
        return;
      }
    }
  }

  async editOptions(repo: string, number: number, signal?: AbortSignal): Promise<EditOptions> {
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } }
      pullRequest(number: $number) { suggestedReviewers { reviewer { login } } } } }`;
    const schema = z.object({
      repository: z.object({
        labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string().nullable(), description: z.string().nullable() })) }).nullable(),
        pullRequest: z.object({ suggestedReviewers: z.array(z.object({ reviewer: z.object({ login: z.string() }).nullable() })) }).nullable(),
      }).nullable(),
    });
    const data = await this.graphql("edit_options", query, this.repoVars(repo, number, "edit_options"), schema, signal);
    return {
      labels: (data.repository?.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color ? l.color.toLowerCase() : null, description: l.description })),
      people: (data.repository?.pullRequest?.suggestedReviewers ?? []).flatMap((s) => (s.reviewer ? [s.reviewer.login] : [])),
    };
  }

  async mergeOptions(repo: string, number: number, signal?: AbortSignal): Promise<MergeOptions> {
    const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
      squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
      pullRequest(number: $number) { isDraft mergeable mergeStateStatus viewerCanEnableAutoMerge reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }`;
    const schema = z.object({ repository: mergeNode.nullable() });
    const data = await this.graphql("merge_options", query, this.repoVars(repo, number, "merge_options"), schema, signal);
    const repository = data.repository;
    if (!repository?.pullRequest) throw new AdapterError("merge_options", `${repo}#${number} was not found`);
    return toMergeOptions(repository as MergeNode);
  }

  async merge(repo: string, number: number, input: MergeInput, signal?: AbortSignal): Promise<{ merged: boolean }> {
    const args = ["pr", "merge", String(number), ...this.target(repo), `--${input.method}`, "--match-head-commit", input.head];
    if (input.auto) args.push("--auto");
    if (input.deleteBranch) args.push("--delete-branch");
    if (input.subject) args.push("--subject", input.subject);
    await this.gh("merge", args, signal);
    return { merged: !input.auto };
  }

  async cancelAutoMerge(repo: string, number: number, signal?: AbortSignal): Promise<void> {
    await this.gh("merge", ["pr", "merge", String(number), ...this.target(repo), "--disable-auto"], signal);
  }

  async comment(repo: string, number: number, body: string, signal?: AbortSignal): Promise<void> {
    await this.gh("comment", ["pr", "comment", String(number), ...this.target(repo), "--body-file", "-"], signal, body);
  }

  async review(repo: string, number: number, post: ReviewPost, signal?: AbortSignal): Promise<ReviewPosted> {
    if (post.verdict === "comment" && !post.body.trim() && post.comments.length === 0) throw new AdapterError("review", "a comment review needs a body or at least one comment");
    const args = ["api", ...this.hostArgs(), "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"];
    const payload = (body: string, comments: unknown[]) =>
      JSON.stringify({ ...(post.head ? { commit_id: post.head } : {}), body, event: EVENT_OF[post.verdict], ...(comments.length ? { comments } : {}) });
    const inline = post.comments.map((c) => (c.line === null ? { path: c.path, body: c.body, subject_type: "file" } : { path: c.path, line: c.line, side: "RIGHT", body: c.body }));
    const first = await this.call("review", args, signal, payload(post.body, inline));
    if (first.code === 0) return { placed: post.comments.length, inBody: 0 };
    // A line GitHub cannot find in the diff: the comments still reach the author in the body, on the same commit.
    if (!post.comments.length || !/HTTP 422/u.test(first.stderr) || !isPlacementError(`${first.stderr} ${apiDetail(first.stdout)}`)) throw this.failure("review", first);
    const second = await this.call("review", args, signal, payload(commentsInBody(post.body, post.comments), []));
    if (second.code !== 0) throw this.failure("review", second);
    return { placed: 0, inBody: post.comments.length };
  }

  async reply(_repo: string, _number: number, thread: string, body: string, signal?: AbortSignal): Promise<void> {
    const mutation = `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`;
    await this.graphql("reply", mutation, { thread, body }, z.object({ addPullRequestReviewThreadReply: z.object({ comment: z.object({ id: z.string() }) }) }), signal);
  }

  async resolve(_repo: string, _number: number, thread: string, resolved: boolean, signal?: AbortSignal): Promise<void> {
    const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const mutation = `mutation($thread: ID!) { ${field}(input: { threadId: $thread }) { thread { isResolved } } }`;
    await this.graphql("resolve", mutation, { thread }, z.object({ [field]: z.object({ thread: z.object({ isResolved: z.boolean() }) }) }), signal);
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
