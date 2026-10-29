import type { Deadline, RetrievalWarning } from "./contracts.ts";

export const GITHUB_COLLECTION_MAX_PAGES = 10;
export const GITHUB_COLLECTION_MAX_ITEMS = 1_000;

export interface GithubCollectionPage<T> {
	items: T[];
	hasNext: boolean;
	acceptedBytes: number;
}

export interface GithubCollectionResult<T> {
	items: T[];
	pages: number;
	acceptedBytes: number;
	part: {
		name: string;
		state: "complete" | "partial";
		fetched: number;
		expected?: number;
		reason?: string;
	};
	warnings: RetrievalWarning[];
}

export async function collectGithubCollection<T>(options: {
	name: string;
	expected?: number;
	deadline: Deadline;
	loadPage: (page: number) => Promise<GithubCollectionPage<T>>;
}): Promise<GithubCollectionResult<T>> {
	const items: T[] = [];
	let pages = 0;
	let acceptedBytes = 0;
	let hasNext = true;
	let reason: string | undefined;

	while (hasNext && pages < GITHUB_COLLECTION_MAX_PAGES && items.length < GITHUB_COLLECTION_MAX_ITEMS) {
		options.deadline.throwIfExpired(`GitHub ${options.name} pagination`);
		try {
			const page = await options.loadPage(pages + 1);
			pages++;
			acceptedBytes += page.acceptedBytes;
			const remaining = GITHUB_COLLECTION_MAX_ITEMS - items.length;
			items.push(...page.items.slice(0, remaining));
			hasNext = page.hasNext;
			if (page.items.length > remaining) {
				reason = `stopped at the ${GITHUB_COLLECTION_MAX_ITEMS.toLocaleString("en-US")}-item collection limit`;
				break;
			}
		} catch (error) {
			if (options.deadline.signal.aborted) throw error;
			if (options.deadline.remainingMs() <= 0) options.deadline.throwIfExpired(`GitHub ${options.name} pagination`);
			reason = error instanceof Error ? error.message : String(error);
			break;
		}
	}

	if (!reason && hasNext) {
		reason = `stopped at the ${GITHUB_COLLECTION_MAX_PAGES}-page/${GITHUB_COLLECTION_MAX_ITEMS.toLocaleString("en-US")}-item collection limit`;
	}
	if (!reason && options.expected !== undefined && items.length < options.expected) {
		reason = `GitHub reported ${options.expected.toLocaleString("en-US")} items but returned ${items.length.toLocaleString("en-US")}`;
	}
	const state = reason ? "partial" as const : "complete" as const;
	const part = {
		name: options.name,
		state,
		fetched: items.length,
		...(options.expected !== undefined ? { expected: options.expected } : {}),
		...(reason ? { reason } : {}),
	};
	const warnings: RetrievalWarning[] = reason
		? [{ code: "github-collection-partial", stage: `github:${options.name}`, message: `${options.name} partial: ${reason}` }]
		: [];
	return { items, pages, acceptedBytes, part, warnings };
}

export interface GithubIssue {
	number: number;
	title: string;
	state: string;
	html_url: string;
	user?: { login: string };
	created_at: string;
	updated_at?: string;
	closed_at?: string | null;
	body?: string | null;
	comments: number;
	review_comments?: number;
	labels?: Array<{ name: string } | string>;
	pull_request?: { merged_at?: string | null; html_url?: string };
	merged_at?: string | null;
	draft?: boolean;
}

export interface GithubComment {
	user?: { login: string };
	created_at: string;
	body?: string | null;
}

export interface GithubReview {
	user?: { login: string };
	submitted_at?: string | null;
	state?: string;
	body?: string | null;
	html_url?: string;
}

export interface GithubReviewComment extends GithubComment {
	path?: string;
	line?: number | null;
	original_line?: number | null;
	html_url?: string;
	pull_request_review_id?: number | null;
}

function actor(user: { login: string } | undefined): string {
	return `@${user?.login ?? "unknown"}`;
}

function date(value: string | null | undefined): string {
	return value ? value.slice(0, 10) : "unknown date";
}

export function formatGithubIssueDocument(input: {
	issue: GithubIssue;
	comments: GithubComment[];
	reviews: GithubReview[];
	reviewComments: GithubReviewComment[];
	meta: Record<string, string>;
	warnings: string[];
}): { title: string; content: string } {
	const { issue, comments, reviews, reviewComments, meta, warnings } = input;
	const type = issue.pull_request ? "Pull Request" : "Issue";
	const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
	const state = issue.pull_request?.merged_at || issue.merged_at ? "merged" : issue.state;
	const lines = [
		`# ${issue.title}`,
		"",
		`**${type} #${issue.number}** in ${meta.owner}/${meta.repo} · ${state}${issue.draft ? " (draft)" : ""} · by ${actor(issue.user)} · opened ${date(issue.created_at)}${issue.closed_at ? ` · closed ${date(issue.closed_at)}` : ""}`,
	];
	if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
	lines.push(`URL: ${issue.html_url}`);
	for (const warning of warnings) lines.push(`Note: ${warning}`);
	lines.push("", issue.body?.trim() || "_(no description)_");

	if (comments.length) {
		lines.push("", "---", "", `## Conversation comments (${comments.length})`);
		for (const comment of comments) {
			lines.push("", `### ${actor(comment.user)} · ${date(comment.created_at)}`, "", comment.body?.trim() || "_(empty)_");
		}
	}
	if (reviews.length) {
		lines.push("", "---", "", `## Reviews (${reviews.length})`);
		for (const review of reviews) {
			lines.push("", `### ${actor(review.user)} · ${review.state?.toLowerCase().replaceAll("_", " ") || "reviewed"} · ${date(review.submitted_at)}`, "", review.body?.trim() || "_(no review summary)_");
			if (review.html_url) lines.push("", `Review: ${review.html_url}`);
		}
	}
	if (reviewComments.length) {
		lines.push("", "---", "", `## Inline review comments (${reviewComments.length})`);
		for (const comment of reviewComments) {
			const line = comment.line ?? comment.original_line;
			const location = comment.path ? ` · ${comment.path}${line ? `:${line}` : ""}` : "";
			lines.push("", `### ${actor(comment.user)} · ${date(comment.created_at)}${location}`, "", comment.body?.trim() || "_(empty)_");
			if (comment.html_url) lines.push("", `Comment: ${comment.html_url}`);
		}
	}
	return { title: `${issue.title} · ${type} #${issue.number}`, content: lines.join("\n") };
}
