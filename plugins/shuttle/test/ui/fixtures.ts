import type { CheckRun, ConversationItem, PrDetails, PrView, ReviewDraft } from "../../src/contract";
import { agent, CAN_ALL, DAY, HOUR, item, link, mine, next, NOW, pr } from "./helpers";

// Two PRs as a person meets them: their own, with changes asked for and an agent on it, and one they review with an AI draft waiting.

const MIN = 60_000;
const ago = (ms: number) => NOW - ms;

const run = (overrides: Partial<CheckRun> & { name: string }): CheckRun => ({
  group: "CI", state: "passed", detail: null, required: false, url: `https://github.com/acme/checkout/actions/runs/${overrides.name.length}`,
  startedAt: ago(20 * MIN), completedAt: ago(18 * MIN), itemId: null, ...overrides,
});

const PASSING = ["build (node 22)", "typecheck", "unit / payments", "unit / cart", "integration / gateway-sandbox", "codeql / javascript", "bundle-size", "cla"];

export const retryPr: PrView = mine({
  repo: "acme/checkout", number: 4821, title: "Retry card authorization when the payment gateway times out", url: "https://github.com/acme/checkout/pull/4821",
  author: "kalindudc", head: "4a1c9e2f00", headRef: "kalindudc/retry-gateway-timeouts", base: "main", additions: 412, deletions: 89, files: 9,
  createdAt: ago(3 * DAY + 2 * HOUR), updatedAt: ago(17 * MIN), checks: "failed", checkCounts: { passed: 8, failed: 2, pending: 1, total: 11 }, review: "changes",
  labels: [{ name: "payments", color: "1f6feb" }, { name: "needs-qa", color: "d29922" }],
  reviewers: [
    { login: "sam-rivera", team: false, state: "changes", at: ago(HOUR), head: "9c2e1f0aa" },
    { login: "priya-n", team: false, state: "approved", at: ago(2 * HOUR), head: "7b13d22aa" },
    { login: "acme/payments", team: true, state: "requested" },
  ],
  agent: agent({ threadId: "thr_agent", title: "Retry gateway timeouts", status: "working", auto: true, lastSent: { at: ago(58 * MIN), text: "2 review comments and 2 failed checks" } }),
  links: [link({ threadId: "thr_agent", title: "Retry gateway timeouts", role: "owner" }), link({ threadId: "thr_plan", title: "Plan Q4 checkout reliability work", role: "reference" })],
  can: CAN_ALL, actions: ["draft", "close", "labels", "reviewers"],
  next: next({ kind: "agent_on_it", tone: "info", label: "The agent is on it", why: "“Retry gateway timeouts” has changes requested by sam-rivera and 2 checks failing, and is asked to fix it.", more: [{ id: "open_agent", label: "Open the thread" }] }),
});

