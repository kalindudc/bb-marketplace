import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import type { BoardQuestDetail } from "../../shared/contract";
import { extractReportHeadline, nameReportIds, type ReportHeadlineNames } from "../../shared/report-headline";
import { pullRequestLine, type PullRequest } from "../../shared/pull-request";
import type { Evidence, Member, Report } from "../../shared/schema";
import { Glyph, OpensMark } from "./glyphs";
import { CheckIndependence, Clamp, EvidenceList, StatusPill, clockTime, plural, summaryNames, useToday } from "./primitives";
import { voiceShown, type Registry } from "./registry";
import { CrestOf, characterName } from "./rows";
import { MemberEstimate } from "./member-estimate";
import "./report-view.css";

export type ReportBlock = { kind: "p"; text: string } | { kind: "list"; items: string[] } | { kind: "code"; text: string };

/**
 * A raw report as reading blocks: paragraphs stay paragraphs; "(1) … (2) …" inside one, or lines starting "1)" or "1.", become a
 * list (one list across paragraphs while the numbering continues); a trailing "Command used: …" becomes a code block.
 */
export function reportBlocks(outcome: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  let text = outcome.trim();
  let command: string | null = null;
  const cmd = text.match(/\s*Command(?:s)? used:\s*([\s\S]+)$/i);
  if (cmd && cmd.index !== undefined) { command = cmd[1]!.trim(); text = text.slice(0, cmd.index).trim(); }
  let list: string[] | null = null;
  const flush = () => { if (list?.length) blocks.push({ kind: "list", items: list }); list = null; };
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    const parts = para.split(/\s\((\d{1,2})\)\s/);
    const numbers = parts.filter((_, i) => i % 2 === 1).map(Number);
    if (numbers.length >= 2 && numbers.every((n, i) => n === i + 1)) {
      flush();
      if (parts[0]!.trim()) blocks.push({ kind: "p", text: parts[0]!.trim() });
      blocks.push({ kind: "list", items: parts.filter((_, i) => i > 0 && i % 2 === 0).map((s) => s.trim()) });
      continue;
    }
    const lines = para.split("\n").map((l) => l.match(/^\s*(\d{1,2})[.)]\s+([\s\S]*)$/));
    if (lines.every((m) => m !== null)) { for (const m of lines) (list ??= []).push(m![2]!.trim()); continue; }
    flush();
    blocks.push({ kind: "p", text: para.replace(/\s*\n\s*/g, " ") });
  }
  flush();
  if (command) blocks.push({ kind: "code", text: command });
  return blocks;
}

