import { createHash } from "node:crypto";
import type { ReferenceRecord, ReferenceInput, ReferenceLogOptions } from "./contract";
import { NotFoundError, ShuttleError, type Ctx } from "./ctx";
import { linkFor, parseKey, resolveQuery } from "./keys";
import { parseGitLink } from "./links";

const FEEDBACK_STATES = ["flagged", "corrected", "suppressed", "confirmed", "dismissed"];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

import { referenceNumbers } from "./reference-tokens";
export class References {
  constructor(private readonly ctx: Ctx) {}

  async resolve(input: ReferenceInput): Promise<ReferenceRecord[]> {
    const mentions = referenceNumbers(input.text).slice(0, 100);
    const numbers = [...new Map(mentions.map((r) => [r.number, r])).values()].slice(0, 50);
    if (numbers.length === 0) return [];
    const servers = this.ctx.config().servers.filter((server) => server.enabled);
    const urls = [...input.urls, ...[...input.text.matchAll(/https?:\/\/[^\s)]+/gu)].map((m) => m[0])];
    const distinct = (values: string[]): string[] => {
      const found = new Map<string, string>();
      for (const url of values) {
        const target = parseGitLink(url, servers);
        if (!target || (target.kind !== "pr" && target.kind !== "issue")) continue;
        const number = target.kind === "issue" ? target.number : target.ref.number;
        const id = JSON.stringify([target.kind, target.server, target.repo, number]);
        if (target.kind === "pr") found.set(id, linkFor(servers.find((s) => s.id === target.server)!, target.repo, number));
        else {
          const canonical = new URL(url);
          canonical.hash = ""; canonical.search = "";
          canonical.pathname = canonical.pathname.replace(/\/+$/u, "");
          const previous = found.get(id);
          if (!previous || (canonical.protocol === "https:" && !previous.startsWith("https:")) || (canonical.protocol === new URL(previous).protocol && canonical.href < previous)) found.set(id, canonical.href);
        }
      }
      return [...found.values()];
    };
    const targets = urls.flatMap((url) => {
      const target = parseGitLink(url, servers);
      return target && (target.kind === "pr" || target.kind === "issue") ? [{ target, url }] : [];
    });
    const thread = await this.ctx.port.getThread(input.threadId);
    if (!thread) throw new NotFoundError("The source thread no longer exists.");
    this.ctx.store.saveThread(thread.id, thread.title, thread.archived);
    const projects = await this.ctx.projects();
    const remote = projects.find((project) => project.id === thread.projectId)?.gitRemoteUrl;
    const contextIds = await this.ctx.port.referenceContext(input.threadId);
    const linked = contextIds.flatMap((id) => this.ctx.store.prsOfThread(id));
    const known = this.ctx.store.allPrs();
    const hash = digest(JSON.stringify([input.text, [...input.urls].sort()]));
    const out: ReferenceRecord[] = [];
    let changed = false;
    for (const reference of numbers) {
      const id = digest(JSON.stringify([input.threadId, input.messageId, reference.number]));
      const old = this.ctx.store.reference(id);
      const explicit = targets.filter(({ target }) => (target.kind === "issue" ? target.number : target.ref.number) === reference.number).map(({ url }) => url);
      const qualifiedMentions = mentions.filter((r) => r.number === reference.number && r.token.includes("/"));
      const qualified = qualifiedMentions.flatMap((mention) => {
        const key = parseKey(mention.token);
        const repo = mention.token.split("#")[0]!;
        const server = key ? servers.find((s) => s.id === key.server) : null;
        return key ? server ? [linkFor(server, key.repo, key.number)] : []
          : known.filter((p) => p.repo === repo && p.number === reference.number && servers.some((s) => s.id === p.server)).map((p) => p.url);
      });
      const exact = distinct([...explicit, ...qualified]);
      const links = distinct(linked.filter((p) => p.number === reference.number && servers.some((s) => s.id === p.server)).map((p) => p.url));
      const repoTargets = new Set(targets.map(({ target }) => `${target.server}:${target.repo}`));
      for (const mention of mentions.filter((r) => r.token.includes("/"))) {
        const key = parseKey(mention.token);
        repoTargets.add(key ? `${key.server}:${key.repo}` : `?:${mention.token.split("#")[0]}`);
      }
      const inProject = known.filter((p) => {
        const server = servers.find((s) => s.id === p.server);
        if (!server || !remote || p.number !== reference.number) return false;
        const scp = /^[^@]+@([^:]+):(.+)$/u.exec(remote);
        try {
          const url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
          const repoPath = url.pathname.replace(/^\/|\/$/gu, "").replace(/\.git$/u, "");
          const page = new URL(linkFor(server, p.repo, p.number));
          const sameServer = scp || url.protocol === "ssh:" ? url.hostname === page.hostname : url.protocol === page.protocol && url.host === page.host;
          return sameServer && repoPath.toLowerCase() === p.repo.toLowerCase();
        } catch { return false; }
      });
      const projectRepos = new Set(inProject.map((p) => `${p.server}:${p.repo}`));
      const mixed = [...repoTargets].some((r) => !projectRepos.has(r));
      const candidates = exact.length ? exact : qualifiedMentions.length ? [] : links.length ? links : mixed ? [] : inProject.map((p) => p.url);
      const unique = distinct(candidates);
      const ambiguous = unique.length > 1 || (!qualifiedMentions.length && !exact.length && !links.length && mixed);
      const automaticUrl = !ambiguous && unique.length === 1 ? unique[0]! : null;
      if (old?.hash === hash && old.record.automaticUrl === automaticUrl && FEEDBACK_STATES.includes(old.record.status) && (old.record.url === null || parseGitLink(old.record.url, servers))) {
        out.push(old.record);
        continue;
      }
      const needsReview = old && ((old.hash !== hash && FEEDBACK_STATES.includes(old.record.status)) || ((old.record.url !== null || FEEDBACK_STATES.includes(old.record.status)) && old.record.automaticUrl !== automaticUrl) || (old.record.url !== null && !parseGitLink(old.record.url, servers)));
      const record: ReferenceRecord = {
        id, threadId: input.threadId, messageId: input.messageId, number: reference.number,
        excerpt: input.text.slice(Math.max(0, reference.offset - 100), reference.offset + reference.token.length + 150),
        status: needsReview ? "flagged" : ambiguous ? "ambiguous" : automaticUrl ? "automatic" : "unresolved", url: needsReview ? null : automaticUrl, automaticUrl,
        reason: needsReview ? "The message or target context changed; review the previous resolution" : ambiguous ? "Conflicting repository context" : exact.length ? "Explicit reference in this message" : links.length ? "PR linked to the source thread" : automaticUrl ? "Known PR in this thread’s repository" : "No number-specific evidence or known PR in this repository",
        candidates: [...new Set([...unique, ...(ambiguous ? targets.map((t) => t.url) : [])])].slice(0, 20), at: old?.record.at ?? this.ctx.now(),
      };
      if (old?.hash !== hash || JSON.stringify(old.record) !== JSON.stringify(record)) {
        this.ctx.store.saveReference(record, hash);
        changed = true;
      }
      out.push(record);
    }
    if (changed) this.ctx.port.publish(["reference-log"]);
    return out;
  }

  feedback(id: string, action: "flag" | "correct" | "suppress" | "reset" | "confirm" | "dismiss", query: string | null): ReferenceRecord {
    const saved = this.ctx.store.reference(id);
    if (!saved) throw new NotFoundError("That reference is no longer in the log.");
    let url: string | null = action === "confirm" || action === "dismiss" ? saved.record.url : null;
    if (action === "confirm" && (!url || !parseGitLink(url, this.ctx.config().servers))) throw new ShuttleError("This reference has no target to mark correct.");
    if (action === "correct") {
      if (!query) throw new ShuttleError("Paste a PR key or a PR or issue URL.");
      let target = parseGitLink(query, this.ctx.config().servers);
      if (!target) {
        const ref = resolveQuery(query, this.ctx.config().servers);
        const server = this.ctx.server(ref.server);
        if (!server?.enabled) throw new ShuttleError("That server is disabled.");
        url = linkFor(server, ref.repo, ref.number);
        target = parseGitLink(url, this.ctx.config().servers);
      } else url = query.trim();
      if (!target || (target.kind !== "pr" && target.kind !== "issue")) throw new ShuttleError("Choose a PR or issue on an enabled Shuttle server.");
    }
    const record: ReferenceRecord = { ...saved.record, status: action === "confirm" ? "confirmed" : action === "dismiss" ? "dismissed" : action === "flag" ? "flagged" : action === "correct" ? "corrected" : action === "suppress" ? "suppressed" : saved.record.automaticUrl ? "automatic" : "unresolved", url: action === "reset" ? saved.record.automaticUrl : url };
    this.ctx.store.referenceFeedback(record, saved.hash, action, saved.record.url);
    this.ctx.port.publish(["references", "reference-log"]);
    return record;
  }

  read(id: string): ReferenceRecord {
    const record = this.ctx.store.reference(id)?.record;
    if (!record) throw new NotFoundError("That reference is no longer in the log.");
    return record;
  }

  log(limit: number, options: ReferenceLogOptions = {}) { return this.ctx.store.referenceLog(limit, options); }
}
