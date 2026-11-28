import { memberIdentityLabel, memberKeeperIds } from "../../shared/identity";
import { hasEndedEngagement, memberActivityWord } from "../../shared/member-engagement";
import { experimental_useRpcQuery, experimental_copyToClipboard, experimental_saveFile, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { rpcContract, type Room } from "../../shared/contract";
import type { Member } from "../../shared/schema";
import { verifiedOf, verifiedWords, CheckIndependence, ExpandsMark, GuardPosture, OpensMark, OverflowMenu, endedCounts, glowVars, keeperStartedLabel, keeperStatus, useToday, type StateTone } from "../kit";
import { CrestOf, Section, StateMark, characterName, classLabel, type Registry, plural } from "./common";
import { rememberCount, timeAgo, useNow } from "../kit";
import { pathChangeWords } from "../kit/rows";
import { PageGlyph } from "./glyphs";
import { MapViewport, mapSvg, svgToPng, textMeasurer, type Box } from "./mapview";
import { boardQuestState, graphFor, isFinished, mapPicture, mapQuests, pathProgress, phaseWord, type MapNode, type PictureNode } from "./model";
import { usePanelState } from "./panel-state";
import { SKEL } from "./skeletons";

const ROW = 58, NODE_H = 44, HEAD = 30, PAD = 12, GUT = 36;
// A squeezed node lets its second line wrap to two lines, so a state is never cut; its rows keep the same 14 px gap.
const ROW_TALL = 70, NODE_H_TALL = 56;
const HEADINGS = ["Keepers", "Quests", "Party and asks", "Waiting on"];
// Natural column widths: the window zooms and pans, so the picture never squeezes its text to fit the screen.
// The Keeper column is wide enough for its longest status, "Thread archived".
const COLS = [174, 198, 238, 174];
// A small squeeze that saves panning (two columns in a phone's window) is worth some truncated names; a bigger one is not.
const MIN_SCALE = 0.75, MIN_COL = 120;

/** The used columns scaled down to fit a window `avail` px wide, when the squeeze is small; otherwise the natural widths, and the window pans. */
export function fitColumns(cols: readonly number[], used: readonly number[], avail: number): number[] {
  const sum = used.reduce((a, c) => a + cols[c]!, 0), fixed = PAD * 2 + Math.max(0, used.length - 1) * GUT;
  if (!avail || fixed + sum <= avail) return [...cols];
  const scale = (avail - fixed) / sum;
  if (scale < MIN_SCALE || used.some((c) => Math.floor(cols[c]! * scale) < MIN_COL)) return [...cols];
  return cols.map((w, c) => used.includes(c) ? Math.floor(w * scale) : w);
}

/** One honest name for the finished group: "Finished" when it holds returned and stopped quests, else "Returned" or "Stopped". */
export function finishedWord(phases: readonly string[]): "Finished" | "Returned" | "Stopped" {
  const returned = phases.includes("done"), stopped = phases.includes("stopped");
  return returned && stopped ? "Finished" : stopped ? "Stopped" : "Returned";
}

function memberSub(registry: Registry, m: Member, status = memberActivityWord(m), keeper?: Member) {
  const cls = classLabel(registry, m.classId);
  return `${keeper ? `${memberIdentityLabel(keeper, registry)}'s ` : ""}${cls ? `${cls.label} (${cls.plain})` : "Unknown class"} · ${status}`;
}

type Laid = { n: PictureNode; x: number; y: number; w: number; h: number; label: string; sub: string; title: string; focused: boolean; tall: boolean };
/** One layout for the screen and the export, so a shared image matches what the user saw. */
/** `now` dates a returned quest's "3h ago": TheMap is memoized, so it passes its own minute clock rather than reading the time here. */
function layoutMap(picture: ReturnType<typeof mapPicture>, registry: Registry, keepers: ReadonlyMap<string, Member>, focus: string | null, cols: readonly number[], now: number) {
  const crossParty = memberKeeperIds(picture.nodes.map(n => n.node?.member)).size > 1;
  const tall = crossParty || picture.nodes.some(n => n.kind === "quest" && n.node?.quest?.pathChange) || cols.some((w, i) => w < COLS[i]!), rowH = tall ? ROW_TALL : ROW, nodeH = tall ? NODE_H_TALL : NODE_H;
  const used = [...new Set(picture.nodes.map((n) => n.col))].sort();
  const slot = new Map(used.map((c, i) => [c, i]));
  const cw = used.map((c) => cols[c]!);
  const x = (col: number) => { const i = slot.get(col)!; return PAD + cw.slice(0, i).reduce((a, b) => a + b, 0) + i * GUT; };
  const wOf = (col: number) => cw[slot.get(col)!]!;
  const width = PAD * 2 + cw.reduce((a, b) => a + b, 0) + Math.max(0, used.length - 1) * GUT;
  const y = (row: number) => HEAD + row * rowH;
  const height = HEAD + picture.rows * rowH + 4;
  const byId = new Map(picture.nodes.map((n) => [n.id, n]));
  const label = (n: PictureNode) => n.label;
  const sub = (n: PictureNode) => {
    const m = n.node?.member;
    if (n.kind === "keeper") return n.sub.charAt(0).toUpperCase() + n.sub.slice(1) + (n.node?.loading ? " · Loading history…" : "");
    if (n.kind === "solo" && m) return `${classLabel(registry, m.classId)?.label ?? "Solo"} · ${m.state}`;
    const keeper = crossParty && m?.keeperThreadId ? keepers.get(m.keeperThreadId) : undefined;
    if (n.kind === "member" && m) return memberSub(registry, m, n.sub, keeper);
    if (n.kind === "errand" && m) {
      const task = `Errand · ${m.title ?? m.state}`;
      return keeper ? memberSub(registry, m, task, keeper) : task;
    }
    if (n.kind === "returned" && n.node?.quest) { const q = n.node.quest; const v = verifiedOf(q); return `${q.archivedAt != null ? "Archived · " : ""}${phaseWord(q.phase)}${v ? ` · ${verifiedWords(v)}` : ""} · ${timeAgo(q.endedAt ?? q.updatedAt, now)}`; }
    if (n.kind === "quest" && n.node?.quest) { const q = n.node.quest; const path = pathProgress(q), change = pathChangeWords(q); return `${phaseWord(q.phase)} · ${path ? `${path.done} of ${path.total}` : "no map yet"}${path && change ? `, ${change}` : ""}${n.folded ? ` · +${n.folded} members` : ""}`; }
    if (n.kind === "outside" && n.node) return n.node.detail;
    if (n.kind === "gate") return "outside gate";
    return n.sub;
  };
  const nodes: Laid[] = picture.nodes.map((n) => {
    const l = label(n), s = sub(n);
    const title = n.kind === "quest" ? `Focus on ${n.node?.quest?.title ?? l}` : n.kind === "returned" ? `${n.node?.quest?.phase === "done" ? "Open the tale" : "Open the quest page"}: ${n.node?.quest?.title ?? l}` : n.kind === "you" || n.kind === "blocked" ? `${l}: ${n.asks!.map((a) => a.question).join(" · ")}` : n.node?.threadId ? `Open ${l}'s thread · ${s}` : `${l} · ${s}`;
    return { n, x: x(n.col), y: y(n.row), w: wOf(n.col), h: nodeH, label: l, sub: s, title, focused: n.kind === "quest" && n.questId === focus, tall };
  });
  const edges = picture.edges.map((e) => { const a = byId.get(e.from)!, b = byId.get(e.to)!; const x1 = x(a.col) + wOf(a.col), y1 = y(a.row) + nodeH / 2, x2 = x(b.col), y2 = y(b.row) + nodeH / 2, mx = (x1 + x2) / 2; return { key: `${e.from}>${e.to}`, from: e.from, to: e.to, d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, hot: e.hot, dashed: e.dashed, quiet: e.quiet }; });
  const returnedOnly = !picture.nodes.some((n) => n.col === 1 && n.kind !== "returned");
  const finished = finishedWord(picture.nodes.filter((n) => n.kind === "returned").map((n) => n.node?.quest?.phase ?? "done"));
  const headings = used.map((c) => ({ x: x(c), y: 0, w: wOf(c), text: c === 1 && returnedOnly ? `${finished} quests` : HEADINGS[c]! }));
  const firstSolo = picture.nodes.find((n) => n.kind === "solo");
  if (firstSolo) headings.push({ x: x(0), y: y(firstSolo.row) - 20, w: wOf(0), text: "Solos" });
  return { width, height, nodes, edges, headings };
}
type Layout = ReturnType<typeof layoutMap>;

/** The focused quest and its one hop: the nodes on its highlighted roads. With `framed` (Only this one), that quest and its Keeper. */
function focusBox(layout: Layout, framed: string | null = null): Box | null {
  const target = framed ? layout.nodes.find((l) => l.n.questId === framed && (l.n.kind === "returned" || l.n.kind === "quest")) : undefined;
  if (target) {
    const keeper = layout.nodes.find((l) => l.n.kind === "keeper" && l.n.node?.threadId === target.n.node?.quest?.keeperThreadId);
    const pair = keeper ? [target, keeper] : [target];
    const x = Math.min(...pair.map((l) => l.x)), y = Math.min(...pair.map((l) => l.y));
    return { x, y, w: Math.max(...pair.map((l) => l.x + l.w)) - x, h: Math.max(...pair.map((l) => l.y + l.h)) - y, lx: x, ay: target.y + target.h / 2 };
  }
  const ids = new Set(layout.edges.filter((e) => e.hot).flatMap((e) => [e.from, e.to]));
  const hit = layout.nodes.filter((l) => ids.has(l.n.id) || l.focused);
  if (!hit.length) return null;
  const x = Math.min(...hit.map((l) => l.x)), y = Math.min(...hit.map((l) => l.y));
  const lead = layout.nodes.find((l) => l.focused) ?? hit[0]!;
  return { x, y, w: Math.max(...hit.map((l) => l.x + l.w)) - x, h: Math.max(...hit.map((l) => l.y + l.h)) - y, lx: lead.x, ay: lead.y + lead.h / 2 };
}

/** Column widths for the export: wide enough for every label and line in that column, never narrower than on screen. */
function exportColumns(layout: Layout, measure: (text: string, size: number, bold?: boolean) => number) {
  const cols = [...COLS];
  for (const l of layout.nodes) {
    const marked = !!l.n.node?.member || ["you", "blocked", "gate", "returned"].includes(l.n.kind);
    const need = (marked ? 38 : 10) + Math.max(measure(l.label, 12, true), measure(l.sub, 11)) + 16;
    cols[l.n.col] = Math.max(cols[l.n.col]!, Math.ceil(need));
  }
  return cols;
}

function MapPicture({ layout, registry, setFocus }: { layout: Layout; registry: Registry; setFocus: (id: string) => void }) {
  const navigate = useBbNavigate();
  const open = (n: PictureNode) => {
    if (n.kind === "quest" && n.questId) return setFocus(n.questId);
    if ((n.kind === "returned" || n.kind === "more") && n.node?.subPath) return navigate.toPluginPanel("tavern", { subPath: n.node.subPath });
    if ((n.kind === "you" || n.kind === "blocked") && n.questId) return navigate.toPluginPanel("tavern", { subPath: `quest/${n.questId}` });
    if (n.kind === "you" || n.kind === "blocked") return navigate.toPluginPanel("tavern", { subPath: "room" });
    if (n.node?.threadId) return navigate.toThread(n.node.threadId);
    if (n.questId) return navigate.toPluginPanel("tavern", { subPath: `quest/${n.questId}` });
  };
  return <div className="tv-mappic" style={{ height: layout.height, width: layout.width }}>
    <svg className="tv-mapedges" width={layout.width} height={layout.height} aria-hidden="true">
      {layout.edges.map((e) => <path key={e.key} className={`tv-road ${e.hot ? "hot" : ""} ${e.dashed ? "dashed" : ""} ${e.quiet ? "quiet" : ""}`} d={e.d} />)}
    </svg>
    {layout.headings.map((h) => <span key={`${h.text}${h.y}`} className="tv-maph" style={{ left: h.x, width: h.w, ...(h.y ? { top: h.y } : {}) }}>{h.text}</span>)}
    {layout.nodes.map(({ n, x, y, w, h, label, sub, title, focused, tall }) => {
      const clickable = n.kind !== "outside";
      const mark = n.node?.member ? <CrestOf member={n.node.member} registry={registry} size={22} /> : n.kind === "you" ? <PageGlyph name="you" size={18} className="tv-mn-you" /> : n.kind === "blocked" ? <PageGlyph name="fail" size={18} className="tv-mn-bad" /> : n.kind === "gate" ? <PageGlyph name="gate" size={18} /> : n.kind === "returned" ? <PageGlyph name="done" size={16} className="tv-mn-done" /> : null;
      const body = <>{mark}<span className="tv-mn-t"><b>{label}</b><span>{sub}</span></span>{clickable && n.kind !== "quest" && <OpensMark />}</>;
      const style = { left: x, top: y, width: w, height: h };
      return clickable
        ? <button type="button" key={n.id} data-node={n.id} className={`tv-mn act k-${n.kind} ${focused ? "focus" : ""} ${mark ? "" : "nomark"} ${tall ? "tall" : ""} ${n.quiet ? "quiet" : ""}`} style={style} title={n.kind === "blocked" || n.kind === "you" ? `${title} · ${n.questId ? "Open the quest" : "Open the common room"}` : title} aria-pressed={n.kind === "quest" ? focused : undefined} onClick={() => open(n)}>{body}</button>
        : <div key={n.id} data-node={n.id} className={`tv-mn k-${n.kind} nomark ${tall ? "tall" : ""}`} style={style} title={title}>{body}</div>;
    })}
  </div>;
}

/** The map as an outline: each Keeper, then what hangs off it, for a chat message or a doc. */
function mapOutline(layout: Layout, heading: string, caption: string) {
  const byId = new Map(layout.nodes.map((l) => [l.n.id, l]));
  const kids = new Map<string, string[]>();
  for (const e of layout.edges) kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  const hasParent = new Set(layout.edges.map((e) => e.to));
  const roots = layout.nodes.filter((l) => !hasParent.has(l.n.id)).sort((a, b) => a.x - b.x || a.y - b.y);
  const md: string[] = [`# ${heading}`, "", caption, ""], html: string[] = [`<h3>${escapeHtml(heading)}</h3><p>${escapeHtml(caption)}</p>`];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    const l = byId.get(id);
    if (!l || seen.has(id)) return;
    seen.add(id);
    const prefix = l.n.kind === "outside" ? "waiting on " : l.n.kind === "solo" ? "solo: " : "";
    md.push(`${"  ".repeat(depth)}- ${prefix}**${l.label}** · ${l.sub}`);
    html.push(`<li>${escapeHtml(prefix)}<b>${escapeHtml(l.label)}</b> · ${escapeHtml(l.sub)}`);
    const next = (kids.get(id) ?? []).filter((k) => byId.has(k));
    if (next.length) { html.push("<ul>"); for (const k of next) walk(k, depth + 1); html.push("</ul>"); }
    html.push("</li>");
  };
  html.push("<ul>");
  for (const r of roots) walk(r.n.id, 0);
  html.push("</ul>");
  return { text: md.join("\n"), html: html.join("") };
}
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/** Who the drawn quests wait on, each named once with its count, you first, then the most waited on. */
export function waitingWords(asks: number, outside: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of outside) counts.set(label, (counts.get(label) ?? 0) + 1);
  const named = [...counts].sort((a, b) => b[1] - a[1]).map(([label, n]) => n > 1 ? `${label} ${n}` : label);
  return [asks ? `you ${asks}` : null, ...named].filter(Boolean).join(" · ");
}

