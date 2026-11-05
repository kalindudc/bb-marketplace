import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Hold, Replayed, ReplayedFinding, ReplaySettings } from "../../replay";
import { BUTTON_GHOST_SMALL, Pill } from "../common";
import { plural } from "../format";
import { findingHoldName, groupOf, holdName, holdsOf, holdTip, isSetting, mainHold, VERDICT_TEXT, VERDICT_TIP, YOU_TEXT, type Group, type Tab } from "./model";

const GROUPS: Group[] = ["post", "settings", "other"];
const GROUP_DOT: Record<Group, string> = { post: "bg-success", settings: "bg-warning", other: "bg-muted-foreground/40" };
const GROUP_TIP: Record<Group, string> = {
  post: "Shuttle would do this with the settings shown.",
  settings: "Every hold on these is a setting on this page; change it and they go through.",
  other: "Something no setting here changes holds these: the review's verdict, the PR itself, or what the check found.",
};
const groupName = (group: Group, tab: Tab) => (group === "post" ? (tab === "comment" ? "Would post" : "Would approve") : group === "settings" ? "Only your settings hold these" : "Held for another reason");

/** A hold as a chip: amber outline for one a setting here decides, muted for the rest; a kept hold keeps its text in the tooltip. */
export function HoldChip({ hold, settings, tab }: { hold: Hold; settings: ReplaySettings; tab: Tab }) {
  const name = holdName(hold, settings, tab);
  return (
    <span data-hold={hold.k} className="inline-flex min-w-0 max-w-full">
      <Pill tone={isSetting(hold) ? "warn" : "neutral"} title={hold.k === "kept" ? hold.text : holdTip(hold)}>
        <span className="max-w-[12rem] truncate">{name}</span>
      </Pill>
    </span>
  );
}

/** A verifier score on a short bar, the floor marked; "not scored" when the verifier gave none. */
function ScoreBar({ label, value, floor }: { label: string; value: number | null; floor: number }) {
  const text = value === null ? `${label}: not scored` : `${label} ${value.toFixed(2)}, floor ${floor.toFixed(2)}`;
  return (
    <div role="img" aria-label={text} title={text} className="relative h-1.5 rounded-full bg-muted">
      <div className={`h-full rounded-full ${value !== null && value >= floor ? "bg-success" : "bg-foreground/50"}`} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      <div aria-hidden className="absolute -inset-y-0.5 w-0.5 bg-warning" style={{ left: `calc(${floor * 100}% - 1px)` }} />
    </div>
  );
}

function FindingLine({ finding, settings }: { finding: ReplayedFinding; settings: ReplaySettings }) {
  const outcome = finding.you === "posted" ? "you posted" : finding.you === "dropped" ? "you dropped" : null;
  return (
    <div data-finding={finding.id} title={finding.body} className="grid min-h-6 grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2.5 text-xs">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">{finding.severity}</span>
      <ScoreBar label="Sure it's right" value={finding.holds} floor={settings.holds} />
      <ScoreBar label="Worth posting" value={finding.worth} floor={settings.worth} />
      <span className="flex items-center gap-1.5">
        <Pill tone={finding.pass ? "ok" : "neutral"}>{finding.pass ? "passes" : findingHoldName(finding.why[0]!)}</Pill>
        {outcome && <span className="text-[11px] text-muted-foreground">{outcome}</span>}
      </span>
    </div>
  );
}