export const retryItems: ConversationItem[] = [
  item({ id: "IC1", kind: "comment", author: "kalindudc", mine: true, body: "@acme/payments this touches the authorization path. A second look before it ships would be great.", path: null, line: null, thread: null, at: ago(3 * DAY) }),
  item({ id: "IC2", kind: "comment", author: "codecov", bot: true, body: "Coverage is 87.2% (+0.4%).", path: null, line: null, thread: null, at: ago(3 * DAY - 15 * MIN) }),
  item({ id: "T1:C1", author: "priya-n", body: "nit: call this `MAX_BACKOFF_MS` so the unit is obvious.", path: "src/payments/retry.ts", line: 12, thread: "T1", resolved: true, at: ago(125 * MIN), review: "PRR_priya" }),
  item({ id: "T1:C2", author: "kalindudc", mine: true, body: "Done in 7b13d22.", path: "src/payments/retry.ts", line: 12, thread: "T1", resolved: true, at: ago(121 * MIN) }),
  item({ id: "R1:APPROVED", kind: "review", author: "priya-n", state: "approved", body: "Looks good overall. The retry budget fits the gateway's 10-second SLA.", path: null, line: null, thread: null, at: ago(2 * HOUR), review: "PRR_priya" }),
  item({ id: "R2:CHANGES_REQUESTED", kind: "review", author: "sam-rivera", state: "changes requested", body: "Two things before this goes in: retry only on timeouts, and fix the jitter order.", path: null, line: null, thread: null, at: ago(HOUR), review: "PRR_sam", delivery: "sent" }),
  item({
    id: "T2:C3", author: "sam-rivera", body: "This retries on every 5xx, including the 502s our own proxy returns when it sheds load. Can we limit it to real gateway timeouts?",
    path: "src/payments/gateway.ts", line: 142, thread: "T2", at: ago(HOUR), review: "PRR_sam", delivery: "sent",
    hunk: [{ kind: "context", text: "  } catch (error) {", line: 140 }, { kind: "add", text: "    if (error.status >= 500) {", line: 141 }, { kind: "add", text: "      return retry(authorize, attempt + 1);", line: 142 }],
  }),
  item({
    id: "T3:C4", author: "sam-rivera", body: "Jitter should be applied before the cap, or every retry after the third lands at exactly 8 s.",
    path: "src/payments/retry.ts", line: 28, thread: "T3", at: ago(59 * MIN), review: "PRR_sam", delivery: "sent",
    outcome: { outcome: "fixed", note: "Applied jitter before the cap and added a test for the ceiling.", commit: "4a1c9e2f00", at: ago(24 * MIN) },
    hunk: [{ kind: "context", text: "  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);", line: 27 }, { kind: "add", text: "  return base + Math.random() * 100;", line: 28 }],
  }),
  item({ id: "CK1:4a1c9e2f00", kind: "check", author: null, body: "lint / eslint failed", path: null, line: null, thread: null, url: "https://github.com/acme/checkout/actions/runs/1", at: ago(18 * MIN), delivery: "sent" }),
  item({ id: "CK2:4a1c9e2f00", kind: "check", author: null, body: "test (ubuntu-latest, node 22) failed", path: null, line: null, thread: null, url: "https://github.com/acme/checkout/actions/runs/2", at: ago(12 * MIN), delivery: "pending" }),
];

export const retryDetails: PrDetails = {
  checks: { total: 11, items: [
    run({ name: "lint / eslint", state: "failed", required: true, startedAt: ago(20 * MIN), completedAt: ago(18 * MIN), itemId: "CK1:4a1c9e2f00" }),
    run({ name: "test (ubuntu-latest, node 22)", state: "failed", required: true, detail: "timed out", startedAt: ago(18 * MIN), completedAt: ago(12 * MIN), itemId: "CK2:4a1c9e2f00" }),
    run({ name: "e2e / checkout-flows", group: "E2E", state: "running", required: true, detail: "in progress", startedAt: ago(9 * MIN), completedAt: null }),
    ...PASSING.map((name) => run({ name, required: name === "typecheck" || name === "cla" })),
  ] },
  commits: { total: 4, items: [
    { sha: "1f0d8aa000", message: "Retry card authorization on gateway timeout", author: "kalindudc", at: ago(3 * DAY + 2 * HOUR) },
    { sha: "7b13d22aa0", message: "Rename the backoff constant to MAX_BACKOFF_MS", author: "kalindudc", at: ago(121 * MIN) },
    { sha: "9c2e1f0aa0", message: "Record retry attempts in checkout metrics", author: "kalindudc", at: ago(80 * MIN) },
    { sha: "4a1c9e2f00", message: "Apply jitter before the backoff cap", author: "kalindudc", at: ago(25 * MIN) },
  ] },
  files: { total: 9, items: [
    { path: "src/payments/gateway.ts", additions: 118, deletions: 41, change: "modified" },
    { path: "src/payments/retry.ts", additions: 86, deletions: 0, change: "added" },
    { path: "src/payments/metrics.ts", additions: 22, deletions: 3, change: "modified" },
    { path: "src/payments/__tests__/retry.test.ts", additions: 104, deletions: 0, change: "added" },
    { path: "src/payments/__tests__/gateway.test.ts", additions: 40, deletions: 12, change: "modified" },
    { path: "src/config/timeouts.ts", additions: 6, deletions: 2, change: "modified" },
    { path: "src/config/legacy-timeouts.ts", additions: 0, deletions: 31, change: "removed" },
    { path: "docs/payments/retries.md", additions: 31, deletions: 0, change: "added" },
    { path: "CHANGELOG.md", additions: 5, deletions: 0, change: "modified" },
  ] },
  timeline: [
    { kind: "review_requested", at: ago(3 * DAY + 2 * HOUR), actor: "kalindudc", subject: "@acme/payments", detail: null },
    { kind: "review_requested", at: ago(3 * DAY + 2 * HOUR), actor: "kalindudc", subject: "sam-rivera", detail: null },
    { kind: "labeled", at: ago(3 * DAY + 2 * HOUR), actor: "kalindudc", subject: "payments", detail: null },
  ],
  merge: { state: "blocked", detail: "A reviewer requested changes." },
};

