import { useEffect, useState, type ReactNode } from "react";
import type { ConcernKind } from "../../config";
import type { ReplayDraft } from "../../contract";
import type { Hold, Replayed, ReplaySettings } from "../../replay";
import { FIELD_SMALL, Pill, Segmented, Toggle } from "../common";
import { plural } from "../format";
import { fixedCounts, holdName, holdTip, KIND_NAME, KIND_TIP, kindsPresent, settingCounts, type Tab } from "./model";

const CHECK_RULES = [{ value: "passed" as const, label: "passed", tip: "Every check passed, or the PR reports none and that counts as passing" }, { value: "not_failed" as const, label: "none failed", tip: "No check failed; checks may still be running or missing" }];
const APPROVAL_SEVERITIES = ["nit", "low", "medium"] as const;

interface Row {
  key: string;
  name: string;
  tip?: string;
  /** Whether the setting holds anything now: an off switch, or a checks rule that lets running checks through, holds nothing. */
  on: boolean;
  drafts: number;
  control: ReactNode;
}

/** A whole number of lines in the schema's range; an invalid entry stays in the field with its message and changes nothing. */
function SizeInput({ value, min, label, onChange }: { value: number; min: number; label: string; onChange(next: number): void }) {
  const [text, setText] = useState(String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(String(value)); setBad(false); }, [value]);
  return (
    <span className="flex flex-col items-end">
      <input type="number" min={min} max={100_000} step={10} inputMode="numeric" aria-label={label} aria-invalid={bad || undefined} value={text} className={`${FIELD_SMALL} w-[5.5rem] tabular-nums`}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          const ok = event.target.value.trim() !== "" && Number.isInteger(next) && next >= min && next <= 100_000;
          setBad(!ok);
          if (ok && next !== value) onChange(next);
        }} />
      {bad && <span role="alert" className="mt-0.5 text-[10.5px] text-destructive-text">{min.toLocaleString()} to 100,000 lines</span>}
    </span>
  );
}

/** Each setting that holds drafts: how many, what it alone holds, and its control; then the reasons no setting changes. */
export function Holds({ rows, drafts, tab, settings, onChange, onTuneFloors }: {
  rows: readonly Replayed[]; drafts: readonly ReplayDraft[]; tab: Tab; settings: ReplaySettings; onChange(patch: Partial<ReplaySettings>): void; onTuneFloors(): void;
}) {
  const { held, only } = settingCounts(rows, tab);
  const list = tab === "comment" ? settings.holdComment : settings.holdApprove;
  const setKind = (kind: ConcernKind, on: boolean) => {
    const next = on ? [...new Set([...list, kind])] : list.filter((item) => item !== kind);
    onChange(tab === "comment" ? { holdComment: next } : { holdApprove: next });
  };
  const defs: Row[] = kindsPresent(drafts).map(({ kind, drafts: n }) => ({
    key: `concern:${kind}`, name: KIND_NAME[kind], tip: KIND_TIP[kind], on: list.includes(kind), drafts: n,
    control: <Toggle on={list.includes(kind)} label={`Hold ${tab === "comment" ? "comments" : "approvals"} for: ${KIND_NAME[kind]}`} onChange={(on) => setKind(kind, on)} />,
  }));
  const sizeHold: Hold = { k: "size" };
  defs.push({
    key: "size", name: holdName(sizeHold, settings, tab), on: true, drafts: held.get("size") ?? 0,
    control: tab === "comment"
      ? <SizeInput value={settings.maxLines} min={10} label="Largest PR for comments, in lines" onChange={(maxLines) => onChange({ maxLines })} />
      : <SizeInput value={settings.apprMaxLines} min={1} label="Largest PR an approval covers, in lines" onChange={(apprMaxLines) => onChange({ apprMaxLines })} />,
  });
  if (tab === "comment") {
    defs.push({
      key: "findings", name: "No finding passes", tip: holdTip({ k: "findings" }), on: true, drafts: held.get("findings") ?? 0,
      control: <button type="button" className="cursor-pointer text-xs text-primary hover:underline" onClick={onTuneFloors}>Tune the floors</button>,
    });
  } else {
    defs.push({
      key: "checks", name: "No passing checks", tip: "PRs whose checks were still running or not reported; a server that reports no checks for a repository always lands here.",
      on: settings.checks === "passed", drafts: drafts.filter((draft) => draft.checks === "pending" || draft.checks === "none" || draft.checks === null).length,
      control: <Segmented label="Checks an approval needs" value={settings.checks} options={CHECK_RULES} onChange={(checks) => onChange({ checks })} />,
    });
    defs.push({
      key: "severity-above", name: holdName({ k: "severity-above" }, settings, tab), on: true, drafts: held.get("severity-above") ?? 0,
      control: (
        <select aria-label="Highest finding severity an approval may carry" value={settings.apprSeverity} className={FIELD_SMALL} onChange={(event) => onChange({ apprSeverity: event.target.value as ReplaySettings["apprSeverity"] })}>
          {APPROVAL_SEVERITIES.map((severity) => <option key={severity} value={severity}>up to {severity}</option>)}
        </select>
      ),
    });
  }
  // A fixed order: concern kinds by how many drafts carry them, then the rest; a count that changes as you type never moves a row.
  const max = Math.max(1, rows.length);
  const fixed = fixedCounts(rows, tab);
  const verb = tab === "comment" ? "would post" : "would be approved";
  return (
    <div>
      <div className="flex flex-col" data-hold-rows>
        {defs.map((def) => {
          const gain = def.on ? only.get(def.key) ?? 0 : 0;
          return (
            <div key={def.key} data-hold-row={def.key} data-on={def.on} className="grid min-h-9 grid-cols-[minmax(8.5rem,1.5fr)_minmax(2.5rem,0.8fr)_1.5rem_auto] items-center gap-2.5 border-t border-border py-1 first:border-t-0">
              <span className={`flex min-w-0 items-baseline gap-1.5 text-xs ${def.on ? "" : "text-muted-foreground"}`}>
                <span className="truncate" title={def.tip}>{def.name}</span>
                {gain > 0 && <span data-hold-gain className="shrink-0 text-[11px] font-semibold text-success" title={`${plural(gain, "draft")} ${verb} if only this changed`}>+{gain}</span>}
              </span>
              <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className={`h-full rounded-full ${def.on ? "bg-warning" : "bg-muted-foreground/30"}`} style={{ width: `${Math.round((def.drafts / max) * 100)}%` }} />
              </div>
              <span data-hold-count className="text-right text-xs tabular-nums text-muted-foreground">{def.drafts}</span>
              <div className="flex min-w-[7rem] items-center justify-end">{def.control}</div>
            </div>
          );
        })}
      </div>
      {fixed.length > 0 && (
        <div data-fixed-holds className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-2.5 text-[11.5px] text-muted-foreground">
          <span title="Holds no setting on this page changes: the review's verdict, the PR itself, or what the check found.">Not settings:</span>
          {fixed.map(({ hold, drafts: n }) => (
            <Pill key={hold.k === "kept" ? `kept:${hold.text}` : hold.k} title={hold.k === "kept" ? hold.text : holdTip(hold)}>
              <span className="max-w-[11rem] truncate">{holdName(hold, settings, tab)}</span> {n}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}
