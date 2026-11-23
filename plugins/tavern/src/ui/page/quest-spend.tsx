import { experimental_useRpcMutation, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import { rpcContract } from "../../shared/contract";
import { NANOS_PER_CENT, budgetCentsSchema, spendCoverage, usd } from "../../shared/spend";
import { FoldSummary } from "../kit";
import { AlertAction } from "../kit/alert-action";
import { Section } from "./common";

const readTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function QuestSpend({ id, editable }: { id: string; editable: boolean }) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "questSpend", input: { id } });
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "setSpendBudget" });
  const fieldId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const view = query.data;
  if (!view) return query.error ? <Section title="Quest spend" className="tv-card"><div role="status">Spend could not be read. The existing budget has not changed.<AlertAction action={{ kind: "run", label: "Retry", run: query.refetch }} /></div></Section> : null;
  const held = view.reachedAt !== null;
  const save = async (budgetCents: number | null) => {
    setError(null);
    try { await mutation.mutate({ id, budgetCents }); setDraft(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const measured = view.usdNanos === null ? "Spend unknown" : view.usdNanos > 0 && view.usdNanos < NANOS_PER_CENT
    ? `Less than ${usd(0.01)} recorded` : `${usd(Math.floor(view.usdNanos / NANOS_PER_CENT) / 100)} recorded`;
  const proposal = view.proposal && <span>Proposed in plan v{view.proposal.planVersion}: {usd(view.proposal.cents / 100)}, not set</span>;
  const details = <div className="tv-spend-body">
      {held && <p className="tv-holdnote" role="status">New hires and briefs are held. Raise or remove the budget to let new work start.</p>}
      {view.missing > 0 && <p>{view.missing} {view.missing === 1 ? "session has" : "sessions have"} missing usage.</p>}
      {view.sources.length > 0 && <ul aria-label="Spend sources">{view.sources.map(source => <li key={source.name}>{source.name} · read <time dateTime={new Date(source.readAt).toISOString()}>{readTime.format(source.readAt)}</time></li>)}</ul>}
      <p>{spendCoverage}</p>
      {view.budgetCents === null && <p>Without a budget, only local cost receipts are checked here.</p>}
      {editable && <form className="tv-spend-form" onSubmit={event => {
        event.preventDefault();
        const cents = budgetCentsSchema.safeParse(Math.round(Number(draft) * 100));
        if (cents.success) void save(cents.data);
      }}>
        <label htmlFor={fieldId}>Budget in USD</label>
        <input className="tv-text" id={fieldId} type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required value={draft} onChange={event => setDraft(event.target.value)} />
        <button className="btn" type="submit" disabled={mutation.isPending}>{held ? "Raise budget" : view.budgetCents === null ? "Set budget" : "Change budget"}</button>
        {view.budgetCents !== null && <button className="btn ghost" type="button" disabled={mutation.isPending} onClick={() => void save(null)}>Remove budget</button>}
      </form>}
      {error && <p role="alert">{error}</p>}
    </div>;
  return view.budgetCents === null ? <details className="tv-card tv-spend tv-spend-fold">
    <FoldSummary><strong>Quest spend:</strong> {measured} · No budget{proposal && <> · {proposal}</>}{editable && <> · <span>Set budget</span></>}</FoldSummary>
    {details}
  </details> : <Section title="Quest spend" className="tv-card tv-spend">
    <p className="tv-spend-body"><span><strong>{measured}</strong> · {usd(view.budgetCents / 100)} budget</span>{proposal}</p>
    {details}
  </Section>;
}
