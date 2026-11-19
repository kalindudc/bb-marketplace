import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Brief } from "../../shared/schema";
import type { ThreadDecor } from "../../shared/contract";
import { ExpandsMark } from "../kit/glyphs";
import { MemberIdentity } from "../kit/member-identity";
import { PlacementFacts } from "../kit/placement";
import { memberName } from "../../shared/member-name";
import { plural } from "../kit/primitives";
import { Prose, reportBlocks } from "../kit/report-view";
import type { Registry } from "../kit/registry";
import { motion } from "../kit/motion";
import type { useTavernMotion } from "../kit/motion";
type MemberCue = ReturnType<typeof useTavernMotion>["cue"];
import { claimMemberUnderline, memberVisit, recordMemberVisit, rememberMemberNew, setMemberFold, useMemberFold } from "./state";
import "./member-brief.css";

export function memberFinished(data: ThreadDecor) {
  return data.boardQuest?.phase === "done" || data.boardQuest?.phase === "stopped" || !!data.member && ["done", "stopped", "failed"].includes(data.member.state);
}

function summary(text: string) {
  const plain = text.replace(/`([^`]+)`/g, "$1").trim().replace(/^(?:\d+[.)]|[-*•])\s+/, "").replace(/\s+/g, " ");
  const sentence = plain.match(/^.{19,}?[.!?](?=\s|$)/)?.[0] ?? plain;
  if (sentence.length <= 160) return sentence;
  const cut = sentence.slice(0, 159), space = cut.lastIndexOf(" ");
  return `${space < 0 ? "" : cut.slice(0, space)}…`;
}

function contextParts(context: string[]) {
  const notes: string[] = [], followUps: { version: number; text: string }[] = [];
  for (const line of context) {
    if (!line.trim()) continue;
    const match = line.match(/^Follow-up v(\d+):\s*([\s\S]*)$/);
    if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0) followUps.push({ version: Number(match[1]), text: match[2]!.trim() });
    else notes.push(line);
  }
  return { notes, followUps: followUps.sort((a, b) => b.version - a.version) };
}

function BriefText({ text, className = "" }: { text: string; className?: string }) {
  const groups: { bullets: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*[-*•]\s+(.+)$/);
    const bullets = !!match, value = match ? match[1]! : line;
    const last = groups.at(-1);
    if (last && last.bullets === bullets) last.lines.push(value);
    else groups.push({ bullets, lines: [value] });
  }
  return <div className={`tw-prose ${className}`} data-content>{groups.map((group, i) => group.bullets
    ? <ul key={i}>{group.lines.map((line, j) => <li key={j}><Prose text={line} /></li>)}</ul>
    : reportBlocks(group.lines.join("\n")).map((block, j) => block.kind === "list" ? <ol key={`${i}-${j}`}>{block.items.map((item, k) => <li key={k}><Prose text={item} /></li>)}</ol> : block.kind === "code" ? <pre key={`${i}-${j}`}><code>{block.text}</code></pre> : <p key={`${i}-${j}`}><Prose text={block.text} /></p>))}</div>;
}

function MemberFold({ threadId, section, label, count, children, preview, heading, cue }: { threadId: string; section: string; label: string; count?: number; children: ReactNode; preview?: ReactNode; heading?: ReactNode; cue?: MemberCue }) {
  const [open, setOpen] = useMemberFold(threadId, section);
  const [moving, setMoving] = useState(false);
  const body = useRef<HTMLDivElement>(null), pending = useRef(false), height = useRef(0);
  useLayoutEffect(() => { const el = body.current; return () => { motion.settle(c => c.el === el); }; }, [cue]);
  useLayoutEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    const el = body.current;
    if (!cue || !el || typeof el.animate !== "function") { setMoving(false); return; }
    cue(el, "member fold", { key: `member-${section}-${open}`, ms: 160, region: "widget", yields: true, restMs: 0,
      run: target => [target.animate([{ height: `${height.current}px`, opacity: open ? 0 : 1 }, { height: `${open ? target.scrollHeight : 0}px`, opacity: open ? 1 : 0 }], { duration: 160, easing: "ease-out" })],
      onDone: () => setMoving(false) });
  }, [open, cue]);
  const toggle = () => { height.current = body.current?.getBoundingClientRect().height ?? 0; motion.settle(c => c.el === body.current); pending.current = true; setMoving(true); setOpen(!open); };
  const id = `member-${threadId}-${section}`;
  return <section className={`tw-member-fold ${open ? "open" : ""}`}>
    <h4><button type="button" id={`${id}-h`} className="tw-fold-trigger act" aria-label={count === undefined ? label : `${label}, ${count}`} aria-expanded={open} aria-controls={id} onClick={toggle}>{heading ?? <span className="lbl">{label}</span>}{count !== undefined && <>{" "}<span className="num">{count}</span></>}<ExpandsMark open={open} /></button></h4>
    {preview}
    <div ref={body} id={id} className="tw-fold-body" hidden={!open && !moving}>{(open || moving) && children}</div>
  </section>;
}

function FollowUp({ row, threadId, isNew, cue, manual }: { row: { version: number; text: string }; threadId: string; isNew: boolean; cue?: MemberCue; manual: boolean }) {
  const [chalk, setChalk] = useState(isNew && manual);
  const path = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    const el = path.current;
    if (!isNew || !manual || !claimMemberUnderline(threadId, row.version) || !cue || !el || typeof el.animate !== "function") { setChalk(false); return; }
    cue(el, "member follow-up", { key: `member-followup-${row.version}`, ms: 180, region: "widget", yields: true,
      run: target => [target.animate([{ strokeDashoffset: 100, opacity: 0 }, { strokeDashoffset: 0, opacity: 1 }], { duration: 180, easing: "ease-out" })],
      onDone: () => setChalk(false) });
    return () => { motion.settle(c => c.el === el); };
  }, [isNew, manual, cue, threadId, row.version]);
  return <div className="tw-follow-up" data-follow-up={row.version}><MemberFold threadId={threadId} cue={cue} section={`followup-${row.version}`} label={`Follow-up v${row.version}. ${summary(row.text)}${isNew ? " New." : ""}`} heading={<><span className="tw-follow-up-meta"><span className="lbl">Follow-up</span><span className="tag tw-follow-up-version">v{row.version}</span></span><span className="tw-follow-up-summary" data-content><Prose text={summary(row.text)} />{chalk && <svg className="tally tw-follow-up-chalk" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><path ref={path} pathLength={100} d="M1 2.5 Q24 1.5 50 2.2 T99 1.6" /></svg>}</span>{isNew && <span className="tag tw-member-new">new</span>}</>}><BriefText text={row.text} /></MemberFold></div>;
}

export function MemberBrief({ brief, classId, threadId = "member", waypoint, onQuest, scopeDetails, scopeAlerts, cue }: { brief: Brief; classId: string; threadId?: string; waypoint?: string; onQuest?: () => void; scopeDetails?: ReactNode; scopeAlerts?: number; cue?: MemberCue }) {
  const { notes, followUps } = contextParts(brief.context);
  const questions = classId === "ranger" ? brief.questions.filter(text => text.trim()) : [];
  const visit = useRef(memberVisit(threadId));
  const newest = followUps[0]?.version ?? 0;
  const baseline = useRef(visit.current.seen ?? newest);
  const newVersions = followUps.filter(row => row.version > baseline.current || !visit.current.manual && visit.current.newVersions.includes(row.version)).map(row => row.version);
  useEffect(() => { recordMemberVisit(threadId, newest); }, [threadId]);
  const newKey = newVersions.join(",");
  useEffect(() => { rememberMemberNew(threadId, newVersions); }, [threadId, newKey]);
  const counts = [notes.length ? plural(notes.length, "context note") : null, followUps.length ? plural(followUps.length, "follow-up") : null, brief.timeboxMinutes !== null ? `time box ${brief.timeboxMinutes} min` : null].filter(Boolean);
  const followUp = (row: typeof followUps[number]) => <FollowUp key={row.version} row={row} threadId={threadId} isNew={newVersions.includes(row.version)} cue={cue} manual={visit.current.manual} />;
  return <div className="tw-brief-fields">
    <section className="tw-glance" role="region" aria-label="At a glance"><header><h4>At a glance</h4><span className="tag">{brief.mode === "make-it-work" ? "Make it work" : "Make it better"}</span></header>
      {waypoint && <button type="button" className="lnk-btn tw-glance-waypoint" aria-label={`Open the quest page at ${waypoint.toLowerCase()}`} onClick={onQuest}>{waypoint}</button>}
      <dl><dt className="lbl">Outcome</dt><dd data-summary="outcome" data-content><Prose text={summary(brief.outcome)} /></dd>
      {brief.doneWhen.trim() && <><dt className="lbl">Done when</dt><dd data-summary="done-when" data-content><Prose text={summary(brief.doneWhen)} /></dd></>}</dl>
      {counts.length > 0 && <p className="tw-glance-counts"><span>{counts.join(" · ")}</span></p>}
    </section>
    {brief.outcome.trim() && <MemberFold threadId={threadId} cue={cue} section="outcome" label="Outcome"><BriefText text={brief.outcome} className="tw-brief-outcome" /></MemberFold>}
    {brief.doneWhen.trim() && <MemberFold threadId={threadId} cue={cue} section="done-when" label="Done when"><BriefText text={brief.doneWhen} /></MemberFold>}
    {brief.outOfScope.trim() && <MemberFold threadId={threadId} cue={cue} section="out-of-scope" label="Out of scope"><BriefText text={brief.outOfScope} /></MemberFold>}
    {notes.length > 0 && <MemberFold threadId={threadId} cue={cue} section="context" label="Context" count={notes.length}><ul className="tw-context-notes">{notes.map((text, i) => <li key={i}><BriefText text={text} /></li>)}</ul></MemberFold>}
    {followUps.length > 0 && <MemberFold threadId={threadId} cue={cue} section="follow-ups" label="Follow-ups" count={followUps.length} preview={followUp(followUps[0]!)}>{followUps.slice(1).map(followUp)}</MemberFold>}
    {questions.length > 0 && <MemberFold threadId={threadId} cue={cue} section="questions" label="Questions" count={questions.length}><ol>{questions.map((text, i) => <li key={i}><BriefText text={text} /></li>)}</ol></MemberFold>}
    {scopeDetails && <MemberFold threadId={threadId} cue={cue} section="scope" label="Scope and guardrails" count={scopeAlerts || undefined}>{scopeDetails}</MemberFold>}
  </div>;
}

export function MemberPanel({ data, registry, scopeDetails, onQuest, cue }: { data: ThreadDecor; registry: Registry | null; scopeDetails: ReactNode; onQuest: (id: string) => void; cue?: MemberCue }) {
  useEffect(() => { if (!data.briefFields) recordMemberVisit(data.threadId); }, [data.threadId, !!data.briefFields]);
  const member = data.member;
  if (!member) return null;
  const finished = memberFinished(data);
  const waypointId = member.checkerWaypointId ?? member.waypointId;
  const waypoint = data.boardQuest && waypointId ? `Waypoint ${waypointId.replace(/^w/, "")}` : undefined;
  const alerts = (data.scope?.problems?.length ?? 0) + (data.violations?.length ?? 0) + (data.scope?.error ? 1 : 0) + (data.scope?.pendingAskId ? 1 : 0);
  return <div className="tw-member-panel">
    {registry && <MemberIdentity member={member} registry={registry} scope={data.scope} violations={data.violations} finished={finished} variant="chips" onScopeDetails={() => setMemberFold(data.threadId, "scope", true)} />}
    {!registry && <PlacementFacts placement={member.placement} memberName={memberName(member, { classes: [], characters: [] })} variant="card" />}
    {member.restNote && <p className="m small" data-content>{member.restNote}</p>}
    {data.briefFields ? <MemberBrief brief={data.briefFields} classId={member.classId} threadId={data.threadId} waypoint={waypoint} onQuest={data.boardQuest ? () => onQuest(data.boardQuest!.id) : undefined} scopeDetails={scopeDetails} scopeAlerts={alerts} cue={cue} /> : <div className="tw-brief-fields">{data.brief && <p data-content><Prose text={data.brief} /></p>}<MemberFold threadId={data.threadId} cue={cue} section="scope" label="Scope and guardrails" count={alerts || undefined}>{scopeDetails}</MemberFold></div>}
    {(data.briefFields || data.brief) && <p className="m small tw-brief-note">{finished ? "This brief records the assignment and its guardrails." : "Messages you send here reach this member now and its Keeper in the next tick."}</p>}
  </div>;
}
