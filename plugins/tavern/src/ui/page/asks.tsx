import { attentionView, fromStoppedKeeper, type AttentionItem } from "../../shared/attention";
import { AlertAction } from "../kit/alert-action";
import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useState, type ReactNode } from "react";
import { rpcContract, type BoardQuestSummary, type Room } from "../../shared/contract";
import type { Ask, Decision } from "../../shared/schema";
import { AskCard, DecidedForYou as KitDecided, ExpandsMark, useDecisionSeen } from "../kit";
import type { Registry } from "./common";
import { CheckerHold } from "./hold";
import { NeedAction, NeedCard } from "./need-card";
import { jumpTo } from "./rail";

export const KIND: Record<Ask["kind"], string> = { greenlight: "greenlight", decision: "decision", conclude: "conclude", production: "production", "cluster-write": "cluster write", merge: "merge", destructive: "destructive", "sends-as-you": "sends as you", "drafts-as-you": "draft as you", blocker: "blocker", credential: "credential", scope: "scope change" };
export function heldTitles(ask: Ask, quest: BoardQuestSummary | null | undefined) { return ask.holds.map((id) => quest?.waypoints.find((w) => w.id === id)?.title ?? "Unlisted waypoint"); }

function useWide(query: string) {
  // Read at the first render, so a wide window opens the oldest ask before the first paint instead of growing the queue after it.
  const [wide, setWide] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return wide;
}

const GROUPS = [
  ["ask", "Asks"], ["hold", "Holds"], ["hand-back", "Handed back to you"], ["rule", "Rules to confirm"],
] as const;
const SHOWN = 3;
const isNeed = (item: AttentionItem) => GROUPS.some(([kind]) => kind === item.kind);