export const RETRY_BODY = [
  "Card authorizations fail outright when the payment gateway takes longer than 10 seconds. This retries them with backoff instead of failing the checkout.",
  "", "## What changes", "", "- A new `retry.ts` with exponential backoff, capped at 8 seconds, plus jitter.", "- `gateway.ts` retries a timed-out authorization up to 3 times with the same idempotency key.",
  "", "## Risk", "", "Retries reuse the idempotency key, so a slow first attempt cannot charge twice.",
].join("\n");

export const taxPr: PrView = pr({
  repo: "acme/checkout", number: 4907, title: "Move tax calculation into a pure module", url: "https://github.com/acme/checkout/pull/4907", author: "dana-k",
  head: "3e9a7c1000", headRef: "dana/pure-tax", base: "main", additions: 640, deletions: 588, files: 14, createdAt: ago(2 * DAY + 4 * HOUR), updatedAt: ago(3 * HOUR),
  checks: "passed", checkCounts: { passed: 8, failed: 0, pending: 0, total: 8 }, review: "required", requestedAt: ago(2 * DAY + 4 * HOUR),
  labels: [{ name: "tax", color: "2ea043" }, { name: "refactor", color: "a371f7" }],
  reviewers: [
    { login: "lee-m", team: false, state: "approved", at: ago(5 * HOUR), head: "3e9a7c1000" },
    { login: "kalindudc", team: false, state: "requested" },
    { login: "acme/tax", team: true, state: "requested" },
  ],
  links: [link({ threadId: "thr_review", title: "Review acme/checkout#4907", role: "review" })],
  can: CAN_ALL, draft: { id: 7, findings: 3, at: ago(90 * MIN) },
  lastReview: { threadId: "thr_review", title: "Review acme/checkout#4907", state: "done", preset: "Thorough", trigger: "auto", head: "3e9a7c1000", at: ago(90 * MIN) },
  next: next({ kind: "post", tone: "info", label: "AI review ready: choose what to post", why: "3 findings from Thorough (started by auto review). Nothing is posted yet.", inbox: true, primary: { id: "choose", label: "Choose what to post" }, more: [{ id: "approve", label: "Approve…" }] }),
});

