import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useState } from "react";
import { rpcContract, type BoardQuestSummary, type Room } from "../../shared/contract";
import type { Ask, Decision } from "../../shared/schema";
import { AskCard, DecidedForYou as KitDecided, ExpandsMark, activeHold, useDecisionSeen, useNow } from "../kit";
import { characterName, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { CheckerHold } from "./hold";
import { heldForYou } from "./model";

export const KIND: Record<Ask["kind"], string> = { greenlight: "greenlight", decision: "decision", production: "production", merge: "merge", destructive: "destructive", "sends-as-you": "sends as you", blocker: "blocker", credential: "credential", scope: "scope change" };
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

export function NeedsYouQueue({ room, registry }: { room: Room; registry: Registry }) {
  const wide = useWide("(min-width: 1200px)");
  const heading = useId();
  const open = room.asks.filter((a) => a.state === "open").sort((a, b) => a.createdAt - b.createdAt);
  const holds = heldForYou(room);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  if (!open.length && !holds.length) return null;
  const counted = [open.length ? `${open.length} ask${open.length === 1 ? "" : "s"}` : null, holds.length ? `${holds.length} hold${holds.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
  // Holds sit among the asks by age; each is its own calm row with its release control.
  const holdRows = holds.map((q) => ({ at: activeHold(q)!.createdAt, node: <CheckerHold key={`hold:${q.id}`} quest={q} asks={open} queue /> }));
  let placed = 0;
  return <section aria-labelledby={heading} className="tv-sec tv-queue" id="tv-needs-you">
    <header className="tv-colh"><h2 id={heading}>Needs you</h2><span className="tv-count">{counted}, oldest first</span></header>
    <div className="tv-asks">{open.map((ask, index) => {
      const keeper = room.keepers.find((k) => k.member.threadId === ask.keeperThreadId);
      const keeperName = keeper ? characterName(registry, keeper.member) : "Keeper unavailable";
      const quest = keeper?.boardQuests.find((q) => q.id === ask.boardQuestId);
      const held = heldTitles(ask, quest);
      const isOpen = shut[ask.id] === undefined ? wide && index === 0 : !shut[ask.id];
      const older = holdRows.slice(placed).filter((h) => h.at <= ask.createdAt);
      placed += older.length;
      return [...older.map((h) => h.node), <details key={ask.id} data-ask open={isOpen} onToggle={(event) => { const now = (event.currentTarget as HTMLDetailsElement).open; if (now !== isOpen) setShut((prev) => ({ ...prev, [ask.id]: !now })); }} className={`tv-ask-disclosure ${ask.kind === "blocker" ? "blk" : ""}`}>
        <summary className="tv-askrow" title={quest ? `${quest.title} · ${ask.question}` : ask.question}>
          <PageGlyph name={ask.kind === "blocker" ? "fail" : "you"} size={13} className="tv-askrow-g" />
          <span className="tv-askrow-t"><span className="tv-askrow-q" data-content>{ask.question}</span><span className="tv-askrow-s">{quest?.short ?? (ask.boardQuestId ? "Quest unavailable" : "Keeper-wide decision")} · {keeperName} asks · {KIND[ask.kind]} · {held.length ? `Holds: ${held.join(", ")}` : `Consequence: ${ask.why}`}</span></span>
          <span className="tv-askrow-a"><time dateTime={new Date(ask.createdAt).toISOString()} title={new Date(ask.createdAt).toLocaleString()} className="num"><AgoShort at={ask.createdAt} /></time><ExpandsMark open={isOpen} /></span>
        </summary>
        <AskCard ask={ask} via="page" headless onFold={() => setShut((prev) => ({ ...prev, [ask.id]: true }))} />
      </details>];
    })}{holdRows.slice(placed).map((h) => h.node)}</div>
  </section>;
}
function AgoShort({ at }: { at: number }) { const now = useNow(); return <>{agoShort(at, now)}</>; }
function agoShort(at: number, now: number) { const m = Math.max(0, Math.floor((now - at) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; }

/**
 * Reversible calls with Undo. With `seen` (the common room), each gets "OK ✓" and the header "Mark all seen";
 * `total` and `seen.throughId` come from the room so a clipped list stays honest. Without it (the quest page), every decision shows, seen ones muted.
 */
export function DecidedForYou({ decisions, total, seen, headingId, limit }: { decisions: Decision[]; total?: number; seen?: { throughId: string | null | undefined }; headingId?: string; limit?: number }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const marks = useDecisionSeen({ throughId: seen?.throughId ?? null });
  const [undone, setUndone] = useState<string[]>([]);
  // Stays mounted once it has shown something, so "Marked 3 seen · Undo" outlives the refetch that empties the list.
  const [shown, setShown] = useState(decisions.length > 0);
  useEffect(() => { if (decisions.length) setShown(true); }, [decisions.length]);
  const act = async (id: string) => { try { await undo.mutate({ decisionId: id }); setUndone((prev) => [...prev, id]); } catch { /* The hook keeps the refusal for the alert below. */ } };
  if (!decisions.length && !shown) return null;
  return <div className="tv-decided"><KitDecided decisions={decisions.map((d) => undone.includes(d.id) ? { ...d, undone: true } : d)} total={total} onUndo={(id) => void act(id)} pending={undo.isPending} headingId={headingId} limit={limit} {...(seen ? marks : {})} />{undo.error && <p role="alert" className="tavern problem">Could not undo: {undo.error.message}</p>}</div>;
}