function NeedRows({ items, count, render }: { items: AttentionItem[]; count: number; render: (item: AttentionItem, index: number) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return <>
    <div id={id} className="tv-asks">{(expanded ? items : items.slice(0, SHOWN)).map(render)}</div>
    {items.length > SHOWN && <button type="button" className="tv-fold act" aria-controls={id} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <ExpandsMark open={expanded} />{expanded ? "Show fewer" : `${count - SHOWN} more`}
    </button>}
  </>;
}

function AskForm({ ask, first }: { ask: Ask; first: boolean }) {
  const wide = useWide("(min-width: 1200px)");
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? (first && wide);
  return <details className="tv-need-answer" open={open} onToggle={event => { if (event.currentTarget.open !== open) setChoice(event.currentTarget.open); }}>
    <summary className="tv-fold act"><ExpandsMark open={open} />{open ? "Hide answer form" : "Open answer form"}</summary>
    <AskCard ask={ask} via="page" headless describeEffects onFold={() => setChoice(false)} />
  </details>;
}

export function NeedsYouQueue({ room, registry }: { room: Room; registry: Registry }) {
  const navigate = useBbNavigate();
  const heading = useId();
  const list = attentionView(room.attention);
  if (!list.needYou && !list.heldByYou) return null;
  const keepers = new Map(room.keepers.map(keeper => [keeper.member.threadId, keeper]));
  const quests = new Map(room.keepers.flatMap(keeper => keeper.boardQuests.map(quest => [quest.id, quest] as const)));
  const asks = new Map(room.asks.map(ask => [ask.id, ask]));
  const render = (item: AttentionItem, index: number) => {
    const keeper = item.keeperThreadId ? keepers.get(item.keeperThreadId) : undefined;
    const quest = item.questId ? quests.get(item.questId) : undefined;
    const ask = item.kind === "ask" ? asks.get(item.id) : undefined;
    const held = ask ? heldTitles(ask, quest) : [];
    return <NeedCard key={`${item.kind}:${item.id}`} item={item} keeper={keeper} questTitle={quest?.title} registry={registry}
      facts={ask && <><span>Ask: {KIND[ask.kind]}</span>{held.length > 0 ? <span>Holds: {held.join(", ")}</span> : ask.why && <span>Consequence: {ask.why}</span>}</>}>
      {ask && <AskForm ask={ask} first={index === 0} />}
      {item.kind === "hold" && quest?.checkerHandoffHold?.id === item.id && <CheckerHold quest={quest} asks={room.asks} queue card />}
      {item.kind === "held" && <HeldByYou id={item.id} />}
      {item.kind === "hold" && item.id.startsWith("spend:") && item.questId && <AlertAction action={{ kind: "run", label: "Review quest spend",
        run: () => navigate.toPluginPanel("tavern", { subPath: `quest/${item.questId}` }) }} />}
    </NeedCard>;
  };
  const groups = GROUPS.flatMap(([kind, label]) => {
    const count = list.counts?.[kind];
    return count ? [{ kind, label, count }] : [];
  });
  const stopped = list.counts?.stopped ?? 0;
  return <section aria-labelledby={heading} className="tv-sec tv-queue" id="tv-needs-you">
    <header className="tv-colh"><h2 id={heading}>Needs you</h2></header>
    {groups.length + Number(stopped > 0) > 0 && <nav className="tv-need-kinds" aria-label="Jump to an attention group">
      {groups.map(({ kind, label, count }) => <button type="button" className="btn ghost sm" key={kind} onClick={() => jumpTo(`tv-need-${kind}`)}>{label} <b>{count}</b></button>)}
      {stopped > 0 && <button type="button" className="btn ghost sm" onClick={() => { const fold = document.querySelector<HTMLDetailsElement>("#tv-need-stopped"); if (fold) fold.open = true; jumpTo("tv-need-stopped"); }}>From stopped Keepers <b>{stopped}</b></button>}
    </nav>}
    {groups.map(({ kind, label, count }) => <section key={kind} id={`tv-need-${kind}`} className="tv-need-group" aria-labelledby={`${heading}-${kind}`}>
      <header className="tv-need-group-head"><h3 id={`${heading}-${kind}`}>{label}</h3><span className="tv-count">{count}</span></header>
      <NeedRows items={list.items.filter(item => item.kind === kind && !fromStoppedKeeper(item))} count={count} render={render} />
    </section>)}
    {list.heldByYou > 0 && <section className="tv-need-group" aria-labelledby={`${heading}-held`}>
      <header className="tv-need-group-head"><h3 id={`${heading}-held`}>Held by you</h3><span className="tv-count">{list.heldByYou}</span></header>
      <NeedRows items={list.items.filter(item => item.kind === "held")} count={list.heldByYou} render={render} />
    </section>}
    {stopped > 0 && <details className="tv-need-group tv-need-stopped" id="tv-need-stopped">
      <summary className="tv-need-group-head act"><ExpandsMark open={false} /><h3>From stopped Keepers</h3><span className="tv-count">{stopped}</span></summary>
      <NeedRows items={list.items.filter(item => isNeed(item) && fromStoppedKeeper(item))} count={stopped} render={render} />
    </details>}
  </section>;
}

function HeldByYou({ id }: { id: string }) {
  const resume = experimental_useRpcMutation({ contract: rpcContract, method: "resumeBoardQuest" });
  const [error, setError] = useState<unknown>(null);
  return <>
    <NeedAction label="Resume" effect="Lets the Keeper continue the quest." disabled={resume.isPending} onClick={() => void resume.mutate({ id }).catch(setError)} />
    {error != null && <p role="alert">{String(error)}</p>}
  </>;
}

/**
 * Reversible calls with Undo. With `seen` (the common room), each gets "OK ✓" and the header "Mark all seen";
 * `total` and `seen.throughId` come from the room so a clipped list stays honest. Without it (the quest page), every decision shows, seen ones muted.
 */
export function DecidedForYou({ decisions, total, seen, headingId, limit, expanded, onExpandedChange, readOnly = false, headless = false, compact = false }: { decisions: Decision[]; total?: number; seen?: { throughId: string | null | undefined }; headingId?: string; limit?: number; expanded?: boolean; onExpandedChange?: (next: boolean) => void; readOnly?: boolean; headless?: boolean; compact?: boolean }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const marks = useDecisionSeen({ throughId: seen?.throughId ?? null });
  const [undone, setUndone] = useState<string[]>([]);
  // Stays mounted once it has shown something, so "Marked 3 seen · Undo" outlives the refetch that empties the list.
  const [shown, setShown] = useState(decisions.length > 0);
  useEffect(() => { if (decisions.length) setShown(true); }, [decisions.length]);
  const act = async (id: string) => { try { await undo.mutate({ decisionId: id }); setUndone((prev) => [...prev, id]); } catch { /* The hook keeps the refusal for the alert below. */ } };
  if (!decisions.length && !shown) return null;
  return <div className="tv-decided"><KitDecided decisions={decisions.map((d) => undone.includes(d.id) ? { ...d, undone: true } : d)} total={total} onUndo={readOnly ? undefined : (id) => void act(id)} pending={undo.isPending} headingId={headingId} limit={limit} headless={headless} compact={compact} expanded={expanded} onExpandedChange={onExpandedChange} {...(seen ? marks : {})} />{undo.error && <p role="alert" className="tavern problem">Could not undo: {undo.error.message}</p>}</div>;
}
