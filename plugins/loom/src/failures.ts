// What a failure that reaches Loom is, decided once where it enters: a host call that threw, a host or forge step that
// answered unavailable, or a forge command's output. Each failure gets a kind (temporary, lasting, or an unknown outcome
// when a call got no answer), a scope (this ticket, a forge or machine every ticket on it shares, or the whole project)
// and its reason. retry.ts decides what Loom does with it. The text rules here also run on the host, which reads gh's,
// git's and forge commands' output into the `transient` field of an unavailable answer.

/** A failure worth waiting out, as a host answer carries it: a server error or timeout, a rate limit, or a network failure. */
export interface Transient {
  transient: "server" | "rate_limit" | "network";
  retryAfterMs?: number;
}

export type FailureKind = "temporary" | "lasting" | "unknown";
export type FailureScope = "ticket" | "forge" | "host" | "project";

export interface Failure {
  /** `unknown`: the call got no answer, so Loom cannot tell whether it ran. */
  kind: FailureKind;
  /** `forge`: every read of the forge host waits; `host`: the project's machine or a repo's checkout on it. */
  scope: FailureScope;
  reason: string;
  /** A rule recognized the failure. An unrecognized one is temporary for this ticket, with fewer tries. */
  known: boolean;
  retryAfterMs?: number;
  /** The forge rate-limited Loom, so it waits at least 15 minutes. */
  rateLimited?: boolean;
  /** What the human must fix, for a failure that pauses the project. */
  fix?: string;
}

/** A forge operation's answer that the host contract refused: the forge's command printed it (forge-gate.ts). */
export class ForgeContractError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
  }
}

/** A step a host could not do, with whether its failure is worth waiting out. */
export class Unavailable extends Error {
  constructor(
    message: string,
    readonly wait: Transient | null = null,
  ) {
    super(message);
  }
}

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// gh's "HTTP 502", git's "returned error: 502", and a forge CLI's "Error: 429: …" or "503: …" at the start of a line.
const HTTP_STATUS = /\bHTTP (\d{3})\b|\breturned error: (\d{3})\b|^[ \t]*(?:error:[ \t]*)?(\d{3}):/imu;
const RATE_LIMITED = /rate[-_ ]limit|abuse detection|too many requests/iu;
// A server that says it is short of something now and asks to be tried again, such as a git server whose upload-pack ran
// out of its memory budget, counts too.
const SERVER_TROUBLE =
  /\bserver error\b|bad gateway|service unavailable|gateway time-?out|\btime(?:d[- ]?|[- ]?)out|deadline exceeded|connection (?:reset|refused)|\bEOF\b|TLS handshake|something went wrong|remote end hung up unexpectedly|retry with backoff|\bretry (?:later|shortly)\b|try again later|temporarily unavailable|budget exhausted|resources? exhausted|\b(?:server|service) (?:is )?(?:too )?busy\b|\boverloaded\b/iu;
// The read never reached the forge: its name did not resolve or no connection opened. That is this machine's resolver or
// network, not one pull request, so it is tested before SERVER_TROUBLE, whose timeouts would also match a connect timeout.
const NETWORK_TROUBLE =
  /could not resolve host|dns error|failed to lookup address|nodename nor servname|no such host|temporary failure in name resolution|getaddrinfo|name or service not known|error connecting to|client error \(connect\)|network is unreachable|host is unreachable|no route to host|connection timed out|i\/o timeout|check your internet connection|couldn't connect to server|failed to connect to/iu;
const RETRY_AFTER_SECONDS = /retry[- ]after:?\s*(\d{1,6})\b/iu;
const RATE_LIMIT_RESET = /x-ratelimit-reset:?\s*(\d{10})\b/iu;
const TRY_AGAIN_IN = /(?:try again|retry) in (\d{1,4}) (second|minute|hour)s?\b/iu;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 };
const LONGEST_RETRY_AFTER_MS = 24 * 3_600_000;

