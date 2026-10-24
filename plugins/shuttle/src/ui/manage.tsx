import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Label, PrAction, PrView, Reviewer, ReviewerState } from "../contract";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, ICON_GHOST, Pill, SectionTitle } from "./common";
import { messageOf, useShuttleQuery } from "./data";
import { useEditPr, type EditPr } from "./edit";
import { PickerAction, PickerCheckbox, PickerFilter, PickerGroup, Picker } from "./picker";

const HEX = /^(?:[0-9a-f]{3}){1,2}$/iu;

/** A label in its server's colour, which servers send as hex without the "#". */
function labelStyle(color: string | null): CSSProperties | undefined {
  if (color === null || !HEX.test(color)) return undefined;
  const hex = `#${color}`;
  return {
    borderColor: `color-mix(in srgb, ${hex} 45%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${hex} 14%, transparent)`,
    color: `color-mix(in srgb, ${hex} 75%, var(--foreground))`,
  };
}

function LabelChip({ label, onRemove, maxChars }: { label: Label; onRemove?: () => void; maxChars?: number }) {
  const style = labelStyle(label.color);
  const cut = maxChars !== undefined && label.name.length > maxChars;
  return (
    <span data-label={label.name} style={style} title={cut ? label.name : undefined}
      className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[11.5px] leading-none ${style ? "" : "border-border text-muted-foreground"}`}>
      {cut ? `${label.name.slice(0, maxChars - 1)}…` : label.name}
      {onRemove && (
        <button type="button" aria-label={`Remove label ${label.name}`} title="Remove" onClick={onRemove} className="-mr-1 inline-flex cursor-pointer rounded-full opacity-70 hover:opacity-100">
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

function ColorDot({ color }: { color: string | null }) {
  const valid = color !== null && HEX.test(color);
  return <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${valid ? "" : "bg-muted"}`} style={valid ? { backgroundColor: `#${color}` } : undefined} />;
}

const REVIEWER_LOOKS: Record<ReviewerState, { icon: string; label: string; className: string }> = {
  requested: { icon: "Clock", label: "Review requested", className: "text-warning-text" },
  approved: { icon: "Check", label: "Approved", className: "text-success" },
  changes: { icon: "X", label: "Changes requested", className: "text-destructive" },
  commented: { icon: "MessageSquare", label: "Commented", className: "text-muted-foreground" },
  dismissed: { icon: "Minus", label: "Dismissed", className: "text-muted-foreground" },
};

function Avatar({ login, team }: { login: string; team: boolean }) {
  const initial = (login.split("/").at(-1) ?? login).replace(/^@/u, "").charAt(0).toUpperCase();
  return (
    <span aria-hidden className={`inline-flex size-[22px] shrink-0 items-center justify-center bg-muted text-[10px] font-bold text-foreground ${team ? "rounded-md" : "rounded-full"}`}>
      {initial}
    </span>
  );
}

function ReviewerRow({ reviewer, actions }: { reviewer: Reviewer; actions?: ReactNode }) {
  const look = REVIEWER_LOOKS[reviewer.state];
  return (
    <li data-reviewer={reviewer.login} className="flex items-center gap-2 py-1 text-sm">
      <Avatar login={reviewer.login} team={reviewer.team} />
      <span className="min-w-0 flex-1 truncate">
        {reviewer.login}
        {reviewer.team && <span className="text-xs text-muted-foreground"> team</span>}
      </span>
      <span className={`inline-flex shrink-0 items-center gap-1 text-xs ${look.className}`}>
        <Icon name={look.icon} className="size-3" aria-hidden />
        {look.label}
      </span>
      {actions}
    </li>
  );
}