// Past this many quests the focus picker shows the first few and puts the rest in a menu, so the map stays on the first screen.
const SEG_MAX = 8, SEG_SHOWN = 5;

type ListRow = { key: string; tone: StateTone; member?: Member; title: string; sub: string; place?: string; run: () => void; label: string; status?: string };
export function TheMap({ room, registry }: { room: Room; registry: Registry }) {
  const navigate = useBbNavigate();
  const day = useToday();
  const now = useNow();
  const [showArchived, setShowArchived] = usePanelState("map.archivedPicture", false);
  const history = experimental_useRpcQuery({ contract: rpcContract, method: "mapHistory", input: {}, enabled: showArchived });
  const archivedCount = room.keepers.filter(k => k.archived).length;
  const choices = useMemo(() => mapQuests(room), [room]);
  const drawable = useMemo(() => choices.flatMap((c) => [...c.active, ...c.done]), [choices]);
  const [hiddenIds, setHiddenIds] = usePanelState<string[]>("map.hidden", [], (v) => Array.isArray(v) && v.every((x) => typeof x === "string"));
  const [showReturned, setShowReturned] = usePanelState("map.finished", false);
  const [cellarCursors, setCellarCursors] = useState<(string | null)[]>([null]);
  const cellar = experimental_useRpcQuery({ contract: rpcContract, method: "archivedBoardQuests", input: { cursor: cellarCursors.at(-1) ?? null, limit: 30 }, enabled: showReturned && room.archivedCount > 0 });
  const [picking, setPicking] = usePanelState("map.picker", false);
  const [framed, setFramed] = useState<string | null>(null);
  // Hidden ids, not shown ones, so a new quest appears by default; a quest that left the board drops out of the choice.
  const hidden = useMemo(() => new Set(hiddenIds.filter((id) => drawable.some((q) => q.id === id))), [hiddenIds, drawable]);
  const setHidden = (next: ReadonlySet<string>) => setHiddenIds(drawable.filter((q) => next.has(q.id)).map((q) => q.id));
  const graph = useMemo(() => graphFor(room, registry, { hidden, returned: showReturned, archived: showArchived, history: history.data, cellar: cellar.data?.boardQuests, only: framed }), [room, registry, hidden, showReturned, showArchived, history.data, cellar.data, framed]);
  const quests = choices.flatMap((c) => c.active);
  const shownActive = quests.filter((q) => !hidden.has(q.id));
  const drawnCount = drawable.filter((q) => !hidden.has(q.id) && (showReturned || !isFinished(q.phase))).length;
  const ended = endedCounts(choices.flatMap(c => c.done));
  const hasFinished = ended.returned + ended.stopped + room.archivedCount > 0;
  const filtered = hidden.size > 0;
  const clearFilters = () => { setFramed(null); setHiddenIds([]); };
  const toggleQuest = (id: string) => { setFramed(null); const next = new Set(hidden); if (next.has(id)) next.delete(id); else next.add(id); setHidden(next); };
  const onlyThis = (id: string) => { setFramed(id); setHidden(new Set(drawable.filter((q) => q.id !== id).map((q) => q.id))); };
  const firstYours = shownActive.find((q) => room.asks.some((a) => a.state === "open" && a.boardQuestId === q.id));
  const [kept, keepFocus] = usePanelState<string | null>("map.focus", null, (v) => typeof v === "string");
  const focus = kept && shownActive.some((q) => q.id === kept) ? kept : firstYours?.id ?? shownActive[0]?.id ?? null;
  // Focusing a quest the filter hides shows it again.
  const setFocus = (id: string) => { setFramed(null); if (hidden.has(id)) { const next = new Set(hidden); next.delete(id); setHidden(next); } keepFocus(id); };
  const pickerId = useId();
  const picture = useMemo(() => mapPicture(graph, focus), [graph, focus]);
  const [boxWidth, setBoxWidth] = useState(0);
  const cols = useMemo(() => fitColumns(COLS, framed ? [0, 1] : [...new Set(picture.nodes.map((n) => n.col))], boxWidth - 24), [picture, boxWidth, framed]);
  const keepers = useMemo(() => new Map(room.keepers.map(k => [k.member.threadId, k.member])), [room.keepers]);
  const layout = useMemo(() => layoutMap(picture, registry, keepers, focus, cols, now), [picture, registry, keepers, focus, cols, now]);
  const ref = useRef<HTMLDivElement>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const listHeading = useId();
  useEffect(() => { if (!receipt) return; const t = setTimeout(() => setReceipt(null), 6000); return () => clearTimeout(t); }, [receipt]);
  const errands = room.keepers.flatMap((k) => k.errands).filter((m) => !hasEndedEngagement(m));
  const open = room.asks.filter((a) => a.state === "open" && (a.boardQuestId === null || !hidden.has(a.boardQuestId))).sort((a, b) => a.createdAt - b.createdAt);
  const outside = graph.nodes.filter((n) => n.kind === "outside");
  const quest = (id?: string) => quests.find((q) => q.id === id);
  const rows: ListRow[] = [];
  if (open.length) {
    const blockers = open.filter((a) => a.kind === "blocker").length;
    const perQuest = [...new Set(open.map((a) => a.boardQuestId))].map((id) => `${quest(id ?? undefined)?.short ?? "Keeper-wide"} ${open.filter((a) => a.boardQuestId === id).length}`);
    rows.push({ key: "you", tone: blockers ? "bad" : "you", title: `You · ${open.length - blockers} ask${open.length - blockers === 1 ? "" : "s"}${blockers ? `, ${blockers} blocker${blockers === 1 ? "" : "s"}` : ""}`, sub: perQuest.join(" · "), run: () => navigate.toPluginPanel("tavern", { subPath: "room" }), label: "Answer in the common room" });
  }
  for (const n of outside) rows.push({ key: n.id, tone: "wait", title: `${n.label} · ${n.detail.split(" · ")[0]}`, sub: `${quest(n.questId)?.short ?? ""} · ${n.detail.split(" · ").slice(1).join(" · ")}`, run: () => n.subPath && navigate.toPluginPanel("tavern", { subPath: n.subPath }), label: `${n.label}: open ${quest(n.questId)?.short ?? "the quest"}` });
  const members = graph.nodes.filter((n): n is MapNode & { member: Member } => (n.kind === "member" || n.kind === "errand") && !!n.member);
  const crossPartyList = memberKeeperIds(members.map(n => n.member)).size > 1;
  const order = (m: Member) => m.state === "failed" ? 0 : m.state === "working" ? 1 : m.state === "waiting" ? 2 : 3;
  for (const n of [...members].sort((a, b) => order(a.member) - order(b.member))) {
    const m = n.member;
    rows.push({ key: n.id, tone: m.state === "failed" ? "bad" : m.strikes > 0 ? "bad" : m.state === "working" ? "work" : m.engagement === "resting" ? "done" : "wait", member: m, title: `${n.label} · ${m.doing ?? m.title ?? m.state}`, place: n.kind === "errand" ? "Errand" : quest(n.questId)?.short ?? "", sub: memberSub(registry, m, n.detail, crossPartyList && m.keeperThreadId ? keepers.get(m.keeperThreadId) : undefined), run: () => navigate.toThread(m.threadId), label: `Open ${n.label}'s thread` });
  }
  const archivedRows: ListRow[] = [];
  for (const k of room.keepers) {
    const name = characterName(registry, k.member), status = keeperStatus(k);
    const liveCount = k.boardQuests.filter(q => boardQuestState(k, q) === "active").length;
    const ended = endedCounts(k.boardQuests.filter(q => boardQuestState(k, q) === "finished"));
    const twin = room.keepers.some((o) => o !== k && characterName(registry, o.member) === name);
    const started = keeperStartedLabel(k, room.keepers, registry, day);
    // The state first, then what tells same-name Keepers apart, then the role, so a narrow row cuts the role, never the state.
    const sub = [status.word, started, twin ? k.threadTitle : null, "Keeper (lead)"].filter(Boolean).join(" · ");
    (k.archived ? archivedRows : rows).push({ key: k.member.threadId, tone: status.tone, status: `${status.label}: ${status.hint}`, member: k.member, title: `${name} · ${liveCount ? plural(liveCount, "live quest") : "no live quest"}${ended.returned + ended.stopped ? ` · ${ended.words}` : ""}`, sub, run: () => navigate.toThread(k.member.threadId), label: `Open ${name}'s thread` });
  }
  const [archivedOpen, setArchivedOpen] = usePanelState("map.archived", false);
  for (const m of room.solos) rows.push({ key: m.threadId, tone: m.state === "working" ? "work" : "wait", member: m, title: `${characterName(registry, m)} · ${m.title ?? m.doing ?? "solo"}`, place: "Solo", sub: memberSub(registry, m), run: () => navigate.toThread(m.threadId), label: `Open ${characterName(registry, m)}'s thread` });
  useEffect(() => rememberCount(SKEL.mapRows, rows.length), [rows.length]);
  const waitingOn = waitingWords(open.length, outside.map((n) => n.label));
  const pickerOpen = picking && drawable.length > 0;
  // The focused quest always has a segment; the menu holds the rest.
  const segQuests = quests.length <= SEG_MAX ? quests : (() => { const first = quests.slice(0, SEG_SHOWN); const f = quests.find((q) => q.id === focus); return f && !first.includes(f) ? [...first, f] : first; })();
  const moreQuests = quests.filter((q) => !segQuests.includes(q));
  const focusQuest = quest(focus ?? undefined);
  const shownNote = `${drawnCount} of ${plural(drawable.length, "quest")} · ${drawable.length - drawnCount} hidden`;
  const caption = `${shownActive.length > 0 ? `Focus plus one hop${focusQuest ? `: ${focusQuest.short}` : ""} · other quests folded into counts` : showReturned ? "Keepers and finished quests" : "Keepers and active quests"}${filtered ? ` · ${shownNote}` : ""}`;
  const exportAs = async (kind: "png" | "svg" | "outline") => {
    const el = ref.current;
    if (!el) return;
    const heading = `Tavern · the map${focusQuest ? ` · ${focusQuest.short}` : ""}${filtered ? ` · showing ${drawnCount} of ${plural(drawable.length, "quest")}` : ""}`;
    try {
      if (kind === "outline") {
        const ok = await experimental_copyToClipboard(mapOutline(layout, heading, `${caption} · ${new Date().toLocaleString()}`));
        setReceipt(ok ? "Copied the map as a Markdown outline" : "Could not copy the outline");
        return;
      }
      const wide = layoutMap(picture, registry, keepers, focus, exportColumns(layout, textMeasurer(el)), Date.now());
      const image = mapSvg({ root: el, nodes: wide.nodes.map((l) => ({ id: l.n.id, x: l.x, y: l.y, w: l.w, h: l.h, label: l.label, sub: l.sub, kind: l.n.kind, focused: l.focused })), edges: wide.edges, headings: wide.headings, width: wide.width, height: wide.height, title: heading, caption });
      const fileName = `tavern-map-${stamp()}.${kind}`;
      const blob = kind === "svg" ? new Blob([image.svg], { type: "image/svg+xml" }) : await svgToPng(image.svg, image.width, image.height);
      const outcome = await experimental_saveFile({ fileName, blob });
      setReceipt(outcome === "started" ? `Saved ${fileName}` : "Could not save the map");
    } catch (error) {
      setReceipt(`Could not export the map: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const exportMenu = <OverflowMenu label="Export the map" className="tv-mv-export" trigger={<><PageGlyph name="export" size={14} /><span>Export</span></>} items={[
    { id: "png", label: "Save as image (PNG)", run: () => void exportAs("png") },
    { id: "svg", label: "Save as vector (SVG)", run: () => void exportAs("svg") },
    { id: "outline", label: "Copy as text outline (Markdown)", run: () => void exportAs("outline") },
  ]} />;
  const row = (r: ListRow) => <li key={r.key} data-stuck={r.member?.state === "failed" || undefined}><button type="button" className="tv-mrow act" onClick={r.run} aria-label={`${r.label}. ${r.title}. ${r.place ? `${r.place} · ` : ""}${r.sub}`} title={`${r.label}: ${r.title}${r.place ? ` · ${r.place}` : ""}`}>
    <StateMark tone={r.tone} title={r.status} />{r.member ? <CrestOf member={r.member} registry={registry} size={18} /> : <span />}<span className="tv-mrow-t"><b>{r.title}{r.member && <> <CheckIndependence member={r.member} /> <GuardPosture member={r.member} /></>}</b><span>{r.place && <><span className="tv-mrow-pl">{r.place}</span> · </>}<span>{r.sub}</span></span></span><OpensMark />
  </button></li>;
  const list = <section className="tv-card tv-maplist" aria-labelledby={listHeading}>
    <header className="tv-maplist-bar"><h2 id={listHeading}>Everyone on the map</h2><span className="tv-count">{plural(rows.length + archivedRows.length, "row")}</span></header>
    {rows.length + archivedRows.length > 0 && <ul className="tv-rows tv-maprows">
      {rows.map(row)}
      {archivedRows.length > 0 && <li className="tv-maprows-fold"><button type="button" className="tv-fold act" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}><ExpandsMark open={archivedOpen} /><span>{plural(archivedRows.length, "archived Keeper")}</span></button></li>}
      {archivedOpen && archivedRows.map(row)}
    </ul>}
    {!rows.length && !archivedRows.length && <p className="tv-empty" data-empty>The map is quiet. No typed threads or quests yet.</p>}
  </section>;
  const finishedToggle = hasFinished && <button type="button" className="seg" aria-pressed={showReturned} onClick={() => { setFramed(null); setCellarCursors([null]); setShowReturned(!showReturned); }}>Show finished quests <span className="num">{ended.returned} returned · {ended.stopped} stopped · {room.archivedCount} archived</span></button>;
  return <div className="tv-map">
    <h1 className="sr">The map (connections)</h1>
    <div className="tv-map-controls">
      <div className="tv-sline">
        <div className="tv-hero"><b className="num">{room.keepers.length}</b><span>Keeper{room.keepers.length === 1 ? "" : "s"} · {quests.length} active quest{quests.length === 1 ? "" : "s"} · {errands.length} errand{errands.length === 1 ? "" : "s"}</span></div>
        {waitingOn && <div className="tv-facts"><span className="tv-facts-long"><span className="tv-nowrap">waiting on</span> <b>{waitingOn}</b></span></div>}
        <span className="tv-sp" />
        {quests.length > 0 && <div className="segc tv-mapfocus" role="group" aria-label="Focus on a quest">{segQuests.map((q) => <button type="button" className={`seg ${hidden.has(q.id) ? "tv-seg-off" : ""}`} key={q.id} aria-pressed={focus === q.id} onClick={() => setFocus(q.id)} title={hidden.has(q.id) ? `Hidden by your filter. Focus on ${q.title} to show it again` : `Focus on ${q.title}`} aria-label={`Focus on ${q.title} · ${phaseWord(q.phase)} · ${q.move.text}${hidden.has(q.id) ? " · hidden by your filter" : ""}`}>{q.short}</button>)}
          {moreQuests.length > 0 && <select className="tv-select seg tv-mapmore" aria-label="Focus on another quest" title="Focus on another quest" value="" onChange={(e) => e.target.value && setFocus(e.target.value)}>
            <option value="">+{moreQuests.length} more</option>
            {moreQuests.map((q) => <option key={q.id} value={q.id}>{q.short} · {phaseWord(q.phase)}</option>)}
          </select>}
        </div>}
      </div>
      {(drawable.length > 0 || hasFinished || archivedCount > 0) && <div className="tv-mapfilters">
        {archivedCount > 0 && <button type="button" className="seg" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>Show archived Keepers ({archivedCount})</button>}
        {drawable.length > 0 && <button type="button" className="lnk-btn act" aria-expanded={pickerOpen} aria-controls={pickerId} onClick={() => setPicking(!picking)}><span>Quests on the board</span><span className="num">{drawnCount} of {drawable.length}</span><ExpandsMark open={pickerOpen} /></button>}
        {!pickerOpen && finishedToggle}
        {!pickerOpen && !quests.length && hasFinished && !showReturned && <span className="tv-mapfilters-n">Only finished quests are available to show.</span>}
        {filtered && <span className="tv-mapfilters-n" role="status"><span>{shownNote}</span><button type="button" className="lnk act tv-clear" onClick={clearFilters}>Clear filters</button></span>}
      </div>}
      {showReturned && room.archivedCount > 0 && <div className="tv-mapfilters">
        {cellarCursors.length > 1 && <button type="button" className="lnk-btn act" onClick={() => setCellarCursors(cellarCursors.slice(0, -1))}>Newer archived quests</button>}
        {cellar.error ? <p className="problem" role="alert">Could not read archived quests: {cellar.error.message}<button type="button" className="lnk act" onClick={() => void cellar.refetch()}>Retry</button></p> :
          !cellar.data ? <span className="tv-mapfilters-n" role="status">Loading archived quests…</span> :
            cellar.data.nextCursor && <button type="button" className="lnk-btn act" onClick={() => setCellarCursors([...cellarCursors, cellar.data!.nextCursor])}>Older archived quests</button>}
      </div>}
      {showArchived && history.error && <p className="problem" role="alert">Could not read archived Keeper history: {history.error.message}<button type="button" className="lnk act" onClick={() => void history.refetch()}>Retry</button></p>}
      {pickerOpen && <div id={pickerId} className="tv-card tv-mappick" role="group" aria-label="Quests the map draws">
        {hasFinished && <div className="tv-mapfilters tv-mappick-status">
          {!showReturned && <span className="tv-mapfilters-n">Finished quests are hidden.</span>}
          {finishedToggle}
        </div>}
        {choices.map(({ active, done, keeper }) => {
          const quests = showReturned ? [...active, ...done] : active;
          return quests.length > 0 && <fieldset key={keeper.threadId}>
            <legend><CrestOf member={keeper} registry={registry} size={16} /><span>{characterName(registry, keeper)}</span></legend>
            {quests.map((q) => <div className="tv-mappick-r" key={q.id}>
              <label title={q.title}><input type="checkbox" checked={!hidden.has(q.id)} onChange={() => toggleQuest(q.id)} /><span className="tv-mappick-x"><span className="tv-mappick-t">{q.short}</span><span className="m">{q.phase === "done" ? "returned" : phaseWord(q.phase)}</span></span></label>
              <button type="button" className="lnk-btn act" onClick={() => onlyThis(q.id)} aria-label={`Only this one: ${q.short}`}><span>Only this one</span></button>
            </div>)}
          </fieldset>;
        })}
      </div>}
    </div>
    <div className="tv-mapgrid" ref={ref}>
      <figure className="tv-card tv-mapcard lit" style={glowVars("connections")}>
        <MapViewport onBoxWidth={setBoxWidth} width={layout.width} height={layout.height} nodes={layout.nodes.length} focus={focusBox(layout, framed)} focusKey={`${framed ?? ""}|${focus ?? ""}`} label={`The map: ${caption}`} bar={<span className="tv-mv-cap clamp" title={caption}>{caption}</span>} controls={exportMenu} status={receipt}
          note={quests.length === 0 ? <p className="tv-map-quiet"><PageGlyph name="map" size={16} /><span><b>No active quests.</b> {room.keepers.some(k => !k.archived) ? "Live Keepers stay on the map." : "There are no live Keepers to draw."}</span></p> : shownActive.length === 0 ? <p className="tv-map-quiet"><PageGlyph name="map" size={16} /><span><b>Every active quest is hidden by your filters.</b></span><button type="button" className="lnk act tv-clear" onClick={clearFilters}>Clear filters</button></p> : undefined}>
          <MapPicture layout={layout} registry={registry} setFocus={setFocus} />
        </MapViewport>
        <figcaption className="tv-mapcap"><span className="tv-mapkey"><span><PageGlyph name="you" size={12} className="tv-mn-you" /><span>your move</span></span><span><span className="tv-key-dash" /><span>outside or errand</span></span><span><span className="tv-key-hot" /><span>focused</span></span></span><span className="tv-sp" /><span className="tv-mv-hint">Drag to move · Ctrl or ⌘ and scroll to zoom · 0 fits</span></figcaption>
      </figure>
      {list}
    </div>
  </div>;
}
