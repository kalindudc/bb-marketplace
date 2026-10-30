// The cards on git links in threads: what a link names, read from Shuttle's own copy first. A PR is never
// fetched on a hover; its comments and details come from the same 30-second read as its view. A commit or
// check run Shuttle cannot place, and an issue, which Shuttle keeps no copy of, are read from their server once
// a minute at most. Nothing is written.
import type { CommitInfo, CheckInfo, IssueInfo } from "./adapters/adapter";
import type { ConversationItem, LINK_STATES, LinkCard, PrDetails } from "./contract";
import { errText, ShuttleError, type Ctx } from "./ctx";
import type { PrRow } from "./db/store";
import { prKey } from "./keys";
import { linkKey, parseGitLink, type LinkTarget } from "./links";
import { toView } from "./views";

const FETCHED_MS = 60_000;
const MAX_FETCHED = 200;

interface Reader {
  /** The PR's conversation and details, from the 30-second cache or its server. */
  read(key: string): Promise<{ items: ConversationItem[]; details: PrDetails | null; error: string | null }>;
  /** What the last read brought, without asking the server. */
  peek(key: string): { items: ConversationItem[]; details: PrDetails | null } | null;
}

const short = (sha: string) => sha.slice(0, 7);

function labelOf(target: LinkTarget): string {
  if (target.kind === "commit") return `${target.repo}@${short(target.sha)}`;
  if (target.kind === "check") return target.ref ? `${target.repo}#${target.ref.number}` : target.repo;
  if (target.kind === "issue") return `${target.repo}#${target.number}`;
  return `${target.repo}#${target.ref.number}`;
}

const TABS: Record<LinkTarget["kind"], LinkCard["tab"]> = { pr: "overview", comment: "conversation", review: "conversation", commit: "changes", check: "checks", issue: "overview" };
const PART_TABS: Record<Extract<LinkTarget, { kind: "pr" }>["part"], LinkCard["tab"]> = { overview: "overview", checks: "checks", files: "changes", commits: "changes" };
/** The PR view's tab closest to what the link shows: a PR's Checks page opens Checks. */
const tabOf = (target: LinkTarget): LinkCard["tab"] => (target.kind === "pr" ? PART_TABS[target.part] : TABS[target.kind]);
/** An agent's reported fix names a real commit: an abbreviated or full hex sha. */
const SHA = /^[0-9a-f]{7,40}$/iu;

export class LinkCards {
  private readonly fetched = new Map<string, { at: number; value: CommitInfo | CheckInfo | IssueInfo | Error }>();

  constructor(private readonly ctx: Ctx, private readonly conversations: Reader) {}

  private target(url: string): LinkTarget {
    const target = parseGitLink(url, this.ctx.config().servers);
    if (!target) throw new ShuttleError("none of Shuttle's servers has that link");
    return target;
  }

  /** Each link's kind and its PR's or issue's state, from Shuttle's copy and the cards it already read; no server is asked. */
  states(urls: readonly string[]): { url: string; kind: LinkCard["kind"] | null; state: (typeof LINK_STATES)[number] | null }[] {
    const servers = this.ctx.config().servers;
    return urls.map((url) => {
      const target = parseGitLink(url, servers);
      if (!target) return { url, kind: null, state: null };
      if (target.kind === "issue") {
        const asPr = this.issuePr(target);
        if (asPr) return { url, kind: "pr", state: asPr.state };
        const read = this.fetched.get(linkKey(target))?.value;
        return { url, kind: "issue", state: read !== undefined && !(read instanceof Error) && "comments" in read && !read.pr ? read.state : null };
      }
      const row = target.ref ? this.ctx.store.prByKey(prKey(target.ref)) : this.byHead(target);
      return { url, kind: target.kind, state: row?.state ?? null };
    });
  }

  /** An issue link whose number is a PR Shuttle has: GitHub opens /issues/N on the PR. */
  private issuePr(target: Extract<LinkTarget, { kind: "issue" }>): PrRow | null {
    return this.ctx.store.prByKey(prKey({ server: target.server, repo: target.repo, number: target.number }));
  }

  /** A commit's or check's PR when the link does not say: the PR whose head it is. */
  private byHead(target: LinkTarget): PrRow | null {
    return target.kind === "commit" ? this.ctx.store.prByHead(target.server, target.repo, target.sha) : null;
  }

