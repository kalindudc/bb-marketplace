import { memberName } from "../../shared/member-name";
import { useEffect, useRef, useState } from "react";
import type { BoardQuestDetail, BoardQuestSummary } from "../../shared/contract";
import { SHAPE_PATHS } from "../../shared/heraldry";
import { keeperSubject, resolutionWords, settled, verifiedWaypoint, waypointCheck } from "../../shared/waypoint";
import { reviewLimitation } from "../../shared/check-posture";
import { useRegistry, memberIdentity, type Registry } from "./registry";
import { Crest } from "./crest";
import { levelFor, type Level } from "./level";
import { StatusPill } from "./primitives";
import { verifiedOf, verifiedWords } from "./rows";

type WaypointView = BoardQuestSummary["waypoints"][number];
const COL = 132;
const LANE = 96;
const PAD_X = 62;
const TOP = 22;

export function layoutWaypoints(waypoints: WaypointView[], laneGap = LANE) {
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(waypoints.map(w => [w.id, w]));
  function level(id: string): number {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) throw new Error(`Quest map has a dependency cycle at ${id}`);
    const waypoint = byId.get(id);
    if (!waypoint) throw new Error(`Quest map references missing waypoint ${id}`);
    visiting.add(id);
    const n = waypoint.dependsOn.length ? Math.max(...waypoint.dependsOn.map(level)) + 1 : 0;
    visiting.delete(id);
    levels.set(id, n);
    return n;
  }
  const lanes = new Map<number, number>();
  return waypoints.map(w => { const column = level(w.id); const lane = lanes.get(column) ?? 0; lanes.set(column, lane + 1); return { waypoint: w, column, lane, x: PAD_X + column * COL, y: TOP + lane * laneGap }; });
}

/** "about 40 min" reads as "~40 min" on the map; the full text stays in the tooltip and the list. */
const shortLead = (t: string | null) => t === null ? "unknown" : t.replace(/^about\s+/i, "~");
const STATE_WORD: Record<WaypointView["state"], string> = { planned: "planned", todo: "to do", doing: "in progress", blocked: "blocked", reported: "reported", verified: "verified", rejected: "rejected", accepted: "accepted", done: "done", skipped: "skipped", waived: "waived" };
const CHECK_WORD = { warden: "Warden check", keeper: "Keeper accepts", none: "no check", you: "you mark done" };

export const checkWord = (waypoint: Pick<WaypointView, "actor" | "check">) => CHECK_WORD[waypointCheck(waypoint)];

type Owner = { kind: "member" | "proposed" | "class" | "you" | "outside"; name: string; identity: ReturnType<typeof memberIdentity>; level?: Level | null };
function ownerOf(w: WaypointView, quest: BoardQuestSummary, registry: Registry | undefined): Owner {
  if (w.actor === "user") return { kind: "you", name: "You", identity: null };
  if (w.actor === "outside") return { kind: "outside", name: w.owner ?? "Outside owner", identity: null };
  if (keeperSubject(w)) return { kind: "class", name: "The Keeper", identity: null };
  if (w.ownerMember && registry) { const identity = memberIdentity(registry, w.ownerMember); return { kind: "member", name: identity?.character.name ?? memberName(w.ownerMember, registry), identity, level: levelFor(registry, w.ownerMember.characterId, w.ownerMember.classId) }; }
  const slot = quest.plan?.party.find(p => p.waypointIds.includes(w.id));
  const cls = registry?.classes.find(c => c.id === (slot?.classId ?? w.owner));
  const character = slot?.characterId ? registry?.characters.find(c => c.id === slot.characterId) : undefined;
  if (cls && character) return { kind: "proposed", name: character.name, identity: { cls, character } };
  return { kind: "class", name: cls ? `A ${cls.label}` : w.owner ?? "Unassigned", identity: cls ? { cls, character: { id: "x", name: cls.label, hue: "ink", charge: "pale" } as never } : null };
}

type MemberCredits = NonNullable<BoardQuestDetail["memberCredits"]>;

