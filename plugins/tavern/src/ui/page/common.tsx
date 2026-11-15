import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useId, type ReactNode, memo } from "react";
import type { z } from "zod";
import type { registrySchema, BoardQuestSummary } from "../../shared/contract";
import type { Member, Phase } from "../../shared/schema";
import { OpensMark, TimeAgo, clockTime, timeAgo, useNow } from "../kit";
import { awayClock } from "../kit/hearth";
import { PageGlyph, type PageGlyphName } from "./glyphs";
import { QuestRoad } from "./quest-road";
import { closedWords, pathProgress, type MoveTone } from "./model";
import { memberName } from "../../shared/member-name";
export { CrestOf, StateMark, PhaseMark } from "../kit";
import { CrestOf, PhaseMark, StateMark } from "../kit";

export type Registry = z.infer<typeof registrySchema>;
/** A member's name on the page: its display name, its character's name, then its class; never blank and never a raw id (a member may have no character). */
export const characterName = (registry: Registry, member: Parameters<typeof memberName>[0]) => memberName(member, registry);
export function Word({ children, plain }: { children: ReactNode; plain: string }) { return <>{children} <span className="anc">{plain}</span></>; }

export function Status({ children, tone = "plain" }: { children: ReactNode; tone?: string }) {
  return <StateMark tone={(tone === "attention" ? "you" : tone === "bad" ? "bad" : tone === "listening" || tone === "busy" || tone === "holding" ? tone : "plain") as never}>{children}</StateMark>;
}
/** A section: a heading row (title, a labelled count, an action) and its content, all on one column edge. */
export function Section({ title, count, aside, action, children, className = "", id, level = 2 }: { title: ReactNode; count?: ReactNode; aside?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  const own = useId();
  const heading = id ?? own;
  return <section className={`tv-sec ${className}`} aria-labelledby={heading}><header className="tv-colh"><H id={heading}>{title}</H>{count !== undefined && <span className="tv-count">{count}</span>}{aside && <span className="tv-colh-aside">{aside}</span>}<span className="tv-sp" />{action}</header>{children}</section>;
}
export function Panel({ title, children, className = "" }: { title: ReactNode; children: ReactNode; className?: string }) { return <Section title={title} className={className}>{children}</Section>; }
export function Empty({ children }: { children: ReactNode }) { return <p className="tv-empty" data-empty>{children}</p>; }
/** Opens a thread; `quiet` draws it as a plain link, for a thread that is archived or a quest that has ended. */
export function ThreadButton({ id, name, label = "Open thread", className = "", quiet = false }: { id: string; name?: string; label?: string; className?: string; quiet?: boolean }) {
  const navigate = useBbNavigate();
  return <button type="button" className={quiet ? `lnk-btn act ${className}` : `btn ${className}`} onClick={() => navigate.toThread(id)} aria-label={name ? `Open ${name}'s thread` : "Open thread"} title={name ? `Open ${name}'s thread` : "Open thread"}><PageGlyph name="thread" /><span>{label}</span><OpensMark /></button>;
}
export function PageButton({ path, children, className = "", glyph }: { path: string; children: ReactNode; className?: string; glyph?: PageGlyphName }) {
  const navigate = useBbNavigate();
  return <button type="button" className={`btn ${className}`} onClick={() => navigate.toPluginPanel("tavern", { subPath: path })}>{glyph && <PageGlyph name={glyph} />}<span>{children}</span><OpensMark /></button>;
}
export function classLabel(registry: Registry, classId: string) { const cls = registry.classes.find((c) => c.id === classId); return cls ? { label: cls.label, plain: cls.plain } : null; }
/** Crest and name of another thread: always opens that thread. */
export function MemberLink({ member, registry, size = 20, sub, className = "" }: { member: Member; registry: Registry; size?: number; sub?: ReactNode; className?: string }) {
  const navigate = useBbNavigate();
  const name = characterName(registry, member);
  const cls = classLabel(registry, member.classId);
  return <button type="button" className={`tv-who act ${className}`} onClick={() => navigate.toThread(member.threadId)} title={`Open ${name}'s thread`} aria-label={`Open ${name}'s thread${cls ? `, ${cls.label}` : ""}`}>
    <CrestOf member={member} registry={registry} size={size} />
    <span className="tv-who-t"><b>{name}</b>{sub !== undefined ? <span className="tv-who-s">{sub}</span> : cls && <span className="anc">{cls.label} · {cls.plain}</span>}</span>
    <OpensMark />
  </button>;
}
export function MemberMark({ member, registry, size = 24 }: { member: Member; registry: Registry; size?: number }) {
  const cls = classLabel(registry, member.classId);
  return <span className="tv-member" title={`${characterName(registry, member)} · ${cls?.label ?? member.classId} · ${member.state}`}>
    <CrestOf member={member} registry={registry} size={size} />
    <span><strong>{characterName(registry, member)}</strong><small>{cls ? `${cls.label} (${cls.plain})` : `Unknown class: ${member.classId}`}</small></span>
  </span>;
}
/** Small crests side by side; each opens its thread. */
/** Party crests; `still` draws them as marks for rows that are already one click target. */
export function Faces({ members, registry, size = 20, max = 6, still = false }: { members: Member[]; registry: Registry; size?: number; max?: number; still?: boolean }) {
  const navigate = useBbNavigate();
  if (still) return <span className="tv-faces still" aria-hidden="true">{members.slice(0, max).map((m) => <CrestOf key={m.threadId} member={m} registry={registry} size={size} />)}{members.length > max && <span className="tv-more">+{members.length - max}</span>}</span>;
  return <span className="tv-faces">{members.slice(0, max).map((m) => <button type="button" key={m.threadId} className="tv-face act" onClick={() => navigate.toThread(m.threadId)} title={`Open ${characterName(registry, m)}'s thread${m.title ? ` · ${m.title}` : ""}`} aria-label={`Open ${characterName(registry, m)}'s thread`}><CrestOf member={m} registry={registry} size={size} /></button>)}{members.length > max && <span className="tv-more">+{members.length - max} more</span>}</span>;
}
export function PhaseStrip({ phase, stoppedAt, proven }: { phase: Phase; tone?: MoveTone; stoppedAt?: Phase | null; proven?: Phase | null }) {
  return <QuestRoad phase={phase} stoppedAt={stoppedAt} proven={proven} />;
}
export function QuestRow({ quest }: { quest: BoardQuestSummary }) {
  const navigate = useBbNavigate();
  const path = pathProgress(quest);
  return <button type="button" className="tv-qrow act" onClick={() => navigate.toPluginPanel("tavern", { subPath: `${quest.phase === "done" ? "tale" : "quest"}/${quest.id}` })} title={quest.title}>
    <span className="tv-qrow-t">{quest.short}</span><Ago at={quest.updatedAt} />
    <span className="tv-qrow-s"><PhaseMark phase={quest.phase} />{path && <span className="tv-dim num">{path.done} of {path.total} on the path</span>}</span><OpensMark />
  </button>;
}
/** One segmented control for filters: a single bordered group, one pressed segment. */
export function SegFilter<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return <div className="segc" role="group" aria-label={label}>{options.map((o) => <button type="button" className="seg" key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}{o.count !== undefined && <span className="num">{o.count}</span>}</button>)}</div>;
}
/** A reference inside a sentence: same font, no box; underline on hover and focus. */
export function InlineLink({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return <button type="button" className="tv-ilink" onClick={onClick} title={title}>{children}</button>;
}
export { plural } from "../kit";

/** Ages always come from the kit's TimeAgo: relative under a week, a date after that. */
export const Ago = memo(function Ago({ at }: { at: number; title?: string }) { return <TimeAgo at={at} />; });
export const ago = timeAgo;
/** A clock time for logs; earlier days carry their date. */
/**
 * Texts that read the clock keep their own: the surfaces above them are memoized and skip unchanged room ticks, so each of these
 * re-renders itself once a minute instead.
 */
export function ClosedWords({ away }: { away: Parameters<typeof closedWords>[0] }) { const now = useNow(); return <>{closedWords(away, now)}</>; }
/** A Closing time clock ("08:00", or "Sun 08:00" when it isn't today). */
export function AwayTime({ at }: { at: number }) { const now = useNow(); return <>{awayClock(at, now)}</>; }
export function Time({ at }: { at: number }) { const now = useNow(); const today = new Date(at).toDateString() === new Date(now).toDateString(); return <time className="num" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{today ? clockTime(at) : `${new Date(at).toLocaleDateString([], { day: "numeric", month: "short" })} ${clockTime(at)}`}</time>; }
export function ReadState({ error, retry }: { error: { message: string } | null; retry(): unknown }) { return error ? <div className="tv-problem" role="alert" data-stuck><PageGlyph name="fail" /><span>Could not load Tavern: {error.message}</span><button type="button" className="btn sm" onClick={() => void retry()}>Try again</button></div> : <p className="tv-loading" role="status">Loading Tavern…</p>; }
