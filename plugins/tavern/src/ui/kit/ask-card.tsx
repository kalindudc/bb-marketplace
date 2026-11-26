import { Fragment, useId, useState } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import type { Ask, LeadPlanReview } from "../../shared/schema";
import { Glyph } from "./glyphs";
import { Clamp, MemberChip, QueryState, TimeAgo, clockTime } from "./primitives";
import { CONSEQUENTIAL_ASK_KINDS, preapprovalWords } from "../../shared/quest-authority";
import { QuestAuthority } from "./quest-authority";
import { useRegistry } from "./registry";
import { isCloseEffect, type PullRequestChoices } from "../../shared/closing";
import { WaiverRows } from "./waiver-rows";
import { scheduleLabel } from "../../shared/member-schedule";
import { useStartKeeper } from "./keeper-draft";

const KIND: Record<Ask["kind"], string> = { greenlight: "Greenlight", decision: "Decision", conclude: "Conclude", production: "Production", "cluster-write": "Cluster write", merge: "Merge", destructive: "Destructive", "sends-as-you": "Sends as you", "drafts-as-you": "Draft as you", blocker: "Blocker", credential: "Credential", scope: "Scope change" };
const VIA: Record<string, string> = { banner: "in the thread", page: "in the common room", phone: "on the phone", chat: "in the chat", cli: "from the CLI", timer: "by its default", tavern: "by Tavern" };
const holdsText = (holds: string[]) => holds.length === 0 ? "No other work" : holds.map(h => /^w\d+$/.test(h) ? `waypoint ${h.slice(1)}` : h).join(", ");

