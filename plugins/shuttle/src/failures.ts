// Why a sync step failed, in plain words. Pure, so the UI and the CLI word it the same way.
import type { SyncFailure, SyncFailureKind, SyncStepName } from "./contract";

/** What each step fetches, for sentences such as "Delta failed while Shuttle asked for team requests". */
export const STEP_LABELS: Record<SyncStepName, string> = {
  whoami: "who you are",
  authored: "your PRs",
  review_requested: "review requests",
  team_requested: "team requests",
  mentioned: "mentions",
  reviewed: "PRs you reviewed",
  refresh: "linked and tracked PRs",
};

/**
 * Failures that usually pass by themselves and are quick to try again. A rate limit is left out, since
 * asking again only makes it worse, and so is a timeout, which would run the same slow request on a
 * server that is already struggling.
 */
export const RETRYABLE: ReadonlySet<SyncFailureKind> = new Set<SyncFailureKind>(["unavailable", "network", "cut_short"]);

export interface FailureSource {
  message: string;
  output?: string;
  exit?: number | null;
  command?: string;
}

const STATUS = [/\bHTTP[ /]?(?:\d\.\d )?([1-5]\d\d)\b/iu, /\bError:? ([45]\d\d)\b/u, /\bstatus(?: code)?:? ([45]\d\d)\b/iu];

export function httpStatus(text: string): number | null {
  for (const pattern of STATUS) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

export function failureKind(text: string, status: number | null = httpStatus(text)): SyncFailureKind {
  if (status === 429 || /rate.?limit|too many requests|abuse detection/iu.test(text)) return "rate_limit";
  if (status === 401 || status === 403 || /unauthori[sz]ed|not (?:logged|signed) in|bad credentials|token (?:is )?(?:expired|invalid|revoked)|did not accept your sign-in|gh auth login/iu.test(text)) return "auth";
  // A gateway timeout is a server error, but asking again would repeat the same slow request.
  if (status === 504 || /took longer than|timed? ?out\b|deadline exceeded|gateway time-?out|couldn't respond to your request in time/iu.test(text)) return "timeout";
  if ((status !== null && status >= 500) || /restarting|service unavailable|bad gateway|internal server error|temporarily unavailable/iu.test(text)) return "unavailable";
  if (/unexpected end of JSON input|unexpected EOF|printed nothing/iu.test(text)) return "cut_short";
  if (/dns error|lookup address|could not resolve|getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|connection (?:refused|reset|closed)|network is unreachable|client error \(Connect\)/iu.test(text)) return "network";
  return "failed";
}

function summaryOf(kind: SyncFailureKind, server: string, status: number | null, text: string, message: string): string {
  const code = status === null ? "" : ` (HTTP ${status})`;
  switch (kind) {
    case "unavailable": return status === 503 && /restarting/iu.test(text) ? `${server} was restarting (HTTP 503)` : `${server} had a server error${code}`;
    case "timeout": return `${server} took too long to answer${code}`;
    case "network": return `Shuttle could not reach ${server}`;
    case "rate_limit": return `${server} is limiting how often Shuttle asks${code}`;
    case "auth": return `${server} did not accept your sign-in${code}`;
    case "cut_short": return `${server} cut its answer short`;
    case "failed": return status !== null ? `${server} answered HTTP ${status}` : message.length > 160 ? `${message.slice(0, 159)}…` : message;
  }
}

const RUN = /\brun `([^`\n]{1,160})`/iu;

/** A failure in plain words, with what the command printed and a fix when the command named one. */
export function describeFailure(server: { name: string; kind: string; hostname?: string }, source: FailureSource): SyncFailure {
  const output = source.output?.trim() || null;
  const text = `${source.message}\n${output ?? ""}`;
  const status = httpStatus(text);
  const kind = failureKind(text, status);
  const named = RUN.exec(output ?? "")?.[1] ?? RUN.exec(source.message)?.[1] ?? null;
  const fix = named ?? (kind === "auth" && server.kind === "github" ? `gh auth login${server.hostname ? ` --hostname ${server.hostname}` : ""}` : null);
  return { kind, summary: summaryOf(kind, server.name, status, text, source.message), message: source.message, output, exit: source.exit ?? null, command: source.command ?? null, fix };
}

/**
 * The step whose failure to tell the user about: a refused sign-in needs them, a rate limit explains
 * the steps that did not run, and otherwise the first failure.
 */
export function primaryStep<T extends { failure: { kind: SyncFailureKind } | null }>(steps: readonly T[]): T | undefined {
  return steps.find((step) => step.failure?.kind === "auth") ?? steps.find((step) => step.failure?.kind === "rate_limit") ?? steps.find((step) => step.failure !== null);
}

/** What happens next, or what the user can do, after a failure of this kind. `next` is a time such as "11:38". */
export function failureAdvice(failure: Pick<SyncFailure, "kind" | "fix">, next: string | null): string {
  const again = next === null ? "Shuttle tries again at the next sync." : `Shuttle tries again around ${next}.`;
  switch (failure.kind) {
    case "auth": return failure.fix ? `Run ${failure.fix}, then sync again.` : "Sign in again with the tool this server's commands use, then sync again.";
    case "rate_limit": return `Shuttle waits for the next sync rather than asking again sooner. ${again}`;
    case "failed": return `Check what the command printed, or the server's commands in Settings. ${again}`;
    default: return `This usually passes by itself. ${again}`;
  }
}