function retryAfterMs(text: string): number | null {
  const seconds = RETRY_AFTER_SECONDS.exec(text);
  const reset = RATE_LIMIT_RESET.exec(text);
  const later = TRY_AGAIN_IN.exec(text);
  const ms = seconds !== null ? Number(seconds[1]) * 1000 : reset !== null ? Number(reset[1]) * 1000 - Date.now() : later !== null ? Number(later[1]) * UNIT_MS[later[2]!.toLowerCase()]! : null;
  return ms === null ? null : Math.min(LONGEST_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/**
 * Whether a forge's or a git remote's error output is worth waiting out: `rate_limit` when it says it rate-limited the
 * call (HTTP 429, a 403 or GraphQL's RATE_LIMITED that says so), `server` for 500, 502, 503 and 504 answers, timeouts
 * and dropped connections, and `network` when the call never reached it, such as a name lookup that failed. Null for
 * the rest, such as a 404 or a bad URL.
 */
export function transientOfText(text: string): Transient | null {
  const found = HTTP_STATUS.exec(text);
  const status = found?.[1] ?? found?.[2] ?? found?.[3];
  if (status === "429" || (RATE_LIMITED.test(text) && (status === undefined || status === "403"))) {
    const wait = retryAfterMs(text);
    return wait === null ? { transient: "rate_limit" } : { transient: "rate_limit", retryAfterMs: wait };
  }
  if (status !== undefined) return /^50[0234]$/u.test(status) ? { transient: "server" } : null;
  if (NETWORK_TROUBLE.test(text)) return { transient: "network" };
  return SERVER_TROUBLE.test(text) ? { transient: "server" } : null;
}

// What bb says when a call to Loom's host entry got no answer: it ran out of time, the host's plugin worker exited or is
// not there, a plugin update retired the generation the call was for or the new one's startup timed out, or the machine
// is not connected; what the host queue says when a call waited too long behind others on the checkout; and what the
// host entry says when a git or gh process it ran ran out of time.
const HOST_CALL_TROUBLE =
  /host plugin call \S+ (?:exceeded|reached) its deadline|host plugin worker (?:exited|failed to start)|host plugin \S+ worker is unavailable|host plugin manager is shutting down|host plugin \S+ generation \S+ is retired|host plugin \S+ startup timed out|host plugin transport is unavailable|\bhost(?: daemon)? is not connected\b|\bhost is (?:suspended|unavailable)\b|timed out waiting for command result|the project's checkout is busy with another call|\b(?:git|gh) [\w-]+ took too long\b/iu;
// An input or output the contract refuses and an unknown method are answers from bb, so waiting would not help.
const ANSWERED_CODES: readonly string[] = ["invalid_input", "invalid_output", "unknown_method", "invalid", "invalid_json", "non_json_result", "invalid_response", "forbidden", "not_found"];

/**
 * Whether an error a host call threw is worth waiting out, as a server error: the SDK's transport_error, or a message
 * that says the call got no answer. A handler's own error, such as a git command that failed, is not.
 */
export function hostCallTransient(error: unknown): Transient | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  if (code === "transport_error") return { transient: "server" };
  if (typeof code === "string" && ANSWERED_CODES.includes(code)) return null;
  const message: unknown = Reflect.get(error, "message");
  return typeof message === "string" && HOST_CALL_TROUBLE.test(message) ? { transient: "server" } : null;
}

/** A forge call the forge gate held, as a failure to wait out until its host's backoff ends: nothing was sent. */
export const heldWait = (held: { message: string; transient: Transient["transient"]; retryAfterMs: number }): Unavailable => new Unavailable(held.message, { transient: held.transient, retryAfterMs: held.retryAfterMs });

/** The Transient part of a host's unavailable answer; null when it has none. */
export const transientOf = (answer: Partial<Transient>): Transient | null =>
  answer.transient === undefined ? null : { transient: answer.transient, ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }) };

/** Whether a failed step is worth waiting out: an Unavailable that says so, or a host call that got no answer. */
export const waitableOf = (error: unknown): Transient | null => (error instanceof Unavailable ? error.wait : hostCallTransient(error));

// gh with no login, a token GitHub refuses, or git with no credentials for the remote: only the human can sign in.
const SIGNED_OUT =
  /gh auth login|GH_TOKEN environment variable|\bnot (?:signed|logged) in\b|\bHTTP 401\b|bad credentials|requires authentication|authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|SAML SSO|re-?authorize|token (?:has )?expired/iu;
