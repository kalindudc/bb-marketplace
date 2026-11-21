import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract, type SuccessionView } from "../../shared/contract";
import { clockTime, QueryState } from "./primitives";
import { OpensMark } from "./glyphs";
import "./succession.css";

const waiting = (view: SuccessionView | null | undefined) => !!view && (view.followupsPending || ["proposed", "preparing", "recovering"].includes(view.state));

export function RefreshKeeper({ threadId, view }: { threadId: string; view?: SuccessionView | null }) {
  const refresh = experimental_useRpcMutation({ contract: rpcContract, method: "refreshKeeper" });
  const cancel = experimental_useRpcMutation({ contract: rpcContract, method: "cancelKeeperRefresh" });
  const finish = experimental_useRpcMutation({ contract: rpcContract, method: "finishKeeperHandover" });
  const [confirm, setConfirm] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (view && view.current !== threadId) return null;
  const pending = waiting(view) || requested && !view;
  const canCancel = view?.state === "proposed" || view?.state === "recovering";
  const request = () => {
    setError(null);
    void refresh.mutate({ threadId }).then(() => { setRequested(true); setConfirm(false); }).catch(setError);
  };
  return <div className="tv-keeper-refresh">
    {view?.requestedByKeeper && <p role="status" className="m small">The Keeper requested this refresh.</p>}
    {view?.finishRequired ? <button type="button" className="btn sm" disabled={finish.isPending} onClick={() => {
      setError(null);
      void finish.mutate({ threadId, successionId: view.id }).catch(setError);
    }}>Finish handover</button> : confirm && !pending ? <>
      <p>Hand this charge to a fresh Keeper? The old thread stays, but its Tavern composer will be locked.</p>
      <button type="button" className="btn sm" disabled={refresh.isPending} onClick={request}>Hand over to a fresh Keeper</button>
      <button type="button" className="btn sm ghost" disabled={refresh.isPending} onClick={() => setConfirm(false)}>Keep this Keeper</button>
    </> : <button type="button" className="btn sm" disabled={pending} onClick={() => setConfirm(true)}>{pending ? "Keeper refresh in progress" : "Refresh Keeper"}</button>}
    {canCancel && <button type="button" className="btn sm ghost" disabled={cancel.isPending} onClick={() => {
      setError(null);
      void cancel.mutate({ threadId, successionId: view.id }).catch(setError);
    }}>Cancel refresh</button>}
    {view?.state === "failed" && view.problem && <p className="m small" data-content>{view.problem}</p>}
    <QueryState error={error} />
  </div>;
}

function CurrentKeeperLink({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return <button type="button" className="btn sm" onClick={() => navigate.toThread(threadId)}>Open the current Keeper<OpensMark /></button>;
}

export function RetiredKeeperNotice({ view }: { view: SuccessionView }) {
  return <section className="tavern tv-succession" aria-label="Keeper retired in Tavern" data-part="RetiredKeeperNotice">
    <p><b>This Keeper is retired in Tavern.</b> Send new messages and answer open asks in the current Keeper.</p>
    <CurrentKeeperLink threadId={view.current} />
    <p className="m small">Do not archive this thread in bb until its members are released. bb’s “Send now” can still send an already-queued message to it.</p>
  </section>;
}

export function KeeperSuccessionRecord({ view, threadId }: { view: SuccessionView; threadId: string }) {
  const text = {
    proposed: "Refresh requested. Tavern is waiting for the current Keeper and its queue to settle.",
    preparing: "The current Keeper is preparing to hand over. Its party can keep working.",
    recovering: "Tavern is checking whether bb created the fresh Keeper. The original still owns the charge.",
    done: view.finishRequired ? "This restored handover needs your confirmation." : view.followupsPending ? "The fresh Keeper owns the charge. Tavern is finishing the transfer in bb." : view.current === threadId ? "This Keeper took over the charge." : "This Keeper handed over the charge.",
    failed: "The refresh did not go through. The original Keeper remains in charge.",
  }[view.state];
  return <section className="tv-succession" data-part="KeeperSuccessionRecord">
    <h3>Keeper succession</h3>
    <p>{text} {view.cutoverAt !== null && <time dateTime={new Date(view.cutoverAt).toISOString()}>{clockTime(view.cutoverAt)}</time>}</p>
    <p className="m small" data-content>{view.reason}</p>
    {view.problem && <p data-content>{view.problem}</p>}
    {view.current !== threadId && <CurrentKeeperLink threadId={view.current} />}
    <p className="m small">Wake-ups set by other plugins do not move.</p>
  </section>;
}
