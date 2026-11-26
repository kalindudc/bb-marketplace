import { memberName } from "../../shared/member-name";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { BoardQuestDetail, BoardQuestSummary } from "../../shared/contract";
import { SHAPE_PATHS } from "../../shared/heraldry";
import { keeperSubject, resolutionWords, settled, verifiedWaypoint, waypointCheck, waypointLabel } from "../../shared/waypoint";
import { reviewLimitation } from "../../shared/check-posture";
import { useRegistry, memberIdentity, type Registry } from "./registry";
import { Crest } from "./crest";
import { levelFor, type Level } from "./level";
import { Glyph, type GlyphName } from "./glyphs";
import { buildQuestGraph, gutterFits, gutterLayout, orderWaypoints, PORT_Y, trailLayout } from "./quest-map-layout";
export { layoutWaypoints } from "./quest-map-layout";
import { verifiedOf, verifiedWords } from "./rows";
import { StatusPill } from "./primitives";

type WaypointView = BoardQuestSummary["waypoints"][number];

const CHECK_WORD = { warden: "Warden check", keeper: "Keeper accepts", none: "no check", you: "you mark done" };

export const checkWord = (waypoint: Pick<WaypointView, "actor" | "check">) => CHECK_WORD[waypointCheck(waypoint)];

type Owner = { kind: "member" | "proposed" | "class" | "you" | "outside"; name: string; identity: ReturnType<typeof memberIdentity>; level?: Level | null; threadId?: string };
function ownerOf(w: WaypointView, quest: BoardQuestSummary, registry: Registry | undefined): Owner {
  if (w.actor === "user") return { kind: "you", name: "You", identity: null };
  if (w.actor === "outside") return { kind: "outside", name: w.owner ?? "Outside owner", identity: null };
  if (keeperSubject(w)) return { kind: "class", name: "The Keeper", identity: null };
  if (w.ownerMember && registry) { const identity = memberIdentity(registry, w.ownerMember); return { kind: "member", name: identity?.character.name ?? memberName(w.ownerMember, registry), threadId: w.ownerMember.threadId, identity, level: levelFor(registry, w.ownerMember.characterId, w.ownerMember.classId) }; }
  const slot = quest.plan?.party.find(p => p.waypointIds.includes(w.id));
  const cls = registry?.classes.find(c => c.id === (slot?.classId ?? w.owner));
  const character = slot?.characterId ? registry?.characters.find(c => c.id === slot.characterId) : undefined;
  if (cls && character) return { kind: "proposed", name: character.name, identity: { cls, character } };
  return { kind: "class", name: cls ? `A ${cls.label}` : w.owner ?? "Unassigned", identity: cls ? { cls, character: { id: "x", name: cls.label, hue: "ink", charge: "pale" } as never } : null };
}

type MemberCredits = NonNullable<BoardQuestDetail["memberCredits"]>;