// A forge command that ran and printed what the spec reference says it may not: the command is wrong, not the pull request.
const BROKEN_COMMAND = /\bmust print a JSON object\b|\bprinted no (?:pull request )?URL\b|\bprinted no JSON\b|\bnot open, merged or closed\b|\bcommand is not configured\b/iu;
// A checkout git left mid-operation or another worktree holds its branch, or a machine that lacks a tool Loom needs:
// every step there fails the same way until someone puts it right.
const CHECKOUT_STUCK =
  /have not concluded your merge|MERGE_HEAD exists|index\.lock': File exists|you need to resolve your current index first|\bis checked out elsewhere\b|\bis already (?:checked out|used by worktree)\b|\bLoom worktree at \S+ is on\b|git-lfs is needed|gh CLI is not installed/iu;
// A repo bb shows no checkout of on the project's machine: someone has to add one.
const NO_CHECKOUT = /\bhas no checkout on the machine\b/iu;
// What no wait changes on one ticket: a merge git stopped, a push the remote refused, a branch or pull request that is not
// there, or a forge that refuses the change itself.
const LASTING =
  /\bCONFLICT\b|\bnon-fast-forward\b|\[rejected\]|\[remote rejected\]|protected branch|couldn't find remote ref|unknown revision|bad revision|not a valid object name|could not resolve to a (?:PullRequest|Repository)|no pull request found|not a GitHub pull request URL|is part of a stack|\bHTTP (?:404|409|410|422)\b/iu;

const PROJECT_FIX = {
  signedOut: "Sign in on the project's machine (for gh, `gh auth login`; for git, the remote's credentials), then resume the project.",
  command: "Fix the forge command in the spec so it prints what the spec reference describes, then resume the project.",
};

const of = (kind: FailureKind, scope: FailureScope, reason: string, known: boolean, extra: Partial<Failure> = {}): Failure => ({ kind, scope, reason, known, ...extra });

/** A failure from its message alone, with what a host or forge answer said about it. */
function classifyText(reason: string, wait: Transient | null): Failure {
  if (SIGNED_OUT.test(reason)) return of("lasting", "project", reason, true, { fix: PROJECT_FIX.signedOut });
  if (HOST_CALL_TROUBLE.test(reason)) return of("unknown", "host", reason, true);
  if (CHECKOUT_STUCK.test(reason)) return of("lasting", "host", reason, true);
  if (NO_CHECKOUT.test(reason)) return of("lasting", "host", reason, true);
  if (wait !== null) {
    const retry = { ...(wait.retryAfterMs === undefined ? {} : { retryAfterMs: wait.retryAfterMs }), ...(wait.transient === "rate_limit" ? { rateLimited: true } : {}) };
    // A rate limit or a failure to reach the forge is the forge's or this machine's, so every read there waits.
    return of("temporary", wait.transient === "server" ? "ticket" : "forge", reason, true, retry);
  }
  // A command that printed a rate limit or a server's refusal instead of what it should is the forge's trouble, not the command's.
  const text = transientOfText(reason);
  if (text !== null) return classifyText(reason, text);
  if (BROKEN_COMMAND.test(reason)) return of("lasting", "project", reason, true, { fix: PROJECT_FIX.command });
  if (LASTING.test(reason)) return of("lasting", "ticket", reason, true);
  return of("temporary", "ticket", reason, false);
}

/**
 * What a failure is: an Unavailable a step threw, an error a host call or bb threw, or anything else. Every failure no
 * rule names is temporary for this ticket, never a reason to stop the project.
 */
export function classify(error: unknown): Failure {
  const reason = errText(error);
  if (error instanceof Unavailable) return classifyText(reason, error.wait);
  if (error instanceof ForgeContractError) return of("lasting", "project", reason, true, { fix: PROJECT_FIX.command });
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  // A host that does not know a method is behind this Loom until someone reloads or updates the plugin there.
  if (code === "unknown_method") return of("lasting", "host", reason, true);
  if (code === "invalid_input" || code === "invalid_output") return of("lasting", "ticket", reason, true);
  if (hostCallTransient(error) !== null) return of("unknown", "host", reason, true);
  return classifyText(reason, null);
}

/** What a host's or forge's unavailable answer is. */
export const classifyAnswer = (answer: { message: string } & Partial<Transient>): Failure => classifyText(answer.message, transientOf(answer));