const RULE_WORDS: Record<string, string> = {
  "git-push-main": "Push to main or master",
  "git-push-force": "Force, mirror or deletion pushes",
  "git-push-target": "Push without naming a branch",
  "cluster-write": "Cluster writes need a separate answer for each run",
  "deploy-fallback": "Run a deployment pipeline",
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

const CHECK_WORDS = { warden: "Warden check", keeper: "Keeper check", you: "your check", none: "no required check" };
function PlanBounds({ bounds, before }: { bounds: LeadPlanReview["approved"]; before?: LeadPlanReview["approved"] }) {
  const was = (next: number | string, old?: number | string) => old !== undefined && old !== next ? ` (was ${old})` : "";
  return <>{bounds.members} {bounds.members === 1 ? "member" : "members"}{was(bounds.members, before?.members)}, {bounds.rangers} {bounds.rangers === 1 ? "Ranger" : "Rangers"}{was(bounds.rangers, before?.rangers)}, {CHECK_WORDS[bounds.check]}{was(CHECK_WORDS[bounds.check], before && CHECK_WORDS[before.check])}
    {bounds.acts.length ? <ul className="grants">{bounds.acts.map(act => <li key={JSON.stringify(act)}>
      <span>{before && !before.acts.some(previous => previous.kind === act.kind && previous.path === act.path && previous.command === act.command) ? "New scope act: " : ""}{act.kind}</span>{act.path && <code>{act.path}</code>}{act.command && <code>{act.command}</code>}
    </li>)}</ul> : <span> · no listed scope acts</span>}</>;
}
function LeadPlanBounds({ request }: { request: LeadPlanReview }) {
  const limits = request.changes.length ? request.changes : [{ linkId: request.parentQuestId, questTitle: request.parentTitle, approved: request.approved, requested: request.requested }];
  const diff = request.planChanges;
  const changes = diff ? [
    ...diff.fields.map(field => `Changed ${field.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}`),
    ...diff.addedWaypoints.map(title => `Added waypoint: ${title}`),
    ...diff.removedWaypoints.map(title => `Removed waypoint: ${title}`),
    ...diff.changedWaypoints.map(title => `Changed waypoint: ${title}`),
    ...(diff.orderChanged ? ["Waypoint order changed"] : []),
  ] : [];
  return <>{limits.map(change => <dl className="sendbox grant" aria-label="Lead plan limits" key={change.linkId}>
    <dt>From</dt><dd data-content>{change.questTitle}</dd>
    <dt>Approved</dt><dd><PlanBounds bounds={change.approved} /></dd>
    <dt>Requested</dt><dd><PlanBounds bounds={change.requested} before={change.approved} /></dd>
  </dl>)}{diff && changes.length > 0 && <dl className="sendbox grant" aria-label="Lead plan changes">
    <dt>Changes since plan v{diff.fromVersion}</dt><dd><ul className="grants">{changes.map((change, index) => <li key={index}>{change}</li>)}</ul></dd>
  </dl>}</>;
}

/** One ask, answered in place. Consequential kinds start with nothing selected; sends-as-you shows sender, recipient and the full draft. */
export function AskCard({ ask: originalAsk, via = "banner", onFold, onAnswered, headless = false, describeEffects = false, cardRef }: { ask: Ask; via?: "banner" | "page" | "phone" | "chat"; onFold?: () => void; onAnswered?: (answered: Ask) => void; headless?: boolean; describeEffects?: boolean; cardRef?: import("react").RefCallback<HTMLElement> }) {
  const name = useId();
  const [approvedAsk, setApprovedAsk] = useState<Ask>();
  const ask = originalAsk.state === "open" && approvedAsk?.id === originalAsk.id && !originalAsk.clusterApproval ? approvedAsk : originalAsk;
  const cluster = ask.kind === "cluster-write";
  const communication = ask.effect?.type === "communication-hold" ? ask.effect.hold : null;
  const readiness = experimental_useRpcQuery({ contract: rpcContract, method: "clusterRunStatus", input: { askId: ask.id }, enabled: cluster && ask.state === "open" });
  const shellGrant = ask.effect?.type === "grant-shell-act" ? ask.effect : null;
  const repair = ask.effect?.type === "repair-guard";
  const userMove = ask.effect?.type === "user-waypoint" ? ask.effect : null;
  const questStart = ask.effect?.type === "quest-start" ? ask.effect : null;
  const startKeeper = useStartKeeper();
  const [optionId, setOption] = useState<string | null>(repair ? "done" : ask.kind === "decision" && !shellGrant ? ask.options.find(o => o.recommended)?.id ?? null : null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ label: string; at: number; note: string | null; pullRequestErrors?: string[]; clusterGrantError?: string } | null>(null);
  const [choices, setChoices] = useState<Record<string, PullRequestChoices[number]["action"]>>({});
  const closing = isCloseEffect(ask.effect) ? ask.effect : null;
  const early = closing?.type === "close-early" ? closing : null;
  const lead = ask.effect?.type === "lead-plan" ? ask.effect.request : null;
  const answer = experimental_useRpcMutation({ contract: rpcContract, method: "answerAsk" });
  if (ask.state !== "open" || receipt) {
    const label = ask.answer?.by === "tavern" ? "" : receipt?.label ?? ask.options.find(o => o.id === ask.answer?.optionId)?.label ?? ask.answer?.optionId ?? "";
    const at = receipt?.at ?? ask.answer?.at ?? null;
    const receiptNote = receipt?.note ?? ask.answer?.note ?? null;
    const reopenDraft = questStart && (receipt ? optionId === "new-keeper" : ask.state === "answered" && ask.answer?.by === "user" && ask.answer.optionId === "new-keeper");
    return (
      <div ref={cardRef} className="tavern receipt" role="status" aria-label={`Ask answered: ${ask.question}`}>
        <Glyph name="check" />
        <b>{ask.state === "withdrawn" ? "Withdrawn" : ask.state === "defaulted" ? "Default applied" : "Answered"}</b>
        {label && <span>“{label}”</span>}
        {ask.answer?.preapproval && <span>{preapprovalWords(ask.answer.preapproval)}</span>}
        {ask.answer?.by === "keeper" && <span>Decided by the Keeper, with Undo in the ledger</span>}
        {(receipt || ask.answer?.by === "user" && ask.answer?.surface === "client (unattested)") && <span className="m">answered from a client Tavern could not attribute</span>}
        {userMove && (receipt || ask.answer?.by === "user") && <span>{userMove.completeOn.includes(ask.answer?.optionId ?? optionId ?? "") ? "Your waypoint is done." : "Your waypoint stays open."}</span>}
        {receiptNote && <span className="receipt-note" data-content>“{receiptNote}”</span>}
        {reopenDraft && <button type="button" className="btn" onClick={() => startKeeper(questStart)}>Open Keeper draft</button>}
        {cluster && ask.clusterApproval && <span>Approved {VIA[ask.clusterApproval.via]} at {clockTime(ask.clusterApproval.at)}</span>}
        {receipt?.clusterGrantError && <span role="alert" className="problem">{receipt.clusterGrantError}</span>}
        {receipt?.pullRequestErrors?.map(message => <span key={message} className="receipt-note problem" role="alert">{message}</span>)}
        <span className="m">{ask.answer?.by === "preapproval" ? "from your quest pre-approval" : VIA[ask.answer?.via ?? via]}{at !== null ? ` at ${clockTime(at)}` : ""} · cleared everywhere</span>
      </div>
    );
  }
  const missingGrant = ask.kind === "scope" && !ask.scopeChange;
  const clusterReady = !cluster || optionId === "deny" || readiness.data?.guarded === true;
  const canSend = clusterReady && (ask.kind !== "sends-as-you" || ask.draft !== null || communication !== null) && !(missingGrant && optionId !== null && GRANTING(optionId));
  const action = repair ? "Done" : shellGrant && (optionId === "once" || optionId === "quest") ? "Grant this command" : shellGrant ? "Send answer" : early && optionId === "close-early" ? "Close early" : communication || ask.effect?.type === "pull-request-draft" ? "Record answer" : ask.kind === "sends-as-you" ? "Record answer" : lead ? (ask.options.find(option => option.id === optionId)?.label ?? "Send answer") : ask.kind === "greenlight" ? "Form the party (greenlight)" : ask.kind === "scope" && optionId !== null && GRANTING(optionId) ? "Grant this scope" : cluster && optionId === "approve" ? "Approve" : cluster && optionId === "confirm-run" ? "Run it now" : "Send answer";
  async function submit() {
    if (!optionId || !canSend) return;
    setError(null);
    try {
      const pullRequestChoices = closing?.type === optionId ? Object.entries(choices).map(([id, action]) => ({ id, action })) : [];
      const result = await answer.mutate({ askId: ask.id, optionId, note: note.trim() || null, via, ...(pullRequestChoices.length ? { pullRequestChoices } : {}) });
      if (result.ask?.clusterApproval) {
        setApprovedAsk(result.ask); setOption(null); setNote(""); return;
      }
      const at = Date.now();
      setReceipt({ label: result.clusterGrantError ? "No run granted" : ask.options.find(o => o.id === optionId)!.label, at, note: note.trim() || null, pullRequestErrors: result.pullRequestErrors, clusterGrantError: result.clusterGrantError });
      onAnswered?.({ ...ask, state: "answered", answer: { optionId, note: note.trim() || null, by: "user", via, at, surface: "client (unattested)" } });
      if (questStart && optionId === "new-keeper") startKeeper(questStart);
    } catch (e) { setError(e); }
  }
  const why = ask.why ? `Yours because ${ask.why.charAt(0).toLowerCase() + ask.why.slice(1)}` : "";
  return (
    <section ref={cardRef} className={`tavern ask k-${ask.kind}`} aria-label={`Ask: ${ask.question}`} data-ask>
      {headless ? why && <Clamp text={why} className="ask-why" /> : <><div className="ask-h"><span className="kind">{early ? "Close early" : KIND[ask.kind]}</span>{ask.createdAt > 0 && <span>asked <TimeAgo at={ask.createdAt} /></span>}{why && <Clamp text={`· ${why.charAt(0).toLowerCase() + why.slice(1)}`} className="ask-why" />}</div><h3 className="ask-q"><Clamp text={ask.question} /></h3></>}
      {questStart && <dl className="sendbox" aria-label="Your goal"><dt>Goal</dt><dd className="draft" data-content>{questStart.goal}</dd></dl>}
      {ask.kind === "greenlight" && <p className="m small">Cluster writes always ask you, even after you approve the quest map.</p>}
      {ask.effect?.type === "member-schedules" && <dl className="sendbox" aria-label="Schedules to approve">
        {ask.effect.schedules.map((schedule, index) => <Fragment key={index}><dt>{scheduleLabel(schedule)} (server time)</dt><dd data-content>{schedule.duty}</dd></Fragment>)}
      </dl>}
      {(ask.effect?.type === "greenlight" ? ask.effect.scheduledSlots : lead?.scheduledSlots)?.map(slot => <dl className="sendbox" aria-label={`Schedules for party slot ${slot.slot}`} key={slot.slot}>
        <dt>Slot {slot.slot}</dt><dd data-content>{slot.purpose}</dd>
        {slot.schedules.map((schedule, index) => <Fragment key={index}><dt>{scheduleLabel(schedule)} (server time)</dt><dd data-content>{schedule.duty}</dd></Fragment>)}
      </dl>)}
      {lead && <><LeadPlanBounds request={lead} /><p className="m small">This answer approves the plan, not any separate permission or consequential act.</p></>}
      {!lead && ask.kind === "greenlight" && ask.boardQuestId && <QuestAuthority questId={ask.boardQuestId} via={via} />}
      {cluster && ask.clusterApproval && <h3>Run it now?</h3>}
      {cluster && !readiness.isLoading && readiness.data?.guarded !== true && <p role="status">This thread cannot be guarded. Run the command yourself or ask a guarded thread to run it.</p>}
      {cluster && ask.target?.command && <dl className="sendbox" aria-label="Exactly what would change">
        <dt>Runs in</dt><dd>{ask.runThreadName ?? "The Keeper"}{ask.runThreadId && <span className="m"> ({ask.runThreadId})</span>}</dd>
        <dt>Command</dt><dd><code className="draft">{ask.target.command}</code></dd>
        {ask.clusterTargets?.map(({ context, namespace }) => <Fragment key={JSON.stringify([context, namespace])}>
          {context && <><dt>Context</dt><dd>{context}</dd></>}
          {namespace && <><dt>Namespace</dt><dd>{namespace}</dd></>}
        </Fragment>)}
        {ask.change && <><dt>Change</dt><dd>{ask.change}</dd></>}
      </dl>}
      {ask.undo && CONSEQUENTIAL_ASK_KINDS.some(kind => kind === ask.kind) && <dl className="sendbox"><dt>Undo</dt><dd>{ask.undo}</dd></dl>}
      {ask.lane === "keeper" && <p role="status">This kind is delegated to the Keeper. You can still answer here or revoke it in the ledger.</p>}
      {communication && <dl className="sendbox" aria-label="Held message">
        <dt>Tool</dt><dd className="wrap">{communication.tool}</dd>
        <dt>To</dt><dd className="wrap">{communication.target ?? "The call did not reveal the recipient."}</dd>
        <dt>Message</dt><dd className="draft" data-content>{communication.body ?? "The call did not reveal the full message."}</dd>
        {communication.detail && <><dt>Command</dt><dd><code className="draft">{communication.detail}</code></dd></>}
      </dl>}
      {ask.draft && (
        <dl className="sendbox" aria-label="Exactly what would be sent">
          <dt>Sends as</dt><dd className="warn">You</dd>
          <dt>To</dt><dd>{ask.draft.to}</dd>
          <dt>Message</dt><dd className="draft">{ask.draft.body}</dd>
        </dl>
      )}
      {ask.scopeChange && <ScopeGrant change={ask.scopeChange} />}
      {shellGrant && <dl className="sendbox grant" aria-label="Exact shell grant">
        <dt>Act</dt><dd>{shellGrant.target.act}</dd>
        <dt>Command</dt><dd><code className="wrap">{shellGrant.target.command}</code></dd>
        <dt>Directory</dt><dd><code className="wrap">{shellGrant.target.cwd}</code></dd>
        {shellGrant.target.destinations?.length ? <><dt>Destination</dt><dd>{shellGrant.target.destinations.map(value => <code className="wrap" key={value}>{value}</code>)}</dd></> : null}
      </dl>}
      {ask.kind === "sends-as-you" && ask.draft === null && !communication && <p role="alert" className="problem">The send preview is missing. Ask the Keeper for the recipient and the full draft before answering.</p>}
      {missingGrant && <p role="alert" className="problem">The grant details are missing, so this scope cannot be widened here. You can still keep the current restrictions.</p>}
      {closing?.draft.fromSteer && <blockquote className="close-quote"><b>You said, {clockTime(closing.draft.fromSteer.at)}:</b> <span data-content>“{closing.draft.fromSteer.text}”</span></blockquote>}
      {early?.draft.noPlan && early.draft.reason && <p className="m" data-content>Reason for closing early: {early.draft.reason}</p>}
      {early && <WaiverRows items={early.draft.unsettled} />}
      {closing?.draft.pullRequests?.length && !(closing.type === "conclude" && closing.draft.lead) ? <fieldset className="close-prs">
        <legend>Open pull requests</legend>
        <p className="m">These choices apply only if you close the quest. Pull requests stay open unless you choose Close pull request.</p>
        <ul>{closing.draft.pullRequests.map(pr => <li key={pr.id}>
          <div><a href={pr.url} target="_blank" rel="noreferrer">{pr.url}</a>
            <span className="m">{pr.state === "ready" ? "Ready" : "Draft"}, owner: {pr.ownerName}, {pr.headVerified ? "head verified" : "head not verified"}</span>
            {pr.stateNote && <span className="m">{pr.stateNote}</span>}{pr.closeUnavailable && <span className="m">{pr.closeUnavailable}</span>}
          </div>
          <select aria-label={`After closing: ${pr.url}`} value={choices[pr.id] ?? "keep"} disabled={answer.isPending} onChange={event => setChoices(current => ({ ...current, [pr.id]: event.target.value as PullRequestChoices[number]["action"] }))}>
            <option value="keep">Keep with the Keeper</option><option value="you">Keep and transfer to you</option><option value="close" disabled={!!pr.closeUnavailable}>Close pull request</option>
          </select>
        </li>)}</ul>
      </fieldset> : null}
      {!repair && <fieldset className="opts">
        <legend className="sr">Your answer</legend>
        {ask.options.map(o => (
          <label key={o.id} className="opt">
            <input type="radio" name={name} checked={optionId === o.id} onChange={() => setOption(o.id)} disabled={answer.isPending || (missingGrant && GRANTING(o.id)) || (cluster && o.id !== "deny" && readiness.data?.guarded !== true)} />
            <span className="ol"><b className="opt-copy ct">{o.label}{o.recommended && <span className="rec"> · recommended</span>}</b>{o.detail && <>{" "}<span className="opt-copy ct m">{o.detail}</span></>}{userMove && <>{" "}<span className="m">{userMove.completeOn.includes(o.id) ? "Finishes your waypoint." : "Leaves your waypoint open."}</span></>}</span>
          </label>
        ))}
      </fieldset>}
      {/* Inline and visible, never a collapsed details: a decision answered without its note is a decision the Keeper cannot read. */}
      <label className="ask-notefield">
        <span>Add a note for the Keeper <span className="m">(optional)</span></span>
        <input className="ask-note-in" type="text" maxLength={2000} value={note} placeholder="Read alongside your answer" onChange={e => setNote(e.target.value)} />
      </label>
      <div className="facts"><span><b>Meanwhile</b> <span data-content>{ask.meanwhile || "nothing else waits"}</span></span><span><b>Holds</b> <span data-content>{holdsText(ask.holds)}</span></span>{ask.proceedAt !== null && <span><b>Default</b> applies at {clockTime(ask.proceedAt)}</span>}</div>
      <QueryState error={error} />
      <div className="ask-f">
        <button type="button" className={`btn ${ask.kind === "greenlight" ? "pri seal" : "pri"}`} disabled={!optionId || answer.isPending || !canSend} aria-describedby={describeEffects ? `${name}-effect` : undefined} onClick={() => void submit()}>{ask.kind === "greenlight" && <Glyph name="wax-seal" />}{answer.isPending ? "Sending…" : action}</button>
        {describeEffects && <span className="ask-effect" id={`${name}-effect`}>{repair ? "Checks whether the guard loaded. It does not run the blocked call." : communication || ask.kind === "sends-as-you" ? "Records your choice. Nothing is sent by the agent." : cluster || shellGrant ? "Records your choice; it does not run the command." : questStart ? "Records your choice without starting a thread." : "Applies your choice and tells the Keeper."}</span>}
        {onFold && <>
          <button type="button" className="btn" aria-describedby={describeEffects ? `${name}-fold-effect` : undefined} onClick={onFold}>Not now</button>
          {describeEffects && <span className="ask-effect" id={`${name}-fold-effect`}>Hides the form without answering.</span>}
        </>}
        {!optionId && <span className="m small">Pick an answer first.</span>}
      </div>
    </section>
  );
}