export const taxDraft: ReviewDraft = {
  id: 7, threadId: "thr_review", threadTitle: "Review acme/checkout#4907", preset: "Thorough", trigger: "auto", head: "3e9a7c1000", at: ago(90 * MIN), verdict: "changes",
  summary: "The move into a pure module reads well. One behaviour change needs fixing: tax is now rounded per line instead of once on the total.",
  findings: [
    { id: "f1", severity: "high", path: "src/tax/calculate.ts", line: 57, body: "Rounding now happens per line item instead of once on the order total, which changes what customers pay." },
    { id: "f2", severity: "medium", path: "src/tax/exemptions.ts", line: 23, body: "`applyExemptions` sorts `exemptions` in place, so the module still changes its caller's array." },
    { id: "f3", severity: "nit", path: "src/tax/index.ts", line: 3, body: "Alphabetical re-exports would be easier to scan." },
  ],
};

export const taxItems: ConversationItem[] = [
  item({ id: "IC9", kind: "comment", author: "dana-k", body: "@kalindudc you wrote the original tax code, so you're the best person to check the rounding.", path: null, line: null, thread: null, at: ago(2 * DAY + 4 * HOUR) }),
  item({ id: "T9:C1", author: "lee-m", body: "Could the rate table be a `const` object instead of a class?", path: "src/tax/rates.ts", line: 8, thread: "T9", resolved: true, at: ago(6 * HOUR) }),
  item({ id: "T9:C2", author: "dana-k", body: "Good call, changed in 3e9a7c1.", path: "src/tax/rates.ts", line: 8, thread: "T9", resolved: true, at: ago(5 * HOUR + 30 * MIN) }),
  item({ id: "R9:APPROVED", kind: "review", author: "lee-m", state: "approved", body: "The layout looks good to me. I'll leave the rounding to @kalindudc.", path: null, line: null, thread: null, at: ago(5 * HOUR) }),
];

export const taxDetails: PrDetails = {
  checks: { total: 8, items: PASSING.map((name) => run({ name, startedAt: ago(3 * HOUR + 4 * MIN), completedAt: ago(3 * HOUR) })) },
  commits: { total: 2, items: [
    { sha: "a01f3c2000", message: "Extract tax calculation into src/tax", author: "dana-k", at: ago(2 * DAY + 5 * HOUR) },
    { sha: "3e9a7c1000", message: "Make the rate table a const object", author: "dana-k", at: ago(5 * HOUR + 30 * MIN) },
  ] },
  files: { total: 2400, items: [
    { path: "src/tax/calculate.ts", additions: 182, deletions: 0, change: "added" },
    { path: "src/tax/rates.ts", additions: 96, deletions: 0, change: "added" },
    { path: "src/checkout/summary.ts", additions: 38, deletions: 214, change: "modified" },
  ] },
  timeline: [{ kind: "review_requested", at: ago(2 * DAY + 4 * HOUR), actor: "dana-k", subject: "kalindudc", detail: null }],
  merge: { state: "blocked", detail: "It needs an approving review." },
};

export const mergedPr: PrView = {
  ...retryPr, state: "merged", closedAt: ago(4 * MIN), checks: "passed", checkCounts: { passed: 11, failed: 0, pending: 0, total: 11 }, review: "approved",
  reviewers: [{ login: "sam-rivera", team: false, state: "approved", at: ago(10 * MIN), head: "4a1c9e2f00" }, { login: "priya-n", team: false, state: "approved", at: ago(2 * HOUR), head: "7b13d22aa0" }],
  agent: { ...retryPr.agent!, status: "idle" }, actions: [],
  next: next({ kind: "merged", tone: "neutral", label: "Merged", why: "Merged." }),
};

export const mergedDetails: PrDetails = {
  ...retryDetails,
  checks: { total: 11, items: retryDetails.checks!.items.map((check) => ({ ...check, state: "passed" as const, detail: null, itemId: null, completedAt: check.completedAt ?? ago(5 * MIN) })) },
  timeline: [...retryDetails.timeline!, { kind: "merged", at: ago(4 * MIN), actor: "kalindudc", subject: "e51b0c4", detail: "main" }, { kind: "branch_deleted", at: ago(4 * MIN), actor: "kalindudc", subject: "kalindudc/retry-gateway-timeouts", detail: null }],
  merge: null,
};
