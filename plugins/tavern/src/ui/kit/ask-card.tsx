import { useId, useState } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { Ask } from "../../shared/schema";
import { Glyph } from "./glyphs";
import { MemberChip, QueryState, TimeAgo, clockTime } from "./primitives";
import { useRegistry } from "./registry";

const KIND: Record<Ask["kind"], string> = { greenlight: "Greenlight", decision: "Decision", conclude: "Conclude", production: "Production", merge: "Merge", destructive: "Destructive", "sends-as-you": "Sends as you", blocker: "Blocker", credential: "Credential", scope: "Scope change" };
const VIA: Record<string, string> = { banner: "in the thread", page: "in the common room", phone: "on the phone", chat: "in the chat", cli: "from the CLI", timer: "by its default" };
const holdsText = (holds: string[]) => holds.length === 0 ? "No other work" : holds.map(h => /^w\d+$/.test(h) ? `waypoint ${h.slice(1)}` : h).join(", ");

const RULE_WORDS: Record<string, string> = {
  "git-push-main": "Push to main or master",
  "git-push-force": "Force, mirror or deletion pushes",
  "git-push-target": "Push without naming a branch",
  "kubectl-write": "Write to a Kubernetes cluster, including dry runs, exec and cp",
  "deploy-fallback": "Run deploy commands (terraform apply, helm, kapp)",
  github: "Use GitHub beyond reads and draft pull requests",
  "git-global-config": "Change global or system git configuration",
};
/** A widening id in plain words: rule ids, "tool:<name>", "tool-deny:<name>" and "write:<path>". */
export function wideningWords(id: string) {
  if (id.startsWith("tool:")) return `Use the tool ${id.slice(5)}`;
  if (id.startsWith("tool-deny:")) return `Lift the block on the tool ${id.slice(10)}`;
  if (id.startsWith("write:")) return `Write to ${id.slice(6)}`;
  return RULE_WORDS[id] ?? `Allow the rule ${id}`;
}
const GRANTING = (optionId: string) => optionId !== "deny";

function ScopeGrant({ change }: { change: NonNullable<Ask["scopeChange"]> }) {
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId: change.memberThreadId } });
  const registry = useRegistry();
  const navigate = useBbNavigate();
  const member = decor.data?.member;
  return (
    <dl className="sendbox grant" aria-label="Exactly what would be granted">
      <dt>Member</dt><dd>{member && registry.data ? <MemberChip member={member} registry={registry.data} onOpen={id => navigate.toThread(id)} /> : <span className="m">{decor.isLoading ? "Loading…" : "Unknown member"}</span>}</dd>
      <dt>Grants</dt><dd><ul className="grants">{change.widenings.map(w => <li key={w}><span>{wideningWords(w)}</span> <code>{w}</code></li>)}</ul></dd>
      <dt>Applies to</dt><dd>{change.projectRoot || change.remotes?.length ? <>{change.projectRoot && <code className="wrap">{change.projectRoot}</code>}{change.remotes?.map(r => <code key={r} className="wrap">{r}</code>)}</> : <span>This member’s worktree only</span>}</dd>
      <dt>Why</dt><dd>{change.reason}</dd>
    </dl>
  );
}

