
import { useState } from "react";
import { type BoardQuestDetail } from "../../shared/contract";
import { resolutionWords, settled } from "../../shared/waypoint";
import type { Ask, Member, Report } from "../../shared/schema";
import { voiceShown, CheckIndependence, MemberIdentity, Glyph, levelFor, levelsShown, reachedInParty, reachedWords, EvidenceList, ExpandsMark, GuardPosture, MemberReports, OpensMark, memberReportNames } from "../kit";
import { CrestOf, characterName, classLabel, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { taleHeadline } from "./model";
import { usePanelState } from "./panel-state";

import { reportsTitle, useOpenReports, viewReportsLabel } from "./reports";
import "./finished.css";


type Credit = NonNullable<BoardQuestDetail["memberCredits"]>[number];

/** What a member did on this quest, from the server's credits: "made w1", "verified w2", or what its class does. */
function roleWords(member: Member, credit: Credit | undefined, registry: Registry, reports: Report[]) {
  const made = credit?.madeWaypointIds ?? [], verified = credit?.verifiedWaypointIds ?? [];
  if (made.length || verified.length) return { made, verified, plain: null };
  const cls = classLabel(registry, member.classId);
  return { made, verified, plain: cls?.plain === "scout" ? "scouted" : reports.length ? "reported" : "in the party" };
}


export function CreditCard({ member, index, detail, registry, identity = false }: { member: Member; index: number; detail: BoardQuestDetail; registry: Registry; identity?: boolean }) {
  const [inline, setInline] = useState(false);
  const openReports = useOpenReports();
  const quest = detail.quest;
  const cls = classLabel(registry, member.classId);
  const character = registry.characters.find((c) => c.id === member.characterId);
  const reports = detail.reports.filter((r) => r.memberThreadId === member.threadId).sort((a, b) => b.createdAt - a.createdAt);
  const lead = reports.find((r) => r.status === "done") ?? reports[0];
  const headline = lead ? taleHeadline(lead, memberReportNames(detail, member, registry)) : null;
  // A report's own voice line always shows; the character's stock wrap line claims an ending, so only a member that finished gets it.
  const voice = lead?.voice ?? (character && (member.engagement === "resting" || member.disposition === "finished") ? character.lines.wrap : null);
  const role = roleWords(member, detail.memberCredits?.find((c) => c.memberThreadId === member.threadId), registry, reports);
  const title = (id: string) => quest.waypoints.find((w) => w.id === id)?.title ?? id;
  const ids = (list: string[]) => list.map((id, i) => <span key={id}>{i > 0 && ", "}<span className="tv-wpid" title={title(id)}>{id}</span></span>);
  const name = characterName(registry, member);
  // The kit's one rule, from the lasting record; nothing earned, no level.
  const lv = levelFor(registry, member.characterId, member.classId);
  // A level belongs to the character, not the member: the kit says each crossing once, on the first member holding it.
  const said = levelsShown(registry) ? reachedInParty(detail, quest.members, registry.characters).find((x) => x.member.threadId === member.threadId) ?? null : null;
  return <li className={`tv-credit nested ${inline ? "open" : ""}`} style={{ ["--i" as string]: index }}>
    <div className="tv-credit-h">
      <CrestOf member={member} registry={registry} size={32} level={lv?.level} />
      {identity ? <div className="tv-credit-n"><div className="tv-credit-nm"><MemberIdentity member={member} registry={registry} compact finished scope={detail.scopes?.find(s => s.threadId === member.threadId)} violations={detail.violations?.filter(v => v.threadId === member.threadId)} />{member.characterId && detail.tale?.keptCharacterIds?.includes(member.characterId) && <span className="tv-kept" data-kept role="img" aria-label="Kept" title={`Kept at the top of ${name}'s tales, from the character sheet`}><Glyph name="wax-seal" size={13} /></span>}</div></div> : <span className="tv-credit-n"><span className="tv-credit-nm"><b>{name}</b>{member.characterId && detail.tale?.keptCharacterIds?.includes(member.characterId) && <span className="tv-kept" data-kept role="img" aria-label="Kept" title={`Kept at the top of ${name}'s tales, from the character sheet`}><Glyph name="wax-seal" size={13} /></span>}</span><span className="m">{cls ? <>{cls.label} <span className="anc">{cls.plain}</span></> : member.classId}</span></span>}
      {lv && lv.level >= 2 && <span className="tag tv-lvl" title={lv.words}>level {lv.level}</span>}
    </div>
    {said && <p className="tv-credit-lvl" data-reached={said.reached.level} data-earned={said.reached.earned || undefined}>{reachedWords(said.name, said.reached)}</p>}
    <CheckIndependence member={member} /><GuardPosture member={member} finished />
    <p className="tv-credit-role">{role.plain ?? <>{role.made.length > 0 && <span>made {ids(role.made)}</span>}{role.made.length > 0 && role.verified.length > 0 && " · "}{role.verified.length > 0 && <span>verified {ids(role.verified)}</span>}</>}</p>
    {headline && <p className="tv-credit-hl" data-content>{headline}</p>}
    {voice && voiceShown(registry) && <p className="tv-voice tv-credit-v" data-content>{voice}</p>}
    {reports.length > 0 && (inline
      ? <button type="button" className="lnk-btn act tv-credit-more" aria-expanded onClick={() => setInline(false)}><span>{reports.length > 1 ? "Hide the reports" : "Hide the report"}</span><ExpandsMark open /></button>
      : <button type="button" className="lnk-btn act tv-credit-more" onClick={() => { if (!openReports({ questId: quest.id, memberThreadId: member.threadId }, reportsTitle(name, quest.short))) setInline(true); }} title={`Opens ${name}'s ${reports.length > 1 ? "reports" : "report"} in the side panel`}><span>{viewReportsLabel(reports.length)}</span><OpensMark /></button>)}
    {inline && <div className="tv-credit-full"><MemberReports detail={detail} member={member} registry={registry} /></div>}
  </li>;
}

export type Waypoint = BoardQuestDetail["quest"]["waypoints"][number];
/** One verified waypoint: its title, who verified it and its done-when stay in view; the evidence folds behind "N evidence". */
export function LootRow({ waypoint: w, detail, registry }: { waypoint: Waypoint; detail: BoardQuestDetail; registry: Registry }) {
  const [open, setOpen] = usePanelState(`tale:${detail.quest.id}.loot.${w.id}`, false);
  const reports = detail.reports.filter((r) => r.waypointId === w.id && r.evidence.length > 0);
  const shown = reports.reduce((n, r) => n + r.evidence.length, 0);
  const verifierId = detail.memberCredits?.find((c) => c.verifiedWaypointIds.includes(w.id))?.memberThreadId;
  const verifier = verifierId ? detail.quest.members.find((m) => m.threadId === verifierId) : undefined;
  return <li>
    <PageGlyph name="done" className="tv-st-done-g" />
    <div className="tv-loot-b">
      <span><b>{w.title}</b><span className="m"> · {verifier ? characterName(registry, verifier) : "a Warden"} verified</span></span>
      {w.doneWhen && <span className="m tv-loot-dw" data-content>{w.doneWhen}</span>}
      {shown > 0 ? <button type="button" className="lnk-btn act tv-loot-ev" aria-expanded={open} onClick={() => setOpen(!open)}><span>{shown} evidence</span><ExpandsMark open={open} /></button> : <span className="m">{w.evidenceCount ? `${w.evidenceCount} evidence` : "No evidence attached"}</span>}
      {open && reports.map((r) => <EvidenceList key={r.id} evidence={r.evidence} />)}
    </div>
  </li>;
}


/** What a waypoint that was not verified was left as, in words. */
export function leftWord(w: Waypoint, skipped?: string): string {
  if (settled(w)) return resolutionWords(skipped && w.state === "skipped" ? { ...w, resolutionReason: skipped } : w);
  if (w.actor === "user") return "still yours";
  if (w.actor === "outside") return `waiting on ${w.owner ?? "someone outside"}`;
  if (w.state === "rejected") return w.rejectedReason ? `rejected: ${w.rejectedReason}` : "rejected";
  return ({ planned: "planned", todo: "planned", doing: "in progress", blocked: "blocked", reported: "reported, not verified" } as Record<string, string>)[w.state] ?? w.state;
}
/** One waypoint left on the board: its title and what it was left as. */
export function LeftRow({ waypoint: w, skipped }: { waypoint: Waypoint; skipped?: string }) {
  return <li><PageGlyph name={w.actor === "user" ? "diamond" : w.actor === "outside" ? "gate" : "wait"} className={w.actor === "user" ? "tv-mn-you" : ""} /><span><b data-content>{w.title}</b><span className="m"> · <span data-content>{leftWord(w, skipped)}</span></span></span></li>;
}

import { preapprovalWords } from "../../shared/quest-authority";
const VIA: Record<NonNullable<Ask["answer"]>["via"], string> = { banner: "from the banner", page: "on the Tavern page", phone: "on your phone", chat: "in chat", cli: "from the CLI", timer: "by its timer" };
/** Why Tavern withdrew an ask, where the server recorded it. Keyed by string so a cause the schema adds later still reads "withdrawn". */
const WITHDRAWN: Record<string, string> = { "quest-stopped": "withdrawn when it stopped", "quest-returned": "withdrawn when the quest returned", "backup-restored": "withdrawn when this backup was restored", "closing-stale": "withdrawn because the closing details changed" };
/** How an ask ended, in words: the option chosen, by whom and how; withdrawn or still open otherwise. */
export function askOutcome(ask: Ask): string {
  const label = ask.answer ? ask.options.find((o) => o.id === ask.answer!.optionId)?.label ?? "an option no longer listed" : null;
  if (ask.answer?.surface === "client (unattested)" && label) return `You chose “${label}”; answered from a client Tavern could not attribute`;
  if (ask.answer?.preapproval) return `${label}: ${preapprovalWords(ask.answer.preapproval)}`;
  if (ask.answer?.by === "keeper") return `${label}: decided by the Keeper`;
  if (ask.answer && label) return ask.answer.by === "user" ? `You chose “${label}” ${VIA[ask.answer.via]}` : `“${label}” applied by itself ${VIA[ask.answer.via]}`;
  if (ask.state === "withdrawn") return (ask.withdrawnCause && WITHDRAWN[ask.withdrawnCause]) || "withdrawn";
  if (ask.state === "defaulted") return "applied its recommendation";
  return "still open";
}
