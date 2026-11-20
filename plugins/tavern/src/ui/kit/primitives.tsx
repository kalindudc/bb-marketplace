import { memberActivityWord } from "../../shared/member-engagement";
import { clockTime } from "../../shared/time";
export { clockTime, moveTime } from "../../shared/time";
import { PHASE_STEPS, phaseIndex, phaseWord } from "./phase";
import { reviewLimitation } from "../../shared/check-posture";
import { memberPlace } from "../../shared/member-place";
import { memberName } from "../../shared/member-name";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type ButtonHTMLAttributes, memo } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { rpcContract, type BoardQuestSummary } from "../../shared/contract";
import { extractReportHeadline, type ReportHeadlineNames } from "../../shared/report-headline";
import type { Actor, Evidence, EntryStatus, Member, Phase, Decision, Report } from "../../shared/schema";
import { identityLabel, isThreadId } from "../../shared/identity";
import { Crest } from "./crest";
import { ExpandsMark, Glyph, OpensMark } from "./glyphs";
import { memberIdentity, type Registry } from "./registry";
import { MAX_TRAVEL_PX, useTavernMotion, type Surface } from "./motion";
import { PlacementFacts } from "./placement";

export const VOCABULARY = {
  quest: ["Quest", "goal"], board: ["Board quest", "goal"], journal: ["Journal", "checklist"], party: ["The party", "team"], map: ["Quest map", "greenlight"],
  ledger: ["The Keeper’s ledger", "what the lead knows"], ledgerShort: ["Ledger", "lead state"], tale: ["The tale", "credits"], errand: ["Side quest", "errand"],
  keeper: ["Keeper", "lead"], ranger: ["Ranger", "scout"], smith: ["Smith", "builder"], warden: ["Warden", "checker"], wanderer: ["Wanderer", "general"],
  road: ["On the road", "working"], table: ["At the table", "idle or waiting"], rest: ["Resting", "done"], decided: ["Decided for you", "reversible calls"],
  questBoard: ["The quest board", "goals"], commonRoom: ["The common room", "home"], connections: ["The map", "connections"], closing: ["Closing time", "away"],
  cellar: ["Cellar", "archived"],
} as const;
/** Plural forms, where the word has one; `Vocabulary` and `vocab` fall back to the singular. */
export const VOCABULARY_PLURAL: Partial<Record<keyof typeof VOCABULARY, readonly [string, string]>> = {
  quest: ["Quests", "goals"], board: ["Board quests", "goals"], journal: ["Journals", "checklists"], errand: ["Side quests", "errands"],
  keeper: ["Keepers", "leads"], ranger: ["Rangers", "scouts"], smith: ["Smiths", "builders"], warden: ["Wardens", "checkers"], wanderer: ["Wanderers", "general"],
};
export type VocabWord = keyof typeof VOCABULARY;
const word2 = (word: VocabWord, plural: boolean) => (plural && VOCABULARY_PLURAL[word]) || VOCABULARY[word];
export function Vocabulary({ word, plural = false }: { word: VocabWord; plural?: boolean }) { const [label, plain] = word2(word, plural); return <>{label} <span className="anc">{plain}</span></>; }
export const vocab = (word: VocabWord, plural = false) => { const [label, plain] = word2(word, plural); return `${label} (${plain})`; };
/** Count with its noun: "1 thread", "2 threads". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The cellar is the archive's name wherever the user reads it; code, tables and RPCs keep "archive". Sending a quest there is the user's acceptance: a quest in the cellar is done. */
export const CELLAR = {
  send: "Send to the cellar (archive)",
  sendAllReturned: "Send all returned to the cellar",
  restore: "Bring up",
  link: (n: number) => `Cellar (archived) · ${n}`,
  sent: (n: number) => `${n} sent to the cellar`,
  autoSetting: "Send returned quests to the cellar after N days (0 = never)",
} as const;
export function Button({ className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className={`btn ${className}`} {...props}>{children}</button>; }

const PILL_MARK: Record<string, string> = { done: "✓", verified: "✓", answered: "✓", failed: "!", rejected: "✕", blocked: "!", "needs-decision": "?", waiting: "…", reported: "✓" };
export function StatusPill({ status, children, mark }: { status: string; children?: ReactNode; mark?: string }) {
  return <span className={`tag status-${status}`}><span aria-hidden="true">{mark ?? PILL_MARK[status] ?? "·"}</span>{children ?? status.replaceAll("-", " ")}</span>;
}

/** The checklist mark: shape carries the status so it reads without colour. */
export function StatusMark({ status, size = 16 }: { status: EntryStatus; size?: number }) {
  return (
    <svg className={`smark s-${status}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect className="box" x="1.5" y="1.5" width="13" height="13" />
      {status === "doing" && <rect className="fill" x="5" y="5" width="6" height="6" />}
      {(status === "done" || status === "verified") && <path className="tick" d="M4.2 8.3 6.9 11 11.9 5.2" />}
      {status === "blocked" && <path className="bar" d="M4.5 8h7" />}
      {status === "rejected" && <path className="tick" d="M5 5l6 6M11 5l-6 6" />}
    </svg>
  );
}

/** Stopping and stopped strike every segment and say no step number: the quest left its path. */
export function PhaseStrip({ phase, label = true }: { phase: Phase; label?: boolean }) {
  const phases = PHASE_STEPS.map(step => step.id);
  const off = phase === "stopping" || phase === "stopped";
  const at = phaseIndex(phase);
  const name = phase === "closing" || phase === "held" ? phaseWord(phase) : phase === "done" ? "returned" : phase;
  return <span className="phw"><span className="ph" role="img" aria-label={off || phase === "held" ? `Phase: ${name}` : `Phase: ${name}${phase === "done" ? "" : `, ${at + 1} of 5`}`}>{phases.map((p, i) => <i key={p} className={off ? "s" : i < at ? "d" : i === at ? "c" : ""} />)}</span>{label && <span className="w">{name}</span>}</span>;
}

export function safeHref(ref: string) { try { const url = new URL(ref); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; } }

/** `fold` clamps a long detail (a command's output) to two lines that open in place. */
export function EvidenceList({ evidence, fold = false, fileRef }: { evidence: readonly Evidence[]; fold?: boolean; fileRef?: (ref: string) => ReactNode }) {
  return <ul className="evidence-list" aria-label="Evidence">{evidence.map((e, i) => { const href = safeHref(e.ref); return <li key={i}><span className="ek">{e.kind}</span><span className="er">{href ? <a href={href} target="_blank" rel="noreferrer" title={e.ref}>{e.ref}</a> : (e.kind === "file" && fileRef?.(e.ref)) || <code title={e.ref}>{e.ref}</code>}{e.exitCode !== null && <span className={`exit ${e.exitCode === 0 ? "ok" : "bad"}`}>exit {e.exitCode}</span>}</span>{e.detail && (fold ? <Clamp text={e.detail} lines={2} className="ed" /> : <span className="ed">{e.detail}</span>)}</li>; })}</ul>;
}

export function MemberChip({ member, registry, compact = false, onOpen, summary }: { member: Member; registry: Registry; compact?: boolean; onOpen?: (threadId: string) => void; summary?: string }) {
  const identity = memberIdentity(registry, member);
  const name = identity?.character.name ?? member.displayName ?? member.characterId;
  const content = <>{identity ? <Crest {...identity} size={compact ? 16 : 22} /> : <span className="tag" aria-label="Unknown character">?</span>}{!compact && <span className="who-t"><b>{name}</b><span className="anc">{identity ? `${identity.cls.label} · ${identity.cls.plain}` : `Unknown class: ${member.classId}`}</span></span>}</>;
  const title = `${name} · ${identity?.cls.label ?? member.classId} (${identity?.cls.plain ?? "unknown"}) · ${memberActivityWord(member)}${reviewLimitation(member.checkIndependence) ? ` · ${reviewLimitation(member.checkIndependence)}` : ""}${member.guardPosture ? ` · ${member.guardPosture.label}` : ""}${(summary ?? member.doing) ? ` · ${summary ?? member.doing}` : ""}`;
  return onOpen ? <button type="button" className="who who-btn act" title={`Open ${title}`} aria-label={`Open ${title}`} onClick={() => onOpen(member.threadId)}>{content}<OpensMark /></button> : <span className="who" title={title}>{content}</span>;
}

/** A Warden checked by a model from the same family as the builder: its verdict is not an independent check. The words are fixed; show them exactly. */
export const SAME_FAMILY = "same-family check (not independent)";
const LIMITATION_TITLE = {
  "same-family": "No model from a different family was available, so this Warden uses the same family as the builder. Its verdict is not an independent check.",
  "not-established": "Tavern couldn't establish that this Warden's model is from a different family than the builder's, so its verdict isn't counted as an independent check.",
} as const;
/** A Warden whose check is not shown to be independent: same family as the builder, or not established. Words from the shared `reviewLimitation`. */
export function CheckIndependence({ member }: { member: Pick<Member, "checkIndependence"> }) {
  const words = reviewLimitation(member.checkIndependence);
  return words && (member.checkIndependence === "same-family" || member.checkIndependence === "not-established") ? <span className="tag check-same" title={LIMITATION_TITLE[member.checkIndependence]}>{words}</span> : null;
}

/** A member whose scope is only watched: a rule break is seen after the action, not stopped before it. The words come from the server; show them exactly. A pre-exec guard is protection, not a caveat, so it shows only in tooltips. */
/** `finished` (a finished record) speaks of the run, past tense: the posture was the run's, not the member's state now. */
export function GuardPosture({ member, finished = false }: { member: Pick<Member, "guardPosture">; finished?: boolean }) {
  const g = member.guardPosture;
  if (g?.mode !== "detection-only") return null;
  return finished
    ? <span className="tag guard-detect" title="During the run this member's scope was watched, not enforced: a rule break was recorded after the action, not prevented before it ran.">{g.label} · during the run</span>
    : <span className="tag guard-detect" title="This member's scope is watched, not enforced: a rule break is recorded after the action and can stop the turn, but it is not prevented before it runs.">{g.label}</span>;
}

/** Lantern glow placement for one card, varied within a small range and fixed by the card's id: origin x 30 to 70%, y 0 to 20%, size within 10% of the default. Same in every theme, never animated. */
export function glowVars(seed: string): Record<string, string> {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const pick = (shift: number, min: number, max: number) => `${(min + (((h >>> shift) & 255) / 255) * (max - min)).toFixed(1)}%`;
  return { "--glow-x": pick(0, 30, 70), "--glow-y": pick(8, 0, 20), "--glow-w": pick(16, 82, 100), "--glow-h": pick(24, 54, 66) };
}

/** Long text in one or two lines. It becomes an expand-in-place control only when the clamp cuts it or `more` (such as a decision's why) is folded behind it; otherwise it stays plain text. */
export function Clamp({ text, more, lines = 2, className = "" }: { text: string; more?: string; lines?: 1 | 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, lines, open, cut]);
  const body = <span className="ct" ref={ref} data-content>{text}{open && more && <span className="m"> {more}</span>}</span>;
  if (!more && !cut && !open) return <span className={`lg-clamp still l${lines} ${className}`}>{body}</span>;
  return <button type="button" className={`lg-clamp act l${lines} ${open ? "open" : ""} ${className}`} aria-expanded={open} title={open ? "Show less" : more ? `${text} · ${more}` : text} onClick={() => setOpen(!open)}>{body}<ExpandsMark open={open} /></button>;
}

/**
 * Names for one member's summary: people from the party, the registry and the quests it is on; quest names from every quest given;
 * waypoint titles only from the member's own quests, and an id two of them title differently stays unresolved. `reports` labels
 * report ids (see `reportLabels`); without them a report id reads "a report".
 */
export function summaryNames(member: Pick<Member, "threadId">, members: Member[], registry: Registry, quests: BoardQuestSummary[], reports: readonly ReportRef[] = []): ReportHeadlineNames {
  const own = quests.filter(q => q.members.some(m => m.threadId === member.threadId));
  const people = [...members, ...own.flatMap(q => [...q.members, ...q.waypoints.flatMap(w => w.ownerMember ? [w.ownerMember] : [])])];
  const threadNames = new Map(people.flatMap(m => { const name = memberIdentity(registry, m)?.character.name ?? m.displayName; return name ? [[m.threadId, name] as const] : []; }));
  const questNames = new Map(quests.map(q => [q.id, q.short || q.title] as const));
  const waypointTitles = new Map<string, string>();
  const clash = new Set<string>();
  for (const q of own) for (const w of q.waypoints) { const seen = waypointTitles.get(w.id); if (seen !== undefined && seen !== w.title) clash.add(w.id); else waypointTitles.set(w.id, w.title); }
  for (const id of clash) waypointTitles.delete(id);
  if (!reports.length) return { threadNames, questNames, waypointTitles };
  const authors = new Map([...members, ...quests.flatMap(q => q.members)].flatMap(m => { const name = memberIdentity(registry, m)?.character.name ?? m.displayName; return name ? [[m.threadId, name] as const] : []; }));
  return { threadNames, questNames, waypointTitles, reportNames: reportLabels(reports, authors, quests) };
}

/** Every name in one board quest, for text about the whole quest (the Keeper's tale): its party, its Keeper as "the Keeper", its waypoints and its reports. */
export function questNames(quest: BoardQuestSummary, registry: Registry, reports: readonly ReportRef[] = []): ReportHeadlineNames {
  const people = [...quest.members, ...quest.waypoints.flatMap(w => w.ownerMember ? [w.ownerMember] : [])];
  const threadNames = new Map(people.flatMap(m => { const name = memberIdentity(registry, m)?.character.name ?? m.displayName; return name ? [[m.threadId, name] as const] : []; }));
  if (!threadNames.has(quest.keeperThreadId)) threadNames.set(quest.keeperThreadId, "the Keeper");
  return { threadNames, questNames: new Map([[quest.id, quest.short || quest.title]]), waypointTitles: new Map(quest.waypoints.map(w => [w.id, w.title] as const)), reportNames: reportLabels(reports, threadNames, [quest]) };
}

type ReportRef = Pick<Report, "id" | "memberThreadId" | "boardQuestId" | "waypointId">;
/**
 * Complete labels for report ids in agent text: "Vex’s report", and "Vex’s report for Check the duration" when Vex filed more
 * than one among `reports`. A report whose author has no name is left out, so the shared namer reads it as "a report".
 */
export function reportLabels(reports: readonly ReportRef[], authors: ReadonlyMap<string, string>, quests: readonly BoardQuestSummary[] = []): Map<string, string> {
  const count = new Map<string, number>();
  for (const r of reports) count.set(r.memberThreadId, (count.get(r.memberThreadId) ?? 0) + 1);
  return new Map(reports.flatMap(r => {
    const name = authors.get(r.memberThreadId);
    if (!name) return [];
    const where = (count.get(r.memberThreadId) ?? 0) > 1 && r.waypointId ? quests.find(q => q.id === r.boardQuestId)?.waypoints.find(w => w.id === r.waypointId)?.title : undefined;
    return [[r.id, `${name}’s report${where ? ` for ${where}` : ""}`] as const];
  }));
}
/** What a party member is doing, in words for people: its report line with names in place of ids, else its state. Never a raw id. */
export function memberSummary(member: Member, members: Member[], registry: Registry, quests: BoardQuestSummary[] = []): string {
  return (member.doing ? extractReportHeadline({ outcome: member.doing }, summaryNames(member, members, registry, quests)) : null) ?? memberActivityWord(member, quests.some(q => q.id === member.boardQuestId && (q.phase === "done" || q.phase === "stopped")));
}

/** The party in three places. `quests` are the quests these members are on (the quest page passes its quest; the room, the Keeper's quests), so their reports can name waypoints and quests. */
/**
 * Each member's place comes from its state (`memberPlace`): working is on the road, done or stopped is resting, anything else is at the
 * table. The stored `place` field is never read; it drifted on old rows (finished members stored at the table).
 * A member who sets out moves onto the road (a slide if it is short, otherwise a fade and an 8 px rise where it lands), then takes one step. A failed member never moves. */
export function PartyPicture({ members, registry, onOpen, mini = false, quests = [], surface = "page", ambientMotion = "calm", repeatSeconds = 20, renderMember }: { renderMember?: (member: Member, summary: string) => ReactNode; ambientMotion?: "calm" | "lively" | "off"; repeatSeconds?: number; members: Member[]; registry: Registry; onOpen?: (id: string) => void; mini?: boolean; quests?: BoardQuestSummary[]; surface?: Surface }) {
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(new Map<string, { place: string; x: number; y: number }>());
  const { cue, settle } = useTavernMotion(surface);
  const lively = ambientMotion === "lively";
  const onRoad = members.some(m => memberPlace(m) === "road");
  useEffect(() => {
    if (!lively || !onRoad) return;
    const timer = setInterval(() => {
      for (const node of root.current?.querySelectorAll<HTMLElement>('[data-place="road"]:not(.fail)') ?? [])
        cue(node, "road repeat", { key: node.dataset.member!, ms: 2800, className: "mo-walk", ambient: true, repeat: true });
    }, repeatSeconds * 1000);
    return () => { clearInterval(timer); settle(c => c.kind === "road repeat"); };
  }, [lively, onRoad, repeatSeconds, cue, settle]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const next = new Map<string, { place: string; x: number; y: number }>();
    for (const node of el.querySelectorAll<HTMLElement>("[data-member]")) {
      const id = node.dataset.member!, place = node.dataset.place!, r = node.getBoundingClientRect();
      const was = seen.current.get(id);
      if (was && was.place !== "road" && place === "road" && !node.classList.contains("fail")) {
        const dx = was.x - r.left, dy = was.y - r.top, slide = Math.hypot(dx, dy) <= MAX_TRAVEL_PX;
        cue(node, "sets out", {
          key: id, ms: 450,
          run: n => [slide
            ? n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.65, 0, .35, 1)" })
            : n.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 150, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "backwards" })],
          onDone: () => cue(node, "road step", { key: id, ms: 2800, className: "mo-walk", ambient: true }),
        });
      }
      next.set(id, { place, x: r.left, y: r.top });
    }
    seen.current = next;
  });
  return <div ref={root} className={`party ${mini ? "mini" : ""}`} role="group" aria-label="The party (team)">{(["road", "table", "rest"] as const).map(place => { const here = members.filter(m => memberPlace(m) === place); return <div className={`zone ${place}`} key={place}><div className="zh"><b><Vocabulary word={place} /></b><span className="num">{here.length}</span></div><div className="zm">{here.length === 0 ? <span className="m">Nobody</span> : here.map(m => { const summary = memberSummary(m, members, registry, quests); return <div className={`pm ${m.state === "failed" ? "fail" : ""}`} key={m.threadId} data-member={m.threadId} data-place={place}>{renderMember ? renderMember(m, summary) : <MemberChip member={m} registry={registry} onOpen={onOpen} compact={mini} summary={summary} />}{!mini && <CheckIndependence member={m} />}{!mini && <GuardPosture member={m} />}{!mini && <Clamp className="pm-s" text={summary} />}{!renderMember && <PlacementFacts placement={m.placement} memberName={memberName(m, registry)} variant={mini ? "compact" : "row"} />}</div>; })}</div></div>; })}</div>;
}

/** Reversible calls, one line each: the title truncates and the why folds open in place; age and Undo stay on the row. */
/** The seen mutations for `DecidedForYou`: ids from a row or a full list, or the scope's `all` through its snapshot watermark when the list is clipped. Leave out `keeperThreadId` for the room's list across Keepers. */
export function useDecisionSeen({ keeperThreadId, throughId }: { keeperThreadId?: string; throughId?: string | null }) {
  const mark = experimental_useRpcMutation({ contract: rpcContract, method: "markDecisionsSeen" });
  const unmark = experimental_useRpcMutation({ contract: rpcContract, method: "markDecisionsUnseen" });
  return {
    onSeen: (ids: string[], all: boolean) => mark.mutate(all || ids.length > 200 ? { all: true as const, ...(keeperThreadId ? { keeperThreadId } : {}), throughId: throughId ?? null } : { ids }),
    onUnseen: (undoToken: string) => unmark.mutate({ undoToken }),
  };
}
type SeenDecision = Decision & { seenAt?: number | null };
/** `total` is the uncapped count when the list is capped. With `onSeen`, each unseen row gets "OK ✓" and the header "Mark all seen": it passes the ids on screen, and `all` true when the list is clipped so the caller can mark through its snapshot watermark; the kit owns the receipt and its Undo. A row with `seenAt` renders muted as "Seen". */
/** `limit` shows that many rows, then "Show all N" expands the rest in place. The heading is an h3 that takes focus, and `headingId` names it for a jump. */
export function DecidedForYou({ decisions, total, onUndo, pending = false, onSeen, onUnseen, limit, headingId, expanded, onExpandedChange, headless = false, compact = false }: { decisions: Decision[]; total?: number; onUndo?: (id: string) => void; expanded?: boolean; onExpandedChange?: (next: boolean) => void; headless?: boolean; compact?: boolean; pending?: boolean; limit?: number; headingId?: string; onSeen?: (ids: string[], all: boolean) => Promise<{ ids: string[]; undoToken: string | null }>; onUnseen?: (undoToken: string) => Promise<unknown> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [receipt, setReceipt] = useState<{ ids: string[]; token: string | null; undone?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ what: string; err: unknown } | null>(null);
  const [localAll, setLocalAll] = useState(false);
  const all = expanded ?? localAll;
  const setAll = onExpandedChange ?? setLocalAll;
  const shown = (decisions as SeenDecision[]).filter(d => !gone.has(d.id));
  const rows = limit != null && !all ? shown.slice(0, limit) : shown;
  const hiddenNow = decisions.length - shown.length;
  const live = total != null ? Math.max(0, total - hiddenNow) : shown.filter(d => !d.undone).length;
  const unseen = onSeen ? shown.filter(d => d.seenAt == null).map(d => d.id) : [];
  const clipped = total != null && total > decisions.length;
  const mark = (ids: string[], all = false) => { if (!onSeen || ids.length === 0) return; setBusy(true); setError(null); void onSeen(ids, all).then(out => { setGone(g => new Set([...g, ...ids])); setReceipt({ ids: out.ids, token: out.ids.length > 0 ? out.undoToken : null }); }, err => setError({ what: "Couldn’t mark seen", err })).finally(() => setBusy(false)); };
  const unmark = (ids: string[], token: string) => { if (!onUnseen) return; setBusy(true); setError(null); void onUnseen(token).then(() => { setGone(g => new Set([...g].filter(id => !ids.includes(id)))); setReceipt({ ids, token: null, undone: true }); }, err => setError({ what: "Couldn’t undo", err })).finally(() => setBusy(false)); };
  return <section className={`decided ${onSeen ? "seenable" : ""}`} data-compact-decided={compact || undefined} aria-label="Decided for you (reversible calls)">{!headless && <div className="dh"><h3 className="dh-t" id={headingId} tabIndex={-1}><Glyph name="decided" /><b><Vocabulary word="decided" /></b><span className="num" aria-label={plural(live, "decision")}>{live}</span></h3>{(unseen.length > 1 || (clipped && unseen.length > 0)) && <button type="button" className="btn sm ghost di-all" disabled={busy || pending} title={`Mark ${clipped ? `all ${live}` : "every decision shown here"} seen: they leave Decided for you and stay in the Ledger’s All decisions. Nothing is undone.`} onClick={() => mark(unseen, clipped)}>Mark all seen<Glyph name="check" size={12} /></button>}</div>}
    {receipt && <p className="di-receipt" role="status">{receipt.undone ? <><Glyph name="undo" size={12} />{`Back in Decided for you: ${plural(receipt.ids.length, "decision")}`}</> : <><Glyph name="check" size={12} />{receipt.ids.length > 0 ? `Marked ${receipt.ids.length} seen` : "Already seen"}{onUnseen && receipt.token && <button type="button" className="btn sm ghost" disabled={busy} aria-label={`Undo: mark ${plural(receipt.ids.length, "decision")} unseen again`} onClick={() => unmark(receipt.ids, receipt.token!)}>Undo</button>}</>}</p>}
    {error && <p className="di-err" role="alert">{error.what}: {error.err instanceof Error ? error.err.message : String(error.err)}</p>}
    {shown.length === 0 ? <p className="m di-empty">{receipt && !receipt.undone ? "Nothing left to look at." : "Nothing decided for you yet."}</p> : <><ul>{rows.map(d => { const isOpen = open === d.id; const seen = d.seenAt != null; return <li className={`di ${d.undone ? "undone" : ""} ${seen ? "seen" : ""} ${isOpen ? "open" : ""}`} key={d.id}>
    {/* The title takes the row: two lines closed (all of it in the tooltip), all of it open, above the reason. The time sits under it, the actions to its right. */}
    <button type="button" className="dt act" aria-expanded={isOpen} title={isOpen ? undefined : `${d.text} · ${d.why}`} onClick={() => setOpen(isOpen ? null : d.id)}><b data-content className="clamp">{d.text}</b><ExpandsMark open={isOpen} /></button>
    <span className="di-acts">
      {d.undone ? <span className="m">Undone</span> : d.reversible && !d.undoUnavailable && onUndo ? <button type="button" className="btn sm" disabled={pending} onClick={() => onUndo(d.id)} aria-label={`Undo: ${d.text}`}>Undo</button> : !d.reversible || d.undoUnavailable ? <span className="m">Final</span> : null}
      {onSeen && (seen ? <span className="m di-seen">Seen</span> : <button type="button" className="btn sm ghost di-ok" disabled={busy || pending} title="Mark seen: it leaves Decided for you and stays in the Ledger’s All decisions. Nothing is undone." aria-label={`Mark seen: ${d.text}`} onClick={() => mark([d.id])}>OK<Glyph name="check" size={12} /></button>)}
    </span>
    <span className="di-meta m">{d.checkChange && <span>From your steer, {clockTime(d.checkChange.steer.at)} · </span>}<TimeAgo at={d.createdAt} /></span>
    {isOpen && <p className="dwhy m" data-content>{d.why}{d.checkChange && <> “{d.checkChange.steer.text}”</>}</p>}
  </li>; })}</ul>{limit != null && shown.length > limit && <button type="button" className="lnk-btn act di-more" aria-expanded={all} onClick={() => setAll(!all)}><ExpandsMark open={all} />{all ? "Show fewer" : compact ? `${live - limit} more` : `Show all ${shown.length}`}</button>}</>}</section>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Relative under a week, a calendar date after that; never "20771d ago". */
export function timeAgo(at: number, now = Date.now()) {
  const diff = now - at;
  const min = Math.floor(Math.max(0, diff) / 60000);
  if (diff < -60000) { const ahead = Math.ceil(-diff / 60000); return ahead < 60 ? `in ${ahead}m` : ahead < 1440 ? `in ${Math.round(ahead / 60)}h` : `on ${dateLabel(at, now)}`; }
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  if (min < 7 * 1440) return `${Math.floor(min / 1440)}d ago`;
  return dateLabel(at, now);
}
function dateLabel(at: number, now: number) { const d = new Date(at); const sameYear = d.getFullYear() === new Date(now).getFullYear(); return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}`; }
/** Wall-clock time in the viewer's zone, with the date when it is not today: "03:12", "Nov 13 22:40". `now` comes from the caller's useToday (or useNow), never from render, so the text turns at midnight. */
export function localTime(at: number, now: number) {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? clockTime(at) : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(at)}`;
}

/**
 * A clock for texts that change only with the date ("23:50" today, "Nov 14 23:50" after midnight): one shared timer re-renders its users
 * once at local midnight, and on return to the tab, since a sleeping laptop fires timers late. Within a day the value never changes, so a
 * memoized part that reads it re-renders once a day, not every minute.
 */
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
let today = 0;
let midnight: ReturnType<typeof setTimeout> | undefined;
const dayListeners = new Set<() => void>();
const readToday = () => { const n = Date.now(); if (!sameDay(today, n)) today = n; return today; };
const turnDay = () => { const before = today; if (readToday() !== before) dayListeners.forEach((l) => l()); };
function armMidnight() {
  clearTimeout(midnight);
  const d = new Date();
  midnight = setTimeout(() => { turnDay(); armMidnight(); }, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - d.getTime() + 50);
}
const onVisible = () => { if (!document.hidden) turnDay(); };
function subscribeDay(listener: () => void) {
  dayListeners.add(listener);
  if (dayListeners.size === 1) { armMidnight(); document.addEventListener("visibilitychange", onVisible); }
  return () => { dayListeners.delete(listener); if (!dayListeners.size) { clearTimeout(midnight); document.removeEventListener("visibilitychange", onVisible); } };
}
export function useToday(): number { return useSyncExternalStore(subscribeDay, readToday, readToday); }

/** A Keeper the user stopped stays quiet until they resume it. Resume clears the Stop and asks the Keeper to re-anchor; Closing time is not touched. The notice hides once Resume succeeds and returns only if a later Stop is newer. */
export function QuietNotice({ threadId, since, compact = false }: { threadId: string; since: number | null | undefined; compact?: boolean }) {
  const resume = experimental_useRpcMutation({ contract: rpcContract, method: "resumeKeeper" });
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [receipt, setReceipt] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const day = useToday();
  useEffect(() => { if (!receipt) return; const t = setTimeout(() => setReceipt(false), 6000); return () => clearTimeout(t); }, [receipt]);
  const quiet = since != null && (resumedAt === null || since > resumedAt);
  if (!quiet) return receipt ? <span className={`tquiet done ${compact ? "compact" : ""}`} role="status"><Glyph name="play" size={12} /><span>{compact ? "Resumed" : "Resumed · the Keeper re-anchors now"}</span></span> : null;
  const when = localTime(since, day);
  const full = new Date(since).toLocaleString();
  const onResume = () => { setError(null); void resume.mutate({ threadId }).then(() => { setResumedAt(Date.now()); setReceipt(true); }, setError); };
  return <span className={`tquiet ${compact ? "compact" : ""}`} role="group" aria-label={`Quiet since you stopped it, ${when}`}>
    <Glyph name="pause" size={12} />
    <span className="tq-t" title={`You stopped this Keeper at ${full}. It does nothing on its own until you resume it.`}>{compact ? <>Quiet <span className="tq-since">since <time dateTime={new Date(since).toISOString()}>{when}</time></span></> : <>Quiet since you stopped it, <time dateTime={new Date(since).toISOString()} title={full}>{when}</time></>}</span>
    <button type="button" className={compact ? "tw-chip act tq-go" : "btn sm tq-go"} disabled={resume.isPending} title="Resume: clears your Stop and has the Keeper re-anchor. Closing time is unchanged." aria-label="Resume this Keeper" onClick={onResume}><Glyph name="play" size={11} /><span>Resume</span></button>
    {error != null && <span className="tq-err" role="alert">{error instanceof Error ? error.message : String(error)}</span>}
  </span>;
}

export function useNow() { const [now, setNow] = useState(Date.now); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []); return now; }
export const TimeAgo = memo(function TimeAgo({ at }: { at: number }) { const now = useNow(); return <time className="ago" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{timeAgo(at, now)}</time>; });

export { QueryState } from "./skeleton";

export function useActorNames(actors: readonly (Actor | string | null | undefined)[], viewer: string) {
  const ids = [...new Set(actors.flatMap(actor => typeof actor === "string" ? [actor] : actor?.kind === "agent" ? [actor.threadId] : []).filter(isThreadId))].sort();
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "identities", input: { ids, viewer }, enabled: ids.length > 0 });
  const previous = useRef<{ viewer: string; data: NonNullable<typeof query.data> } | null>(null);
  useLayoutEffect(() => {
    if (query.data) previous.current = { viewer, data: query.data };
  }, [query.data, viewer]);
  const page = query.data ?? (previous.current?.viewer === viewer ? previous.current.data : undefined);
  const identities = useMemo(() => new Map(page?.identities.map(identity => [identity.threadId, identity])), [page]);
  const threadNames = useMemo(() => new Map([...identities].map(([id, identity]) => [id, identityLabel(id, identity)])), [identities]);
  const name = (actor: Actor | string | null, opts?: Parameters<typeof identityLabel>[2]) => {
    const id = typeof actor === "string" ? actor : actor?.kind === "agent" ? actor.threadId : undefined;
    const identity = id ? identities.get(id) : undefined;
    if (id && isThreadId(id) && !identity && !query.data && !query.error) return "";
    return identityLabel(actor, identity, opts);
  };
  return Object.assign(name, { threadNames, identities });
}

export function useSidebarActorNames(threadIds: string[]) {
  const ids = useMemo(() => [...new Set(threadIds)].sort(), [threadIds.join(",")]);
  const crests = experimental_useRpcQuery({ contract: rpcContract, method: "crests", input: { threadIds: ids } });
  const sidebar = experimental_useSidebarThreads();
  const threadNames = useMemo(() => new Map<string, string>([
    ...sidebar.threads.flatMap(t => { const title = t.displayTitle ?? t.title; return title ? [[t.id, title] as const] : []; }),
    ...(crests.data?.crests ?? []).map(c => [c.threadId, c.label] as const),
  ]), [crests.data, sidebar.threads]);
  const name = (actor: Actor | string | null, opts: { mid?: boolean } = {}) => {
    const word = (start: string, mid: string) => opts.mid ? mid : start;
    if (actor === null) return word("Unassigned", "nobody");
    if (typeof actor !== "string") {
      if (actor.kind === "user") return word("You", "you");
      if (actor.kind === "tavern") return "Tavern";
      if (actor.kind === "import") return `${word("Imported", "imported")} from ${actor.from}`;
      actor = actor.threadId;
    }
    return threadNames.get(actor) ?? word("Another thread", "another thread");
  };
  return Object.assign(name, { threadNames });
}