/** "Lark made · Vex verified": credited members first, then the waypoint's own owner and verifier, then the class word; never a guessed name. */
function creditLine(w: WaypointView, owner: Owner, quest: BoardQuestSummary, registry: Registry | undefined, credits: MemberCredits) {
  if (w.actor === "user") return `Your move · ${waypointLabel(w.state)}`;
  if (w.actor === "outside") return `${owner.name} · ${waypointLabel(w.state)}`;
  const nameOf = (threadId: string | null) => { const m = threadId ? quest.members.find(x => x.threadId === threadId) : undefined; return m && registry ? memberIdentity(registry, m)?.character.name ?? null : null; };
  const madeRow = credits.find(c => c.madeWaypointIds.includes(w.id));
  const verifiedRow = credits.find(c => c.verifiedWaypointIds.includes(w.id));
  if (keeperSubject(w)) {
    const checker = verifiedWaypoint(w) ? quest.members.find(m => m.threadId === w.verifiedBy) : undefined;
    const verdict = verifiedWaypoint(w) ? `${nameOf(w.verifiedBy) ?? "A Warden"} verified` : waypointLabel(w.state);
    const posture = verifiedWaypoint(w) ? reviewLimitation(checker?.checkIndependence) ?? (checker?.checkIndependence === "independent" ? "different-family check" : "check independence not established") : null;
    const subject = w.evidenceCount > 0 ? "Subject recorded by the Keeper" : "Keeper records the subject";
    return `${subject} · ${verdict}${posture ? ` · ${posture}` : ""}`;
  }
  const classed = owner.kind === "class" ? owner.name.replace(/^A /, "a ") : owner.name;
  const maker = madeRow ? nameOf(madeRow.memberThreadId) ?? classed : classed;
  const checker = verifiedWaypoint(w) ? nameOf(verifiedRow?.memberThreadId ?? w.verifiedBy) ?? "a Warden" : null;
  const made = ["reported", "verified", "rejected"].includes(w.state) || madeRow ? `${maker} made` : maker;
  return `${made} · ${checker ? `${checker} verified` : waypointLabel(w.state)}`;
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

function Mark({ owner, size }: { owner: Owner; size: number }) {
  if (owner.kind === "you") return <svg className="wp-mark you" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 22.5 12 12 22.5 1.5 12Z" /><path className="in" d="M12 7.5 16.5 12 12 16.5 7.5 12Z" /></svg>;
  if (owner.kind === "outside") return <svg className="wp-mark gate" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path className="post" d="M4 22V5M20 22V5" /><path className="lintel" d="M2.5 5.5h19M2.5 9h19" /><path className="bar" d="M7 13h10M7 17h10" /></svg>;
  if (owner.kind === "member" && owner.identity) return <Crest {...owner.identity} size={size} level={owner.level?.level} title={`${owner.name}, ${owner.identity.cls.label}${owner.level?.notches && size >= 24 ? `, level ${owner.level.level}` : ""}`} />;
  const shape = owner.identity ? SHAPE_PATHS[owner.identity.cls.shape] : SHAPE_PATHS.shield;
  return <svg className={`wp-mark ${owner.kind === "proposed" ? "proposed" : "open"}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={shape} /></svg>;
}

type MapProps = { quest: BoardQuestSummary; mode: "plan" | "live" | "tale"; dealt?: boolean; memberCredits?: BoardQuestDetail["memberCredits"]; stretch?: boolean; showChecks?: boolean; rowsOnly?: boolean; drawn?: boolean; onOpenAsk?: (id: string) => void };
const STATE_GLYPH: Record<WaypointView["state"], GlyphName> = { planned: "st-none", todo: "st-none", doing: "st-work", blocked: "block", reported: "st-wait", verified: "verified", rejected: "rejected", accepted: "check", done: "check", skipped: "st-none", waived: "st-none" };
const CHECK_GLYPH: Record<ReturnType<typeof waypointCheck>, GlyphName> = { warden: "verified", keeper: "shield", none: "st-none", you: "ask" };

function ownerKey(w: WaypointView, owner: Owner) {
  if (owner.kind === "member") return owner.threadId;
  if (owner.kind === "proposed") return `character:${owner.identity?.character.id}`;
  if (owner.kind === "you" || owner.kind === "outside" || keeperSubject(w)) return `${owner.kind}:${owner.name}`;
  return undefined;
}

export function QuestMap(props: MapProps) {
  const { quest, mode } = props;
  const result = useMemo(() => {
    try { return { graph: buildQuestGraph(quest.waypoints, mode === "live"), rows: orderWaypoints(quest.waypoints) }; }
    catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
  }, [quest.waypoints, mode]);
  if (result.error !== undefined) return <p className="problem" role="alert">{result.error}</p>;
  return <QuestRoute {...props} graph={result.graph} rows={result.rows} />;
}

function QuestRoute({ quest, mode, dealt = false, memberCredits: credits, stretch = false, showChecks = mode === "plan", rowsOnly = false, drawn = false, onOpenAsk, graph, rows }: MapProps & { graph: ReturnType<typeof buildQuestGraph>; rows: WaypointView[] }) {
  const registry = useRegistry();
  const keyboardHelp = useId();
  const container = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const active = hovered ?? focused;
  const trail = !rowsOnly && width > 0 && !gutterFits(graph, width);
  const layout = useMemo(() => rowsOnly ? null : trail ? trailLayout(graph, heights, width) : gutterLayout(graph, heights, width, stretch), [graph, heights, width, stretch, trail, rowsOnly]);

  useLayoutEffect(() => {
    const section = container.current, ordered = list.current;
    if (!section || !ordered || rowsOnly) return;
    const cards = Array.from(ordered.children) as HTMLElement[];
    const measure = (available: number) => {
      if (available > 0) setWidth(available);
      const next = new Map(cards.map(card => [card.dataset.waypoint!, card.getBoundingClientRect().height]));
      if ([...next.values()].some(h => h === 0)) return;
      setHeights(prev => next.size === prev.size && [...next].every(([id, h]) => prev.get(id) === h) ? prev : next);
    };
    measure(section.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => measure(entries.find(e => e.target === section || !e.target)?.contentRect.width ?? section.getBoundingClientRect().width));
    observer.observe(section);
    cards.forEach(card => observer.observe(card, { box: "border-box" }));
    return () => observer.disconnect();
  }, [graph, rowsOnly, stretch, width]);

  const members = useMemo(() => new Map(quest.members.map(m => [m.threadId, m])), [quest.members]);
  const owners = useMemo(() => {
    const makers = new Map(credits?.flatMap(c => c.madeWaypointIds.map(id => [id, c.memberThreadId] as const)));
    return new Map(quest.waypoints.map(w => {
      const owner = ownerOf(w, quest, registry.data);
      const maker = owner.kind === "class" || owner.kind === "proposed" ? members.get(makers.get(w.id) ?? "") : undefined;
      const identity = maker && registry.data ? memberIdentity(registry.data, maker) : null;
      return [w.id, identity && maker ? { kind: "member" as const, name: identity.character.name, threadId: maker.threadId, identity } : owner];
    }));
  }, [credits, members, quest, registry.data]);
  const byId = new Map(rows.map(w => [w.id, w]));
  const peer = active && byId.has(active) ? ownerKey(byId.get(active)!, owners.get(active)!) : undefined;
  const ordered = layout ? [...layout.cards.keys()].map(id => byId.get(id)!) : rows;
  const tabStop = cursor && byId.has(cursor) ? cursor : ordered[0]?.id;
  const moveFocus = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? ordered.length - 1
      : event.key === "ArrowRight" || event.key === "ArrowDown" ? Math.min(index + 1, ordered.length - 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? Math.max(index - 1, 0) : null;
    if (next === null) return;
    event.preventDefault();
    (list.current?.children[next] as HTMLElement | undefined)?.focus();
  };
  const onLitRoad = new Set(graph.lit);
  const labelled = `${drawn ? "Drawn quest map" : "Quest map"}: ${quest.title}`;
  return <section ref={container} aria-label={labelled} className={`tavern quest-map-container qmap m-${mode}${drawn ? " drawn" : ""}${dealt ? " dealt" : ""}${stretch ? " stretch" : ""}${trail ? " trail" : ""}`} data-part="QuestMap">
    {showChecks && !quest.waypoints.some(w => waypointCheck(w) === "warden") && <p className="wp-check-note m">No Warden checks on this map</p>}
    {layout && layout.roads.length > 0 && mode !== "tale" && <div className="map-key m">
      {graph.lit.length > 0 && <RoadKey tone="lit">Most steps left ({graph.lit.length})</RoadKey>}
      <RoadKey tone="ahead">Ahead</RoadKey><RoadKey tone="walked">Walked</RoadKey>
    </div>}
    {layout && <span className="sr" id={keyboardHelp}>Use the arrow keys to move between waypoints.</span>}
    <div className="qm-canvas" style={layout ? { width: layout.width, height: layout.height, "--qm-port-y": `${PORT_Y}px` } as CSSProperties : undefined}>
      {layout && <svg className={`qsvg${active ? " linking" : ""}`} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
        {[...layout.roads.filter(road => !road.lit), ...layout.roads.filter(road => road.lit)].map(road => <path key={JSON.stringify([road.from, road.to])} className={`road ${road.lit ? "lit" : road.walked ? "walked" : "ahead"}${road.from === active || road.to === active ? " on" : ""}`} d={road.path} />)}
        {layout.dots.map(({ id, x, y }) => {
          const state = byId.get(id)!.state;
          const className = `qm-port${onLitRoad.has(id) ? " lit" : ""}${graph.needsYou.has(id) ? " your-move" : ""}`;
          return trail && (state === "blocked" || state === "rejected")
            ? <rect key={id} x={x - 4} y={y - 4} width={8} height={8} className={`${className} ${state}`} />
            : <circle key={id} cx={x} cy={y} r={trail ? 5 : 3} className={className} />;
        })}
      </svg>}
      <ol ref={list} className={layout ? "qm-cards" : "qm-rows"} role="list" aria-label="Waypoints in order">
        {ordered.map((w, i) => {
          const owner = owners.get(w.id)!;
          const box = layout?.cards.get(w.id);
          const { askId } = w;
          const yourMove = mode !== "tale" && graph.needsYou.has(w.id);
          const state = waypointLabel(w.state);
          const ownerName = owner.kind === "proposed" ? `${owner.name} (proposed)` : owner.name;
          const check = waypointCheck(w);
          const timing = [w.leadTime ?? "lead time unknown", w.dependsOn.length ? `after ${w.dependsOn.map(d => d.replace(/^w/, "")).join(", ")}` : null].filter(Boolean).join(" · ");
          const credit = credits && creditLine(w, owner, quest, registry.data, credits);
          const verifier = w.verifiedBy ? members.get(w.verifiedBy) : undefined;
          const proof = w.state === "accepted" ? `Accepted by ${w.acceptedBy ?? "the Keeper"}; no Warden check`
            : !credit && verifiedWaypoint(w) ? `Verified by ${verifier ? memberName(verifier, registry.data ?? { classes: [], characters: [] }) : "a Warden"}` : null;
          const ask = askId && onOpenAsk && <button type="button" className="btn sm wp-ask" aria-label={`Answer ask: ${w.title}`} onClick={() => onOpenAsk(askId)}><Glyph name="ask" />Answer ask</button>;
          if (!layout) return <li key={w.id} className={`wp${settled(w) ? " settled" : ""}${w.state === "doing" ? " cur" : ""}${yourMove ? " your-move" : ""}`}>
            <span className="qm-crest" aria-hidden="true"><Mark owner={owner} size={20} /></span>
            <div className="qm-row-text" data-content><b>{w.title}</b>
              <span className="qm-row-meta m">{credit || (yourMove ? "Your move" : owner.kind === "outside" ? `Waits on ${ownerName}` : ownerName)}{showChecks && <> · <span className="wp-check">{checkWord(w)}</span></>} · {timing}{mode === "tale" && !credits && ` · ${w.evidenceCount} evidence`}</span>
              {proof && <span className="qm-row-meta m">{proof}</span>}
              {w.rejectedReason && <span className="qm-row-meta m">Rejected: {w.rejectedReason}</span>}
              {w.resolutionReason && <span className="qm-row-meta m">{w.resolutionReason}</span>}{ask}
            </div>
            {!(mode === "plan" && w.state === "planned") && <StatusPill status={w.state} mark={w.state === "done" ? "·" : undefined}>{waypointLabel(w.state)}</StatusPill>}
          </li>;
          return <li key={w.id} data-waypoint={w.id} tabIndex={w.id === tabStop ? 0 : -1} aria-describedby={w.id === tabStop ? keyboardHelp : undefined}
            className={`wp o-${owner.kind} s-${w.state}${settled(w) ? " settled" : ""}${yourMove ? " your-move" : ""}${peer && w.id !== active && ownerKey(w, owner) === peer ? " peer" : ""}`}
            style={box ? { left: box.x, top: box.y, width: box.width, "--i": i } as CSSProperties : undefined}
            onPointerEnter={e => { if (e.pointerType !== "touch") setHovered(w.id); }} onPointerLeave={() => setHovered(null)}
            onKeyDown={e => moveFocus(e, i)} onFocus={e => { setHovered(null); setFocused(w.id); if (e.target === e.currentTarget) setCursor(w.id); }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(null); }}>
            <span className="qm-crest" aria-hidden="true"><Mark owner={owner} size={24} /></span>
            <div className="qm-step">
              <div className="qm-heading"><span className="qm-number num m" aria-label={`Waypoint ${w.id.replace(/^w/, "")}`}>{w.id.replace(/^w/, "")}</span><b className="qm-title" data-content>{w.title}</b></div>
              <div className="qm-meta">
                <span className="qm-owner" title={owner.identity?.cls.label}>{ownerName}{yourMove && owner.kind !== "you" ? " · Your move" : ""}</span>
                <span className="qm-state" title={resolutionWords(w)}><Glyph name={yourMove ? "ask" : STATE_GLYPH[w.state]} />{state}</span>
                <span className="wp-check"><Glyph name={CHECK_GLYPH[check]} />{checkWord(w)}</span>
              </div>
              {credit && <p className="qm-detail m">{credit}</p>}
              {proof && <p className="qm-detail m">{proof}</p>}
              <p className="qm-detail m">{timing}{mode === "tale" && !credits && ` · ${w.evidenceCount} evidence`}</p>
              {w.rejectedReason && <p className="qm-detail m" data-content>Rejected: {w.rejectedReason}</p>}
              {w.resolutionReason && <p className="qm-detail m" data-content>{w.resolutionReason}</p>}
              {!w.resolutionReason && w.state === "done" && <span className="sr">{resolutionWords(w)}</span>}
              {ask}
            </div>
          </li>;
        })}
      </ol>
    </div>
  </section>;
}

function RoadKey({ tone, children }: { tone: "lit" | "ahead" | "walked"; children: ReactNode }) {
  return <span><svg viewBox="0 0 24 8" width="24" height="8" aria-hidden="true"><path className={`road ${tone}`} d="M1 4H23" /></svg>{children}</span>;
}
