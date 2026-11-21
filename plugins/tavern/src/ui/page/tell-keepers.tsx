import { experimental_useRpcMutation, useSdk } from "@get-bb/plugin-sdk/app";
import { useId, useRef, useState, type FormEvent } from "react";
import { rpcContract, TELL_KEEPER_LIMIT, type Room } from "../../shared/contract";
import { QueryState } from "../kit";
import { characterName, type Registry } from "./common";
import "./tell-keepers.css";

type Receipt = { threadId: string; name: string; message: string };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function TellKeepers({ keepers, registry }: { keepers: Room["keepers"]; registry: Registry }) {
  const sdk = useSdk();
  const prepare = experimental_useRpcMutation({ contract: rpcContract, method: "prepareTellKeepers" });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<unknown>(null);
  const locked = useRef(false);
  const formId = useId();
  const live = keepers.filter(k => !k.archived);
  if (!open && !live.length) return null;

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (locked.current || !selected.length || !text.trim()) return;
    locked.current = true;
    setSending(true);
    setError(null);
    setReceipts([]);
    try {
      const { targets } = await prepare.mutate({ keeperIds: selected });
      const result: Receipt[] = [];
      for (const { threadId, name, status } of targets) {
        let message: string;
        if (status === "gone") message = "Skipped; the thread is gone.";
        else if (status === "unavailable") message = "Skipped; could not check the thread.";
        else {
          try {
            // The browser client uses the same user message endpoint as the thread composer.
            const delivery = await sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
            message = delivery.delivery === "queued" ? "Queued." : "Sent.";
          } catch (error) {
            message = `Could not confirm delivery: ${messageOf(error)}`;
          }
        }
        result.push({ threadId, name, message });
      }
      setReceipts(result);
      setSelected([]);
      if (result.every(receipt => receipt.message === "Sent." || receipt.message === "Queued.")) setText("");
    } catch (error) { setError(error); }
    finally { locked.current = false; setSending(false); }
  };
  return <section className="tv-tell" aria-label="Tell selected Keepers">
    <button type="button" className="btn sm" aria-expanded={open} aria-controls={formId} onClick={() => setOpen(!open)}>Tell selected Keepers</button>
    <div id={formId} hidden={!open}>
      <form className="tv-tell-form" onSubmit={event => void send(event)}>
        <p className="m">Send one message to each selected Keeper’s thread.</p>
        <fieldset disabled={sending}><legend>Keepers</legend><div className="tv-tell-keepers">{keepers.filter(k => !k.archived || selected.includes(k.member.threadId)).map(k => {
          const id = k.member.threadId, checked = selected.includes(id);
          return <label key={id}><input type="checkbox" checked={checked} disabled={!checked && selected.length >= TELL_KEEPER_LIMIT} onChange={() => setSelected(checked ? selected.filter(value => value !== id) : [...selected, id])} />{characterName(registry, k.member)}</label>;
        })}</div></fieldset>
        {selected.length >= TELL_KEEPER_LIMIT && <p className="m">Choose up to {TELL_KEEPER_LIMIT} Keepers per message.</p>}
        <label className="tv-tell-text">Message<textarea className="tv-inp" rows={3} value={text} disabled={sending} onChange={event => setText(event.target.value)} /></label>
        <button type="submit" className="btn sm pri" disabled={sending || !selected.length || !text.trim()}>{sending ? "Sending…" : "Send message"}</button>
      </form>
      <QueryState error={error} />
      <div aria-live="polite">{receipts.length > 0 && <ul className="tv-tell-receipts" aria-label="Message receipts">{receipts.map(r => <li key={r.threadId}><b>{r.name}:</b> {r.message}</li>)}</ul>}</div>
    </div>
  </section>;
}