function LabelChoices({ pr, edit }: { pr: PrView; edit: EditPr }) {
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
      {options.error !== null && <div className="px-2.5 py-1.5 text-xs text-destructive">Could not load the labels: {messageOf(options.error)}</div>}
      {options.isLoading && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Loading labels…</div>}
      <PickerGroup>Labels in {pr.repo}</PickerGroup>
      {shown.map((label) => {
        const on = current.some((item) => item.name === label.name);
        return (
          <PickerCheckbox key={label.name} checked={on} onToggle={() => edit.apply(on ? { kind: "labels", remove: [label.name] } : { kind: "labels", add: [label.name] })}>
            <ColorDot color={label.color} />
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

function ReviewerChoices({ pr, edit }: { pr: PrView; edit: EditPr }) {
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
      {options.error !== null && <div className="px-2.5 py-1.5 text-xs text-destructive">Could not load suggestions: {messageOf(options.error)}</div>}
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

const ROW = "border-b border-border px-3 py-2.5 last:border-b-0";
const ROW_HEAD = "mb-1.5 flex items-center text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground";
const QUIET_DESTRUCTIVE = `${BUTTON} text-destructive`;

function StatusRow({ pr, edit }: { pr: PrView; edit: EditPr }) {
  const can = (action: PrAction) => pr.actions.includes(action);
  const reason = `${pr.serverName} can't do this`;
  const buttons: { action: PrAction; label: string; icon: string; className: string }[] = [];
  if (pr.state === "draft") buttons.push({ action: "ready", label: "Ready for review", icon: "Check", className: BUTTON_PRIMARY });
  if (pr.state === "open") buttons.push({ action: "draft", label: "Convert to draft", icon: "GitPullRequestDraft", className: BUTTON });
  if (pr.state === "open" || pr.state === "draft") buttons.push({ action: "close", label: "Close PR", icon: "GitPullRequestClosed", className: QUIET_DESTRUCTIVE });
  if (pr.state === "closed") buttons.push({ action: "reopen", label: "Reopen", icon: "RotateCcw", className: QUIET_DESTRUCTIVE });
  const missing = buttons.filter((button) => !can(button.action));
  return (
    <div data-manage-row="status" className={ROW}>
      <div className={ROW_HEAD}>Status</div>
      <div className="flex flex-wrap items-center gap-2">
        {pr.state === "draft" && <Pill icon="GitPullRequestDraft">Draft: reviewers aren't notified</Pill>}
        {pr.state === "open" && <Pill tone="ok">Ready for review</Pill>}
        {pr.state === "closed" && <Pill tone="bad">Closed</Pill>}
        {pr.state === "merged" && <Pill tone="brand" icon="GitMerge">Merged</Pill>}
        <span className="flex-1" />
        {buttons.map((button) => (
          <button key={button.action} type="button" className={button.className} disabled={!can(button.action)} title={can(button.action) ? undefined : reason}
            onClick={() => edit.apply({ kind: button.action } as { kind: "ready" | "draft" | "close" | "reopen" })}>
            <Icon name={button.icon} className="size-3.5" aria-hidden />
            {button.label}
          </button>
        ))}
      </div>
      {missing.length > 0 && <div className="mt-1.5 text-xs text-muted-foreground">{reason}: {missing.map((button) => button.label.toLowerCase()).join(", ")}.</div>}
    </div>
  );
}

/** Status, labels and reviewers of one of the user's own PRs; each change goes to the server at once. */
export function ManageCard({ pr, phone }: { pr: PrView; phone: boolean }) {
  const edit = useEditPr(pr);
  const can = (action: PrAction) => pr.actions.includes(action);
  const reason = `${pr.serverName} can't do this`;
  return (
    <section aria-label="Manage your PR" data-manage className="mt-2 rounded-lg border border-primary/35 bg-primary/5">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold">
        <Icon name="GitPullRequest" className="size-4" aria-hidden />
        <span className="flex-1">Manage your PR</span>
        <span className="text-xs font-normal text-muted-foreground">Changes go straight to {pr.serverName}</span>
      </div>
      <StatusRow pr={pr} edit={edit} />
      <div data-manage-row="labels" className={ROW}>
        <div className={ROW_HEAD}>
          <span className="flex-1">Labels</span>
          <Picker phone={phone} title="Labels" triggerLabel="Edit labels" triggerClassName={BUTTON_GHOST} disabled={!can("labels")} disabledReason={reason}
            trigger={<><Icon name="Plus" className="size-3.5" aria-hidden />Edit</>}>
            <LabelChoices pr={pr} edit={edit} />
          </Picker>
        </div>
        {pr.labels !== null && (
          <div className="flex flex-wrap gap-1.5">
            {pr.labels.length === 0 && <span className="text-xs text-muted-foreground">No labels</span>}
            {pr.labels.map((label) => (
              <LabelChip key={label.name} label={label} onRemove={can("labels") ? () => edit.apply({ kind: "labels", remove: [label.name] }) : undefined} />
            ))}
          </div>
        )}
      </div>
      <div data-manage-row="reviewers" className={ROW}>
        <div className={ROW_HEAD}>
          <span className="flex-1">Reviewers</span>
          <Picker phone={phone} title="Request reviewers" triggerLabel="Request reviewers" triggerClassName={BUTTON_GHOST} disabled={!can("reviewers")} disabledReason={reason}
            trigger={<><Icon name="Plus" className="size-3.5" aria-hidden />Request</>}>
            <ReviewerChoices pr={pr} edit={edit} />
          </Picker>
        </div>
        {pr.reviewers !== null && pr.reviewers.length === 0 && (
          <div className="text-xs text-muted-foreground">Nobody yet.{pr.state === "draft" ? " Requests on a draft wait until it's ready." : ""}</div>
        )}
        {pr.reviewers !== null && pr.reviewers.length > 0 && (
          <ul>
            {pr.reviewers.map((reviewer) => (
              <ReviewerRow key={`${reviewer.team ? "team" : "person"}:${reviewer.login}`} reviewer={reviewer} actions={!can("reviewers") ? undefined : reviewer.state === "requested" ? (
                <button type="button" aria-label={`Withdraw the request to ${reviewer.login}`} title="Withdraw the request" className={ICON_GHOST}
                  onClick={() => edit.apply({ kind: "reviewers", remove: [{ login: reviewer.login, team: reviewer.team }] })}>
                  <Icon name="X" className="size-3.5" aria-hidden />
                </button>
              ) : (
                <button type="button" aria-label={`Ask ${reviewer.login} to review again`} title="Ask for a new review" className={BUTTON_GHOST}
                  onClick={() => edit.apply({ kind: "reviewers", add: [{ login: reviewer.login, team: reviewer.team }] })}>
                  <Icon name="RotateCcw" className="size-3.5" aria-hidden />
                  Ask again
                </button>
              )} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const SECTION = "py-2";

/** Someone else's PR: its labels and reviewers, to read. */
export function LabelsAndReviewers({ pr }: { pr: PrView }) {
  return (
    <>
      {pr.labels !== null && (
        <div data-readonly="labels" className={SECTION}>
          <SectionTitle icon="Filter">Labels</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {pr.labels.length === 0 ? <span className="text-sm text-muted-foreground">No labels</span> : pr.labels.map((label) => <LabelChip key={label.name} label={label} />)}
          </div>
        </div>
      )}
      {pr.reviewers !== null && (
        <div data-readonly="reviewers" className={SECTION}>
          <SectionTitle icon="UserRound">Reviewers</SectionTitle>
          {pr.reviewers.length === 0 ? <div className="text-sm text-muted-foreground">Nobody yet.</div> : (
            <ul>{pr.reviewers.map((reviewer) => <ReviewerRow key={`${reviewer.team ? "team" : "person"}:${reviewer.login}`} reviewer={reviewer} />)}</ul>
          )}
        </div>
      )}
    </>
  );
}
