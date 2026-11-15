import { useEffect, useState, type ReactNode } from "react";
import type { Rule } from "../../shared/schema";
import { ExpandsMark, Glyph } from "./glyphs";

type Scope = Rule["scope"];

/** Who a standing rule reaches, in plain words. A rule reaches its Keeper and that Keeper's party; a member reads it in its brief. */
export const RULE_SCOPE: Record<Scope, { label: string; reach: string }> = {
  keeper: { label: "This Keeper", reach: "this Keeper and its party" },
  quest: { label: "This quest", reach: "this quest's Keeper and party, while the quest is open" },
  project: { label: "This project", reach: "every Keeper and party in this project" },
  global: { label: "All Keepers", reach: "every Keeper and party, in every project" },
};

/** "This Keeper", "This quest: Vault cutover", "All Keepers". */
export function ruleScopeLabel(scope: Scope, questTitle?: string | null) {
  return scope === "quest" && questTitle ? `${RULE_SCOPE.quest.label}: ${questTitle}` : RULE_SCOPE[scope].label;
}

/**
 * One quiet action that widens a rule to all Keepers, confirmed in place (never a modal).
 * Returns the trigger for the rule's scope line and the confirm for the full row width, so each surface places them.
 * `onWiden` is absent when the rule cannot widen (already global, turned off, or the server has no widen call yet).
 */
export function useWidenRule({ rule, onWiden }: { rule: Pick<Rule, "id" | "text" | "scope" | "active">; onWiden?: () => Promise<unknown> }): { trigger: ReactNode; confirm: ReactNode } {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 6000); return () => clearTimeout(t); }, [done]);
  if (done) return { trigger: <span className="rs-done" role="status"><Glyph name="check" size={12} /><span>Now applies to all Keepers</span></span>, confirm: null };
  if (!onWiden || rule.scope === "global" || !rule.active) return { trigger: null, confirm: null };
  const id = `rs-${rule.id}`;
  const apply = () => { setBusy(true); setError(null); onWiden().then(() => { setOpen(false); setDone(true); }, setError).finally(() => setBusy(false)); };
  return {
    trigger: <button type="button" className="lnk-btn act rs-widen" aria-expanded={open} aria-controls={id} title={`Apply to all Keepers: ${RULE_SCOPE.global.reach}. You confirm first.`} onClick={() => setOpen(!open)}><span>Apply to all Keepers</span><ExpandsMark open={open} /></button>,
    confirm: open ? <div className="rs-confirm" id={id} role="group" aria-label="Apply this rule to all Keepers">
      <p>All Keepers and their parties, in every project, follow “{rule.text}” from their next tick. You can turn it off in any Ledger.</p>
      <div className="rs-acts">
        <button type="button" className="btn sm pri" disabled={busy} onClick={apply}>Apply to all Keepers</button>
        <button type="button" className="lnk-btn act" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error != null && <p className="rs-err" role="alert">{error instanceof Error ? error.message : String(error)}</p>}
    </div> : null,
  };
}
