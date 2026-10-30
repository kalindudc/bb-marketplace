import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Label, PrView, ReviewerState } from "../contract";
import { Avatar } from "./avatar";
import { Pill } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import type { EditPr } from "./edit";
import { PickerAction, PickerCheckbox, PickerFilter, PickerGroup } from "./picker";

const HEX = /^(?:[0-9a-f]{3}){1,2}$/iu;

/**
 * A label as a neutral chip in the theme's colours, with its server's colour kept as a dot: servers send it
 * as hex without the "#", chosen for their own page, so it never colours the chip itself.
 */
export function LabelChip({ label, onRemove, maxChars }: { label: Label; onRemove?: () => void; maxChars?: number }) {
  const cut = maxChars !== undefined && label.name.length > maxChars;
  return (
    <span data-label={label.name} title={cut ? label.name : undefined}
      className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-recessed px-2 text-[11.5px] leading-none text-muted-foreground">
      <ColorDot color={label.color} />
      {cut ? `${label.name.slice(0, maxChars - 1)}…` : label.name}
      {onRemove && (
        <button type="button" aria-label={`Remove label ${label.name}`} title="Remove" onClick={onRemove} className="-mr-1 inline-flex cursor-pointer rounded-full opacity-70 hover:text-foreground hover:opacity-100">
          <Icon name="X" className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

const ROW_LABELS = 3;
const ROW_LABEL_CHARS = 24;

/** A list row's labels: the first few, shortened, then how many more. Servers such as Delta add long automatic ones. */
export function RowLabels({ labels }: { labels: readonly Label[] | null }) {
  if (labels === null || labels.length === 0) return null;
  const rest = labels.slice(ROW_LABELS);
  return (
    <>
      {labels.slice(0, ROW_LABELS).map((label) => <LabelChip key={label.name} label={label} maxChars={ROW_LABEL_CHARS} />)}
      {rest.length > 0 && <Pill title={rest.map((label) => label.name).join("\n")}>+{rest.length}</Pill>}
    </>
  );
}

function ColorDot({ color, size = "size-2" }: { color: string | null; size?: string }) {
  const valid = color !== null && HEX.test(color);
  return <span aria-hidden className={`${size} shrink-0 rounded-full ${valid ? "" : "bg-muted-foreground/40"}`} style={valid ? { backgroundColor: `#${color}` } : undefined} />;
}

export const REVIEWER_LOOKS: Record<ReviewerState, { icon: string; label: string; className: string }> = {
  requested: { icon: "Clock", label: "Review requested", className: "text-warning-text" },
  approved: { icon: "Check", label: "Approved", className: "text-success" },
  changes: { icon: "X", label: "Changes requested", className: "text-destructive-text" },
  commented: { icon: "MessageSquare", label: "Commented", className: "text-muted-foreground" },
  dismissed: { icon: "Minus", label: "Dismissed", className: "text-muted-foreground" },
};

export function LabelChoices({ pr, edit }: { pr: PrView; edit: EditPr }) {
  const options = useShuttleQuery("editOptions", { key: pr.key });
  const [filter, setFilter] = useState("");
  const offered = options.data?.labels;
  const { rememberColors } = edit;
  useEffect(() => {
    if (offered) rememberColors(offered);
  }, [offered, rememberColors]);
  const current = pr.labels ?? [];
  const all = [...(offered ?? []), ...current.filter((label) => !offered?.some((item) => item.name === label.name)).map((label) => ({ ...label, description: null }))];
  const text = filter.trim();
  const shown = all.filter((label) => `${label.name} ${label.description ?? ""}`.toLowerCase().includes(text.toLowerCase()));
  return (
    <>
      <PickerFilter label="Filter labels" value={filter} onChange={setFilter} />
      {options.error !== null && <div className="px-2.5 py-1.5 text-xs text-destructive-text">Could not load the labels: {messageOf(options.error)}</div>}
      {options.isLoading && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading labels…</div>}
      <PickerGroup>Labels in {pr.repo}</PickerGroup>
      {shown.map((label) => {
        const on = current.some((item) => item.name === label.name);
        return (
          <PickerCheckbox key={label.name} checked={on} onToggle={() => edit.apply(on ? { kind: "labels", remove: [label.name] } : { kind: "labels", add: [label.name] })}>
            <ColorDot color={label.color} size="size-2.5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{label.name}</span>
              {label.description && <span className="block truncate text-xs text-muted-foreground">{label.description}</span>}
            </span>
          </PickerCheckbox>
        );
      })}
      {text !== "" && shown.length === 0 && (
        <PickerAction keepOpen onSelect={() => { edit.apply({ kind: "labels", add: [text] }); setFilter(""); }}>
          <Icon name="Plus" className="size-3.5" aria-hidden />
          Add label “{text}”
        </PickerAction>
      )}
    </>
  );
}

export function ReviewerChoices({ pr, edit }: { pr: PrView; edit: EditPr }) {
  const options = useShuttleQuery("editOptions", { key: pr.key });
  const [filter, setFilter] = useState("");
  const reviewers = pr.reviewers ?? [];
  const find = (login: string, team: boolean) => reviewers.find((reviewer) => reviewer.login === login && reviewer.team === team) ?? null;
  const unique = (logins: readonly string[]) => [...new Set(logins)];
  const people = unique([...(options.data?.people ?? []), ...reviewers.filter((reviewer) => !reviewer.team).map((reviewer) => reviewer.login)]).filter((login) => login !== pr.author);
  const teams = unique([...(options.data?.teams ?? []), ...reviewers.filter((reviewer) => reviewer.team).map((reviewer) => reviewer.login)]);
  const text = filter.trim();
  const matches = (login: string) => login.toLowerCase().includes(text.replace(/^@/u, "").toLowerCase());
  const shownPeople = people.filter(matches);
  const shownTeams = teams.filter(matches);

  const choice = (login: string, team: boolean) => {
    const reviewer = find(login, team);
    const reviewed = reviewer !== null && reviewer.state !== "requested";
    const sub = reviewed ? `${REVIEWER_LOOKS[reviewer.state].label}: use Ask again` : reviewer !== null ? "Review requested" : team ? "Team" : null;
    return (
      <PickerCheckbox key={`${team ? "team" : "person"}:${login}`} checked={reviewer !== null} disabled={reviewed}
        onToggle={() => edit.apply(reviewer !== null ? { kind: "reviewers", remove: [{ login, team }] } : { kind: "reviewers", add: [{ login, team }] })}>
        <Avatar login={login} team={team} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{login}</span>
          {sub !== null && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
        </span>
      </PickerCheckbox>
    );
  };
  const typedTeam = text.startsWith("@");
  const typedLogin = text.replace(/^@/u, "");
  return (
    <>
      <PickerFilter label="Search people and teams" value={filter} onChange={setFilter} />
      {options.error !== null && <div className="px-2.5 py-1.5 text-xs text-destructive-text">Could not load suggestions: {messageOf(options.error)}</div>}
      {options.isLoading && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading suggestions…</div>}
      {shownPeople.length > 0 && <PickerGroup>Suggested</PickerGroup>}
      {shownPeople.map((login) => choice(login, false))}
      {shownTeams.length > 0 && <PickerGroup>Teams</PickerGroup>}
      {shownTeams.map((login) => choice(login, true))}
      {typedLogin !== "" && shownPeople.length === 0 && shownTeams.length === 0 && (
        <PickerAction keepOpen onSelect={() => { edit.apply({ kind: "reviewers", add: [{ login: typedLogin, team: typedTeam }] }); setFilter(""); }}>
          <Icon name="Plus" className="size-3.5" aria-hidden />
          Request {typedTeam ? `team ${typedLogin}` : typedLogin}
        </PickerAction>
      )}
    </>
  );
}