/** One ask, answered in place. Consequential kinds start with nothing selected; sends-as-you shows sender, recipient and the full draft. */
export function AskCard({ ask, via = "banner", onFold, onAnswered, headless = false }: { ask: Ask; via?: "banner" | "page" | "phone" | "chat"; onFold?: () => void; onAnswered?: (answered: Ask) => void; headless?: boolean }) {
  const name = useId();
  const [optionId, setOption] = useState<string | null>(ask.kind === "decision" ? ask.options.find(o => o.recommended)?.id ?? null : null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ label: string; at: number; note: string | null } | null>(null);
  const answer = experimental_useRpcMutation({ contract: rpcContract, method: "answerAsk" });
  if (ask.state !== "open" || receipt) {
    const label = receipt?.label ?? ask.options.find(o => o.id === ask.answer?.optionId)?.label ?? ask.answer?.optionId ?? "";
    const at = receipt?.at ?? ask.answer?.at ?? null;
    const receiptNote = receipt?.note ?? ask.answer?.note ?? null;
    return (
      <div className="tavern receipt" role="status" aria-label={`Ask answered: ${ask.question}`}>
        <Glyph name="check" />
        <b>{ask.state === "withdrawn" ? "Withdrawn" : ask.state === "defaulted" ? "Default applied" : "Answered"}</b>
        {label && <span>“{label}”</span>}
        {(receipt || ask.answer?.surface === "client (unattested)") && <span className="m">answered from a client Tavern could not attribute</span>}
        {receiptNote && <span className="receipt-note" data-content>“{receiptNote}”</span>}
        <span className="m">{VIA[ask.answer?.via ?? via]}{at !== null ? ` at ${clockTime(at)}` : ""} · cleared everywhere</span>
      </div>
    );
  }
  const missingGrant = ask.kind === "scope" && !ask.scopeChange;
  const canSend = (ask.kind !== "sends-as-you" || ask.draft !== null) && !(missingGrant && optionId !== null && GRANTING(optionId));
  const action = ask.kind === "sends-as-you" ? "Send as you" : ask.kind === "greenlight" ? "Form the party (greenlight)" : ask.kind === "scope" && optionId !== null && GRANTING(optionId) ? "Grant this scope" : "Send answer";
  async function submit() {
    if (!optionId || !canSend) return;
    setError(null);
    try {
      await answer.mutate({ askId: ask.id, optionId, note: note.trim() || null, via });
      const at = Date.now();
      setReceipt({ label: ask.options.find(o => o.id === optionId)!.label, at, note: note.trim() || null });
      onAnswered?.({ ...ask, state: "answered", answer: { optionId, note: note.trim() || null, by: "user", via, at, surface: "client (unattested)" } });
    } catch (e) { setError(e); }
  }
  return (
    <section className={`tavern ask k-${ask.kind}`} aria-label={`Ask: ${ask.question}`} data-ask>
      {headless ? ask.why && <p className="ask-why">Yours because {ask.why.charAt(0).toLowerCase() + ask.why.slice(1)}</p> : <><div className="ask-h"><span className="kind">{KIND[ask.kind]}</span><span>asked <TimeAgo at={ask.createdAt} /></span>{ask.why && <span>· yours because {ask.why.charAt(0).toLowerCase() + ask.why.slice(1)}</span>}</div><h3 className="ask-q">{ask.question}</h3></>}
      {ask.draft && (
        <dl className="sendbox" aria-label="Exactly what would be sent">
          <dt>Sends as</dt><dd className="warn">You</dd>
          <dt>To</dt><dd>{ask.draft.to}</dd>
          <dt>Message</dt><dd className="draft">{ask.draft.body}</dd>
        </dl>
      )}
      {ask.scopeChange && <ScopeGrant change={ask.scopeChange} />}
      {ask.kind === "sends-as-you" && ask.draft === null && <p role="alert" className="problem">The send preview is missing. Ask the Keeper for the recipient and the full draft before answering.</p>}
      {missingGrant && <p role="alert" className="problem">The grant details are missing, so this scope cannot be widened here. You can still keep the current restrictions.</p>}
      <fieldset className="opts">
        <legend className="sr">Your answer</legend>
        {ask.options.map(o => (
          <label key={o.id} className="opt">
            <input type="radio" name={name} checked={optionId === o.id} onChange={() => setOption(o.id)} disabled={answer.isPending || (missingGrant && GRANTING(o.id))} />
            <span className="ol"><b>{o.label}{o.recommended && <span className="rec"> · recommended</span>}</b>{o.detail && <span className="m">{o.detail}</span>}</span>
          </label>
        ))}
      </fieldset>
      {/* Inline and visible, never a collapsed details: a decision answered without its note is a decision the Keeper cannot read. */}
      <label className="ask-notefield">
        <span>Add a note for the Keeper <span className="m">(optional)</span></span>
        <input className="ask-note-in" type="text" maxLength={2000} value={note} placeholder="Read alongside your answer" onChange={e => setNote(e.target.value)} />
      </label>
      <div className="facts"><span><b>Meanwhile</b> <span data-content>{ask.meanwhile || "nothing else waits"}</span></span><span><b>Holds</b> <span data-content>{holdsText(ask.holds)}</span></span>{ask.proceedAt !== null && <span><b>Default</b> applies at {clockTime(ask.proceedAt)}</span>}</div>
      <QueryState error={error} />
      <div className="ask-f">
        <button type="button" className={`btn ${ask.kind === "greenlight" ? "pri seal" : "pri"}`} disabled={!optionId || answer.isPending || !canSend} onClick={() => void submit()}>{ask.kind === "greenlight" && <Glyph name="wax-seal" />}{answer.isPending ? "Sending…" : action}</button>
        {onFold && <button type="button" className="btn" onClick={onFold}>Not now</button>}
        {!optionId && <span className="m small">Pick an answer first.</span>}
      </div>
    </section>
  );
}