  private async fetchOnce<T extends CommitInfo | CheckInfo | IssueInfo>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = this.fetched.get(key);
    if (hit && this.ctx.now() - hit.at < FETCHED_MS) {
      if (hit.value instanceof Error) throw hit.value;
      return hit.value as T;
    }
    try {
      const value = await read();
      this.remember(key, value);
      return value;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.remember(key, failure);
      throw failure;
    }
  }

  private remember(key: string, value: CommitInfo | CheckInfo | IssueInfo | Error): void {
    this.fetched.delete(key);
    if (this.fetched.size >= MAX_FETCHED) this.fetched.delete(this.fetched.keys().next().value!);
    this.fetched.set(key, { at: this.ctx.now(), value });
  }

  async card(url: string): Promise<LinkCard> {
    const target = this.target(url);
    const server = this.ctx.server(target.server);
    const serverName = server?.name ?? target.server;
    const card: LinkCard = {
      kind: target.kind, label: labelOf(target), server: target.server, serverName, pr: null, prKey: target.ref ? prKey(target.ref) : null, tab: tabOf(target),
      comment: null, review: null, commit: null, check: null, issue: null, note: null,
    };
    let row = target.ref ? this.ctx.store.prByKey(prKey(target.ref)) : this.byHead(target);
    const view = () => (row ? toView(this.ctx, row) : null);
    const unseen = () => `Shuttle hasn't seen ${card.prKey === null ? "this PR" : card.label} yet.`;
    switch (target.kind) {
      case "issue": return this.issueCard(card, target);
      case "pr":
        card.pr = view();
        if (card.pr === null) card.note = unseen();
        return card;
      case "comment":
      case "review": {
        card.pr = view();
        if (row === null) return { ...card, note: `${unseen()} Look it up to read the ${target.kind}.` };
        const read = await this.conversations.read(row.key);
        const item = read.items.find((entry) => entry.url !== null && entry.url.endsWith(`#${target.anchor}`) && (target.kind === "review" ? entry.kind === "review" : entry.kind !== "review"));
        if (!item) return { ...card, note: read.error ?? `That ${target.kind} is not on ${card.label} any more, or ${serverName} did not send it.` };
        if (target.kind === "comment") {
          const thread = item.thread === null ? [item] : read.items.filter((entry) => entry.thread === item.thread);
          const first = [...thread].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))[0]!;
          card.comment = { item: { ...item, hunk: item.hunk ?? first.hunk }, replies: thread.length - 1, resolved: item.resolved };
        } else {
          const lines = read.items.filter((entry) => entry.kind === "thread" && item.review !== null && entry.review === item.review);
          card.review = { item, comments: lines.length, open: new Set(lines.filter((entry) => !entry.resolved).map((entry) => entry.thread ?? entry.id)).size };
        }
        return card;
      }
      case "commit": return this.commitCard(card, target, row, view);
      case "check": {
        const adapter = this.ctx.adapter(target.server);
        let info: CheckInfo | null = null;
        if (adapter.checkRun) {
          try {
            info = await this.fetchOnce(linkKey(target), () => adapter.checkRun!(target.repo, { checkRun: target.checkRun, run: target.run }));
          } catch (error) {
            card.note = `Could not read the check from ${serverName}: ${errText(error)}`;
          }
        }
        if (row === null && info !== null) {
          const number = info.prs[0];
          row = number !== undefined ? this.ctx.store.prByKey(prKey({ server: target.server, repo: target.repo, number })) : info.head === null ? null : this.ctx.store.prByHead(target.server, target.repo, info.head);
          if (row) card.label = `${row.repo}#${row.number}`;
        }
        card.pr = view();
        card.prKey ??= row?.key ?? null;
        // What the PR's view last read says the server alone does not: Required, and what the agent got.
        const known = row ? this.conversations.peek(row.key) : null;
        const runs = known?.details?.checks?.items ?? [];
        // The same URL is the same check; a name alone can belong to several, such as one job in two workflows.
        const byUrl = (want: string | null) => (want === null ? undefined : runs.find((run) => run.url === want));
        const match = info !== null
          ? byUrl(info.run.url) ?? (runs.filter((run) => run.name === info.run.name).length === 1 ? runs.find((run) => run.name === info.run.name) : undefined)
          : runs.find((run) => run.url !== null && run.url.startsWith(url.split("?")[0]!));
        const base = info?.run ?? match ?? null;
        if (base === null) {
          card.note ??= `${serverName} cannot be asked about check runs here.`;
          return card;
        }
        const itemId = match?.itemId ?? base.itemId;
        const item = itemId === null ? undefined : known?.items.find((entry) => entry.id === itemId);
        card.check = { ...base, required: match?.required ?? base.required, itemId, delivery: item?.delivery ?? null };
        // The header names the PR; the check's own name is in the card.
        card.label = row ? `${row.repo}#${row.number}` : base.name;
        return card;
      }
    }
  }

  private async issueCard(card: LinkCard, target: Extract<LinkTarget, { kind: "issue" }>): Promise<LinkCard> {
    const ref = { server: target.server, repo: target.repo, number: target.number };
    const asPr = (): LinkCard => ({ ...card, kind: "pr", prKey: prKey(ref) });
    const known = this.issuePr(target);
    if (known) return { ...asPr(), pr: toView(this.ctx, known) };
    const adapter = this.ctx.adapter(target.server);
    if (!adapter.issue) return { ...card, note: `${card.serverName} cannot be asked about issues here.` };
    let info: IssueInfo;
    try {
      info = await this.fetchOnce(linkKey(target), () => adapter.issue!(target.repo, target.number));
    } catch (error) {
      return { ...card, note: `Could not read the issue from ${card.serverName}: ${errText(error)}` };
    }
    if (info.pr) return { ...asPr(), note: `Shuttle hasn't seen ${card.label} yet.` };
    const closedBy = info.closedBy.map((pr) => {
      const row = this.ctx.store.prByKey(prKey({ server: target.server, repo: pr.repo, number: pr.number }));
      return { repo: pr.repo, number: pr.number, title: row?.title ?? pr.title, state: row?.state ?? pr.state, url: pr.url, key: row?.key ?? null };
    });
    const { pr: _pr, url: _url, ...shown } = info;
    return { ...card, issue: { ...shown, closedBy } };
  }

  private async commitCard(card: LinkCard, target: Extract<LinkTarget, { kind: "commit" }>, start: PrRow | null, view: () => ReturnType<typeof toView> | null): Promise<LinkCard> {
    let row = start;
    const serverName = card.serverName;
    const fromPr = row ? (await this.conversations.read(row.key)).details?.commits?.items.find((commit) => commit.sha.startsWith(target.sha) || target.sha.startsWith(commit.sha)) ?? null : null;
    let info: CommitInfo | null = null;
    const adapter = this.ctx.adapter(target.server);
    if (adapter.commit && (fromPr === null || row === null)) {
      try {
        info = await this.fetchOnce(linkKey(target), () => adapter.commit!(target.repo, target.sha));
      } catch (error) {
        card.note = `Could not read the commit from ${serverName}: ${errText(error)}`;
      }
    }
    if (row === null && info !== null && info.prs[0] !== undefined) row = this.ctx.store.prByKey(prKey({ server: target.server, repo: target.repo, number: info.prs[0] }));
    card.prKey ??= row?.key ?? (info?.prs[0] !== undefined ? prKey({ server: target.server, repo: target.repo, number: info.prs[0] }) : null);
    const pr = row ? toView(this.ctx, row) : view();
    card.pr = pr;
    const sha = info?.sha ?? fromPr?.sha ?? target.sha;
    if (info === null && fromPr === null) {
      card.note ??= row ? `${short(target.sha)} is not one of the last commits ${serverName} listed for ${row.repo}#${row.number}.` : `Shuttle has no PR with ${short(target.sha)}, and ${serverName} cannot be asked about commits here.`;
      return card;
    }
    const items = row ? this.conversations.peek(row.key)?.items ?? [] : [];
    const outcomes = row ? this.ctx.store.outcomes(row.id) : new Map();
    const fixes = items.flatMap((item) => {
      const outcome = outcomes.get(item.id);
      const commit = outcome?.commit_sha ?? null;
      return outcome?.outcome === "fixed" && commit !== null && SHA.test(commit) && (commit.startsWith(short(sha)) || sha.startsWith(commit)) ? [{ author: item.author, path: item.path, line: item.line, body: item.body }] : [];
    });
    card.commit = {
      sha,
      message: info?.message ?? fromPr?.message ?? "",
      author: info?.author ?? fromPr?.author ?? null,
      at: info?.at ?? fromPr?.at ?? null,
      additions: info?.additions ?? null,
      deletions: info?.deletions ?? null,
      checks: info?.checks ?? (pr !== null && pr.head !== null && pr.head.startsWith(short(sha)) ? pr.checks : null),
      head: pr !== null && pr.head !== null && (pr.head.startsWith(short(sha)) || sha.startsWith(pr.head)),
      fixes,
    };
    card.label = `${target.repo}@${short(sha)}`;
    return card;
  }
}