/** "Lark made · Vex verified": credited members first, then the waypoint's own owner and verifier, then the class word; never a guessed name. */
function creditLine(w: WaypointView, owner: Owner, quest: BoardQuestSummary, registry: Registry | undefined, credits: MemberCredits) {
  if (w.actor === "user") return `Your move · ${STATE_WORD[w.state]}`;
  if (w.actor === "outside") return `${owner.name} · ${STATE_WORD[w.state]}`;
  const nameOf = (threadId: string | null) => { const m = threadId ? quest.members.find(x => x.threadId === threadId) : undefined; return m && registry ? memberIdentity(registry, m)?.character.name ?? null : null; };
  const madeRow = credits.find(c => c.madeWaypointIds.includes(w.id));
  const verifiedRow = credits.find(c => c.verifiedWaypointIds.includes(w.id));
  if (keeperSubject(w)) {
    const checker = verifiedWaypoint(w) ? quest.members.find(m => m.threadId === w.verifiedBy) : undefined;
    const verdict = verifiedWaypoint(w) ? `${nameOf(w.verifiedBy) ?? "A Warden"} verified` : STATE_WORD[w.state];
    const posture = verifiedWaypoint(w) ? reviewLimitation(checker?.checkIndependence) ?? (checker?.checkIndependence === "independent" ? "different-family check" : "check independence not established") : null;
    const subject = w.evidenceCount > 0 ? "Subject recorded by the Keeper" : "Keeper records the subject";
    return `${subject} · ${verdict}${posture ? ` · ${posture}` : ""}`;
  }
  const classed = owner.kind === "class" ? owner.name.replace(/^A /, "a ") : owner.name;
  const maker = madeRow ? nameOf(madeRow.memberThreadId) ?? classed : classed;
  const checker = verifiedWaypoint(w) ? nameOf(verifiedRow?.memberThreadId ?? w.verifiedBy) ?? "a Warden" : null;
  const made = ["reported", "verified", "rejected"].includes(w.state) || madeRow ? `${maker} made` : maker;
  return `${made} · ${checker ? `${checker} verified` : STATE_WORD[w.state]}`;
}

export type Figure = { label: string; value: string; title?: string; note?: string };
const span = (ms: number) => { const m = Math.max(1, Math.round(ms / 60000)); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`; return `${Math.floor(h / 24)}d ${h % 24}h`; };
/** The tale's figures, from the data: path verified, party, pickup to return and checks. The page and the thread card both read these, so they agree. */
export function taleFigures({ quest, tale, memberCredits: credits }: Pick<BoardQuestDetail, "quest" | "tale" | "memberCredits">): Figure[] {
  // The agents' path: the same rule as every "verified" label, with skipped waypoints named, never counted as verified.
  const path = verifiedOf({ waypoints: quest.waypoints.filter(w => w.actor === "agent") });
  const party = quest.members.filter(m => !m.errand);
  const figures: Figure[] = [{ label: "path verified", value: path ? verifiedWords(path, "") : "0 of 0" }, { label: "party", value: String(party.length), title: party.length === 1 ? "1 member" : `${party.length} members` }];
  const end = tale?.wrappedAt ?? quest.endedAt;
  if (end) figures.push({ label: quest.phase === "stopped" ? "pickup to stop" : "pickup to return", value: span(end - quest.createdAt), title: `${new Date(quest.createdAt).toLocaleString()} to ${new Date(end).toLocaleString()}` });
  const wardens = party.filter(m => m.classId === "warden");
  if (wardens.length) {
    const checksBy = (m: (typeof wardens)[number]) => credits ? credits.find(c => c.memberThreadId === m.threadId)?.verifiedWaypointIds.length ?? 0 : 1;
    // A check counts as independent only when it was shown to be; "not established" is never rounded up to independent.
    const count = (posture: "same-family" | "not-established") => wardens.filter(m => m.checkIndependence === posture).reduce((n, m) => n + checksBy(m), 0);
    const same = count("same-family"), unknown = count("not-established");
    const independent = wardens.filter(m => m.checkIndependence !== "same-family" && m.checkIndependence !== "not-established").reduce((n, m) => n + checksBy(m), 0);
    const parts = [independent ? `${independent} independent` : "", same ? `${same} same-family` : "", unknown ? `${unknown} independence not established` : ""].filter(Boolean);
    const caveats = [same ? "Same-family checks used a model from the builder’s family: they are not independent." : "", unknown ? "For some checks, Tavern couldn't establish that the Warden's model differs in family from the builder's." : ""].filter(Boolean).join(" ");
    if (parts.length) figures.push({ label: same + independent + unknown === 1 ? "check" : "checks", value: parts.join(" · "), title: caveats || undefined });
  }
  return figures;
}
/** A row of figures, label over value as in `Kpi`: the value carries the weight, the label stays plain. */
export function FigureRow({ figures, compact = false }: { figures: Figure[]; compact?: boolean }) {
  return <dl className={`tfig ${compact ? "compact" : ""}`}>{figures.map(f => <div key={f.label} title={f.title}><dt>{f.label}</dt><dd>{f.value}{f.note && <span className="tfig-note">{f.note}</span>}</dd></div>)}</dl>;
}

function Mark({ w, owner, size = 30 }: { w: WaypointView; owner: Owner; size?: number }) {
  if (owner.kind === "you") return <svg className="wp-mark you" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 22.5 12 12 22.5 1.5 12Z" /><path className="in" d="M12 7.5 16.5 12 12 16.5 7.5 12Z" /></svg>;
  if (owner.kind === "outside") return <svg className="wp-mark gate" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path className="post" d="M4 22V5M20 22V5" /><path className="lintel" d="M2.5 5.5h19M2.5 9h19" /><path className="bar" d="M7 13h10M7 17h10" /></svg>;
  if (owner.kind === "member" && owner.identity) return <Crest {...owner.identity} size={size} level={owner.level?.level} title={`${owner.name}, ${owner.identity.cls.label}${owner.level?.notches && size >= 24 ? `, level ${owner.level.level}` : ""}`} />;
  const shape = owner.identity ? SHAPE_PATHS[owner.identity.cls.shape] : SHAPE_PATHS.shield;
  return <svg className={`wp-mark ${owner.kind === "proposed" ? "proposed" : "open"}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={shape} /></svg>;
}