/** Inline code inside report text: `backticked` spans and absolute paths. */
export function inlineCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`|(?<![\w/])(\/(?:[\w.@-]+\/)*[\w.@-]+)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1] ?? m[2]! });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

export function Prose({ text }: { text: string }) {
  return <>{inlineCode(text).map((part, i) => part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>)}</>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Agent text with every id named (Ted's nameReportIds); an id nobody can name becomes "another thread", "another quest" or
 * "a waypoint", so no raw id reaches a person. Ids inside a path are part of the path and stay.
 */
export function readable(text: string, names: ReportHeadlineNames = {}): string {
  const { text: named, unresolved } = nameReportIds(text, names);
  return unresolved.reduce((out, id) => {
    const word = /^thr_/i.test(id) ? "another thread" : /^quest_/i.test(id) ? "another quest" : null;
    return word
      ? out.replace(new RegExp(`(?<![\\w/-])${escape(id)}(?![\\w/-])`, "g"), word)
      : out.replace(new RegExp(`\\bwaypoint\\s+${escape(id)}(?![\\w/-])`, "gi"), "a waypoint");
  }, named);
}

const KIND_ORDER: Record<string, number> = { command: 0, file: 1, pr: 2, url: 3, query: 4, note: 5 };
/** Evidence grouped by kind (commands first, then files, links and notes), with its detail lines and notes named; commands, files and links stay verbatim. */
export function readableEvidence(evidence: readonly Evidence[], names: ReportHeadlineNames = {}): Evidence[] {
  return evidence.map((e, i) => ({ e, i })).sort((a, b) => (KIND_ORDER[a.e.kind] ?? 9) - (KIND_ORDER[b.e.kind] ?? 9) || a.i - b.i)
    .map(({ e }) => ({ ...e, ref: e.kind === "note" ? readable(e.ref, names) : e.ref, detail: e.detail ? readable(e.detail, names) : e.detail }));
}

/**
 * One member report as a person reads it, with no card or panel around it: the headline, the outcome as readable text, the
 * evidence by kind with long output folded, confidence, the Warden's independence words and the voice line last.
 * `compact` is the chat card's form: the headline, two lines of outcome and the evidence as a count beside "View report".
 * `member` supplies the independence label, which the report itself does not carry.
 */
/** `voice` is `voiceShown(registry)` at the caller: with Character voice off, the report's voice line isn't drawn. */
export function ReportView({ report, names = {}, compact = false, member, onView, voice = true, pullRequests = member?.pullRequests ?? [] }: { report: Report; names?: ReportHeadlineNames; compact?: boolean; pullRequests?: PullRequest[]; member?: Pick<Member, "checkIndependence"> & { pullRequests?: PullRequest[] }; onView?: () => void; voice?: boolean }) {
  const headline = extractReportHeadline(report, names);
  let outcome = readable(report.outcome, names);
  // A headline taken from the outcome is its first sentence: the body starts after it rather than repeating it.
  if (headline && !report.headline?.trim() && !headline.includes("\n") && !/\bCommands? used:/i.test(headline)) {
    const at = outcome.indexOf(headline);
    if (at >= 0 && at < 80) outcome = outcome.slice(at + headline.length).trim();
  }
  const evidence = readableEvidence(report.evidence, names);
  const prs = pullRequests.filter(pr => pr.memberThreadId === report.memberThreadId || pr.owner === report.memberThreadId).map(pr => <p key={pr.id} className="rv-p" data-content><a href={pr.url} target="_blank" rel="noreferrer">{pullRequestLine(pr)}</a></p>);
  if (compact) return <div className={`rv compact r-${report.status}`}>
    {headline && <Clamp text={headline} lines={2} className="rv-lead" />}
    {outcome && <Clamp text={outcome} lines={2} className="rv-out" />}
    {prs}
    {(evidence.length > 0 || onView) && <p className="rv-foot">{evidence.length > 0 && <span className="m">{plural(evidence.length, "piece")} of evidence</span>}{onView && <button type="button" className="lnk-btn act" onClick={onView}><span>View report</span><OpensMark /></button>}</p>}
  </div>;
  return <div className={`rv r-${report.status}`} data-tavern-report="">
    {headline && <p className="rv-lead" data-content>{headline}</p>}
    {reportBlocks(outcome).map((block, i) => block.kind === "code"
      ? <pre key={i} className="rv-code" data-content><code>{block.text}</code></pre>
      : block.kind === "list"
        ? <ol key={i} className="rv-list" data-content>{block.items.map((item, j) => <li key={j}><Prose text={item} /></li>)}</ol>
        : <p key={i} className="rv-p" data-content><Prose text={block.text} /></p>)}
    {prs}
    {report.checkpoint && <div className="rv-sec"><h4 className="rv-h">What is left</h4><p className="rv-p" data-content><Prose text={readable(report.checkpoint.left, names)} /></p><p className="rv-p">Estimated time: {plural(report.checkpoint.moreMinutes, "minute")}</p></div>}
    {evidence.length > 0 && <div className="rv-sec"><h4 className="rv-h">Evidence</h4><EvidenceList evidence={evidence} fold /></div>}
    {report.artifacts.length > 0 && <div className="rv-sec"><h4 className="rv-h">Artifacts</h4><EvidenceList evidence={report.artifacts.map((ref) => ({ kind: /^https?:\/\//i.test(ref) ? "url" : "file", ref, detail: "", exitCode: null }))} /></div>}
    <MemberEstimate confidence={report.confidence} />
    {member && <CheckIndependence member={member} />}
    {voice && report.voice && <p className="rv-voice" data-content>{report.voice}</p>}
  </div>;
}

const STATUS_WORD: Record<Report["status"], string> = { done: "done", "needs-decision": "needs a decision", blocked: "blocked", checkpoint: "checkpoint" };
const when = (at: number, now: number) => new Date(at).toDateString() === new Date(now).toDateString() ? clockTime(at) : `${new Date(at).toLocaleDateString([], { day: "numeric", month: "short" })} ${clockTime(at)}`;

/** Names for one member's reports: the party, the quest and its waypoints (summaryNames), the quest's Keeper as "the Keeper" when nothing names it better, and each report by who filed it. */
export function memberReportNames(detail: BoardQuestDetail, member: Pick<Member, "threadId">, registry: Registry): ReportHeadlineNames {
  const names = summaryNames(member, detail.quest.members, registry, [detail.quest], detail.reports);
  const threadNames = new Map(names.threadNames);
  if (!threadNames.has(detail.quest.keeperThreadId)) threadNames.set(detail.quest.keeperThreadId, "the Keeper");
  return { ...names, threadNames };
}

/**
 * Every report one member filed on one quest, newest first, each a full ReportView under its status, waypoint and time; a jump
 * list from three reports. It starts with who and which quest, because the side panel is a sheet on phones. No panel chrome: the
 * page's tab and a thread's tab each draw their own and own the scroll. `reportId` scrolls to that report once.
 */
export function MemberReports({ detail, member, registry, reportId }: { detail: BoardQuestDetail; member: Member; registry: Registry; reportId?: string }) {
  const navigate = useBbNavigate();
  const root = useRef<HTMLDivElement>(null);
  const day = useToday();
  const quest = detail.quest;
  const reports = detail.reports.filter((r) => r.memberThreadId === member.threadId).sort((a, b) => b.createdAt - a.createdAt);
  const names = memberReportNames(detail, member, registry);
  const credit = detail.memberCredits?.find((c) => c.memberThreadId === member.threadId);
  const title = (id: string) => quest.waypoints.find((w) => w.id === id)?.title ?? "a waypoint";
  const did = [...(credit?.madeWaypointIds ?? []).map((id) => `made ${title(id)}`), ...(credit?.verifiedWaypointIds ?? []).map((id) => `verified ${title(id)}`)];
  const cls = registry.classes.find((c) => c.id === member.classId);
  const name = characterName(registry, member);
  // From the index, focus moves to the report's header first (without scrolling), then one scroll brings it up, so the next
  // Tab continues inside that report rather than from the index far above it.
  const jump = (id: string, focus = false) => {
    const section = [...root.current?.querySelectorAll<HTMLElement>("[data-report]") ?? []].find((el) => el.dataset.report === id);
    if (!section) return;
    if (focus) {
      const head = section.querySelector<HTMLElement>(".rv-rep-h") ?? section;
      if (!head.hasAttribute("tabindex")) head.setAttribute("tabindex", "-1");
      head.focus({ preventScroll: true });
    }
    section.scrollIntoView?.({ block: "start" });
  };
  // Back from a report to its own entry in the index, so a keyboard user who jumped in has a next stop and a way out.
  const back = (id: string) => {
    const entry = [...root.current?.querySelectorAll<HTMLElement>("[data-jump]") ?? []].find((el) => el.dataset.jump === id);
    entry?.focus({ preventScroll: true });
    entry?.scrollIntoView?.({ block: "nearest" });
  };
  useEffect(() => { if (reportId) jump(reportId); }, [reportId]);
  return <div ref={root} className="rv-reps">
    <header className="rv-reps-h">
      <CrestOf member={member} registry={registry} size={28} />
      <div className="rv-reps-who">
        <b>{name}</b>
        <span className="m">{cls ? <>{cls.label} <span className="anc">{cls.plain}</span></> : member.classId} · {quest.short || quest.title}</span>
        {did.length > 0 && <span className="rv-reps-did" data-content>{did.join(" · ")}</span>}
      </div>
      <button type="button" className="lnk-btn act" title={`Open ${name}’s thread`} onClick={() => navigate.toThread(member.threadId)}><span>Open thread</span><OpensMark /></button>
    </header>
    {reports.length >= 3 && <nav className="rv-reps-jump" aria-label={`${name}’s reports`}>{reports.map((r) => { const hl = extractReportHeadline(r, names) ?? readable(r.outcome, names).replace(/\s+/g, " ").slice(0, 120).trim(); const label = `${when(r.createdAt, day)} · ${STATUS_WORD[r.status]}${hl ? ` · ${hl}` : ""}`; return <button key={r.id} type="button" className="lnk-btn act" data-jump={r.id} onClick={() => jump(r.id, true)} title={label}><span>{label}</span></button>; })}</nav>}
    {reports.map((r) => <section key={r.id} data-report={r.id} className="rv-rep" aria-label={`Report, ${STATUS_WORD[r.status]}`}>
      <header className="rv-rep-h"><StatusPill status={r.status}>{STATUS_WORD[r.status]}</StatusPill>{r.waypointId && <span className="m" data-content>{title(r.waypointId)}</span>}<time className="num" dateTime={new Date(r.createdAt).toISOString()} title={new Date(r.createdAt).toLocaleString()}>{when(r.createdAt, day)}</time></header>
      <ReportView report={r} names={names} member={member} voice={voiceShown(registry)} />
      {reports.length >= 3 && <button type="button" className="lnk-btn act rv-rep-back" title={`Back to ${name}’s list of reports`} onClick={() => back(r.id)}><Glyph name="up" size={12} /><span>Back to the list</span></button>}
    </section>)}
    {!reports.length && <p className="rv-none">{name} filed no report on this quest.</p>}
  </div>;
}
