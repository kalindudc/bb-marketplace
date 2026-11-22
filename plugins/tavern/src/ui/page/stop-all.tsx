import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState } from "react";
import { QUEUED_STOP_NOTICE, RESUME_ATTESTATION_NOTICE, stopBy, stopAllContract, type CellarStopReceipt, type StopReceipt } from "../../shared/stop-all";
import { FoldSummary, Glyph } from "../kit";
import { useTavernSettings } from "./settings";
import "./stop-all.css";

const SCOPE = "Stops every running Keeper and member turn now, and holds new ticks, briefs and hires until you resume. Quests, parties and machines stay as they are.";

export function StopAllControls() {
  const state = experimental_useRpcQuery({ contract: stopAllContract, method: "stopAllStatus", input: {} });
  const stop = experimental_useRpcMutation({ contract: stopAllContract, method: "stopAll" });
  const settings = useTavernSettings();
  const [confirm, setConfirm] = useState(false), [error, setError] = useState<string | null>(null);
  const id = useId(), cancel = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const close = () => { setConfirm(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!confirm) return;
    cancel.current?.focus();
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setConfirm(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [confirm]);
  const paused = settings.data?.effective.tavern.paused;
  const stopNow = async () => {
    setError(null);
    try { await stop.mutate({}); close(); void state.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const pause = async () => {
    setError(null);
    try { await settings.save({ tavern: { paused: !paused } }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="tv-brake-controls" ref={wrap} onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <button ref={trigger} type="button" className="btn ghost" aria-label="Stop all" aria-expanded={confirm} aria-controls={confirm ? id : undefined} title="Stop all Keeper and member turns" disabled={!state.data || stop.isPending} onClick={() => setConfirm(!confirm)}><Glyph name="block" /><span>Stop all</span></button>
    <button type="button" className="btn ghost" aria-label="Pause every Keeper" aria-pressed={paused ?? false} title="Pauses new Keeper work; running turns finish." disabled={!settings.data || settings.pending} onClick={() => void pause()}><Glyph name="pause" /><span>{paused ? "Keepers paused" : "Pause every Keeper"}</span></button>
    {confirm && <div id={id} role="dialog" aria-label="Stop all" className="tv-confirm tv-brake-confirm">
      <h3>Stop all?</h3><p>{SCOPE}</p>
      <div className="tv-brake-actions"><button type="button" className="btn" disabled={stop.isPending} onClick={() => void stopNow()}>Stop everything now</button><button ref={cancel} type="button" className="btn ghost" disabled={stop.isPending} onClick={close}>Cancel</button></div>
    </div>}
    {(error || state.error || settings.error || settings.note || settings.problems.length > 0) && <p className="tv-problem tv-brake-error" role="alert">{error ?? state.error?.message ?? settings.error?.message ?? settings.note ?? settings.problems.map(p => p.message).join("; ")}<button type="button" className="btn sm" onClick={() => { void state.refetch(); void settings.refetch(); }}>Retry</button></p>}
  </div>;
}

export function StopReceiptView({ receipt }: { receipt: StopReceipt }) {
  return <div>
    <p>Stop requested through {receipt.surface ?? "an unrecorded surface"}.</p>
    <p>{receipt.keepersStopped} Keeper{receipt.keepersStopped === 1 ? "" : "s"} and {receipt.membersStopped} member{receipt.membersStopped === 1 ? "" : "s"} stopped; {receipt.stillStopping} still stopping; {receipt.failed} failed; {receipt.alreadyIdle} already idle. {receipt.completedAt === null ? "Collecting confirmations." : `Last confirmed stop after ${receipt.elapsedMs} ms. Still-stopping entries update when bb next reports their status.`}</p>
    <details><FoldSummary>Stop receipt</FoldSummary><ul>{receipt.entries.map(entry => <li key={entry.threadId}>{entry.role === "keeper" ? "Keeper" : "Member"} {entry.threadId}: {entry.status.replaceAll("-", " ")}{entry.error ? ` — ${entry.error}` : ""}</li>)}</ul></details>
  </div>;
}

export function StopKeeperGone({ ids, onReceipt }: { ids: string[]; onReceipt: (receipt: CellarStopReceipt) => void }) {
  const stop = experimental_useRpcMutation({ contract: stopAllContract, method: "stopKeeperGoneQuests" });
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  const restoreFocus = useRef(false);
  const close = () => { restoreFocus.current = true; setConfirm(null); };
  useEffect(() => {
    if (confirm) cancel.current?.focus();
    else if (restoreFocus.current && !stop.isPending) { restoreFocus.current = false; trigger.current?.focus(); }
  }, [confirm, stop.isPending]);
  const act = async (targets: string[]) => {
    try { onReceipt(await stop.mutate({ ids: targets })); }
    catch { /* The mutation keeps the refusal next to the trigger. */ }
    finally { close(); }
  };
  return <div className="tv-cellar-stop" onKeyDown={event => { if (event.key === "Escape" && !stop.isPending) close(); }}>
    <button ref={trigger} type="button" className="btn sm" disabled={!ids.length || stop.isPending} aria-expanded={!!confirm} aria-controls={confirm ? id : undefined} onClick={() => setConfirm([...ids])}>Stop and send to the cellar</button>
    {confirm && <div id={id} className="tv-confirm" role="dialog" aria-label="Stop and send to the cellar">
      <h3>Stop and send to the cellar?</h3>
      <p>Stop {confirm.length} {confirm.length === 1 ? "quest" : "quests"}. Each is recorded as stopped and sent to the cellar after its party stops.</p>
      <div className="tv-brake-actions">
        <button type="button" className="btn sm" onClick={() => void act(confirm)} disabled={stop.isPending}>Stop {confirm.length} {confirm.length === 1 ? "quest" : "quests"}</button>
        <button ref={cancel} type="button" className="btn ghost sm" onClick={close} disabled={stop.isPending}>Cancel</button>
      </div>
    </div>}
    {stop.error && <p className="tv-problem" role="alert">{stop.error.message}</p>}
  </div>;
}

export function CellarStopReceiptView({ receipt, stillStopping }: { receipt: CellarStopReceipt; stillStopping: ReadonlySet<string> }) {
  return <div className="tv-confirm" role="status" aria-label="Stop and cellar receipt">
    <p>You asked to stop these quests and send them to the cellar.</p>
    <ul>{receipt.entries.map(entry => <li key={entry.questId}>{entry.title}: {stillStopping.has(entry.questId) ? "Still stopping. Tavern retries before sending it to the cellar." : "Stopped and sent to the cellar."}</li>)}</ul>
  </div>;
}

export function StopAllNotice() {
  const state = experimental_useRpcQuery({ contract: stopAllContract, method: "stopAllStatus", input: {} });
  const resume = experimental_useRpcMutation({ contract: stopAllContract, method: "resumeAll" });
  const [error, setError] = useState<string | null>(null);
  if (!state.data) return null;
  if (state.data.state !== "stopped") return state.data.resumeReceipt ? <section className="tv-confirm tv-brake-notice" aria-label="Tavern resumed"><p>Resume requested through {state.data.resumeReceipt.surface}. {state.data.resumeReceipt.notice}</p></section> : null;
  const go = async () => {
    setError(null);
    try { await resume.mutate({}); void state.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="tv-confirm tv-brake-notice" aria-label="Tavern stopped" role="status">
    <div className="tv-brake-actions"><strong>Stopped by {stopBy(state.data)} since <time dateTime={new Date(state.data.since!).toISOString()}>{new Date(state.data.since!).toLocaleString()}</time></strong><button type="button" className="btn sm" aria-label="Resume Tavern" disabled={resume.isPending} onClick={() => void go()}><Glyph name="play" />Resume</button></div>
    <p>{QUEUED_STOP_NOTICE}</p>
    <p>{RESUME_ATTESTATION_NOTICE}</p>
    {state.data.receipt && <StopReceiptView receipt={state.data.receipt} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}