/** The quest map: one route in dependency order; each owner's mark stands on the waypoint it owns. Columns are order, not a promised ETA. */
/** `memberCredits` (tale mode) names who made and verified each waypoint; `stretch` spreads the route across the full width with two-line labels. */
export function QuestMap({ quest, mode, dealt = false, memberCredits: credits, stretch = false, showChecks = mode === "plan", rowsOnly = false, showAll = false }: { quest: BoardQuestSummary; mode: "plan" | "live" | "tale"; dealt?: boolean; memberCredits?: BoardQuestDetail["memberCredits"]; stretch?: boolean; showChecks?: boolean; rowsOnly?: boolean; showAll?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const registry = useRegistry();
  const container = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => { const node = container.current; if (!node || typeof ResizeObserver === "undefined") return; const observer = new ResizeObserver(entries => { const entry = entries[0]; if (entry) setAvailableWidth(entry.contentRect.width); }); observer.observe(node); return () => observer.disconnect(); }, []);
  let nodes: ReturnType<typeof layoutWaypoints>;
  try { nodes = layoutWaypoints(quest.waypoints, showChecks ? 116 : LANE); } catch (error) { return <p className="problem" role="alert">{String(error instanceof Error ? error.message : error)}</p>; }
  const shown = showAll || expanded ? nodes : nodes.slice(0, 8);
  const natural = Math.max(...shown.map(n => n.x + PAD_X));
  const columns = Math.max(...shown.map(n => n.column)) + 1;
  const spread = stretch && availableWidth > natural;
  // Spread waypoints evenly, inset the ends by half a label so the first and last labels stay inside the card.
  const roughStep = columns > 1 ? (availableWidth - 2 * PAD_X) / (columns - 1) : availableWidth;
  const wideLabel = Math.min(Math.max(COL, roughStep) - 12, 220);
  const pad = spread ? Math.max(PAD_X, wideLabel / 2 + 2) : PAD_X;
  const step = spread ? (columns > 1 ? (availableWidth - 2 * pad) / (columns - 1) : 0) : COL;
  const labelW = spread ? Math.max(COL - 8, Math.min(wideLabel, step - 12)) : COL - 8;
  const labelH = showChecks ? 82 : 64;
  const visible = spread ? shown.map(n => ({ ...n, x: columns > 1 ? pad + n.column * step : availableWidth / 2 })) : shown;
  const width = spread ? availableWidth : natural;
  const height = Math.max(...visible.map(n => n.y)) + labelH + 20;
  const byId = new Map(visible.map(n => [n.waypoint.id, n]));
  // With credits, a waypoint's mark is the member who made it, not the class the plan proposed.
  const owners = new Map(visible.map(n => {
    const planned = ownerOf(n.waypoint, quest, registry.data);
    const row = credits && (planned.kind === "class" || planned.kind === "proposed") ? credits.find(c => c.madeWaypointIds.includes(n.waypoint.id)) : undefined;
    const maker = row ? quest.members.find(m => m.threadId === row.memberThreadId) : undefined;
    const identity = maker && registry.data ? memberIdentity(registry.data, maker) : null;
    return [n.waypoint.id, identity ? { kind: "member" as const, name: identity.character.name, identity } : planned];
  }));
  const narrow = availableWidth > 0 && availableWidth < Math.min(natural, 520);
  const credit = (w: WaypointView) => credits ? creditLine(w, owners.get(w.id)!, quest, registry.data, credits) : null;
  const describe = (w: WaypointView) => { const o = owners.get(w.id)!; return `${w.title}: ${o.name}, ${resolutionWords(w)}${showChecks ? `, ${checkWord(w)}` : ""}, lead time ${w.leadTime ?? "unknown"}`; };
  return (
    <section ref={container} className={`tavern quest-map-container qmap m-${mode} ${rowsOnly || narrow ? "list-only" : ""} ${dealt ? "dealt" : ""} ${stretch ? "stretch" : ""}`} data-part="QuestMap" aria-label={`Quest map: ${quest.title}`}>
      {showChecks && !quest.waypoints.some(w => waypointCheck(w) === "warden") && <p className="wp-check-note m">No Warden checks on this map</p>}
      {!rowsOnly && <svg className="qsvg" viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: spread ? "none" : width }} role="img" aria-label={visible.map(({ waypoint }) => [describe(waypoint), credit(waypoint)].filter(Boolean).join(", ")).join("; ")}>
        {visible.flatMap(n => n.waypoint.dependsOn.map(id => { const from = byId.get(id); if (!from) return null; const mx = (from.x + n.x) / 2; const done = settled(from.waypoint); return <path key={`${id}-${n.waypoint.id}`} className={`road ${done ? "done" : ""}`} d={from.y === n.y ? `M${from.x + 18} ${from.y}H${n.x - 18}` : `M${from.x + 18} ${from.y}C${mx} ${from.y} ${mx} ${n.y} ${n.x - 18} ${n.y}`} />; }))}
        {visible.map((n, i) => { const w = n.waypoint; const o = owners.get(w.id)!; return (
          <g key={w.id} className={`wp s-${w.state} o-${o.kind}`} style={{ ["--i" as string]: i }}>
            {(w.state === "doing" || w.state === "reported" || w.state === "blocked" || w.state === "rejected") && <rect className="ring" x={n.x - 19} y={n.y - 19} width={38} height={38} />}
            <foreignObject className="wp-fo" x={n.x - 16} y={n.y - 16} width={32} height={32}><Mark w={w} owner={o} size={32} /></foreignObject>
            {verifiedWaypoint(w) && <g className="ok" transform={`translate(${n.x + 10} ${n.y - 20})`}><rect width="12" height="12" /><path d="M2.5 6.2 5 8.6 9.6 3.4" /></g>}
            <foreignObject x={n.x - labelW / 2} y={n.y + 19} width={labelW} height={labelH}>
              <div className="map-label" title={`${describe(w)}${credit(w) ? ` · ${credit(w)}` : ""}`}><b className="clamp">{w.title}</b>{credit(w) ? <span className={`o o-${o.kind} o-credit`}><span className="m clamp">{credit(w)}</span></span> : <span className={`o o-${o.kind}`}>{o.name}{!showChecks && <span className="m"> · {mode === "tale" ? (verifiedWaypoint(w) ? `${w.evidenceCount} evidence` : STATE_WORD[w.state]) : w.state === "planned" || w.state === "todo" ? shortLead(w.leadTime) : STATE_WORD[w.state]}</span>}</span>}{showChecks && <span className="wp-check m">{checkWord(w)}</span>}</div>
            </foreignObject>
          </g>
        ); })}
      </svg>}
      <ol className="qlist" aria-label="Waypoints in order">
        {visible.map(({ waypoint: w }) => { const o = owners.get(w.id)!; return (
          <li key={w.id} className={settled(w) ? "done" : w.state === "doing" ? "cur" : ""}>
            <span className="vw"><Mark w={w} owner={o} size={20} /></span>
            <span className="qt"><b>{w.title}</b><span className="m">{credit(w) ?? (o.kind === "you" ? "Your move" : o.kind === "outside" ? `Waits on ${o.name}` : o.kind === "proposed" ? `${o.name} (proposed)` : o.name)}{showChecks && <> · <span className="wp-check">{checkWord(w)}</span></>} · {w.leadTime ?? "lead time unknown"}{w.dependsOn.length > 0 ? ` · after ${w.dependsOn.map(d => d.replace(/^w/, "")).join(", ")}` : ""}{!credit(w) && mode === "tale" ? ` · ${w.evidenceCount} evidence${verifiedWaypoint(w) ? " · verified" : ""}` : ""}</span>{w.rejectedReason && <span className="m">Rejected: {w.rejectedReason}</span>}{w.resolutionReason && <span className="wp-reason m">{w.resolutionReason}</span>}</span>
            <StatusPill status={w.state} mark={w.state === "done" ? "·" : undefined}>{STATE_WORD[w.state]}</StatusPill>
          </li>
        ); })}
      </ol>
      {!showAll && nodes.length > 8 && <button type="button" className="btn sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Fold after 8 waypoints" : `Show ${nodes.length - 8} more waypoints`}</button>}
    </section>
  );
}
