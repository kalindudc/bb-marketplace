import { experimental_copyToClipboard, useBbNavigate, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, useSyncExternalStore } from "react";

type DraftAction = { kind: "tell"; keeperThreadId: string; text: string };
type Action = DraftAction | { kind: "run"; label: string; run: () => unknown }
  | { kind: "check"; text: string; run: () => unknown };

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(notify => notify());
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };

export function useKeeperAlertDraft(threadId: string, composer: PluginComposerApi) {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(threadId), () => undefined);
  const target = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  useEffect(() => {
    if (draft === undefined || target !== threadId || drafts.get(threadId) !== draft) return;
    drafts.delete(threadId);
    changed();
    composer.replace(current => ({
      ...current,
      text: current.text ? `${current.text}\n\n${draft}` : draft,
    }));
    composer.focus();
  }, [composer, draft, threadId, target]);
}

export function AlertAction({ action }: { action: Action }) {
  return action.kind === "tell" ? <TellAction action={action} /> : <RunAction action={action} />;
}

function TellAction({ action }: { action: DraftAction }) {
  const navigate = useBbNavigate();
  const [receipt, setReceipt] = useState("");
  const tell = () => {
    drafts.delete(action.keeperThreadId);
    drafts.set(action.keeperThreadId, action.text);
    if (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
    changed();
    navigate.toThread(action.keeperThreadId);
  };
  const copy = async () => {
    try {
      setReceipt(await experimental_copyToClipboard({ text: action.text }) ? "Copied" : "Select the suggested text to copy it.");
    } catch {
      setReceipt("Select the suggested text to copy it.");
    }
  };
  return <span className="tv-alert-action" data-alert-action>
    <span data-content>{action.text}</span>
    <button type="button" className="btn sm" onClick={tell}>Tell the Keeper</button>
    <button type="button" className="lnk-btn" onClick={() => void copy()}>Copy</button>
    {receipt && <span className="m" role="status">{receipt}</span>}
  </span>;
}

function RunAction({ action }: { action: Exclude<Action, DraftAction> }) {
  const [receipt, setReceipt] = useState("");
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    setReceipt("");
    try { await action.run(); if (action.kind === "check") setReceipt("Checked again."); }
    catch (error) { setReceipt(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return <span className="tv-alert-action" data-alert-action>
    {action.kind === "check" && <span>{action.text}</span>}
    <button type="button" className="btn sm" disabled={pending} onClick={() => void run()}>{action.kind === "check" ? "Done" : action.label}</button>
    {receipt && <span className="m" role="status">{receipt}</span>}
  </span>;
}
