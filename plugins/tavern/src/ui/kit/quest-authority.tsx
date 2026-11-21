import { useState } from "react";
import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { DELEGATABLE_KINDS, preapprovalWords } from "../../shared/quest-authority";
import { QueryState, clockTime } from "./primitives";
import { useRegistry } from "./registry";
import { usd } from "../../shared/spend";
const names = { "cluster-write": "Cluster writes", production: "Production changes", merge: "Merges", credential: "Credentials", "sends-as-you": "Sending as you", "drafts-as-you": "Drafting as you", destructive: "Deleting outside quest work or changing your tools" };
export function QuestAuthority({ questId, via = "page", compact = false }: { questId: string; via?: "page" | "banner" | "phone" | "chat"; compact?: boolean }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "questAuthority", input: { boardQuestId: questId } });
  const registry = useRegistry();
  const delegate = experimental_useRpcMutation({ contract: rpcContract, method: "delegateQuest" });
  const approve = experimental_useRpcMutation({ contract: rpcContract, method: "preapproveQuest" });
  const revoke = experimental_useRpcMutation({ contract: rpcContract, method: "revokeQuestAuthority" });
  const [classes, setClasses] = useState<string[]>([]), [max, setMax] = useState(2), [greenlight, setGreenlight] = useState(false), [placement, setPlacement] = useState(false), [conclude, setConclude] = useState(false), [ends, setEnds] = useState("");
  const [targetText, setTargetText] = useState("");
  const targets = [...new Set(targetText.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  const [error, setError] = useState<unknown>(null), [receipt, setReceipt] = useState("");
  const busy = delegate.isPending || approve.isPending || revoke.isPending;
  async function act(run: () => Promise<unknown>, text: string) { setError(null); try { await run(); setReceipt(text); } catch (e) { setError(e); } }
  const data = query.data;
  if (!data) return <QueryState loading={query.isLoading} error={query.error} />;
  const live = (g: { endedAt: number | null; revokedAt: number | null; endsAt?: number | null }) => g.endedAt === null && g.revokedAt === null && (g.endsAt == null || g.endsAt > Date.now());
  return <section className="tavern gl-blocks" aria-label="Who decides on this quest">
    <h3>Authority on this quest</h3>
    <dl className="sendbox"><dt>{data.keeperName} decides</dt><dd>{data.rows.filter(r => r.lane === "keeper").map(r => names[r.kind as keyof typeof names] ?? r.kind).join(", ")}</dd><dt>Asks you</dt><dd>{data.rows.filter(r => r.lane === "user").map(r => names[r.kind as keyof typeof names] ?? r.kind).join(", ") || "No delegated kinds remain with you"}</dd><dt>Tavern answers</dt><dd>{data.rows.filter(r => r.lane === "tavern").map(r => `${r.kind} within your pre-approval`).join(", ") || "No standing answers"}</dd><dt>Review</dt><dd>review {data.review.used} of {data.review.total}</dd><dt>Spend budget</dt><dd>{data.spendBudget === null ? "None set" : usd(data.spendBudget / 100)}{data.spendProposal !== undefined && <p>Approving this plan yourself sets the budget to {usd(data.spendProposal / 100)}.</p>}</dd></dl>
    {!compact && <details><summary>Let {data.keeperName} decide for this quest</summary><p>Cluster writes always ask you. Only you send messages.</p><ul className="grants">{DELEGATABLE_KINDS.map(kind => {
      const grant = data.delegations.find(g => g.kind === kind && live(g));
      if (kind === "drafts-as-you") return <li key={kind}><span>{names[kind]}</span>
        <label>Draft targets, one per line<textarea value={targetText} onChange={e => setTargetText(e.target.value)} /></label>
        <button className="btn sm" type="button" disabled={busy || !targets.length} onClick={() => void act(async () => {
          await delegate.mutate({ boardQuestId: questId, kind, via, targets }); setTargetText("");
        }, "Draft authority recorded for these targets only.")}>Delegate these draft targets</button>
      </li>;
      return <li key={kind}><span>{names[kind]}</span>{(kind === "merge" || kind === "production") && <p className="m">Needs a Warden verdict on the exact commit or command.</p>}{grant ? <span className="m">Delegated</span> : <button className="btn sm" type="button" disabled={busy} onClick={() => void act(() => delegate.mutate({ boardQuestId: questId, kind, via }), `${names[kind]} delegated to ${data.keeperName} for this quest only.`)}>Let {data.keeperName} decide {names[kind].toLowerCase()}</button>}</li>;
    })}</ul></details>}
    {!compact && <details><summary>Pre-approve routine answers for this quest</summary><p>No model answers these asks. Anything outside your envelope still asks you.</p><p>The plan’s declared acts are the pre-approval gate; a push still needs its merge ask.</p>
      <label className="opt"><input type="checkbox" checked={greenlight} onChange={e => setGreenlight(e.target.checked)} />Approve fitting greenlights with no always-ask acts</label>
      {greenlight && <><label>At most <input type="number" min={0} max={8} value={max} onChange={e => setMax(Number(e.target.value))} /> members</label><fieldset><legend>Allowed classes</legend>{registry.data?.classes.filter(c => c.id !== "keeper").map(c => <label key={c.id} className="opt"><input type="checkbox" checked={classes.includes(c.id)} onChange={e => setClasses(e.target.checked ? [...classes, c.id] : classes.filter(id => id !== c.id))} />{c.id}</label>)}</fieldset></>}
      <label className="opt"><input type="checkbox" checked={placement} onChange={e => setPlacement(e.target.checked)} />On a placement blocker, retry once, then stop the quest</label>
      <label className="opt"><input type="checkbox" checked={conclude} onChange={e => setConclude(e.target.checked)} />Conclude only when every waypoint is verified</label>
      <label>Ends with this quest, or earlier <input type="datetime-local" value={ends} onChange={e => setEnds(e.target.value)} /></label>
      <button type="button" className="btn pri" disabled={busy || !(greenlight || placement || conclude) || greenlight && !classes.length} onClick={() => void act(() => approve.mutate({ boardQuestId: questId, via, greenlight: greenlight ? { maxMembers: max, classes } : null, placement, conclude, endsAt: ends ? new Date(ends).getTime() : null }), "Your pre-approval was recorded for this quest only.")}>Record my pre-approval</button>
    </details>}
    <ul className="grants" aria-label="Quest authority ledger">{[...data.delegations, ...data.preapprovals].map(g => <li key={g.id}><span>{"kind" in g ? `${names[g.kind]} ${g.kind === "sends-as-you" ? "was recorded before send delegation was removed" : "delegated"} at ${clockTime(g.at)} (${g.surface})` : preapprovalWords(g)}</span>{"kind" in g && g.targets?.length ? <ul aria-label="Draft targets">{g.targets.map(target => <li className="wrap" key={target}>{target}</li>)}</ul> : null}<span className="m">{g.revokedAt !== null ? "Revoked" : g.endedAt !== null ? "Ended with the quest" : "endsAt" in g && g.endsAt !== null ? `Ends ${clockTime(g.endsAt)}` : "Ends with the quest"}</span>{live(g) && (!("kind" in g) || g.kind !== "sends-as-you") && <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => revoke.mutate({ boardQuestId: questId, id: g.id, via }), "Revoked immediately. Future asks return to you.")}>Revoke</button>}</li>)}</ul>
    {receipt && <p role="status">{receipt}</p>}<QueryState error={error} />
  </section>;
}