function DraftRow({ row, tab, settings, open, onToggle, onOpenPr }: { row: Replayed; tab: Tab; settings: ReplaySettings; open: boolean; onToggle(): void; onOpenPr(key: string): void }) {
  const { draft } = row;
  const holds = holdsOf(row, tab);
  const main = mainHold(holds);
  const passingFindings = row.findings.filter((f) => f.pass).length;
  const panelId = `auto-post-draft-${draft.id}`;
  return (
    <li data-draft={draft.id} data-group={groupOf(row, tab)} className="border-t border-border first:border-t-0">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle}
        className="grid h-[3.25rem] w-full cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-x-2 rounded-md px-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono font-medium">{draft.display}</span>
          <span className="min-w-0 truncate text-muted-foreground" title={draft.title}>{draft.title}</span>
        </span>
        <span aria-hidden />
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[11px] text-muted-foreground" title={VERDICT_TIP[draft.verdict]}>Review: {VERDICT_TEXT[draft.verdict]}</span>
          <Pill tone="neutral" title={`What you did with the review: ${YOU_TEXT[draft.you]}`}><span className="max-w-[10rem] truncate">You: {YOU_TEXT[draft.you]}</span></Pill>
          <span className="min-w-0 flex-1" />
          {main !== null && <HoldChip hold={main} settings={settings} tab={tab} />}
          {main === null && tab === "comment" && <span className="text-[11px] text-muted-foreground">{plural(passingFindings, "finding")} {passingFindings === 1 ? "passes" : "pass"}</span>}
          {main === null && tab === "approve" && row.unchecked && <Pill tone="warn" icon="Clock" title="Shuttle runs the verifier's blocking check on the diff before it approves; it has not run for this draft yet.">blocking check not run yet</Pill>}
        </span>
      </button>
      {open && (
        <div id={panelId} data-draft-detail className="ml-[1.75rem] mr-1.5 flex flex-col gap-2 border-t border-border/60 py-2.5">
          <div data-draft-holds className="flex flex-wrap items-center gap-1.5">
            {holds.length === 0 && <span className="text-[11px] text-muted-foreground">Nothing holds it.</span>}
            {holds.map((hold, index) => <HoldChip key={index} hold={hold} settings={settings} tab={tab} />)}
            <span className="flex-1" />
            <button type="button" className={BUTTON_GHOST_SMALL} onClick={() => onOpenPr(draft.key)}><Icon name="GitPullRequest" className="size-3" aria-hidden />Open {draft.display}</button>
          </div>
          {row.findings.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2.5 text-[10.5px] text-muted-foreground">
                <span>{plural(row.findings.length, "finding")}</span><span>sure it's right</span><span>worth posting</span><span />
              </div>
              {row.findings.map((finding) => <FindingLine key={finding.id} finding={finding} settings={settings} />)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Every draft in three groups: those Shuttle would act on, those only this page's settings hold, and those held for another reason. */
export function Drafts({ rows, tab, settings, onOpenPr }: { rows: readonly Replayed[]; tab: Tab; settings: ReplaySettings; onOpenPr(key: string): void }) {
  const [closed, setClosed] = useState<Record<Group, boolean>>({ post: false, settings: false, other: true });
  const [open, setOpen] = useState<number | null>(null);
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">No drafts were checked in this range.</div>;
  const grouped = (group: Group) => {
    const members = rows.filter((row) => groupOf(row, tab) === group);
    return group === "settings" ? [...members].sort((a, b) => holdsOf(a, tab).length - holdsOf(b, tab).length) : members;
  };
  return (
    <div className="flex flex-col gap-3">
      {GROUPS.map((group) => {
        const members = grouped(group);
        const shown = !closed[group];
        return (
          <section key={group} data-draft-group={group}>
            <button type="button" aria-expanded={shown} aria-controls={`auto-post-group-${group}`} title={GROUP_TIP[group]} onClick={() => setClosed({ ...closed, [group]: shown })}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              <i aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${GROUP_DOT[group]}`} />
              <span className="font-semibold">{groupName(group, tab)}</span>
              <span data-group-count className="tabular-nums text-muted-foreground">{members.length}</span>
              <span className="flex-1" />
              <Icon name={shown ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
            </button>
            {shown && members.length > 0 && (
              <ul id={`auto-post-group-${group}`} className="mt-1 rounded-md border border-border">
                {members.map((row) => (
                  <DraftRow key={row.draft.id} row={row} tab={tab} settings={settings} open={open === row.draft.id} onToggle={() => setOpen(open === row.draft.id ? null : row.draft.id)} onOpenPr={onOpenPr} />
                ))}
              </ul>
            )}
            {shown && members.length === 0 && <div className="px-6 py-1 text-[11.5px] text-muted-foreground">None</div>}
          </section>
        );
      })}
    </div>
  );
}
